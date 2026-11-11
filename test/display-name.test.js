// Settings -> Profile -> Name: a person chooses the name tdoc shows for them
// instead of the one their sign-in provider sent. Pins:
//   - validation (trim, collapse spaces, drop control/bidi characters, 1-60
//     characters, no markup, no address) and the empty name going back to
//     the provider's
//   - the gates: hosted only, signed in, same origin, not a widget token,
//     rate limited
//   - precedence: the chosen name beats a fresh sign-in's provider name
//   - EXISTING comments and replies show the new name (resolved at read
//     time by actor key; the stored snapshot is the fallback), as do new
//     ones, the @ list, the team roster, the inbox and the agent read
//   - agents keep their own names even when they act for the person
// Run with: node test/display-name.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = { Origin: 'https://tdoc.dev' };
const PROVIDER_NAME = 'Jingyu Shi (Julie)';

(async () => {
  console.log('display name');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const setName = (cookie, name, headers = ORIGIN) => call('/api/me/name', { method: 'POST', cookie, body: { name }, headers });

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  // The provider's name, as GitHub / Clerk stamp it on every sign-in.
  const providerSession = async (login, accountId, name, sid) => {
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name, avatar_url: '', account_id: accountId, created: new Date().toISOString() }));
    return `tdoc_sid=${sid}`;
  };
  const aliceCookie = await providerSession('alice', alice.account_id, PROVIDER_NAME, 'a1'.repeat(16));
  let sidSeq = 0;
  const providerSessionFor = (login, accountId) => providerSession(login, accountId, login, (++sidSeq).toString(16).padStart(32, 'e'));

  const up = await call('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'plan', version: 1, html: '<h1>Plan</h1><p>Billing first.</p>' } });
  assert(up.status === 200, `upload ${up.status} ${up.text}`);

  // Written BEFORE the rename: the stored snapshot says the provider name.
  const root = await call('/api/comments', { method: 'POST', cookie: aliceCookie, body: { slug: 'plan', version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'Billing' } } });
  assert(root.status === 200, `alice comment ${root.status} ${root.text}`);
  const bobRoot = await call('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', version: 1, text: 'Ship it.', anchor: { kind: 'text', text: 'Plan' } } });
  assert(bobRoot.status === 200, `bob comment ${bobRoot.status}`);
  const reply = await call('/api/comments', { method: 'POST', cookie: aliceCookie, body: { slug: 'plan', version: 1, parent_id: bobRoot.body.id, text: 'Agreed.' } });
  assert(reply.status === 200, `alice reply ${reply.status} ${reply.text}`);
  const agentReply = await call('/api/agent/reply', { method: 'POST', token: alice.token, body: { slug: 'plan', parent_id: root.body.id, text: 'Billing is owned by Ana.', status: 'answered' } });
  assert(agentReply.status === 200, `agent reply ${agentReply.status} ${agentReply.text}`);

  const readLog = async () => JSON.stringify(await (await env.COMMENTS.get('plan').fetch('https://do/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'plan' }),
  })).json());
  const stored = await readLog();

  await t('before choosing, comments carry the provider name and Settings offers it', async () => {
    const list = (await call('/api/comments?slug=plan')).body;
    const mine = list.find((c) => c.id === root.body.id);
    assert(mine.author.name === PROVIDER_NAME, `snapshot ${mine.author.name}`);
    const prof = (await call('/api/me/profile', { cookie: aliceCookie })).body.profile;
    assert(prof.name === PROVIDER_NAME && prof.display_name === '' && prof.provider_name === PROVIDER_NAME, JSON.stringify(prof));
  });

  await t('the name is cleaned: control and bidi characters dropped, spaces collapsed, trimmed', async () => {
    const r = await setName(aliceCookie, `  Julie‮ \u0007  Shi​ \n`);
    assert(r.status === 200, `${r.status} ${r.text}`);
    assert(r.body.name === 'Julie Shi' && r.body.display_name === 'Julie Shi', JSON.stringify(r.body));
    assert(r.body.provider_name === PROVIDER_NAME, `provider ${r.body.provider_name}`);
    const prof = JSON.parse(env.META.map.get(`account-profile:${alice.account_id}`));
    assert(prof.display_name === 'Julie Shi', `stored ${prof.display_name}`);
  });

  await t('refused: markup, an address, over 60 characters, not a string', async () => {
    for (const [name, error] of [['<b>Julie</b>', 'invalid_name'], ['julie@example.com', 'invalid_name'], ['x'.repeat(61), 'name_too_long'], [42, 'invalid_name'], [{ a: 1 }, 'invalid_name']]) {
      const r = await setName(aliceCookie, name);
      assert(r.status === 400 && r.body.error === error, `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
    const sixty = await setName(aliceCookie, 'é'.repeat(60));
    assert(sixty.status === 200, `60 characters ${sixty.status}`);
    const back = await setName(aliceCookie, 'Julie Shi');
    assert(back.status === 200 && back.body.name === 'Julie Shi', 'restore');
  });

  await t('EXISTING comments and replies show the chosen name; others keep theirs; the snapshot is untouched', async () => {
    for (const path of ['/api/comments?slug=plan', '/api/comments?slug=plan&version=all']) {
      const list = (await call(path, { cookie: bob.cookie })).body;
      const mine = list.find((c) => c.id === root.body.id);
      assert(mine.author.name === 'Julie Shi', `${path} root ${mine.author.name}`);
      const bobs = list.find((c) => c.id === bobRoot.body.id);
      assert(bobs.author.name === 'bob', `${path} bob ${bobs.author.name}`);
      const r = (bobs.replies || []).find((x) => x.text === 'Agreed.');
      assert(r && r.author.name === 'Julie Shi', `${path} reply ${r && r.author.name}`);
      assert(!JSON.stringify(list).includes(PROVIDER_NAME), `${path} still shows the provider name`);
      assert(!JSON.stringify(list).includes(alice.account_id), `${path} leaks the account id`);
    }
    const after = await readLog();
    assert(after.includes(PROVIDER_NAME), 'the stored snapshot lost the provider name');
    assert(after === stored, 'reading rewrote the comment log');
  });

  await t('an agent acting for the person keeps its own name', async () => {
    const list = (await call('/api/comments?slug=plan')).body;
    const mine = list.find((c) => c.id === root.body.id);
    const agent = (mine.replies || []).find((x) => x.text === 'Billing is owned by Ana.');
    assert(agent, 'agent reply missing');
    assert(agent.author.kind === 'agent', `kind ${agent.author.kind}`);
    assert(agent.author.name !== 'Julie Shi', `agent renamed to ${agent.author.name}`);
  });

  await t('a fresh sign-in with the provider name does not undo the choice', async () => {
    const again = await providerSession('alice', alice.account_id, PROVIDER_NAME, 'a2'.repeat(16));
    const me = (await call('/api/me', { cookie: again })).body;
    assert(me.identity.name === 'Julie Shi', `identity ${me.identity.name}`);
    assert(me.profile.display_name === 'Julie Shi' && me.profile.provider_name === PROVIDER_NAME, JSON.stringify(me.profile));
    const auth = (await call('/api/auth/me', { cookie: again })).body;
    assert(JSON.stringify(auth).includes('Julie Shi') && !JSON.stringify(auth).includes(PROVIDER_NAME), `auth/me ${JSON.stringify(auth)}`);
    const fresh = await call('/api/comments', { method: 'POST', cookie: again, body: { slug: 'plan', version: 1, text: 'New one.', anchor: { kind: 'text', text: 'Plan' } } });
    assert(fresh.status === 200 && fresh.body.author.name === 'Julie Shi', `new comment ${fresh.text}`);
  });

  await t('the @ list, the inbox and the agent markdown read use it', async () => {
    const m = (await call('/api/mentions?slug=plan', { cookie: bob.cookie })).body;
    const a = m.users.find((u) => u.login === 'alice');
    assert(a && a.name === 'Julie Shi', `mentions ${JSON.stringify(a)}`);
    const inbox = await call('/api/notifications', { cookie: bob.cookie });
    assert(inbox.status === 200, `inbox ${inbox.status}`);
    assert(inbox.text.includes('Julie Shi') && !inbox.text.includes(PROVIDER_NAME), `inbox ${inbox.text.slice(0, 400)}`);
    const md = await call('/d/plan', { headers: { Accept: 'text/markdown' } });
    assert(!md.text.includes(PROVIDER_NAME), 'markdown read shows the old name');
  });

  await t('the team roster shows it', async () => {
    const team = await call('/api/teams', { method: 'POST', cookie: aliceCookie, body: { name: 'Research' }, headers: ORIGIN });
    assert(team.status === 200, `team ${team.status} ${team.text}`);
    const got = (await call(`/api/team?id=${team.body.team.id}`, { cookie: aliceCookie })).body.team;
    assert(got.members[0].name === 'Julie Shi', `roster ${got.members[0].name}`);
    // A roster entry written with the provider name still reads as the choice.
    const raw = JSON.parse(env.META.map.get(`team:${team.body.team.id}`));
    raw.members[0].name = PROVIDER_NAME;
    env.META.map.set(`team:${raw.id}`, JSON.stringify(raw));
    const again = (await call(`/api/team?id=${raw.id}`, { cookie: aliceCookie })).body.team;
    assert(again.members[0].name === 'Julie Shi', `stale roster ${again.members[0].name}`);
  });

  await t('an empty name goes back to the provider name, everywhere', async () => {
    const r = await setName(aliceCookie, '');
    assert(r.status === 200 && r.body.name === PROVIDER_NAME && r.body.display_name === '', JSON.stringify(r.body));
    const list = (await call('/api/comments?slug=plan')).body;
    assert(list.find((c) => c.id === root.body.id).author.name === PROVIDER_NAME, 'old comment did not fall back to its snapshot');
    const me = (await call('/api/me', { cookie: aliceCookie })).body;
    assert(me.identity.name === PROVIDER_NAME, `identity ${me.identity.name}`);
    await setName(aliceCookie, 'Julie Shi');
  });

  await t('gates: signed out, cross-site, a feedback token, self-hosted', async () => {
    const anon = await call('/api/me/name', { method: 'POST', body: { name: 'X' }, headers: ORIGIN });
    assert(anon.status === 401, `anonymous ${anon.status}`);
    const cross = await setName(aliceCookie, 'Mallory', { Origin: 'https://evil.example' });
    assert(cross.status === 403, `cross-site ${cross.status}`);
    const tokenOnly = await call('/api/me/name', { method: 'POST', token: alice.token, body: { name: 'Token' }, headers: ORIGIN });
    assert(tokenOnly.status === 401 || tokenOnly.status === 403, `bearer ${tokenOnly.status}`);
    const byok = await worker.fetch(req('/api/me/name', { method: 'POST', cookie: aliceCookie, body: { name: 'X' }, headers: ORIGIN }), { ...env, TDOC_HOSTED_REGISTRATION: '0' }, {});
    assert(byok.status === 404, `self-hosted ${byok.status}`);
    const prof = JSON.parse(env.META.map.get(`account-profile:${alice.account_id}`));
    assert(prof.display_name === 'Julie Shi', `a refused request changed the name to ${prof.display_name}`);
  });

  await t('L4: a body that does not parse, or names no `name`, changes nothing', async () => {
    const before = env.META.map.get(`account-profile:${alice.account_id}`);
    const bad = await worker.fetch(new Request('https://tdoc.dev/api/me/name', { method: 'POST', headers: { Cookie: aliceCookie, 'Content-Type': 'application/json', ...ORIGIN }, body: '{"name": ' }), env, {});
    assert(bad.status === 400, `malformed ${bad.status}`);
    for (const body of [{}, { nme: 'x' }, []]) {
      const r = await call('/api/me/name', { method: 'POST', cookie: aliceCookie, body, headers: ORIGIN });
      assert(r.status === 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
    const blank = await setName(aliceCookie, '   ');
    assert(blank.status === 400, `whitespace only ${blank.status}`);
    assert(env.META.map.get(`account-profile:${alice.account_id}`) === before, 'a refused request changed the profile');
  });

  await t('L1: invisible, look-alike and link-shaped input', async () => {
    const vera = await issue(worker, env, 'vera');
    const cases = [
      // [input, expected name | error]
      ['\u202eVera\u2066 \u200dLin\u{e0041}\u{e007f}', 'Vera Lin'],
      ['Vera\u034f\u17b4\u180b\ufe0f\u2800\uffa0 Lin', 'Vera Lin'],
      ['José 李小龙', 'José 李小龙'],
      ['\u2800\u2800\u3164', 'invalid_name'],
      ['!!! ---', 'invalid_name'],
      ['e\u0301\u0302\u0303\u0304\u0305', 'invalid_name'],
      ['vera\uff20example.com', 'invalid_name'],
      ['vera\ufe6bexample', 'invalid_name'],
      ['\uff1cb\uff1eVera', 'invalid_name'],
      ['https://spam.example', 'invalid_name'],
      ['www.spam', 'invalid_name'],
      ['Buy cheap.io', 'invalid_name'],
      ['vera\uff0ecom', 'invalid_name'],
    ];
    for (const [input, want] of cases) {
      const r = await setName(vera.cookie, input);
      if (want === 'invalid_name') assert(r.status === 400 && r.body.error === 'invalid_name', `${JSON.stringify(input)} -> ${r.status} ${r.text}`);
      else assert(r.status === 200 && r.body.name === want, `${JSON.stringify(input)} -> ${r.status} ${r.text}`);
    }
  });

  await t('M2: names that pass for tdoc, an agent, a placeholder or a team agent are refused', async () => {
    const rex = await issue(worker, env, 'rex');
    const team = await call('/api/teams', { method: 'POST', cookie: rex.cookie, body: { name: 'Ops' }, headers: ORIGIN });
    assert(team.status === 200, `team ${team.status} ${team.text}`);
    const raw = JSON.parse(env.META.map.get(`team:${team.body.team.id}`));
    raw.agents = [{ id: 'ta_0123456789abcdef', name: 'Report Bot' }];
    env.META.map.set(`team:${raw.id}`, JSON.stringify(raw));
    for (const name of ['tdoc', 'TDOC', 'tdoc AI', 'Tdoc  ai helper', 'td0c-AI', 'tdoc agent', 'Team agent', 'team-agent 2', 'Claude', 'CLAUDE CODE', 'C1aude', 'Codex', 'cursor', 'Gemini', 'grok',
    ]) {
      const r = await setName(rex.cookie, name);
      assert(r.status === 400 && (r.body.error === 'reserved_name' || r.body.error === 'invalid_name'), `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
    // A second person in the same team: the rest of the list (20 saves an hour each).
    const rae = await issue(worker, env, 'rae');
    const ids = JSON.parse(env.META.map.get(`account-teams:${rae.account_id}`) || '[]');
    env.META.map.set(`account-teams:${rae.account_id}`, JSON.stringify([...ids, raw.id]));
    raw.members.push({ account_id: rae.account_id, key: 'rae', name: 'rae', role: 'member', joined: '2026-01-01T00:00:00.000Z' });
    env.META.map.set(`team:${raw.id}`, JSON.stringify(raw));
    for (const name of [
      'Deleted user', 'anonymous', 'Someone', 'Agent', 'Julie · Claude', 'Julie \u2022 Claude', 'report bot', 'Rep0rt-B0t', '\uff34doc']) {
      const r = await setName(rae.cookie, name);
      assert(r.status === 400 && (r.body.error === 'reserved_name' || r.body.error === 'invalid_name'), `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
    for (const name of ['Monet Claude', 'Rex Tdocson']) {
      const r = await setName(rex.cookie, name);
      assert(r.status === 200, `${name} -> ${r.status} ${r.text}`);
    }
  });

  await t('M1: an old comment shows a chosen name only while the account still holds that identity', async () => {
    // Two accounts: carl still holds GitHub "carl"; erin's account once had
    // "erin", gave it up on GitHub, and someone else wrote under "erin".
    const carl = await issue(worker, env, 'carl');
    const erin = await issue(worker, env, 'erin');
    env.META.map.set(`account-github:${carl.account_id}`, JSON.stringify({ sub: '1001', handle: 'carl', linked_at: '2026-01-01T00:00:00.000Z' }));
    env.META.map.set(`account-github:${erin.account_id}`, JSON.stringify({ sub: '1002', handle: 'erin-renamed', linked_at: '2026-01-01T00:00:00.000Z' }));
    assert((await setName(carl.cookie, 'Carl Chosen')).status === 200, 'carl name');
    assert((await setName(erin.cookie, 'Erin Chosen')).status === 200, 'erin name');
    const at = '2026-01-02T00:00:00.000Z';
    // Records from before account ids were stamped: a handle and a snapshot.
    await env.META.put('meta:legacy', JSON.stringify({ title: 'Legacy', slug: 'legacy', created: at, versions: [{ n: 1, created: at }],
      access: { visibility: 'public', commenting: 'signed_in' }, hosted: { account_id: carl.account_id, github_login: 'carl' } }));
    await env.DOCS.put('docs/legacy/v1/index.html', '<h1>Legacy</h1><p>Old words.</p>');
    await env.META.put('comments:legacy', JSON.stringify([
      { id: 'c_old_carl', author: { login: 'carl', name: 'carl (old)', avatar_url: '' }, text: 'Old note.', created: at, version: 1, anchor: { kind: 'text', text: 'Old' } },
      { id: 'c_old_erin', author: { login: 'erin', name: 'Erin Snapshot', avatar_url: '' }, text: 'Not the same erin.', created: at, version: 1, anchor: { kind: 'text', text: 'words' } },
    ]));
    const list = (await call('/api/comments?slug=legacy')).body;
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    assert(byId.c_old_carl.author.name === 'Carl Chosen', `carl ${byId.c_old_carl.author.name}`);
    assert(byId.c_old_erin.author.name === 'Erin Snapshot', `erin got ${byId.c_old_erin.author.name}`);
    // New records carry the account: resolved by it, and the id never leaves.
    const fresh = await call('/api/comments', { method: 'POST', cookie: erin.cookie, body: { slug: 'legacy', version: 1, text: 'New one.', anchor: { kind: 'text', text: 'Old' } } });
    assert(fresh.status === 200 && fresh.body.author.name === 'Erin Chosen', `fresh ${fresh.text}`);
    const all = await call('/api/comments?slug=legacy&version=all');
    assert(!all.text.includes(erin.account_id) && !all.text.includes(carl.account_id), 'an account id left the worker');
    assert(all.body.find((c) => c.id === fresh.body.id).author.name === 'Erin Chosen', 'fresh by account');
  });

  await t('L2: the @ list does not name accounts behind invite-only logins', async () => {
    // Owner alice invites "carl" by handle; carl has never spoken on plan.
    const meta = JSON.parse(env.META.map.get('meta:plan'));
    meta.access = { ...(meta.access || {}), allowed_users: [...((meta.access && meta.access.allowed_users) || []), 'carl'] };
    env.META.map.set('meta:plan', JSON.stringify(meta));
    const m = (await call('/api/mentions?slug=plan', { cookie: aliceCookie })).body;
    const c = m.users.find((u) => u.login === 'carl');
    assert(c, `carl not listed: ${JSON.stringify(m.users)}`);
    assert(c.name !== 'Carl Chosen', 'invite-only entry revealed the account name');
    const b = m.users.find((u) => u.login === 'bob');
    assert(b && b.name === 'bob', `participant ${JSON.stringify(b)}`);
  });

  await t('L6: agent-looking authors keep their names', async () => {
    const out = await env.META.get('x');
    assert(out === null);
    const list = (await call('/api/comments?slug=plan')).body;
    for (const c of list) for (const r of c.replies || []) {
      if (r.author && r.author.kind === 'agent') assert(r.author.name !== 'Julie Shi', 'agent renamed');
    }
  });

  await t('N1: comments a publisher uploads keep the names they carry, whoever they claim', async () => {
    // carl and erin have chosen names (M1 case above). alice owns plan and
    // uploads v2 with comments naming them, an account id and an address.
    const carlId = JSON.parse(env.META.map.get('hosted-account:carl')).account_id;
    await env.META.put(`account-email:carl@example.com`, JSON.stringify({ account_id: carlId, created: '2026-01-01T00:00:00.000Z' }));
    const forged = [
      { id: 'c_forged_1', author: { login: 'carl', name: 'Forged One', avatar_url: '' }, text: 'f1', created: '2026-01-03T00:00:00.000Z', version: 1, anchor: { kind: 'text', text: 'Plan' } },
      { id: 'c_forged_2', author: { login: 'email:carl@example.com', name: 'Forged Two', avatar_url: '' }, text: 'f2', created: '2026-01-03T00:00:00.000Z', version: 1, anchor: { kind: 'text', text: 'Plan' } },
      { id: 'c_forged_3', author: { login: 'bob', name: 'Forged Three', avatar_url: '', account_id: carlId }, text: 'f3', created: '2026-01-03T00:00:00.000Z', version: 1, anchor: { kind: 'text', text: 'Plan' },
        replies: [{ id: 'r_forged', author: { login: 'carl', name: 'Forged Reply', github_id: '1001', account_id: carlId }, text: 'fr', created: '2026-01-03T00:00:00.000Z' }] },
    ];
    const up2 = await call('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'plan', version: 2, html: '<h1>Plan</h1><p>Billing first.</p>', comments: forged } });
    assert(up2.status === 200, `upload ${up2.status} ${up2.text}`);
    const all = await call('/api/comments?slug=plan&version=all');
    assert(!all.text.includes('Carl Chosen'), 'an uploaded comment resolved to carl\'s chosen name');
    assert(!all.text.includes(carlId), 'an account id left the worker');
    const byId = Object.fromEntries(all.body.map((c) => [c.id, c]));
    assert(byId.c_forged_1.author.name === 'Forged One', `f1 ${byId.c_forged_1.author.name}`);
    assert(byId.c_forged_2.author.name === 'Forged Two', `f2 ${byId.c_forged_2.author.name}`);
    assert(byId.c_forged_3.author.name === 'Forged Three', `f3 ${byId.c_forged_3.author.name}`);
    const log = await (await env.COMMENTS.get('plan').fetch('https://do/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'plan' }) })).json();
    const stored = JSON.stringify(log.list.filter((c) => String(c.id).startsWith('c_forged')));
    assert(!stored.includes(carlId) && !stored.includes('1001'), 'the uploaded ids were stored');
    assert(stored.includes('"imported":true'), 'uploaded authors are not marked imported');
  });

  await t('N3: a record stamped with a GitHub id resolves only while that id holds the handle', async () => {
    const at = '2026-01-04T00:00:00.000Z';
    await env.META.put('meta:ghid', JSON.stringify({ title: 'G', slug: 'ghid', created: at, versions: [{ n: 1, created: at }],
      access: { visibility: 'public', commenting: 'signed_in' }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
    await env.DOCS.put('docs/ghid/v1/index.html', '<h1>G</h1><p>Words.</p>');
    await env.META.put('comments:ghid', JSON.stringify([
      { id: 'c_g_ok', author: { login: 'carl', name: 'carl then', avatar_url: '', github_id: '1001' }, text: 'a', created: at, version: 1, anchor: { kind: 'text', text: 'Words' } },
      { id: 'c_g_other', author: { login: 'carl', name: 'another carl', avatar_url: '', github_id: '7777' }, text: 'b', created: at, version: 1, anchor: { kind: 'text', text: 'Words' } },
    ]));
    const all = await call('/api/comments?slug=ghid');
    const byId = Object.fromEntries(all.body.map((c) => [c.id, c]));
    assert(byId.c_g_ok.author.name === 'Carl Chosen', `same id ${byId.c_g_ok.author.name}`);
    assert(byId.c_g_other.author.name === 'another carl', `other id ${byId.c_g_other.author.name}`);
    assert(!all.text.includes('1001') && !all.text.includes('7777'), 'github ids left the worker');
  });

  await t('N5: the author of a reply with an agent verdict, or with an agent login, is never renamed', async () => {
    const helper = await issue(worker, env, 'helperbot');
    env.META.map.set(`account-github:${helper.account_id}`, JSON.stringify({ sub: '3003', handle: 'helperbot', linked_at: '2026-01-01T00:00:00.000Z' }));
    assert((await setName(helper.cookie, 'Helper Person')).status === 200, 'helper name');
    const cc = await issue(worker, env, 'claude-code');
    env.META.map.set(`account-github:${cc.account_id}`, JSON.stringify({ sub: '3004', handle: 'claude-code', linked_at: '2026-01-01T00:00:00.000Z' }));
    assert((await setName(cc.cookie, 'Some Person')).status === 200, 'cc name');
    const at = '2026-01-05T00:00:00.000Z';
    await env.META.put('meta:agentold', JSON.stringify({ title: 'A', slug: 'agentold', created: at, versions: [{ n: 1, created: at }],
      access: { visibility: 'public', commenting: 'signed_in' }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
    await env.DOCS.put('docs/agentold/v1/index.html', '<h1>A</h1><p>Words.</p>');
    await env.META.put('comments:agentold', JSON.stringify([
      { id: 'c_a', author: { login: 'helperbot', name: 'helperbot', avatar_url: '' }, text: 'q', created: at, version: 1, anchor: { kind: 'text', text: 'Words' },
        replies: [
          { id: 'r_a1', author: { login: 'helperbot', name: 'Helper (agent)', avatar_url: '' }, text: 'done', created: at, agent_status: 'answered' },
          { id: 'r_a2', author: { login: 'claude-code', name: 'Claude Code', avatar_url: '' }, text: 'ok', created: at },
        ] },
    ]));
    const list = (await call('/api/comments?slug=agentold&version=all')).body;
    const c = list.find((x) => x.id === 'c_a');
    assert(c.author.name === 'Helper Person', `human root ${c.author.name}`);
    const r1 = c.replies.find((r) => r.id === 'r_a1');
    const r2 = c.replies.find((r) => r.id === 'r_a2');
    assert(r1 && r1.author.name === 'Helper (agent)', `verdict reply renamed: ${JSON.stringify(r1)}`);
    assert(r2 && r2.author.name === 'Claude Code', `agent login renamed: ${JSON.stringify(r2)}`);
  });

  await t('N4/N6: look-alike scripts, runtime prefixes, separators and dotted hosts are refused', async () => {
    const pat = await issue(worker, env, 'pat');
    for (const name of ['\u0421laude', 'C\u043edex', '\u0442\u0434oc', 'tdo\u0441', '\u03a4doc AI', 'Claude: Julie', 'Grok!',
      'Julie – Claude', 'Julie — Claude', 'Julie | Claude', 'Julie / Claude', 'shop\u3002example', 'shop\uff61example', 'buy.cheap', '10.0.0.1']) {
      const r = await setName(pat.cookie, name);
      assert(r.status === 400 && (r.body.error === 'reserved_name' || r.body.error === 'invalid_name'), `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
    const ok = await setName(pat.cookie, 'Сергей Петров');
    assert(ok.status === 200, `all-Cyrillic name refused: ${ok.text}`);
  });

  await t('R1: team review and the @ list keep upload and agent protections', async () => {
    // A team doc: a legacy thread whose reply carries an agent verdict from
    // helperbot (who has a chosen name), and a comment uploaded naming carl.
    const otto = await issue(worker, env, 'otto');
    const team = await call('/api/teams', { method: 'POST', cookie: otto.cookie, body: { name: 'Review' }, headers: ORIGIN });
    assert(team.status === 200, `team ${team.status} ${team.text}`);
    const at = '2026-01-06T00:00:00.000Z';
    await env.META.put('comments:opsdoc', JSON.stringify([
      { id: 'c_ops', author: { login: 'otto', name: 'otto', avatar_url: '' }, text: 'q', created: at, version: 1, anchor: { kind: 'text', text: 'Words' },
        replies: [{ id: 'r_ops', author: { login: 'helperbot', name: 'Helper (agent)', avatar_url: '' }, text: 'done', created: at, agent_status: 'answered' }] },
    ]));
    const up = await call('/api/upload', { method: 'POST', token: otto.token, body: { slug: 'opsdoc', version: 1, html: '<h1>Ops</h1><p>Words.</p>',
      comments: [{ id: 'c_ops_forged', author: { login: 'carl', name: 'Forged Carl', avatar_url: '' }, text: 'f', created: at, version: 1, anchor: { kind: 'text', text: 'Words' } }] } });
    assert(up.status === 200, `upload ${up.status} ${up.text}`);
    const moved = await call('/api/team/move', { method: 'POST', cookie: otto.cookie, body: { slugs: ['opsdoc'], team: team.body.team.id }, headers: ORIGIN });
    assert(moved.status === 200, `move ${moved.status} ${moved.text}`);
    const review = await call(`/api/team/comments?id=${team.body.team.id}`, { cookie: otto.cookie });
    assert(review.status === 200, `review ${review.status} ${review.text}`);
    assert(!review.text.includes('Carl Chosen') && !review.text.includes('Helper Person'), `team review renamed: ${review.text.slice(0, 600)}`);
    const items = review.body.items || [];
    const forgedRow = items.find((x) => x.id === 'c_ops_forged');
    const agentRow = items.find((x) => x.id === 'r_ops');
    assert(forgedRow && forgedRow.author.name === 'Forged Carl', `forged ${JSON.stringify(forgedRow)}`);
    assert(agentRow && agentRow.author.name === 'Helper (agent)' && agentRow.author.kind === 'agent', `agent ${JSON.stringify(agentRow)}`);
    assert(!/account_id|github_id/.test(review.text), 'ids left the worker');
    // The @ list on the same doc: the uploaded carl is not resolved, and
    // helperbot (an agent here) is not offered.
    const m = (await call('/api/mentions?slug=opsdoc', { cookie: otto.cookie })).body;
    const c = m.users.find((u) => u.login === 'carl');
    assert(c && c.name === 'Forged Carl', `@ carl ${JSON.stringify(c)}`);
    assert(!m.users.some((u) => u.login === 'helperbot'), `agent offered: ${JSON.stringify(m.users)}`);
    assert(!/account_id|github_id/.test(JSON.stringify(m)), 'ids in the @ list');
  });

  await t('G1: replying to an uploaded author does not make a contact that resolves on other docs', async () => {
    const otto = { cookie: null };
    // otto (R1) owns opsdoc, where an upload named carl. otto answers it.
    const ottoAcct = JSON.parse(env.META.map.get('hosted-account:otto')).account_id;
    otto.cookie = await providerSessionFor('otto', ottoAcct);
    const r = await call('/api/comments', { method: 'POST', cookie: otto.cookie, body: { slug: 'opsdoc', version: 1, parent_id: 'c_ops_forged', text: 'Thanks.' } });
    assert(r.status === 200, `reply ${r.status} ${r.text}`);
    const contacts = env.META.map.get('contacts:otto') || '[]';
    assert(!contacts.includes('carl'), `uploaded author became a contact: ${contacts}`);
    // Even a contact list that already holds carl (written before this
    // fix) does not name carl's account on a doc carl never touched.
    env.META.map.set('contacts:otto', JSON.stringify([{ login: 'carl', name: 'Forged Carl', avatar_url: '', at: '2026-01-07T00:00:00.000Z' }]));
    const ottoToken = (await issue(worker, env, 'otto')).token;
    const up = await call('/api/upload', { method: 'POST', token: ottoToken, body: { slug: 'ottodoc', version: 1, html: '<h1>Otto</h1><p>Fresh.</p>' } });
    assert(up.status === 200, `upload ${up.status} ${up.text}`);
    const m = (await call('/api/mentions?slug=ottodoc', { cookie: otto.cookie })).body;
    const c = m.users.find((u) => u.login === 'carl');
    assert(c, `contact not listed: ${JSON.stringify(m.users)}`);
    assert(c.name !== 'Carl Chosen', 'a recent contact resolved to the account name');
  });

  await t('R2: real names pass; agent-ish, look-alike and host-shaped ones do not', async () => {
    const quinn = await issue(worker, env, 'quinn');
    for (const name of ['Claude Dupont', 'Claude Monet', 'Dr.Smith', 'St.John', 'Alexei (Алексей)', 'Claudette Roy']) {
      const r = await setName(quinn.cookie, name);
      assert(r.status === 200 && r.body.name === name, `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
    const uma = await issue(worker, env, 'uma');
    for (const name of ['Claude AI', 'Claude Bot', 'Codex agent', 'Gemini Assistant', 'Grok GPT', 'Claude Code', 'Claude: Julie', 'Claude, Julie', '\u0421laude', '\u1d1bdoc', '\u1d1b\u1d05\u1d0f\u1d04 AI', 'evil.fr', 'x.shop/path', 'buy.cheap']) {
      const r = await setName(uma.cookie, name);
      assert(r.status === 400 && (r.body.error === 'reserved_name' || r.body.error === 'invalid_name'), `${JSON.stringify(name)} -> ${r.status} ${r.text}`);
    }
  });

  await t('rate limited per account', async () => {
    let last = null;
    for (let i = 0; i < 25; i++) {
      last = await setName(bob.cookie, `Bob ${i}`);
      if (last.status === 429) break;
    }
    assert(last.status === 429 && last.body.error === 'rate_limited', `no limit: ${last.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
