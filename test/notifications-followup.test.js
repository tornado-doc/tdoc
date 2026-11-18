// Bell follow-ups to #1083 (Julie's calls, 2026-11-18). Real worker routes:
//  - an agent's reply is a quiet bell row for the doc's owner and the people
//    in the thread who can still read the doc: one row per doc, never pushed
//    or emailed, one inbox write per person per request (no rate counter),
//    none past AGENT_REPLY_ROW_CAP; seeing the threads reads it, reading it
//    marks them seen; Needs you's "done" for a doc reads it too;
//  - a row on a doc the person can no longer read keeps no title or words;
//  - an unread row older than 30 days neither counts nor shows as unread,
//    and stays in the list; a new event starts its own row beside it;
//  - equal times page the same way every time, each row once;
//  - ?filter=unread (Needs you) is comment, reply and mention rows only, so
//    reactions and access requests do not eat its pages;
//  - the client keeps a row once when a page repeats it (appendUnique), and
//    an agent reply reads "replied".
// Run with: node test/notifications-followup.test.js

const path = require('path');
const { pathToFileURL } = require('url');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';
const SAME_ORIGIN = { Origin: 'https://tdoc.dev' };
const DAY = 864e5;

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

(async () => {
  console.log('Bell follow-ups: agent replies, aged unread, paging');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  // A signed-in person with an account behind them (an attested author).
  const person = async (env, login) => {
    const sid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${sid}`, JSON.stringify({ login, account_id: `acct-${login}`, name: login, avatar_url: '', created: new Date().toISOString() }));
    return sid;
  };
  async function seed(rows = []) {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await person(env, 'owner');
    const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'u-doc', version: 1, html: PROSE } });
    assert(up.status === 200, `upload: ${up.status} ${up.text}`);
    const a = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug: 'u-doc', access: { visibility: 'unlisted' } } });
    assert(a.status === 200, `access: ${a.status}`);
    if (rows.length) await env.META.put('inbox:owner', JSON.stringify({ items: rows }));
    return { env, owner, token: tok.token, reader: await person(env, 'reader') };
  }
  const comment = async (env, cookie, text, parent_id) => {
    const body = parent_id ? { slug: 'u-doc', version: 1, parent_id, text } : { slug: 'u-doc', version: 1, text, anchor: { kind: 'text', text: 'A sentence' } };
    const r = await call(env, '/api/comments', { method: 'POST', cookie, body });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body;
  };
  const agentReply = async (env, token, parent_id, text) => {
    const r = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'u-doc', parent_id, text, status: 'answered', agent_login: 'claude' } });
    assert(r.status === 200, `agent reply ${r.status} ${r.text}`);
    return r.body;
  };
  const bell = async (env, cookie, query = '') => {
    const r = await call(env, `/api/notifications${query}`, { cookie });
    assert(r.status === 200, `bell ${r.status} ${r.text}`);
    return r.body;
  };
  const agentRows = async (env, cookie) => (await bell(env, cookie)).items.filter((i) => i.kind === 'agent_reply');
  const row = (id, kind, at, extra = {}) => ({ id, kind, group_key: `${kind}:${id}`, slug: 'u-doc', version: 1, comment_id: `c_${id}`, thread_id: `c_${id}`,
    actor: { login: 'claire', name: 'Claire' }, preview: 'p', title: 'Plan', at, read: false, count: 1, ...extra });

  console.log('agent replies');

  await t('an agent reply is a quiet row for the owner and the people in the thread, never the agent; no push or email is looked up', async () => {
    const { env, owner, reader, token } = await seed();
    const c = await comment(env, reader, 'Can the agent check the numbers?');
    // A push subscription exists. Two guards keep the row quiet: its kind is
    // in neither PUSH_KINDS nor EMAIL_NOTIFY_KINDS, and writeInboxEvent stops
    // at `quiet` before either is looked at.
    await env.META.put('push-subs:owner', JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: {} }]));
    env.META.gets.length = 0;
    const reply = await agentReply(env, token, c.id, 'The Q3 numbers are right.');
    assert(!env.META.gets.some((k) => k.startsWith('push-subs:') || k.startsWith('notify-email')), `looked up: ${env.META.gets.filter((k) => /push|email/.test(k))}`);
    for (const [who, cookie] of [['owner', owner], ['reader', reader]]) {
      const rows = await agentRows(env, cookie);
      eq(rows.length, 1, `${who}: agent rows`);
      const r = rows[0];
      eq([r.read, r.quiet, r.thread_id, r.comment_id, r.preview], [false, true, c.id, reply.id, 'The Q3 numbers are right.'], who);
      eq(r.actor.kind, 'agent');
      assert(!JSON.stringify(r.actor).includes('@'), `an address in the actor: ${JSON.stringify(r.actor)}`);
    }
    // It counts in the bell, and sits at the top.
    const page = await bell(env, owner);
    eq(page.items[0].kind, 'agent_reply');
    assert(page.unread >= 1);
  });

  await t('agent replies on one doc are one row across threads (count 3); it is read once every thread is seen', async () => {
    const { env, owner, token } = await seed();
    const c1 = await comment(env, owner, 'first');
    const c2 = await comment(env, owner, 'second');
    const a1 = await agentReply(env, token, c1.id, 'one');
    await comment(env, owner, 'and?', c1.id);
    const a2 = await agentReply(env, token, c1.id, 'two');
    const a3 = await agentReply(env, token, c2.id, 'three');
    let rows = await agentRows(env, owner);
    eq(rows.map((r) => [r.count, r.preview, r.thread_id]), [[3, 'three', c2.id]]);
    eq(Object.keys(rows[0].thread_at).sort(), [c1.id, c2.id].sort());
    const see = (id, at) => call(env, '/api/comments/seen', { method: 'POST', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc', seen: { [id]: Date.parse(at) } } });
    await see(c2.id, a3.created);
    eq((await agentRows(env, owner))[0].read, false, 'one thread seen read the whole doc row');
    await see(c1.id, a2.created);
    rows = await agentRows(env, owner);
    eq(rows[0].read, true, 'every thread seen, the row is still unread');
    assert(a1, 'first reply');
  });

  await t('one agent reply: one inbox write per person, no rate-limit counter write', async () => {
    const { env, owner, reader, token } = await seed();
    const c = await comment(env, reader, 'question');
    const puts = [];
    const put = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { puts.push(k); return put(k, v, o); };
    await agentReply(env, token, c.id, 'answer');
    env.META.put = put;
    eq(puts.filter((k) => k === 'inbox:owner').length, 1, `owner inbox writes: ${puts}`);
    eq(puts.filter((k) => k === 'inbox:reader').length, 1, `reader inbox writes: ${puts}`);
    assert(!puts.some((k) => k.startsWith('rl:agent-bell')), `a bell rate counter was written: ${puts}`);
    assert((await agentRows(env, owner)).length === 1 && (await agentRows(env, reader)).length === 1);
  });

  await t('past the cap a doc\'s agent row is not written again until it is read', async () => {
    const at = new Date(Date.now() - 60e3).toISOString();
    const { env, owner, token } = await seed([
      { ...row('n_agent', 'agent_reply', at), group_key: 'agent_reply:u-doc', count: 99, quiet: true, actor: { kind: 'agent', name: 'Claude Code' } },
    ]);
    const c = await comment(env, owner, 'mine');
    const before = await env.META.get('inbox:owner');
    await agentReply(env, token, c.id, 'one more');
    eq(await env.META.get('inbox:owner'), before, 'a capped row was written');
    // Read, the next reply starts a new row.
    await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, headers: SAME_ORIGIN, body: { ids: ['n_agent'] } });
    // (An agent answers once per human turn.)
    await comment(env, owner, 'and?', c.id);
    await agentReply(env, token, c.id, 'and another');
    const rows = await agentRows(env, owner);
    eq(rows.map((r) => [r.count, r.read]), [[1, false], [99, true]]);
  });

  await t('Needs you\'s done for a doc (slug) reads its agent row too', async () => {
    const { env, owner, token } = await seed();
    const c = await comment(env, owner, 'mine');
    await agentReply(env, token, c.id, 'answer');
    const r = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc' } });
    assert(r.status === 200, `read ${r.status}`);
    eq((await agentRows(env, owner))[0].read, true);
  });

  console.log('access');

  await t('a collaborator removed from a private doc gets no agent row; the owner still does', async () => {
    const { env, owner, reader, token } = await seed();
    const share = (allowed) => call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug: 'u-doc', access: { visibility: 'private', allowed_users: allowed } } });
    eq((await share(['reader'])).status, 200);
    const c = await comment(env, reader, 'invited question');
    eq((await share([])).status, 200);
    await agentReply(env, token, c.id, 'The secret answer.');
    eq((await agentRows(env, reader)).length, 0, 'a removed collaborator got the reply');
    eq((await agentRows(env, owner)).length, 1);
  });

  await t('a member who left the team gets no agent row on a team doc; while a member they did', async () => {
    const env = makeEnv(mod.CommentsStore);
    const ann = await issue(worker, env, 'ann');
    const ben = await issue(worker, env, 'ben');
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { name: 'Acme' } })).body.team;
    const joined = await call(env, '/api/team/join', { method: 'POST', cookie: ben.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(joined.status === 200, `join: ${joined.text}`);
    const up = await call(env, '/api/upload', { method: 'POST', token: ann.token, body: { slug: 'team-plan', version: 1, html: PROSE } });
    assert(up.status === 200, `upload ${up.text}`);
    const moved = await call(env, '/api/team/move', { method: 'POST', cookie: ann.cookie, headers: SAME_ORIGIN, body: { team: team.id, slugs: ['team-plan'] } });
    assert(moved.status === 200, `move ${moved.text}`);
    // Team only: the members read it, nobody else.
    const priv = await call(env, '/api/doc/access', { method: 'PATCH', cookie: ann.cookie, headers: SAME_ORIGIN, body: { slug: 'team-plan', access: { visibility: 'private', team: true } } });
    assert(priv.status === 200, `access ${priv.status} ${priv.text}`);
    const say = async (cookie, text, parent_id) => {
      const body = parent_id ? { slug: 'team-plan', version: 1, parent_id, text } : { slug: 'team-plan', version: 1, text, anchor: { kind: 'text', text: 'A sentence' } };
      const r = await call(env, '/api/comments', { method: 'POST', cookie, body });
      assert(r.status === 200, `comment ${r.status} ${r.text}`);
      return r.body;
    };
    const reply = async (parent_id, text) => {
      const r = await call(env, '/api/agent/reply', { method: 'POST', token: ann.token, body: { slug: 'team-plan', parent_id, text, status: 'answered', agent_login: 'claude' } });
      assert(r.status === 200, `agent reply ${r.status} ${r.text}`);
    };
    const benRows = async () => (await bell(env, ben.cookie)).items.filter((i) => i.kind === 'agent_reply');
    const c = await say(ben.cookie, 'member question');
    await reply(c.id, 'first answer');
    eq((await benRows()).length, 1, 'a member got no row');
    await call(env, '/api/notifications/read', { method: 'POST', cookie: ben.cookie, headers: SAME_ORIGIN, body: { all: true } });
    const left = await call(env, '/api/team/remove', { method: 'POST', cookie: ben.cookie, headers: SAME_ORIGIN, body: { id: team.id, account_id: ben.account_id } });
    assert(left.status === 200, `leave ${left.status} ${left.text}`);
    await say(ann.cookie, 'and?', c.id);
    await reply(c.id, 'second answer, after ben left');
    const rows = await benRows();
    eq(rows.map((r) => [r.count, r.read]), [[1, true]], 'a member who left got a new row');
    // And the old row no longer carries the doc's title or words.
    eq([rows[0].title, rows[0].preview, rows[0].no_access], ['', '', true]);
  });

  await t('an email-born owner gets agent rows on their own private doc', async () => {
    const env = makeEnv(mod.CommentsStore);
    const email = 'olga@example.com';
    await env.META.put(`account-email:${email}`, JSON.stringify({ account_id: 'acct-olga', created: '2026-01-01T00:00:00.000Z' }));
    const sid = 'ab'.repeat(16);
    await env.META.put(`session:${sid}`, JSON.stringify({ email, account_id: 'acct-olga', name: 'Olga', created: new Date().toISOString() }));
    const olga = `tdoc_sid=${sid}`;
    const minted = await call(env, '/api/hosted/token', { method: 'POST', cookie: olga, body: { label: 'olga' } });
    assert(minted.status === 200 && minted.body.token, `token ${minted.status} ${minted.text}`);
    const up = await call(env, '/api/upload', { method: 'POST', token: minted.body.token, body: { slug: 'olga-doc', version: 1, html: PROSE } });
    assert(up.status === 200, `upload ${up.status} ${up.text}`);
    const meta = JSON.parse(await env.META.get('meta:olga-doc'));
    assert(!meta.hosted.github_login, `precondition: no GitHub login on the doc: ${JSON.stringify(meta.hosted)}`);
    const priv = await call(env, '/api/doc/access', { method: 'PATCH', cookie: olga, headers: SAME_ORIGIN, body: { slug: 'olga-doc', access: { visibility: 'private' } } });
    assert(priv.status === 200, `access ${priv.status} ${priv.text}`);
    const c = await call(env, '/api/comments', { method: 'POST', cookie: olga, body: { slug: 'olga-doc', version: 1, text: 'check this', anchor: { kind: 'text', text: 'A sentence' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    const r = await call(env, '/api/agent/reply', { method: 'POST', token: minted.body.token, body: { slug: 'olga-doc', parent_id: c.body.id, text: 'Checked.', status: 'answered', agent_login: 'claude' } });
    assert(r.status === 200, `agent reply ${r.status} ${r.text}`);
    const rows = (await bell(env, olga)).items.filter((i) => i.kind === 'agent_reply');
    eq(rows.map((i) => [i.slug, i.preview, i.read, !!i.no_access]), [['olga-doc', 'Checked.', false, false]], 'the owner got no row');
  });

  await t('a GitHub user invited by email address gets agent rows', async () => {
    const { env, owner, token } = await seed();
    // Gina signs in with GitHub; her account's address is the one invited.
    const sid = 'cd'.repeat(16);
    await env.META.put('hosted-account:gina', JSON.stringify({ account_id: 'acct-gina', github_login: 'gina', email: 'gina@example.com', created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${sid}`, JSON.stringify({ login: 'gina', email: 'gina@example.com', account_id: 'acct-gina', name: 'Gina', created: new Date().toISOString() }));
    const gina = `tdoc_sid=${sid}`;
    const share = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc', access: { visibility: 'private', allowed_users: ['gina@example.com'] } } });
    assert(share.status === 200, `share ${share.status} ${share.text}`);
    const c = await comment(env, gina, 'invited by address');
    await agentReply(env, token, c.id, 'Answer for Gina.');
    const rows = (await bell(env, gina)).items.filter((i) => i.kind === 'agent_reply');
    eq(rows.map((i) => [i.preview, !!i.no_access]), [['Answer for Gina.', false]], 'the email-invited GitHub user got no row');
  });

  await t('rows on a doc that is gone are blank (fail closed), not counted, and not in filter=unread', async () => {
    const at = new Date(Date.now() - 60e3).toISOString();
    const { env, owner } = await seed([
      { ...row('n_gone', 'reply', at), slug: 'gone-doc', title: 'Secret plan', preview: 'secret words', thread_at: { c_n_gone: at }, actor: { login: 'mallory', name: 'Mallory' } },
      { ...row('n_granted', 'access_granted', at), slug: 'gone-doc', title: 'Secret plan' },
      row('n_here', 'comment', at),
    ]);
    const page = await bell(env, owner);
    const gone = page.items.find((i) => i.id === 'n_gone');
    eq([gone.title, gone.preview, gone.actor, gone.thread_at, gone.read, gone.no_access], ['', '', null, undefined, true, true]);
    eq(page.items.find((i) => i.id === 'n_granted').title, '', 'an access_granted title on a gone doc');
    eq(page.unread, 1, 'a row on a gone doc counts');
    eq((await call(env, '/api/notifications/unread', { cookie: owner })).body.unread, 1);
    eq((await bell(env, owner, '?filter=unread')).items.map((i) => i.id), ['n_here']);
    assert(!JSON.stringify(page).includes('Secret') && !JSON.stringify(page).includes('mallory'), 'title, words or author leaked');
  });

  await t('rows on a doc the person can no longer read keep no title or words', async () => {
    const { env, owner, reader, token } = await seed();
    const share = (allowed) => call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug: 'u-doc', access: { visibility: 'private', allowed_users: allowed } } });
    eq((await share(['reader'])).status, 200);
    const c = await comment(env, reader, 'invited question');
    await comment(env, owner, 'A human reply with words.', c.id);
    await agentReply(env, token, c.id, 'The secret answer.');
    let page = await bell(env, reader);
    assert(page.items.some((i) => i.kind === 'agent_reply' && i.preview === 'The secret answer.' && i.title), 'invited: full row');
    eq((await share([])).status, 200);
    page = await bell(env, reader);
    const rows = page.items.filter((i) => i.slug === 'u-doc');
    assert(rows.length >= 2, `rows: ${JSON.stringify(rows)}`);
    for (const r of rows) eq([r.title, r.preview, r.no_access], ['', '', true], r.kind);
    assert(!JSON.stringify(page).includes('secret') && !JSON.stringify(page).includes('A human reply'), 'words leaked');
    // The owner still reads them in full.
    assert((await bell(env, owner)).items.some((i) => i.kind === 'agent_reply' && i.preview === 'The secret answer.'));
  });

  await t('seeing the thread reads the agent row; reading it in the bell marks the thread seen and clears My docs\' note', async () => {
    const { env, owner, token } = await seed();
    const c = await comment(env, owner, 'mine');
    const a = await agentReply(env, token, c.id, 'answer');
    const seen = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, headers: SAME_ORIGIN, body: { slug: 'u-doc', seen: { [c.id]: Date.parse(a.created) } } });
    assert(seen.status === 200, `seen ${seen.status}`);
    eq((await agentRows(env, owner))[0].read, true, 'seen thread left the agent row unread');

    const c2 = await comment(env, owner, 'another');
    await agentReply(env, token, c2.id, 'answer 2');
    const r = (await agentRows(env, owner)).find((i) => i.thread_id === c2.id);
    eq(r.read, false);
    const read = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, headers: SAME_ORIGIN, body: { ids: [r.id] } });
    assert(read.status === 200, `read ${read.status}`);
    const after = (await call(env, '/api/comments/seen?slug=u-doc', { cookie: owner })).body.seen;
    assert(Number(after[c2.id]) >= Date.parse(r.at), `thread not seen: ${JSON.stringify(after)}`);
    const note = JSON.parse(await env.META.get('agent-unread:owner') || '{"items":[]}');
    assert(!note.items.some((i) => i.thread === c2.id), 'My docs still notes the reply');
  });

  console.log('aged unread');

  await t('an unread row older than 30 days does not count, is listed read, and is not in filter=unread', async () => {
    const now = Date.now();
    const { env, owner } = await seed([
      row('n_old', 'comment', new Date(now - 31 * DAY).toISOString()),
      row('n_edge', 'reply', new Date(now - 29 * DAY).toISOString()),
      row('n_new', 'mention', new Date(now - 60e3).toISOString()),
    ]);
    const page = await bell(env, owner);
    eq(page.items.map((i) => [i.id, i.read]), [['n_new', false], ['n_edge', false], ['n_old', true]]);
    eq(page.unread, 2);
    eq((await call(env, '/api/notifications/unread', { cookie: owner })).body.unread, 2);
    eq((await bell(env, owner, '?filter=unread')).items.map((i) => i.id), ['n_new', 'n_edge']);
    // My docs' badge agrees: the aged row is not counted on the doc.
    const me = (await call(env, '/api/me', { cookie: owner })).body;
    const doc = (me.docs || []).find((d) => d.slug === 'u-doc');
    eq(doc && doc.activity && doc.activity.comments, 2, 'My docs counts the aged row');
  });

  await t('a new event of an aged row\'s group starts its own row, counted from one', async () => {
    const { env, owner, reader } = await seed([
      { ...row('n_aged', 'comment', new Date(Date.now() - 40 * DAY).toISOString()), group_key: 'comment:u-doc', count: 7 },
    ]);
    await comment(env, reader, 'fresh');
    const page = await bell(env, owner);
    eq(page.items.map((i) => [i.kind, i.count, i.read]), [['comment', 1, false], ['comment', 7, true]]);
    eq(page.unread, 1);
  });

  console.log('paging');

  await t('equal times across a page boundary: every row once, the same order on every walk', async () => {
    const at = new Date(Date.now() - 3600e3).toISOString();
    const rows = Array.from({ length: 45 }, (_, i) => row(`n_tie_${String(i).padStart(2, '0')}`, 'comment', at, { group_key: `g${i}` }));
    // Stored in no particular order.
    rows.sort(() => 0.5 - Math.random());
    const { env, owner } = await seed(rows);
    const walk = async (filter = '') => {
      const all = [];
      for (let offset = 0; ;) {
        const page = await bell(env, owner, `?offset=${offset}${filter}`);
        all.push(...page.items.map((i) => i.id));
        offset += page.items.length;
        if (!page.has_more) return all;
      }
    };
    const first = await walk();
    eq(first.length, 45);
    eq(new Set(first).size, 45, 'a row twice');
    eq(await walk(), first, 'a second walk differs');
    eq(await walk('&filter=unread'), first, 'filter=unread differs');
  });

  await t('filter=unread skips reactions, access requests and agent replies: they do not eat Needs you\'s pages', async () => {
    const at = (min) => new Date(Date.now() - min * 60e3).toISOString();
    const noise = Array.from({ length: 30 }, (_, i) => row(`n_noise_${i}`, ['reaction', 'access_request', 'agent_reply'][i % 3], at(i + 1)));
    const todo = [row('n_c', 'comment', at(100)), row('n_r', 'reply', at(200)), row('n_m', 'mention', at(300))];
    const { env, owner } = await seed([...noise, ...todo]);
    const page = await bell(env, owner, '?filter=unread');
    eq(page.items.map((i) => i.id), ['n_c', 'n_r', 'n_m']);
    eq(page.has_more, false);
    eq(page.unread, 33, 'the count is still every unread row');
  });

  console.log('client');
  const { appendUnique } = await import(pathToFileURL(path.join(__dirname, '..', 'shell/src/notification-rows.js')).href);
  const text = await import(pathToFileURL(path.join(__dirname, '..', 'shell/src/notification-text.js')).href);

  await t('appendUnique keeps a row once when a new row shifts the next page by one', async () => {
    const page1 = [{ id: 'a' }, { id: 'b' }];
    // A row arrived on top meanwhile: page 2 starts with page 1's last row.
    const page2 = [{ id: 'b' }, { id: 'c' }, null];
    eq(appendUnique(page1, page2).map((r) => r.id), ['a', 'b', 'c']);
    eq(appendUnique([], [{ id: 'x' }, { id: 'x' }]).map((r) => r.id), ['x']);
    eq(appendUnique(null, null), []);
  });

  await t('an agent reply row reads "<agent> replied on <doc>"', async () => {
    const item = { kind: 'agent_reply', actor: { kind: 'agent', name: 'Claude Code' }, title: 'Plan', slug: 'u-doc', comment_id: 'r_1', count: 1 };
    eq(text.notificationLabel(item), 'Claude Code replied on Plan');
    eq(text.notificationLabel({ ...item, count: 3 }), 'Claude Code replied 3 times on Plan');
    eq(text.notificationTarget(item), '/d/u-doc?comment=r_1');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
