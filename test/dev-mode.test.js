// Dev mode, and onboarding coming back after every sign-in.
//
// Real worker routes, fake bindings. Covers:
//   - the re-login bug: Sign out lands on the landing page, whose Sign in
//     returns to /setup -- a connected account was shown "Connect your agent"
//     and stamped `started` (which puts the checklist back on My docs) on every
//     re-login. Now `/setup?via=signin` sends it to My docs and stamps nothing.
//   - a linked person (GitHub + email identities in one group) whose agent
//     stamps landed under the old id: the browser reads the whole group.
//   - the Dev mode switch: allow-listed accounts only, kept per account on the
//     server; off = no Internal bar, state route refused; never offered to, and
//     always refused for, anybody else.
const { loadWorker, makeEnv, req, bootData, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const hex = (c) => c.repeat(32);
async function emailSession(env, sid, { email, account_id, login = '' }) {
  await env.META.put(`session:${sid}`, JSON.stringify({
    login, email, account_id, name: email, avatar_url: '', created: new Date().toISOString(),
  }));
  return `tdoc_sid=${sid}`;
}
const record = async (env, id) => JSON.parse((await env.META.get(`account-onboarding:${id}`)) || 'null');

(async () => {
  console.log('dev mode + re-login onboarding');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = (env, path, opts) => worker.fetch(req(path, opts), env, { waitUntil() {} });

  await t('re-login: a connected account signing in again goes to My docs, not the gate', async () => {
    const env = makeEnv(mod.CommentsStore);
    // A long-time user: their agent connected (the token mint stamps
    // `agent_connected` and the terminal marker), long before any journey.
    const alice = await issue(worker, env, 'alice');
    assert(await env.META.get(`account-terminal:${alice.account_id}`), 'precondition: paired');
    const before = await record(env, alice.account_id);
    assert(before && before.agent_connected && !before.started, 'precondition: connected, never started');
    // Sign out, sign in again: a fresh session for the same person, and the
    // landing page's Sign in returns to /setup?via=signin.
    const out = await call(env, '/api/auth/logout', { method: 'POST', cookie: alice.cookie });
    assert(out.status === 200, 'logout');
    const cookie = `tdoc_sid=${hex('a')}`;
    await env.META.put(`session:${hex('a')}`, JSON.stringify({ login: 'alice', name: 'alice', avatar_url: '', created: new Date().toISOString() }));
    const r = await call(env, '/setup?via=signin', { cookie });
    assert(r.status === 302 && r.headers.get('location') === '/me', `expected 302 /me, got ${r.status} ${r.headers.get('location')}`);
    const after = await record(env, alice.account_id);
    assert(!after.started, 'signing in again must not start the journey (that is what put the checklist back)');
    // The record survived sign-out: nothing on logout touches it.
    assert(after.agent_connected === before.agent_connected, 'logout does not reset onboarding');
    // Opening /setup on purpose still works and still starts the journey.
    const direct = await call(env, '/setup', { cookie });
    assert(direct.status === 302 && direct.headers.get('location') === '/me?setup=1', 'an explicit setup visit opens the modal over My docs');
  });

  await t('re-login: a brand-new account signing in still lands on the gate', async () => {
    const env = makeEnv(mod.CommentsStore);
    await env.META.put('hosted-account:newbie', JSON.stringify({ account_id: 'acct-new', github_login: 'newbie', created: '2026-10-01T00:00:00Z' }));
    const cookie = `tdoc_sid=${hex('b')}`;
    await env.META.put(`session:${hex('b')}`, JSON.stringify({ login: 'newbie', account_id: 'acct-new', name: 'newbie', created: new Date().toISOString() }));
    const r = await call(env, '/setup?via=signin', { cookie });
    assert(r.status === 302 && r.headers.get('location') === '/me?setup=1', `new account opens setup over My docs, got ${r.status}`);
    assert((await record(env, 'acct-new')).started, 'and the visit starts the journey');
  });

  await t('linked identities: the agent stamps under the old id still count in the browser', async () => {
    const env = makeEnv(mod.CommentsStore);
    // The agent's token was minted for the GitHub account; the browser signs
    // in as the email account, which is canonical for the merged group.
    await env.META.put('account-onboarding:acct-gh', JSON.stringify({ agent_connected: '2026-01-01T00:00:00Z', published_first: '2026-01-01T00:01:00Z', first_doc: 'old-doc' }));
    await env.META.put('account-terminal:acct-gh', JSON.stringify({ first: '2026-01-01T00:00:00Z' }));
    const group = JSON.stringify({ canonical: 'acct-mail', ids: ['acct-mail', 'acct-gh'] });
    await env.META.put('account-group:acct-mail', group);
    await env.META.put('account-group:acct-gh', group);
    const cookie = await emailSession(env, hex('c'), { email: 'julie@example.com', account_id: 'acct-mail' });
    const body = await (await call(env, '/api/onboarding', { cookie })).json();
    assert(body.paired === true, `paired across the group, got ${JSON.stringify(body)}`);
    assert(body.record && body.record.first_doc === 'old-doc', 'record read across the group');
    const r = await call(env, '/setup?via=signin', { cookie });
    assert(r.status === 302 && r.headers.get('location') === '/me', 'a linked, connected person is not sent through the gate');
    // A new stamp lands under the canonical id, and the stray copy goes so a
    // reset cannot be undone by it.
    await call(env, '/api/onboarding/event', { method: 'POST', cookie, body: { action: 'tour_seen' } });
    const canonical = await record(env, 'acct-mail');
    assert(canonical && canonical.tour_seen && canonical.first_doc === 'old-doc', 'written under the canonical id, merged');
    assert(!(await env.META.get('account-onboarding:acct-gh')), 'the member copy is folded in, not left to resurface');
  });

  await t('linked identities: an unrelated account, or a one-sided claim, is never merged or touched', async () => {
    const env = makeEnv(mod.CommentsStore);
    // A real, symmetric link: acct-mail (canonical) + acct-gh.
    const group = JSON.stringify({ canonical: 'acct-mail', ids: ['acct-mail', 'acct-gh'] });
    await env.META.put('account-group:acct-mail', group);
    await env.META.put('account-group:acct-gh', group);
    await env.META.put('account-onboarding:acct-gh', JSON.stringify({ agent_connected: '2026-01-01T00:00:00Z' }));
    // An unrelated person with their own journey and their own terminal.
    const strangerRec = JSON.stringify({ started: '2026-02-02T00:00:00Z', agent_connected: '2026-02-02T00:00:00Z', first_doc: 'strangers-doc' });
    await env.META.put('account-onboarding:acct-stranger', strangerRec);
    await env.META.put('account-terminal:acct-stranger', JSON.stringify({ first: 'x' }));
    // A stale/forged one-sided claim: acct-mail's record is rewritten to list
    // acct-victim, whose own group record does not name acct-mail back.
    await env.META.put('account-group:acct-mail', JSON.stringify({ canonical: 'acct-mail', ids: ['acct-mail', 'acct-gh', 'acct-victim'] }));
    const victimRec = JSON.stringify({ started: '2026-03-03T00:00:00Z', first_doc: 'victims-doc', checked: { comment: 'v' } });
    await env.META.put('account-onboarding:acct-victim', victimRec);
    await env.META.put('account-group:acct-victim', JSON.stringify({ canonical: 'acct-victim', ids: ['acct-victim'] }));
    await env.META.put('account-terminal:acct-victim', JSON.stringify({ first: 'v' }));
    const cookie = await emailSession(env, hex('9'), { email: 'julie@example.com', account_id: 'acct-mail' });
    const body = await (await call(env, '/api/onboarding', { cookie })).json();
    assert(body.record.agent_connected === '2026-01-01T00:00:00Z', 'the real member is merged');
    assert(!body.record.first_doc && !body.record.started && !body.record.checked, `nobody else's stamps leak in: ${JSON.stringify(body.record)}`);
    // Writes (a stamp, then a debug-style full save via a tick) leave the others alone.
    await call(env, '/api/onboarding/event', { method: 'POST', cookie, body: { action: 'tour_seen' } });
    await call(env, '/api/onboarding/event', { method: 'POST', cookie, body: { action: 'step_checked', step: 'connect' } });
    assert(await env.META.get('account-onboarding:acct-victim') === victimRec, 'one-sided claim: record untouched');
    assert(await env.META.get('account-terminal:acct-victim'), 'one-sided claim: terminal marker untouched');
    assert(await env.META.get('account-onboarding:acct-stranger') === strangerRec, 'unrelated account: record untouched');
    assert(!(await env.META.get('account-onboarding:acct-gh')), 'the verified member copy is folded in');
    const merged = await record(env, 'acct-mail');
    assert(merged.agent_connected === '2026-01-01T00:00:00Z' && merged.tour_seen && merged.checked.connect, 'merged record written before the copy went');
    // And the stranger's own session still sees exactly their own journey.
    const theirs = await emailSession(env, hex('8'), { email: 'stranger@example.com', account_id: 'acct-stranger' });
    const sb = await (await call(env, '/api/onboarding', { cookie: theirs })).json();
    assert(sb.record.first_doc === 'strangers-doc' && sb.paired === true, 'stranger unaffected');
  });

  await t('linked identities: if the put fails, no copy is deleted', async () => {
    const env = makeEnv(mod.CommentsStore);
    const group = JSON.stringify({ canonical: 'acct-mail', ids: ['acct-mail', 'acct-gh'] });
    await env.META.put('account-group:acct-mail', group);
    await env.META.put('account-group:acct-gh', group);
    const ghRec = JSON.stringify({ agent_connected: '2026-01-01T00:00:00Z' });
    await env.META.put('account-onboarding:acct-gh', ghRec);
    const cookie = await emailSession(env, hex('7'), { email: 'julie@example.com', account_id: 'acct-mail' });
    env.META.failPutOnce.add('account-onboarding:acct-mail');
    await call(env, '/api/onboarding/event', { method: 'POST', cookie, body: { action: 'tour_seen' } }).catch(() => null);
    assert(await env.META.get('account-onboarding:acct-gh') === ghRec, 'the member copy survives a failed write');
  });

  await t('dev mode: allow-listed account is on by default and sees the Internal bar', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_DEBUG_ACCOUNTS: 'julie@example.com' });
    const cookie = await emailSession(env, hex('d'), { email: 'julie@example.com', account_id: 'acct-julie' });
    const me = bootData(await (await call(env, '/me', { cookie })).text(), '__TDOC_APP_BOOT__');
    assert(me.debug === true && me.devMode && me.devMode.on === true, `on by default: ${JSON.stringify({ debug: me.debug, devMode: me.devMode })}`);
    const setupRoute = await call(env, '/setup', { cookie });
    assert(setupRoute.status === 302 && setupRoute.headers.get('location') === '/me?setup=1', 'setup uses the docs hub');
    const setup = bootData(await (await call(env, setupRoute.headers.get('location'), { cookie })).text(), '__TDOC_APP_BOOT__');
    assert(setup.debug === true && setup.devMode.on === true, 'the hub beneath setup carries it too');
    const get = await (await call(env, '/api/me/dev-mode', { cookie })).json();
    assert(get.ok && get.on === true, 'GET says on');
  });

  await t('dev mode off: no bar, no replay, the state route refuses; on again restores it', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_DEBUG_ACCOUNTS: 'julie@example.com' });
    const cookie = await emailSession(env, hex('e'), { email: 'julie@example.com', account_id: 'acct-julie' });
    await env.META.put('account-onboarding:acct-julie', JSON.stringify({ started: 'x', agent_connected: 'x', published_first: 'x', first_doc: 'd1' }));
    const off = await call(env, '/api/me/dev-mode', { method: 'POST', cookie, body: { on: false }, headers: { Origin: 'https://tdoc.dev' } });
    assert(off.status === 200 && (await off.json()).on === false, 'switched off');
    assert(await env.META.get('dev-mode:julie@example.com') === 'off', 'kept on the server, per account');
    const me = bootData(await (await call(env, '/me', { cookie })).text(), '__TDOC_APP_BOOT__');
    assert(me.debug === false, 'no Internal bar while off');
    assert(me.devMode && me.devMode.on === false, 'but the switch is still offered, saying off');
    // A second session (another browser) sees the same position.
    const cookie2 = await emailSession(env, hex('f'), { email: 'julie@example.com', account_id: 'acct-julie' });
    const me2 = bootData(await (await call(env, '/me', { cookie: cookie2 })).text(), '__TDOC_APP_BOOT__');
    assert(me2.debug === false && me2.devMode.on === false, 'off on one device is off on the next');
    const reset = await call(env, '/api/onboarding/state', { method: 'POST', cookie, body: { state: 'new' } });
    assert(reset.status === 403 && (await reset.json()).error === 'dev_mode_off', 'replay/state refused while off');
    assert((await record(env, 'acct-julie')).first_doc === 'd1', 'and the real record is untouched');
    const on = await call(env, '/api/me/dev-mode', { method: 'POST', cookie, body: { on: true } });
    assert(on.status === 200, 'switched back on');
    assert(!(await env.META.get('dev-mode:julie@example.com')), 'on is the default, so the key goes');
    const ok = await call(env, '/api/onboarding/state', { method: 'POST', cookie, body: { state: 'started' } });
    assert(ok.status === 200, `state route works again: ${ok.status}`);
  });

  await t('dev mode: never offered to and always refused for an account not on the list', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_DEBUG_ACCOUNTS: 'julie@example.com' });
    const cookie = await emailSession(env, hex('1'), { email: 'bob@example.com', account_id: 'acct-bob' });
    const me = bootData(await (await call(env, '/me', { cookie })).text(), '__TDOC_APP_BOOT__');
    assert(me.debug === false && !me.devMode, `no switch, no bar: ${JSON.stringify({ debug: me.debug, devMode: me.devMode })}`);
    assert((await call(env, '/api/me/dev-mode', { cookie })).status === 403, 'GET refused');
    const post = await call(env, '/api/me/dev-mode', { method: 'POST', cookie, body: { on: true } });
    assert(post.status === 403, 'POST refused');
    assert(!(await env.META.get('dev-mode:bob@example.com')), 'nothing written');
    assert((await call(env, '/api/onboarding/state', { method: 'POST', cookie, body: { state: 'new' } })).status === 403, 'state refused');
    assert((await call(env, '/api/me/dev-mode', { method: 'POST', body: { on: false } })).status === 403, 'signed out refused');
  });

  await t('dev mode: a cross-origin write is refused even for the allow-list', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_DEBUG_ACCOUNTS: 'julie@example.com' });
    const cookie = await emailSession(env, hex('2'), { email: 'julie@example.com', account_id: 'acct-julie' });
    const r = await call(env, '/api/me/dev-mode', { method: 'POST', cookie, body: { on: false }, headers: { Origin: 'https://evil.example' } });
    assert(r.status === 403, `cross-origin refused, got ${r.status}`);
    assert(!(await env.META.get('dev-mode:julie@example.com')), 'nothing written');
    const bad = await call(env, '/api/me/dev-mode', { method: 'POST', cookie, body: { on: 'nope' } });
    assert(bad.status === 400, 'a non-boolean is refused');
  });

  await t('dev mode: a document page carries the switch and the bar only while on', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_DEBUG_ACCOUNTS: 'julie@example.com' });
    const cookie = await emailSession(env, hex('3'), { email: 'julie@example.com', account_id: 'acct-julie' });
    await env.META.put('meta:doc-a', JSON.stringify({
      title: 'A', slug: 'doc-a', created: '2026-10-01T00:00:00Z', versions: [{ n: 1, created: '2026-10-01T00:00:00Z' }],
      hosted: { account_id: 'acct-julie', owner_key: 'email:julie@example.com' },
      access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put('docs/doc-a/v1/index.html', '<!doctype html><html><body><h1>A</h1><p>Words on the page.</p></body></html>');
    const cfgOn = bootData(await (await call(env, '/d/doc-a/v/1', { cookie, dest: 'document' })).text(), '__TDOC_SHELL__');
    assert(cfgOn.debug === true && cfgOn.devMode && cfgOn.devMode.on === true, `doc page on: ${JSON.stringify({ debug: cfgOn.debug, devMode: cfgOn.devMode })}`);
    await env.META.put('dev-mode:julie@example.com', 'off');
    const cfgOff = bootData(await (await call(env, '/d/doc-a/v/1', { cookie, dest: 'document' })).text(), '__TDOC_SHELL__');
    assert(cfgOff.debug === false && cfgOff.devMode.on === false, 'doc page off');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
