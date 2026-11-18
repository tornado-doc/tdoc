// Inbox helpers — Reddit-style recipients + aggregation + read/paging.
// Extracted from worker.js (same pattern as comment-ops.test.js).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
function fn(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`fn ${name} not found`);
  let i = src.indexOf('(', s), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') d++;
    else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  return src.slice(s, i);
}

function consts() {
  const a = src.indexOf('const INBOX_MAX');
  const b = src.indexOf('function emptyInbox');
  if (a === -1 || b === -1) throw new Error('INBOX_MAX block not found');
  return src.slice(a, b);
}

const box = {};
vm.createContext(box);
vm.runInContext([
  consts(),
  fn('sessionLogin'),
  fn('normalizeGithubLogin'),
  fn('emptyInbox'),
  fn('inboxRowUnread'),
  fn('inboxUnread'),
  fn('inboxRowThreads'),
  fn('noteInboxThread'),
  fn('inboxEventThreads'),
  fn('trimInbox'),
  fn('inboxEventCapped'),
  fn('applyInboxEvent'),
  fn('markInboxRead'),
  fn('pageInbox'),
  fn('inboxRecipients'),
  fn('findRecord'),
  fn('recordAuthor'),
  fn('findCommentThread'),
].join('\n\n'), box);

console.log('notifications inbox');

t('a grouped comment row lists its threads; seen clears it only when all are seen', () => {
  box.DOC_ACTIVITY_INBOX_KINDS = new Set(['comment', 'reply', 'mention']);
  let inbox = box.emptyInbox();
  inbox = box.applyInboxEvent(inbox, { id: 'n1', kind: 'comment', slug: 'd', comment_id: 'T1', thread_id: 'T1', at: '2026-01-01T01:00:00.000Z' });
  inbox = box.applyInboxEvent(inbox, { id: 'n2', kind: 'comment', slug: 'd', comment_id: 'T2', thread_id: 'T2', at: '2026-01-01T02:00:00.000Z' });
  assert(inbox.items.length === 1 && inbox.items[0].count === 2, JSON.stringify(inbox));
  assert(JSON.stringify(Object.keys(inbox.items[0].thread_at).sort()) === '["T1","T2"]', JSON.stringify(inbox.items[0]));
  const only2 = box.markInboxRead(inbox, { slug: 'd', seen: { T2: Date.parse('2026-01-01T02:00:00.000Z') } });
  assert(!only2.items[0].read, 'T1 is still unread');
  const both = box.markInboxRead(inbox, { slug: 'd', seen: { T1: Date.parse('2026-01-01T01:00:00.000Z'), T2: Date.parse('2026-01-01T02:00:00.000Z') } });
  assert(both.items[0].read, 'both seen');
});

t('a grouped row stored before rows listed their threads is never cleared by seen', () => {
  const legacy = { items: [{ id: 'n1', kind: 'comment', group_key: 'comment:d', slug: 'd', comment_id: 'T2', thread_id: 'T2', at: '2026-01-01T02:00:00.000Z', read: false, count: 2 }] };
  assert(!box.markInboxRead(legacy, { slug: 'd', seen: { T2: Date.parse('2026-01-02T00:00:00.000Z') } }).items[0].read);
  const grown = box.applyInboxEvent({ items: [{ ...legacy.items[0], count: 1 }] }, { id: 'n3', kind: 'comment', slug: 'd', comment_id: 'T3', thread_id: 'T3', at: '2026-01-01T03:00:00.000Z' });
  assert(JSON.stringify(Object.keys(grown.items[0].thread_at).sort()) === '["T2","T3"]', 'a one-thread legacy row starts its list right');
});

t('past the cap a grouped row stops listing and waits for the bell', () => {
  let inbox = box.emptyInbox();
  for (let n = 0; n <= 50; n += 1) { // INBOX_ROW_THREADS_MAX
    inbox = box.applyInboxEvent(inbox, { id: `n${n}`, kind: 'comment', slug: 'd', comment_id: `T${n}`, thread_id: `T${n}`, at: '2026-01-01T01:00:00.000Z' });
  }
  assert(inbox.items[0].threads_capped === true, JSON.stringify(Object.keys(inbox.items[0])));
  const seen = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`T${n}`, Date.parse('2026-01-02T00:00:00.000Z')]));
  assert(!box.markInboxRead(inbox, { slug: 'd', seen }).items[0].read);
});

t('inboxKey lowercases github login', () => {
  assert(box.inboxKey('SerenaKeyitan') === 'inbox:serenakeyitan');
  assert(box.inboxKey('') === null);
});

t('Reddit: reply notifies only the direct parent, not owner or ancestors', () => {
  const r = box.inboxRecipients({
    kind: 'reply',
    actorLogin: 'carol',
    ownerLogin: 'owner',
    parentAuthorLogin: 'bob',
    targetAuthorLogin: 'alice',
  });
  assert(r.length === 1 && r[0] === 'bob', `got ${JSON.stringify(r)}`);
});

