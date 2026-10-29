// Settings -> Delete account (self-serve). What goes at once (sessions,
// tokens, personal docs, teams, profile, the login and address resolving),
// what blocks it, who may ask (a browser session, same origin, never a token),
// that the same identity signing in again gets a fresh empty account, the
// 30-day purge (comments keep their words as "Deleted user") and the
// operator's restore inside the window.
//
// Run with: node test/account-delete.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const DAY = 24 * 60 * 60 * 1000;
const SAME = { Origin: 'https://tdoc.dev' };
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-secret', TDOC_EMAIL_ALIAS_SECRET: 'alias-secret' });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.clone().text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text, r };
  };
  const cron = (at) => worker.scheduled({ scheduledTime: at, cron: '23 * * * *' }, env, ctx);
  const session = async (fields) => {
    const id = hex();
    await env.META.put(`session:${id}`, JSON.stringify({ name: fields.login || fields.email, avatar_url: '', created: new Date().toISOString(), ...fields }));
    return `tdoc_sid=${id}`;
  };
  const publish = (who, slug, access = { visibility: 'public' }) => call('/api/upload', {
    method: 'POST', token: who.token,
    body: { slug, version: 1, html: `<h1>${slug}</h1><p>${slug} body text</p>`, meta: { title: `Title ${slug}`, access } },
  });
  const comment = async (cookie, slug, text) => {
    const r = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text, anchor: null } });
    assert(r.status === 200, `comment on ${slug}: ${r.status} ${r.text}`);
    return r.body;
  };
  const authorsOn = async (slug, opts) => {
    const r = await call(`/api/comments?slug=${slug}&version=all`, opts);
    assert(r.status === 200, `read comments ${slug}: ${r.status} ${r.text.slice(0, 200)}`);
    const list = Array.isArray(r.body) ? r.body : (r.body.comments || []);
    const out = [];
    for (const c of list) {
      out.push({ text: c.text, author: c.author });
      for (const rep of c.replies || []) out.push({ text: rep.text, author: rep.author });
    }
    return { out, raw: r.text };
  };
  const del = (cookie, confirm, headers = SAME) => call('/api/me/account/delete', { method: 'POST', cookie, headers, body: { confirm } });

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const zed = await issue(worker, env, 'zed');
  // A second, stamped session (signed in after the account existed) besides
  // the unstamped one `issue` made.
  const aliceStamped = await session({ login: 'alice', account_id: alice.account_id });

  console.log('account delete: who may ask');

  await t('GET says what to type and that nothing blocks', async () => {
    const r = await call('/api/me/account/delete', { cookie: alice.cookie });
    assert(r.status === 200 && r.body.confirm === 'alice' && r.body.confirm_kind === 'login', `${r.status} ${r.text}`);
    assert(Array.isArray(r.body.blockers) && r.body.blockers.length === 0, r.text);
    assert(r.body.retention_days === 30, r.text);
  });

  await t('refused for a Bearer account token, even beside a session cookie', async () => {
    const r = await call('/api/me/account/delete', { method: 'POST', token: alice.token, headers: SAME, body: { confirm: 'alice' } });
    assert(r.status === 403 && r.body.error === 'browser_session_only', `${r.status} ${r.text}`);
    const both = await call('/api/me/account/delete', { method: 'POST', token: alice.token, cookie: alice.cookie, headers: SAME, body: { confirm: 'alice' } });
    assert(both.status === 403, `cookie + token: ${both.status}`);
    const get = await call('/api/me/account/delete', { token: alice.token });
    assert(get.status === 403, `GET with a token: ${get.status}`);
  });

  await t('refused cross-site: another Origin, no Origin, Sec-Fetch-Site cross-site', async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, {}, { Origin: 'https://tdoc.dev', 'Sec-Fetch-Site': 'cross-site' }]) {
      const r = await del(alice.cookie, 'alice', headers);
      assert(r.status === 403 && r.body.error === 'cross_origin', `${JSON.stringify(headers)}: ${r.status} ${r.text}`);
    }
    assert(await env.META.get(`hosted-account:alice`), 'nothing happened');
  });

  await t('the typed confirmation must be the login', async () => {
    for (const typed of ['', 'alic', 'bob', 'delete']) {
      const r = await del(alice.cookie, typed);
      assert(r.status === 400 && r.body.error === 'confirm_mismatch' && /alice/.test(r.body.message), `${typed}: ${r.status} ${r.text}`);
    }
  });

  await t('no account: nothing to delete (and no account is minted asking)', async () => {
    const spectator = await session({ login: 'nobody' });
    const r = await call('/api/me/account/delete', { cookie: spectator });
    assert(r.status === 404 && r.body.error === 'account_required', `${r.status} ${r.text}`);
    assert(!(await env.META.get('hosted-account:nobody')), 'asking minted an account');
    const anon = await call('/api/me/account/delete', { method: 'POST', headers: SAME, body: { confirm: 'x' } });
    assert(anon.status === 401, `anonymous: ${anon.status}`);
  });

  console.log('account delete: blockers');

  // Acme: alice (admin) + bob (member). Solo: alice alone. Paid: alice and
  // zed, both admins, with a live subscription.
  const mkTeam = async (cookie, name) => (await call('/api/teams', { method: 'POST', cookie, headers: SAME, body: { name } })).body.team;
  const acme = await mkTeam(alice.cookie, 'Acme');
  const solo = await mkTeam(alice.cookie, 'Solo');
  const join = async (who, team) => {
    const r = await call('/api/team/join', { method: 'POST', cookie: who.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(r.status === 200, `join ${team.name}: ${r.status} ${r.text}`);
  };
  await join(bob, acme);

  await t('sole admin of a team with other members: refused, with a link to the team', async () => {
    const pre = await call('/api/me/account/delete', { cookie: alice.cookie });
    const b = pre.body.blockers.find((x) => x.kind === 'sole_admin');
    assert(b && b.team.id === acme.id && b.url === `/me?team=${acme.id}&view=settings` && /only admin of Acme/.test(b.message), pre.text);
    assert(pre.body.teams_deleted.some((x) => x.id === solo.id), 'Solo goes with the account');
    const r = await del(alice.cookie, 'alice');
    assert(r.status === 409 && r.body.error === 'blocked' && r.body.blockers[0].kind === 'sole_admin', `${r.status} ${r.text}`);
    assert(await env.META.get('hosted-account:alice'), 'nothing happened');
  });

  const paid = await mkTeam(zed.cookie, 'Paid');
  await join(alice, paid);
  await t('admin of a team with a live subscription: refused until it is cancelled', async () => {
    const t1 = JSON.parse(await env.META.get(`team:${paid.id}`));
    t1.members.find((m) => m.account_id === alice.account_id).role = 'admin';
    await env.META.put(`team:${paid.id}`, JSON.stringify(t1));
    await env.META.put(`team-billing:${paid.id}`, JSON.stringify({ status: 'active', customer: 'cus_1', subscription: 'sub_1' }));
    const pre = await call('/api/me/account/delete', { cookie: alice.cookie });
    const b = pre.body.blockers.find((x) => x.kind === 'paid_team');
    assert(b && b.team.id === paid.id && b.url.endsWith('#billing') && /paid subscription/.test(b.message), pre.text);
    assert(!pre.body.blockers.some((x) => x.kind === 'sole_admin' && x.team.id === paid.id), 'zed is admin too');
    await env.META.put(`team-billing:${paid.id}`, JSON.stringify({ status: 'canceled', customer: 'cus_1' }));
    const after = await call('/api/me/account/delete', { cookie: alice.cookie });
    assert(!after.body.blockers.some((x) => x.kind === 'paid_team'), 'cancelled no longer blocks');
  });

  // Unblock Acme: bob becomes admin too.
  assert((await call('/api/team/role', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { id: acme.id, account_id: bob.account_id, role: 'admin' } })).status === 200, 'promote bob');

  // What alice has: two personal docs, a doc in Acme and one in Solo, a
  // comment on bob's doc, a star, a public profile, an AI-app grant, a team
  // agent she added in Acme and one in Solo, and a pairing approved but not
  // yet collected.
  assert((await publish(alice, 'alice-plan')).status === 200, 'publish alice-plan');
  assert((await publish(alice, 'alice-notes', { visibility: 'private' })).status === 200, 'publish alice-notes');
  assert((await publish(alice, 'acme-doc')).status === 200, 'publish acme-doc');
  assert((await call('/api/team/move', { method: 'POST', token: alice.token, body: { team: acme.id, slugs: ['acme-doc'] } })).status === 200, 'move acme-doc');
  assert((await publish(alice, 'solo-doc')).status === 200, 'publish solo-doc');
  assert((await call('/api/team/move', { method: 'POST', token: alice.token, body: { team: solo.id, slugs: ['solo-doc'] } })).status === 200, 'move solo-doc');
  assert((await publish(bob, 'bob-doc', { visibility: 'public', allowed_users: ['carol@example.com'] })).status === 200, 'publish bob-doc');
  await comment(alice.cookie, 'bob-doc', 'Alice was here.');
  assert((await call('/api/star', { method: 'POST', cookie: alice.cookie, body: { slug: 'bob-doc', starred: true } })).status === 200, 'star');
  assert((await call('/api/me/handle', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { handle: 'alice' } })).status === 200, 'claim handle');
  assert((await call('/@alice', { headers: { Accept: 'application/json' } })).status === 200, 'profile before');
  const grantId = 'a'.repeat(32);
  const oauthHash = 'b'.repeat(64);
  await env.META.put(`hosted-token:${oauthHash}`, JSON.stringify({
    account_id: alice.account_id, github_login: 'alice', created: new Date().toISOString(),
    oauth: { client_id: 'c', client_name: 'Claude', grant_id: grantId, granted_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() },
  }), { metadata: { account_id: alice.account_id } });
  const addAgent = async (team) => {
    const added = await call('/api/team/agents', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { id: team.id, name: 'bot' } });
    assert(added.status === 200, `add agent ${added.status} ${added.text}`);
    const connected = await call('/api/team/agents/connect', { method: 'POST', body: { code: added.body.setup_code, device: 'box' } });
    assert(connected.status === 200 && connected.body.token, `connect ${connected.text}`);
    return connected.body.token;
  };
  const acmeAgent = await addAgent(acme);
  const soloAgent = await addAgent(solo);
  await env.META.put('pair:ABCDEFGH', JSON.stringify({
    status: 'approved', secret_hash: await (async () => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pairsecret')); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); })(),
    label: 'laptop', created: new Date().toISOString(),
    approved: { login: 'alice', name: 'alice', email: null, at: new Date().toISOString() },
  }));
  await t('refused for a workspace-scoped agent token and a team agent token', async () => {
    const scoped = await call('/api/hosted/token/scoped', { method: 'POST', token: alice.token, body: { workspaces: ['me'], label: 'bot' } });
    assert(scoped.status === 200 && scoped.body.token, `scoped mint: ${scoped.status} ${scoped.text}`);
    for (const token of [scoped.body.token, acmeAgent]) {
      const r = await call('/api/me/account/delete', { method: 'POST', token, headers: SAME, body: { confirm: 'alice' } });
      assert(r.status === 403, `${token.slice(0, 8)}: ${r.status} ${r.text}`);
    }
    assert(await env.META.get('hosted-account:alice'), 'nothing happened');
  });
  // Old sessions, both kinds, are live before.
  for (const c of [alice.cookie, aliceStamped]) assert((await call('/api/me/account/delete', { cookie: c })).status === 200, 'session live before');

  console.log('account delete: what goes at once');

  let deleted = null;
  await t('POST deletes: 200, cookie cleared, when it will be erased', async () => {
    const r = await del(aliceStamped, 'ALICE');
    assert(r.status === 200 && r.body.ok, `${r.status} ${r.text}`);
    deleted = r.body;
    assert(Math.abs(Date.parse(r.body.purge_at) - Date.parse(r.body.deleted_at) - 30 * DAY) < 1000, 'purge 30 days out');
    assert(/tdoc_sid=;.*Max-Age=0/.test(r.r.headers.get('set-cookie') || ''), 'cookie cleared');
    assert(r.body.teams_deleted.some((x) => x.id === solo.id) && r.body.teams_left.some((x) => x.id === acme.id) && r.body.teams_left.some((x) => x.id === paid.id), r.text);
  });

  await t('signed out everywhere: stamped and unstamped sessions both end', async () => {
    for (const c of [alice.cookie, aliceStamped]) {
      const r = await call('/api/me/sign-in-methods', { cookie: c });
      assert(r.status === 401, `session still works: ${r.status} ${r.text}`);
    }
  });

  await t('every token is revoked: account, AI-app grant (with tombstone); a pairing approved before cannot be collected', async () => {
    const who = await call('/api/hosted/whoami', { token: alice.token });
    assert(who.status === 401, `account token: ${who.status} ${who.text}`);
    assert(!(await env.META.get(`hosted-token:${oauthHash}`)), 'oauth token record gone');
    assert(await env.META.get(`oauth-grant-revoked:${grantId}`), 'grant tombstone written');
    assert(await env.META.get(`oauth-revoked-before:${alice.account_id}`), 'account-wide OAuth cut-off written');
    assert(![...env.META.map.entries()].some(([k, v]) => k.startsWith('hosted-token:') && v.includes(alice.account_id)), 'no token of the account left');
    const poll = await call('/api/cli/pair/poll', { method: 'POST', body: { user_code: 'ABCD-EFGH', pair_secret: 'pairsecret' } });
    assert(poll.status === 400 && poll.body.error === 'expired_token' && !poll.body.token, `pair poll: ${poll.status} ${poll.text}`);
  });

  await t('a token minted for the account after the sweep (racing it) is refused too', async () => {
    const h = 'c'.repeat(64);
    await env.META.put(`hosted-token:${h}`, JSON.stringify({ account_id: alice.account_id, github_login: 'alice', created: new Date().toISOString() }));
    const raw = 'tdoc_racing';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`hosted-token:${hash}`, JSON.stringify({ account_id: alice.account_id, github_login: 'alice', created: new Date().toISOString() }));
    const r = await call('/api/hosted/whoami', { token: raw });
    assert(r.status === 401, `racing token: ${r.status}`);
  });

  await t('team agents: the one in a team that lives on keeps working, the deleted team\'s does not', async () => {
    const live = await call('/api/teams', { token: acmeAgent });
    assert(live.status === 200, `acme agent: ${live.status} ${live.text}`);
    const dead = await call('/api/teams', { token: soloAgent });
    assert(dead.status === 401, `solo agent: ${dead.status}`);
  });

  await t('personal docs go to Trash, unreadable; the solo team and its docs go; Acme keeps its doc', async () => {
    for (const slug of ['alice-plan', 'alice-notes', 'solo-doc']) {
      const rec = JSON.parse(await env.META.get(`meta:${slug}`));
      assert(rec.trashed_at && rec.account_deleted_at === deleted.deleted_at, `${slug} ${JSON.stringify(rec).slice(0, 200)}`);
      const page = await call(`/d/${slug}`, { cookie: bob.cookie });
      assert(page.status === 302 && page.r.headers.get('location') === '/?notice=notfound', `${slug}: ${page.status}`);
      const raw = await call(`/d/${slug}/raw`, { token: 'admin-secret' });
      assert(raw.status === 404, `${slug} raw: ${raw.status}`);
    }
    assert(!(await env.META.get(`team:${solo.id}`)), 'solo team record gone');
    const acmeDoc = JSON.parse(await env.META.get('meta:acme-doc'));
    assert(!acmeDoc.trashed_at && acmeDoc.workspace_id === acme.id, 'acme doc stays with the team');
    assert((await call('/d/acme-doc', { cookie: bob.cookie })).status === 200, 'bob still reads the team doc');
  });

  await t('removed from team member lists', async () => {
    const team = JSON.parse(await env.META.get(`team:${acme.id}`));
    assert(!team.members.some((m) => m.account_id === alice.account_id) && team.members.length === 1, JSON.stringify(team.members));
    const paidTeam = JSON.parse(await env.META.get(`team:${paid.id}`));
    assert(!paidTeam.members.some((m) => m.account_id === alice.account_id), 'left Paid');
  });

  await t('profile page and handle are gone; login and handle no longer resolve', async () => {
    const r = await call('/@alice', { headers: { Accept: 'application/json' } });
    assert(r.status === 404 || !r.text.includes('alice-plan'), `profile: ${r.status} ${r.text.slice(0, 120)}`);
    for (const k of ['hosted-account:alice', 'hosted-handle:alice', `account-profile:${alice.account_id}`, `account-teams:${alice.account_id}`, 'stars:alice']) {
      assert(!(await env.META.get(k)), `${k} still there`);
    }
    const rec = JSON.parse(await env.META.get(`account-deleted:${alice.account_id}`));
    assert(rec.deleted_at === deleted.deleted_at && rec.ids.includes(alice.account_id), 'deleted_at recorded');
  });

  // An email-only account (carol), whose address bob invited: bob sees it
  // next to her comment until she deletes her account.
  const carolCookie = await session({ email: 'carol@example.com', name: 'Carol', oidc: true });
  assert((await call('/api/me/handle', { method: 'POST', cookie: carolCookie, headers: SAME, body: { handle: 'carol-c' } })).status === 200, 'carol gets an account');
  await comment(carolCookie, 'bob-doc', 'Carol says hi.');

  await t('an email account confirms with its address, and its address stops showing at once', async () => {
    const before = await authorsOn('bob-doc', { cookie: bob.cookie });
    assert(before.raw.includes('carol@example.com'), 'bob (who invited her) sees the address before');
    const pre = await call('/api/me/account/delete', { cookie: carolCookie });
    assert(pre.body.confirm === 'carol@example.com' && pre.body.confirm_kind === 'email', pre.text);
    assert((await del(carolCookie, 'carol')).status === 400, 'the local part is not the address');
    const r = await del(carolCookie, 'Carol@Example.com');
    assert(r.status === 200, `${r.status} ${r.text}`);
    const after = await authorsOn('bob-doc', { cookie: bob.cookie });
    assert(!after.raw.includes('carol@example.com'), `address still shown: ${after.raw.slice(0, 300)}`);
    assert(!(await env.META.get('account-email:carol@example.com')), 'address no longer resolves');
  });

  console.log('account delete: the same identity again');

  let fresh = null;
  await t('signing in again with the same login gets a fresh, empty account', async () => {
    await new Promise((r) => setTimeout(r, 5));
    const cookie = await session({ login: 'alice' });
    const me = await call('/api/me/account/delete', { cookie });
    assert(me.status === 404, `no account until something is created: ${me.status} ${me.text}`);
    const h = await call('/api/me/handle', { method: 'POST', cookie, headers: SAME, body: { handle: 'alice' } });
    assert(h.status === 200, `claim: ${h.status} ${h.text}`);
    const rec = JSON.parse(await env.META.get('hosted-account:alice'));
    assert(rec.account_id !== alice.account_id, 'same account came back');
    fresh = { cookie, account_id: rec.account_id };
    const hub = await call('/api/me', { cookie });
    assert(hub.status === 200, `hub ${hub.status}`);
    for (const slug of ['alice-plan', 'alice-notes', 'solo-doc', 'acme-doc']) assert(!hub.text.includes(slug), `fresh account lists ${slug}`);
    assert(!hub.text.includes(acme.id) && !hub.text.includes(solo.id), 'fresh account is in no team');
    const trash = await call('/api/trash', { cookie });
    assert(trash.status === 200 && !trash.text.includes('alice-plan'), `trash: ${trash.text.slice(0, 200)}`);
    const restore = await call('/api/trash/restore', { method: 'POST', cookie, headers: SAME, body: { slug: 'alice-plan' } });
    assert(restore.status >= 400 && restore.status < 500, `restored the old doc: ${restore.status}`);
    assert(JSON.parse(await env.META.get('meta:alice-plan')).trashed_at, 'old doc stays in Trash');
    const stars = await call('/api/me', { cookie });
    assert(!/"starred":\s*\[\s*\{/.test(stars.text) || !stars.text.includes('bob-doc'), 'old stars came back');
    // The old sessions stay dead even though the login resolves again.
    assert((await call('/api/me/sign-in-methods', { cookie: alice.cookie })).status === 401, 'old unstamped session revived');
    await comment(cookie, 'bob-doc', 'New alice, after.');
  });

  console.log('account delete: the purge, 30 days later');

  await t('the scheduled run before the window ends changes nothing', async () => {
    await cron(Date.parse(deleted.deleted_at) + 29 * DAY);
    assert(await env.META.get(`account-deleted:${alice.account_id}`), 'purged early');
    assert(await env.META.get('meta:alice-plan'), 'doc purged early');
  });

  await t('after 30 days: docs erased, comments anonymized (words kept), record and stash gone', async () => {
    for (let i = 0; i < 5; i++) await cron(Date.parse(deleted.deleted_at) + 31 * DAY);
    for (const slug of ['alice-plan', 'alice-notes', 'solo-doc']) assert(!(await env.META.get(`meta:${slug}`)), `${slug} not purged`);
    assert(!(await env.META.get(`account-deleted:${alice.account_id}`)), 'record not purged');
    assert(!(await env.META.get(`account-deleted-stash:${alice.account_id}`)), 'stash not purged');
    assert(!(await env.META.get('account-deleted-identity:alice')), 'identity tombstone not purged');
    const marker = JSON.parse(await env.META.get(`account-group:${alice.account_id}`));
    assert(marker.deleted_at && marker.purged_at && !JSON.stringify(marker).includes('alice@'), JSON.stringify(marker));
    const { out, raw } = await authorsOn('bob-doc', { cookie: bob.cookie });
    const old = out.find((c) => c.text === 'Alice was here.');
    assert(old && old.author.name === 'Deleted user' && !old.author.login && !old.author.avatar_url, JSON.stringify(old));
    const carol = out.find((c) => c.text === 'Carol says hi.');
    assert(carol && carol.author.name === 'Deleted user' && !carol.author.login, JSON.stringify(carol));
    assert(!raw.includes('carol@example.com') && !raw.includes('"Carol"'), 'carol\'s name or address left');
    const after = out.find((c) => c.text === 'New alice, after.');
    assert(after && after.author.login === 'alice', `the new account's comment was anonymized: ${JSON.stringify(after)}`);
  });

  await t('restore after the purge is refused', async () => {
    const r = await call('/api/admin/account/restore', { method: 'POST', token: 'admin-secret', body: { account_id: alice.account_id } });
    assert(r.status === 404, `${r.status} ${r.text}`);
  });

  console.log('account delete: operator restore inside the window');

  await t('an operator restores: docs, login and profile come back to the same account; old sessions stay ended', async () => {
    const dave = await issue(worker, env, 'dave');
    assert((await publish(dave, 'dave-doc')).status === 200, 'publish dave-doc');
    assert((await call('/api/me/handle', { method: 'POST', cookie: dave.cookie, headers: SAME, body: { handle: 'dave' } })).status === 200, 'handle');
    assert((await del(dave.cookie, 'dave')).status === 200, 'delete dave');
    const notAdmin = await call('/api/admin/account/restore', { method: 'POST', token: bob.token, body: { login: 'dave' } });
    assert(notAdmin.status === 403, `a person restored: ${notAdmin.status}`);
    const r = await call('/api/admin/account/restore', { method: 'POST', token: 'admin-secret', body: { login: 'dave' } });
    assert(r.status === 200 && r.body.account_id === dave.account_id && r.body.docs.includes('dave-doc'), `${r.status} ${r.text}`);
    const rec = JSON.parse(await env.META.get('hosted-account:dave'));
    assert(rec.account_id === dave.account_id, 'login resolves to the same account');
    const meta = JSON.parse(await env.META.get('meta:dave-doc'));
    assert(!meta.trashed_at && !meta.account_deleted_at, 'doc back');
    assert((await call('/d/dave-doc')).status === 200, 'doc readable');
    assert((await call('/api/me/sign-in-methods', { cookie: dave.cookie })).status === 401, 'old session revived');
    const again = await session({ login: 'dave' });
    const hub = await call('/api/me', { cookie: again });
    assert(hub.text.includes('dave-doc'), 'signing in again finds the restored docs');
    assert(!(await env.META.get(`account-deleted:${dave.account_id}`)), 'record cleared');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
