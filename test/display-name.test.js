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
    const r = await setName(aliceCookie, '   ');
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