t('top-level comment notifies owner, not the commenter', () => {
  const r = box.inboxRecipients({
    kind: 'comment', actorLogin: 'bob', ownerLogin: 'alice',
  });
  assert(r.length === 1 && r[0] === 'alice');
  const self = box.inboxRecipients({
    kind: 'comment', actorLogin: 'alice', ownerLogin: 'alice',
  });
  assert(self.length === 0, 'owner commenting on own doc should not notify self');
});

t('reaction notifies the item author only', () => {
  const r = box.inboxRecipients({
    kind: 'reaction', actorLogin: 'bob', targetAuthorLogin: 'alice', ownerLogin: 'owner',
  });
  assert(r.length === 1 && r[0] === 'alice');
});

t('same-thread events aggregate into one unread row', () => {
  let inbox = box.emptyInbox();
  inbox = box.applyInboxEvent(inbox, {
    id: 'n1', kind: 'comment', slug: 'conway-life', comment_id: 'c1',
    actor: { login: 'bob' }, preview: 'first', title: 'Conway', at: 't1',
  });
  inbox = box.applyInboxEvent(inbox, {
    id: 'n2', kind: 'comment', slug: 'conway-life', comment_id: 'c2',
    actor: { login: 'carol' }, preview: 'second', title: 'Conway', at: 't2',
  });
  assert(inbox.items.length === 1, `expected 1 row, got ${inbox.items.length}`);
  assert(inbox.items[0].count === 2, `count ${inbox.items[0].count}`);
  assert(inbox.items[0].comment_id === 'c2', 'should jump to latest');
  assert(box.inboxUnread(inbox) === 1);
});

t('replies to different parents do not merge', () => {
  let inbox = box.emptyInbox();
  inbox = box.applyInboxEvent(inbox, {
    id: 'n1', kind: 'reply', slug: 'd', comment_id: 'r1', target_id: 'c1',
    actor: { login: 'a' }, at: 't1',
  });
  inbox = box.applyInboxEvent(inbox, {
    id: 'n2', kind: 'reply', slug: 'd', comment_id: 'r2', target_id: 'c2',
    actor: { login: 'b' }, at: 't2',
  });
  assert(inbox.items.length === 2);
});

t('mark read by comment_id; page newest first, read or not', () => {
  let inbox = box.emptyInbox();
  inbox = box.applyInboxEvent(inbox, {
    id: 'n1', kind: 'reply', slug: 'd', comment_id: 'r1', target_id: 'c1',
    actor: { login: 'a' }, at: 't1',
  });
  inbox = box.markInboxRead(inbox, { comment_id: 'r1' });
  assert(inbox.items[0].read === true);
  assert(box.inboxUnread(inbox) === 0);
  inbox = box.applyInboxEvent(inbox, {
    id: 'n3', kind: 'comment', slug: 'other', comment_id: 'c9',
    actor: { login: 'z' }, at: 't3',
  });
  // A read row newer than an unread one stays above it: the bell is what
  // happened, newest first (Julie, 2026-11-18).
  inbox = box.applyInboxEvent(inbox, {
    id: 'n4', kind: 'reply', slug: 'd', comment_id: 'r4', target_id: 'c1',
    actor: { login: 'a' }, at: 't4',
  });
  inbox = box.markInboxRead(inbox, { comment_id: 'r4' });
  const page = box.pageInbox(inbox, { offset: 0, limit: 20 });
  assert(page.items.map((i) => i.id).join() === 'n4,n3,n1', `order ${page.items.map((i) => i.id)}`);
  assert(page.unread === 1 && page.has_more === false);
  const waiting = box.pageInbox(inbox, { offset: 0, limit: 20, unread: true });
  assert(waiting.items.map((i) => i.id).join() === 'n3', 'unread: the unread rows alone');
  assert(waiting.unread === 1 && waiting.has_more === false);
});

t('mark read by comment_id does not clear other rows on the same thread', () => {
  let inbox = box.emptyInbox();
  inbox = box.applyInboxEvent(inbox, {
    id: 'n-react', kind: 'reaction', slug: 'd', comment_id: 'c1',
    thread_id: 'c1', target_id: 'c1', actor: { login: 'bob' }, at: 't1',
  });
  inbox = box.applyInboxEvent(inbox, {
    id: 'n-reply', kind: 'reply', slug: 'd', comment_id: 'r1',
    thread_id: 'c1', target_id: 'c1', actor: { login: 'bob' }, at: 't2',
  });
  inbox = box.markInboxRead(inbox, { comment_id: 'r1' });
  const reply = inbox.items.find(i => i.id === 'n-reply');
  const react = inbox.items.find(i => i.id === 'n-react');
  assert(reply && reply.read === true, 'reply row should be read');
  assert(react && !react.read, 'reaction on the thread root must stay unread');
  assert(box.inboxUnread(inbox) === 1);
});

