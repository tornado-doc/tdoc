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
  fn('inboxUnread'),
  fn('inboxRowThreads'),
  fn('noteInboxThread'),
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

t('mark read by comment_id; page unread first', () => {
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
  const page = box.pageInbox(inbox, { offset: 0, limit: 20 });
  assert(page.items[0].id === 'n3', 'unread should sort first');
  assert(page.unread === 1 && page.has_more === false);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
