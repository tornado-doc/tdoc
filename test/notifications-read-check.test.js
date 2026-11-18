// #1086: a comment, reply or reaction tells only people who can still read
// the doc -- bell row, push and email alike -- judged as they would sign in
// (inboxReaderSession: account, linked identities, address, teams). And the
// bell's review lows: one reader lookup per person per request, the author's
// account / GitHub id used rather than whoever holds the handle now, an
// access request blank for someone who no longer manages the doc, and a
// bounded number of doc reads on the 30-second unread poll.
// Run with: node test/notifications-read-check.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';
const SAME_ORIGIN = { Origin: 'https://tdoc.dev' };

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

(async () => {
  console.log('Notifications: read check at send time (#1086)');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const hex = (c) => c.repeat(32);
  // A signed-in person with an account (and optionally an address).
  const person = async (env, login, { sid = null, email = '' } = {}) => {
    const id = sid || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, ...(email ? { email } : {}), created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${id}`, JSON.stringify({ login, ...(email ? { email } : {}), account_id: `acct-${login}`, name: login, avatar_url: '', created: new Date().toISOString() }));
    return `tdoc_sid=${id}`;
  };
  async function seed(access = { visibility: 'unlisted' }) {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await person(env, 'owner');
    const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'u-doc', version: 1, html: PROSE } });
    assert(up.status === 200, `upload: ${up.status} ${up.text}`);
    const a = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc', access } });
    assert(a.status === 200, `access: ${a.status} ${a.text}`);
    return { env, owner, token: tok.token };
  }
  const share = (env, owner, access) => call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc', access } });
  const comment = async (env, cookie, text, parent_id, slug = 'u-doc') => {
    const body = parent_id ? { slug, version: 1, parent_id, text } : { slug, version: 1, text, anchor: { kind: 'text', text: 'A sentence' } };
    const r = await call(env, '/api/comments', { method: 'POST', cookie, body });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body;
  };
  const inbox = async (env, login) => JSON.parse(await env.META.get(`inbox:${login}`) || '{"items":[]}').items;

  await t('a collaborator removed from a private doc gets no reply row, push or email; while invited they did', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: ['rita'] });
    const rita = await person(env, 'rita', { email: 'rita@example.com' });
    await env.META.put('push-subs:rita', JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: {} }]));
    const c1 = await comment(env, rita, 'first question');
    await comment(env, owner, 'answer while invited', c1.id);
    eq((await inbox(env, 'rita')).map((i) => i.kind), ['reply'], 'an invited collaborator got no row');
    eq((await share(env, owner, { visibility: 'private', allowed_users: [] })).status, 200);
    env.META.gets.length = 0;
    await comment(env, owner, 'answer after removal: secret', c1.id);
    const rows = await inbox(env, 'rita');
    eq(rows.length, 1, 'a removed collaborator got a new row');
    assert(!JSON.stringify(rows).includes('secret'), 'the words reached the removed collaborator');
    assert(!env.META.gets.some((k) => k === 'push-subs:rita' || k.startsWith('notify-email-off:rita')), `push or email looked up: ${env.META.gets.filter((k) => /rita/.test(k))}`);
  });

  await t('a reaction on a removed collaborator\'s comment tells them nothing', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: ['rita'] });
    const rita = await person(env, 'rita');
    const c = await comment(env, rita, 'my point');
    eq((await share(env, owner, { visibility: 'private', allowed_users: [] })).status, 200);
    const r = await call(env, '/api/reactions', { method: 'POST', cookie: owner, body: { slug: 'u-doc', comment_id: c.id, emoji: '👍', version: 1 } });
    eq(r.status, 200);
    eq((await inbox(env, 'rita')).length, 0);
  });

  await t('a member who left the team gets no reply row on a team-only doc; a member does', async () => {
    const env = makeEnv(mod.CommentsStore);
    const ann = await issue(worker, env, 'ann');
    const ben = await issue(worker, env, 'ben');
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { name: 'Acme' } })).body.team;
    eq((await call(env, '/api/team/join', { method: 'POST', cookie: ben.cookie, body: { token: team.invite_url.split('/').pop() } })).status, 200);
    eq((await call(env, '/api/upload', { method: 'POST', token: ann.token, body: { slug: 'team-plan', version: 1, html: PROSE } })).status, 200);
    eq((await call(env, '/api/team/move', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { team: team.id, slugs: ['team-plan'] } })).status, 200);
    eq((await call(env, '/api/doc/access', { method: 'PATCH', cookie: ann.cookie, headers: SAME_ORIGIN, body: { slug: 'team-plan', access: { visibility: 'private', team: true } } })).status, 200);
    const c = await comment(env, ben.cookie, 'member question', null, 'team-plan');
    await comment(env, ann.cookie, 'reply to a member', c.id, 'team-plan');
    eq((await inbox(env, 'ben')).length, 1, 'a member got no reply row');
    const left = await call(env, '/api/team/remove', { method: 'POST', cookie: ben.cookie, headers: SAME_ORIGIN, body: { id: team.id, account_id: ben.account_id } });
    eq(left.status, 200, left.text);
    await comment(env, ann.cookie, 'reply after ben left', c.id, 'team-plan');
    const rows = await inbox(env, 'ben');
    eq(rows.length, 1, 'a member who left got a new row');
    eq(rows[0].count || 1, 1, 'folded into the old row');
  });

  await t('an email-born owner still gets comment rows on their private doc; a GitHub user invited by address gets replies', async () => {
    const env = makeEnv(mod.CommentsStore);
    const email = 'olga@example.com';
    await env.META.put(`account-email:${email}`, JSON.stringify({ account_id: 'acct-olga', created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${hex('a')}`, JSON.stringify({ email, account_id: 'acct-olga', name: 'Olga', created: new Date().toISOString() }));
    const olga = `tdoc_sid=${hex('a')}`;
    const minted = await call(env, '/api/hosted/token', { method: 'POST', cookie: olga, body: { label: 'olga' } });
    assert(minted.status === 200, minted.text);
    eq((await call(env, '/api/upload', { method: 'POST', token: minted.body.token, body: { slug: 'u-doc', version: 1, html: PROSE } })).status, 200);
    eq((await share(env, olga, { visibility: 'private', allowed_users: ['gina@example.com'] })).status, 200);
    const gina = await person(env, 'gina', { email: 'gina@example.com' });
    const c = await comment(env, gina, 'a question for olga');
    const olgaRows = JSON.parse(await env.META.get(`inbox:email:${email}`) || '{"items":[]}').items;
    eq(olgaRows.map((i) => [i.kind, i.preview]), [['comment', 'a question for olga']], 'the email-born owner got no row');
    await comment(env, olga, 'an answer for gina', c.id);
    eq((await inbox(env, 'gina')).map((i) => [i.kind, i.preview]), [['reply', 'an answer for gina']], 'the email-invited GitHub user got no row');
  });

  await t('a mention still reaches a reader, who is looked up once', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: ['rita'] });
    const rita = await person(env, 'rita');
    const c = await comment(env, rita, 'question');
    env.META.gets.length = 0;
    // A reply to rita that also names her: she is told once (the mention).
    await comment(env, owner, '@rita here you go', c.id);
    const rows = await inbox(env, 'rita');
    eq(rows.map((i) => i.kind).sort(), ['mention'], `rows ${JSON.stringify(rows.map((i) => i.kind))}`);
    eq(env.META.gets.filter((k) => k === 'account-group:acct-rita').length, 1, 'rita looked up more than once');
  });

  await t('the author\'s account on the comment decides, not whoever holds the handle now', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: ['rita@example.com'] });
    const rita = await person(env, 'rita', { email: 'rita@example.com' });
    const c = await comment(env, rita, 'question from the first rita');
    // The handle now names someone else's account, with another address.
    await env.META.put('hosted-account:rita', JSON.stringify({ account_id: 'acct-rita2', github_login: 'rita', email: 'other@example.com', created: '2026-06-01T00:00:00.000Z' }));
    await env.META.put('account-group:acct-rita', JSON.stringify({ canonical: 'acct-rita', ids: ['acct-rita'], actor_keys: ['rita', 'email:rita@example.com'] }));
    await comment(env, owner, 'answer for the first rita', c.id);
    eq((await inbox(env, 'rita')).map((i) => i.preview), ['answer for the first rita'], 'the comment\'s own author was judged as the new handle holder');
  });

  await t('the owner @mentions someone new on a private doc: invited and told, even when KV still returns the record from before', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: [] });
    await person(env, 'nina');
    const before = await env.META.get('meta:u-doc');
    // KV is eventually consistent: reads of the record during this request
    // return it as it was before the invite was written.
    const get = env.META.get.bind(env.META);
    env.META.get = async (k) => (k === 'meta:u-doc' ? before : get(k));
    try {
      await comment(env, owner, '@nina can you look at this?');
    } finally { env.META.get = get; }
    assert(JSON.parse(await env.META.get('meta:u-doc')).access.allowed_users.includes('nina'), 'precondition: nina was invited');
    eq((await inbox(env, 'nina')).map((i) => i.kind), ['mention'], 'the invited person was not told');
  });

  await t('a team doc shared with nobody in the team: its admin (the owner) still gets comment and agent-reply rows', async () => {
    const env = makeEnv(mod.CommentsStore);
    const ann = await issue(worker, env, 'ann');
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { name: 'Acme' } })).body.team;
    eq((await call(env, '/api/upload', { method: 'POST', token: ann.token, body: { slug: 'team-plan', version: 1, html: PROSE } })).status, 200);
    eq((await call(env, '/api/team/move', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { team: team.id, slugs: ['team-plan'] } })).status, 200);
    const priv = await call(env, '/api/doc/access', { method: 'PATCH', cookie: ann.cookie, headers: SAME_ORIGIN, body: { slug: 'team-plan', access: { visibility: 'private', team: false, allowed_users: ['rita'] } } });
    eq(priv.status, 200, priv.text);
    const rita = await person(env, 'rita');
    const c = await comment(env, rita, 'outside question', null, 'team-plan');
    eq((await inbox(env, 'ann')).filter((i) => i.kind === 'comment').length, 1, 'the team admin got no comment row');
    const a = await call(env, '/api/agent/reply', { method: 'POST', token: ann.token, body: { slug: 'team-plan', parent_id: c.id, text: 'Agent answer.', status: 'answered', agent_login: 'claude' } });
    eq(a.status, 200, a.text);
    eq((await inbox(env, 'ann')).filter((i) => i.kind === 'agent_reply').length, 1, 'the team admin got no agent row');
  });

  await t('an author known by a GitHub id that no longer resolves is not matched by the bare handle', async () => {
    const { env, owner } = await seed({ visibility: 'private', allowed_users: ['rita'] });
    // Rita commented without an account: her record carries the attested id.
    await env.META.put(`session:${hex('e')}`, JSON.stringify({ login: 'rita', name: 'rita', idp: { provider: 'github', sub: '555' }, created: new Date().toISOString() }));
    const rita = `tdoc_sid=${hex('e')}`;
    const c = await comment(env, rita, 'question');
    const rec = JSON.parse(await env.META.get('meta:u-doc'));
    assert(rec, 'precondition: doc');
    await comment(env, owner, 'answer', c.id);
    eq((await inbox(env, 'rita')).length, 0, 'the bare handle matched the invite');
  });

  console.log('bell list and poll');

  await t('an access request is blank for someone who no longer manages the doc, and has no Approve to offer', async () => {
    const { env, owner } = await seed();
    const at = new Date(Date.now() - 60e3).toISOString();
    const rows = [
      { id: 'n_req', kind: 'access_request', group_key: 'access_request:u-doc:mallory', slug: 'u-doc', requester: 'mallory', actor: { login: 'mallory', name: 'Mallory' }, title: 'Plan', at, read: false, count: 1 },
      { id: 'n_req2', kind: 'access_request', group_key: 'access_request:u-doc:zed', slug: 'u-doc', requester: 'zed', actor: { login: 'zed', name: 'Zed' }, title: 'Plan', at, read: false, count: 1 },
    ];
    await env.META.put('inbox:owner', JSON.stringify({ items: [rows[0]] }));
    // Someone else (a former owner) still holds a request row for this doc.
    const exOwner = await person(env, 'exowner');
    await env.META.put('inbox:exowner', JSON.stringify({ items: [rows[1]] }));
    const mine = (await call(env, '/api/notifications', { cookie: owner })).body;
    eq([mine.items[0].title, mine.items[0].no_access, mine.unread], ['Plan', undefined, 1], 'the owner lost their request');
    const theirs = (await call(env, '/api/notifications', { cookie: exOwner })).body;
    eq([theirs.items[0].title, theirs.items[0].actor, theirs.items[0].requester, theirs.items[0].no_access, theirs.unread], ['', null, undefined, true, 0]);
  });

  await t('the unread poll reads at most 20 doc records a call, newest first', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await person(env, 'owner');
    const at = (i) => new Date(Date.now() - (i + 1) * 60e3).toISOString();
    // 60 unread rows on 60 different docs that do not exist.
    await env.META.put('inbox:owner', JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`, kind: 'comment', group_key: `comment:d${i}`, slug: `doc-${i}`, title: 't', preview: 'p', at: at(i), read: false, count: 1,
    })) }));
    env.META.gets.length = 0;
    const first = (await call(env, '/api/notifications/unread', { cookie: owner })).body.unread;
    const reads = env.META.gets.filter((k) => /^meta:doc-\d+$/.test(k));
    assert(reads.length <= 20, `${reads.length} doc reads on one poll`);
    eq(reads.slice().sort(), Array.from({ length: 20 }, (_, i) => `meta:doc-${i}`).sort(), 'not the newest rows\' docs');
    // The 20 checked are gone docs (not counted); the rest wait for later polls.
    eq(first, 40);
    const second = (await call(env, '/api/notifications/unread', { cookie: owner })).body.unread;
    eq(second, 20, 'the next poll did not move on to the next docs');
    eq((await call(env, '/api/notifications/unread', { cookie: owner })).body.unread, 0, 'the count did not settle');
  });

  await t('past the cap, polls keep moving on to docs never checked after earlier answers expire', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await person(env, 'owner');
    const at = (i) => new Date(Date.now() - (i + 1) * 60e3).toISOString();
    const created = new Date().toISOString();
    for (let i = 0; i < 50; i++) await env.META.put(`meta:pub-${i}`, JSON.stringify({ title: 't', slug: `pub-${i}`, created, versions: [{ n: 1, created }], hosted: { github_login: 'claire', owner_key: 'claire' }, access: { visibility: 'public' } }));
    await env.META.put('inbox:owner', JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, kind: 'comment', group_key: `comment:p${i}`, slug: `pub-${i}`, title: 't', preview: 'p', at: at(i), read: false, count: 1,
    })) }));
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const readsOf = async () => {
        env.META.gets.length = 0;
        await call(env, '/api/notifications/unread', { cookie: owner });
        return env.META.gets.filter((k) => /^meta:pub-\d+$/.test(k)).map((k) => Number(k.slice(9))).sort((a, b) => a - b);
      };
      eq(await readsOf(), Array.from({ length: 20 }, (_, i) => i));
      shift = 61e3; // every answer so far has expired
      eq(await readsOf(), Array.from({ length: 20 }, (_, i) => i + 20), 'the poll re-read the docs it had already checked');
      shift = 122e3;
      const third = await readsOf();
      assert([40, 41, 42, 43, 44, 45, 46, 47, 48, 49].every((n) => third.includes(n)), `docs 40-49 never reached: ${third}`);
    } finally { Date.now = realNow; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