t('recordAuthor finds nested reply authors', () => {
  const list = [{
    id: 'c1', author: { login: 'alice' },
    events: [
      { kind: 'reply_added', reply: { id: 'r1', author: { login: 'bob' } } },
    ],
  }];
  assert(box.recordAuthor(list, 'c1').login === 'alice');
  assert(box.recordAuthor(list, 'r1').login === 'bob');
  assert(box.recordAuthor(list, 'missing') === null);
});


console.log('bell follow-ups: eviction, cap, coalesced agent rows, recipients');
vm.runInContext('const AGENT_REPLY_ROW_CAP = 99;', box);
vm.runInContext([fn('normalizeEmail'), fn('normalizeActorKey'), fn('isNonHumanAuthor'), fn('agentReplyBellRecipients'),
  'function snapshotAt(c) { return c; }'].join('\n\n'), box);
const recent = (min) => new Date(Date.now() - min * 60e3).toISOString();

t('a full inbox drops read and agent rows first, never an unread person\'s row for an agent\'s', () => {
  const humans = Array.from({ length: 150 }, (_, i) => ({ id: `h${i}`, kind: 'comment', group_key: `comment:d${i}`, slug: `d${i}`, at: recent(1000 + i), read: false, count: 1 }));
  const agents = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, kind: 'agent_reply', group_key: `agent_reply:x${i}`, slug: `x${i}`, at: recent(10 + i), read: false, count: 1, quiet: true }));
  let inbox = { items: [...agents, ...humans] };
  inbox = box.applyInboxEvent(inbox, { id: 'a_new', kind: 'agent_reply', slug: 'y', thread_id: 'c1', at: recent(0), quiet: true });
  assert(inbox.items.length === 200, `kept ${inbox.items.length}`);
  assert(humans.every((h) => inbox.items.some((i) => i.id === h.id)), 'an unread person\'s row was evicted for an agent row');
  assert(!inbox.items.some((i) => i.id === 'a49'), 'the oldest agent row should go');
  assert(inbox.items[0].id === 'a_new');
  // A read row goes before an agent row.
  inbox.items[100] = { ...inbox.items[100], read: true };
  const readId = inbox.items[100].id;
  inbox = box.applyInboxEvent(inbox, { id: 'h_new', kind: 'mention', slug: 'z', thread_id: 'c2', target_id: 'c2', at: recent(0) });
  assert(!inbox.items.some((i) => i.id === readId), 'the read row should go first');
  assert(inbox.items.some((i) => i.id === 'a48'), 'an agent row went before a read one');
  // Only unread people's rows left: the oldest of them goes.
  const full = { items: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, kind: 'reply', group_key: `reply:${i}`, slug: 'd', at: recent(i), read: false, count: 1 })) };
  const next = box.applyInboxEvent(full, { id: 'p_new', kind: 'reply', slug: 'd', target_id: 'new', at: recent(0) });
  assert(next.items.length === 200 && !next.items.some((i) => i.id === 'p199') && next.items[0].id === 'p_new');
});

t('a coalesced agent event adds its count and every thread to the doc\'s row', () => {
  let inbox = box.applyInboxEvent({ items: [] }, { id: 'n1', kind: 'agent_reply', slug: 'd', thread_id: 'c1', comment_id: 'r1', at: recent(5), quiet: true });
  inbox = box.applyInboxEvent(inbox, { id: 'n2', kind: 'agent_reply', slug: 'd', thread_id: 'c3', comment_id: 'r3', at: recent(1), quiet: true,
    count: 2, threads: [['c2', recent(2)], ['c3', recent(1)]] });
  assert(inbox.items.length === 1, 'one row per doc');
  const row = inbox.items[0];
  assert(row.count === 3 && row.group_key === 'agent_reply:d' && row.quiet === true, JSON.stringify(row));
  assert(Object.keys(row.thread_at).sort().join() === 'c1,c2,c3', JSON.stringify(row.thread_at));
});

t('the cap: a doc\'s unread agent row at AGENT_REPLY_ROW_CAP takes no more; read, or another doc, does', () => {
  const ev = { kind: 'agent_reply', slug: 'd', at: recent(0) };
  const at = (count, extra = {}) => ({ items: [{ id: 'n', kind: 'agent_reply', group_key: 'agent_reply:d', slug: 'd', at: recent(1), read: false, count, ...extra }] });
  assert(box.inboxEventCapped(at(99), ev) === true);
  assert(box.inboxEventCapped(at(98), ev) === false);
  assert(box.inboxEventCapped(at(99, { read: true }), ev) === false);
  assert(box.inboxEventCapped(at(99), { ...ev, slug: 'other' }) === false);
  assert(box.inboxEventCapped(at(99), { ...ev, kind: 'reply' }) === false, 'people\'s rows are never capped');
});

t('agent row recipients: owner and attested people in the thread; not agents, the actor, or a deleted root\'s author', () => {
  const human = (login) => ({ kind: 'human', login, account_id: `acct-${login}` });
  const thread = (rootExtra = {}) => ({ root: { id: 'c1', author: human('rita'), ...rootExtra, replies: [
    { id: 'r1', author: human('sam') },
    { id: 'r2', author: { kind: 'agent', login: 'claude' }, agent_status: 'answered' },
    { id: 'r3', author: { kind: 'human', login: 'nobody' } }, // no account behind the name
    { id: 'r4', author: human('gone'), deleted: true },
  ] } });
  const keys = (t, o) => [...box.agentReplyBellRecipients(t, o)].join();
  assert(keys(thread(), { owner: 'olga' }) === 'olga,rita,sam', keys(thread(), { owner: 'olga' }));
  assert(keys(thread(), { owner: 'olga', skip: ['sam'] }) === 'olga,rita');
  assert(keys(thread({ deleted: true }), { owner: 'olga' }) === 'olga,sam', 'a deleted root\'s author is still notified');
});


t('inboxReaderSession: one lookup per person and author per request memo; the author record is the hint', () => {
  const ctx = vm.createContext({ calls: [] });
  vm.runInContext([fn('inboxReaderSession'),
    'function buildInboxReaderSession(env, k, hint) { calls.push([k, hint.accountHint, hint.githubId]); return Promise.resolve({ k }); }'].join('\n\n'), ctx);
  const memo = new Map();
  const a = ctx.inboxReaderSession({}, 'rita', { memo });
  const b = ctx.inboxReaderSession({}, 'rita', { memo });
  assert(a === b, 'not memoized');
  ctx.inboxReaderSession({}, 'rita', { memo, author: { account_id: 'acct-rita' } });
  ctx.inboxReaderSession({}, 'rita', { memo, author: { github_id: '123' } });
  ctx.inboxReaderSession({}, 'rita', { memo, author: { github_id: 'not-a-number' } });
  ctx.inboxReaderSession({}, 'rita', {});
  const calls = JSON.stringify(ctx.calls);
  assert(calls === JSON.stringify([['rita', '', ''], ['rita', 'acct-rita', ''], ['rita', '', '123'], ['rita', '', '']]), calls);
});

// Async: one batched delivery (a suggestion accepted that fixed comments in
// several threads), each person gets only their threads, count and preview.
const pending = (async () => {
  const name = 'each person\'s agent row holds only their own threads, count and newest words';
  try {
    vm.runInContext([fn('agentReplyEvent'), 'async ' + fn('deliverAgentReplyRows'),
      'const AGENT_REPLY_PREVIEW_MAX = 300;',
      'var written = [];',
      'async function loadDocMeta(env, slug) { return { title: "Plan", slug }; }',
      'function accessFromMeta() { return {}; }',
      'function canReadDoc() { return true; }',
      'async function inboxReaderSession(env, who) { return { login: who }; }',
      'function ownerActorKey() { return "olga"; }',
      'function agentFaceAuthor(a) { return a; }',
      'async function writeInboxEvent(env, who, ev) { written.push([who, ev]); }',
    ].join('\n\n'), box);
    const human = (login) => ({ kind: 'human', login, account_id: `acct-${login}` });
    const agent = { kind: 'agent', login: 'claude', name: 'Claude Code' };
    const thread = (id, login) => ({ root: { id, author: human(login), replies: [] } });
    await box.deliverAgentReplyRows({}, 'plan', [
      { thread: thread('c1', 'rita'), at: '2026-11-18T10:00:01Z', author: agent, replyId: 'r1', text: 'for rita' },
      { thread: thread('c2', 'sam'), at: '2026-11-18T10:00:02Z', author: agent, replyId: 'r2', text: 'for sam, first' },
      { thread: thread('c3', 'sam'), at: '2026-11-18T10:00:03Z', author: agent, replyId: 'r3', text: 'for sam, newest' },
    ], {});
    const by = Object.fromEntries(box.written.map(([who, ev]) => [who, [ev.count, ev.threads.map((t) => t[0]).join(), ev.preview, ev.thread_id]]));
    const want = {
      olga: [3, 'c1,c2,c3', 'for sam, newest', 'c3'],
      rita: [1, 'c1', 'for rita', 'c1'],
      sam: [2, 'c2,c3', 'for sam, newest', 'c3'],
    };
    assert(JSON.stringify(by) === JSON.stringify(want), JSON.stringify(by));
    assert(box.written.length === 3, 'one write per person');
    ok(name);
  } catch (e) { bad(name, e.message); }
})();

pending.then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
