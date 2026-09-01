// @mentions — a comment reaches people by name, not only by position in the
// thread. Same extraction pattern as notifications.test.js: pull the pure
// helpers out of worker.js and out of the shell module, and run them.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');

function fn(source, name) {
  let s = source.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`fn ${name} not found`);
  // Keep a leading `async`: slicing from `function` alone yields a body with
  // `await` in a sync function, which is a SyntaxError rather than a failure.
  if (source.slice(s - 6, s) === 'async ') s -= 6;
  let i = source.indexOf('(', s), d = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') d++;
    else if (source[i] === ')') { d--; if (d === 0) { i++; break; } }
  }
  while (i < source.length && source[i] !== '{') i++;
  d = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') d++;
    else if (source[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  return source.slice(s, i);
}

function constLine(source, name) {
  const a = source.indexOf(`const ${name} =`);
  if (a === -1) throw new Error(`const ${name} not found`);
  return source.slice(a, source.indexOf('\n', a) + 1);
}

const box = {};
vm.createContext(box);
vm.runInContext([
  constLine(src, 'MENTION_RE'),
  constLine(src, 'MENTION_MAX_PER_COMMENT'),
  fn(src, 'sessionLogin'),
  fn(src, 'normalizeGithubLogin'),
  fn(src, 'parseMentionLogins'),
  fn(src, 'commentParticipants'),
  fn(src, 'mentionableUsers'),
  fn(src, 'mentionCandidates'),
  fn(src, 'classifyMentions'),
  constLine(src, 'PRESENCE_PREFIXES'),
  fn(src, 'hasUsedTdoc'),
  fn(src, 'describeNewcomers'),
  fn(src, 'positionalRecipient'),
  fn(src, 'inboxRecipients'),
  fn(src, 'inboxGroupKey'),
].join('\n\n'), box);

// The shell's pure half is an ES module; strip the export keyword and run the
// same way.
const shellSrc = fs.readFileSync(path.join(root, 'shell', 'src', 'document', 'mentions.js'), 'utf8');
const shell = {};
vm.createContext(shell);
vm.runInContext(shellSrc.replace(/^export /gm, ''), shell);

console.log('mentions');

// ── parsing ──────────────────────────────────────────────────────────────
t('a mention is a login at a word boundary', () => {
  assert(JSON.stringify(box.parseMentionLogins('hey @dana can you look')) === '["dana"]');
  assert(JSON.stringify(box.parseMentionLogins('@dana starts the line')) === '["dana"]');
  assert(JSON.stringify(box.parseMentionLogins('(@dana) in parens')) === '["dana"]');
});

t('an email address is not a mention', () => {
  assert(box.parseMentionLogins('write to dana@example.com').length === 0);
  assert(box.parseMentionLogins('ping @@dana').length === 0);
});

t('two mentions separated by one space both resolve', () => {
  assert(JSON.stringify(box.parseMentionLogins('@ana @bo')) === '["ana","bo"]');
});

t('mentions are lowercased and deduped, order kept', () => {
  assert(JSON.stringify(box.parseMentionLogins('@Dana @bo @dana')) === '["dana","bo"]');
});

t('a trailing hyphen is not part of a GitHub login', () => {
  assert(JSON.stringify(box.parseMentionLogins('ask @dana- about it')) === '["dana"]');
});

t('a login stops at 39 characters', () => {
  const long = 'a'.repeat(50);
  assert(box.parseMentionLogins(`@${long}`)[0].length === 39);
});

// ── who is mentionable ───────────────────────────────────────────────────
const list = [
  {
    id: 'c1', author: { login: 'Bo', name: 'Bo Chen', avatar_url: 'bo.png' },
    events: [
      { kind: 'created', at_version: 1, text: 'hi' },
      { kind: 'reply_added', at_version: 1, reply: { id: 'r1', author: { login: 'cy' } } },
      { kind: 'deleted', at_version: 2 },
    ],
  },
];

t('participants come off the event log, deleted comments included', () => {
  const people = box.commentParticipants(list);
  assert(JSON.stringify(people.map(p => p.login)) === '["bo","cy"]', JSON.stringify(people));
  assert(people[0].name === 'Bo Chen' && people[0].avatar_url === 'bo.png');
});

t('the mentionable set is owner + allowlist + participants, deduped', () => {
  const users = box.mentionableUsers({
    ownerLogin: 'Ana', allowedUsers: ['bo', 'dee'], participants: box.commentParticipants(list),
  });
  assert(JSON.stringify(users.map(u => u.login)) === '["ana","bo","dee","cy"]', JSON.stringify(users));
});

t('a duplicate entry keeps the name and avatar it was seen with', () => {
  const users = box.mentionableUsers({
    ownerLogin: 'bo', allowedUsers: [], participants: box.commentParticipants(list),
  });
  assert(users.length === 2 && users[0].login === 'bo' && users[0].avatar_url === 'bo.png');
});

t('an outsider is not shown the private-doc allowlist', () => {
  const users = box.mentionableUsers({
    ownerLogin: 'ana', allowedUsers: ['dee'], participants: [], includeAllowed: false,
  });
  assert(JSON.stringify(users.map(u => u.login)) === '["ana"]', JSON.stringify(users));
});

t('one comment cannot name an unbounded crowd', () => {
  const many = Array.from({ length: 25 }, (_, i) => `@dev${i}`).join(' ');
  assert(box.mentionCandidates(many).length === 10, box.mentionCandidates(many).length);
});

// ── who a mention may actually reach ─────────────────────────────────────
const anyoneCanRead = () => true;
const onlyInvited = (allowed) => (login) => allowed.includes(login);

t('on a readable doc every name is delivered, GitHub strangers included', () => {
  const out = box.classifyMentions(['torvalds', 'ana'], { canRead: anyoneCanRead });
  assert(JSON.stringify(out.notified) === '["torvalds","ana"]', JSON.stringify(out));
  assert(out.invited.length === 0 && out.blocked.length === 0);
});

t('a private doc does not leak its preview to a stranger', () => {
  const out = box.classifyMentions(['dee', 'torvalds'], {
    canRead: onlyInvited(['dee']), canInvite: false,
  });
  assert(JSON.stringify(out.notified) === '["dee"]', JSON.stringify(out));
  assert(JSON.stringify(out.blocked) === '["torvalds"]', JSON.stringify(out));
});

t('the owner naming a stranger on a private doc invites them', () => {
  const out = box.classifyMentions(['torvalds'], {
    canRead: onlyInvited([]), canInvite: true, inviteBudget: 5,
  });
  assert(JSON.stringify(out.invited) === '["torvalds"]', JSON.stringify(out));
  // An invite is worthless if the mention that caused it does not land.
  assert(JSON.stringify(out.notified) === '["torvalds"]', JSON.stringify(out));
  assert(out.blocked.length === 0);
});

t('the invite budget is a hard stop, the rest are blocked not silently dropped', () => {
  const out = box.classifyMentions(['a', 'b', 'c'], {
    canRead: onlyInvited([]), canInvite: true, inviteBudget: 2,
  });
  assert(JSON.stringify(out.invited) === '["a","b"]', JSON.stringify(out));
  assert(JSON.stringify(out.blocked) === '["c"]', JSON.stringify(out));
});

// ── delivery ─────────────────────────────────────────────────────────────
t('a mention notifies everyone named, never the author', () => {
  const r = box.inboxRecipients({
    kind: 'mention', actorLogin: 'bo', mentionLogins: ['ana', 'bo', 'ana', 'cy'],
  });
  assert(JSON.stringify(r) === '["ana","cy"]', JSON.stringify(r));
});

t('being named outranks sitting in the thread — one row, not two', () => {
  assert(box.positionalRecipient('Ana', ['ana']) === null);
  assert(box.positionalRecipient('Ana', ['bo']) === 'Ana');
  assert(box.positionalRecipient(null, ['ana']) === null);
});

t('a mention keeps its own inbox row instead of folding into the doc', () => {
  assert(box.inboxGroupKey('mention', 'spec', 'c1') === 'mention:c1');
  assert(box.inboxGroupKey('mention', 'spec', 'c2') !== box.inboxGroupKey('mention', 'spec', 'c1'));
  assert(box.inboxGroupKey('comment', 'spec', 'c1') === 'comment:spec');
});

// ── the composer's half ──────────────────────────────────────────────────
t('the picker opens on the token under the caret only', () => {
  const q = shell.mentionQueryAt('ask @da', 7);
  assert(q && q.query === 'da' && q.start === 4, JSON.stringify(q));
  assert(shell.mentionQueryAt('ask @dana about it', 18) === null);
  assert(shell.mentionQueryAt('dana@example.com', 16) === null);
  assert(shell.mentionQueryAt('@', 1)?.query === '');
});

t('matches rank prefix hits first and cap at six', () => {
  const people = [{ login: 'cydana' }, { login: 'dana' }, { login: 'dan', name: 'X' }];
  const m = shell.matchMentionable(people, 'da');
  assert(JSON.stringify(m.map(p => p.login)) === '["dan","dana","cydana"]', JSON.stringify(m));
  const many = Array.from({ length: 12 }, (_, i) => ({ login: `dev${i}` }));
  assert(shell.matchMentionable(many, 'dev').length === 6);
});

t('picking a person replaces the typed token and reports the caret', () => {
  const before = 'ask @da about it';
  const next = shell.insertMention(before, shell.mentionQueryAt(before, 7), 'dana');
  // One space after the name, not two — the caret lands past the one already there.
  assert(next.text === 'ask @dana about it', JSON.stringify(next.text));
  assert(next.caret === 10, next.caret);
  const end = shell.insertMention('ask @da', shell.mentionQueryAt('ask @da', 7), 'dana');
  assert(end.text === 'ask @dana ' && end.caret === 10, JSON.stringify(end));
});

t('a chip is only drawn for a mention the server delivered', () => {
  const parts = shell.splitMentions('hi @dana and @torvalds', ['dana']);
  assert(JSON.stringify(parts) === JSON.stringify([
    { type: 'text', value: 'hi ' },
    { type: 'mention', value: '@dana', login: 'dana' },
    { type: 'text', value: ' and @torvalds' },
  ]), JSON.stringify(parts));
});

t('a comment with no mentions is one plain run of text', () => {
  assert(JSON.stringify(shell.splitMentions('plain', [])) === '[{"type":"text","value":"plain"}]');
  assert(JSON.stringify(shell.splitMentions('', ['dana'])) === '[]');
});

t('the chip shows the token as typed, including a trailing hyphen', () => {
  const parts = shell.splitMentions('@dana- ok', ['dana']);
  assert(parts[0].value === '@dana-' && parts[0].login === 'dana', JSON.stringify(parts));
  assert(parts[1].value === ' ok');
});

// ── the two implementations must agree ───────────────────────────────────
t('the local server parses mentions the same way as the worker', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const name of ['parseMentionLogins', 'mentionCandidates', 'positionalRecipient']) {
    assert(norm(fn(src, name)) === norm(fn(serverSrc, name)),
      `${name} has DRIFTED between worker.js and server.js`);
  }
});

// ── who has actually used tdoc ───────────────────────────────────────────
const asyncTests = [];
function ta(n, f) { asyncTests.push([n, f]); }

// META with only the keys named; everything else reads as absent.
const envWith = (...keys) => ({ META: { get: async (k) => (keys.includes(k) ? '{}' : null) } });

ta('a doc opened while signed in counts as having used tdoc', async () => {
  assert(await box.hasUsedTdoc(envWith('recents:ada'), 'ada') === true);
});

ta('a star counts, and so does a hosted account (new key or legacy)', async () => {
  assert(await box.hasUsedTdoc(envWith('stars:ada'), 'ada') === true, 'stars');
  assert(await box.hasUsedTdoc(envWith('hosted-account:ada'), 'ada') === true, 'hosted-account');
  assert(await box.hasUsedTdoc(envWith('hosted-github:ada'), 'ada') === true, 'legacy hosted-github');
});

// The regression this whole probe exists to avoid: a mention writes the
// inbox, so an inbox must never be evidence that its owner has been here.
ta('an inbox is NOT evidence — a mention creates one', async () => {
  assert(await box.hasUsedTdoc(envWith('inbox:ada'), 'ada') === false,
    'inbox: made the probe answer its own question');
});

ta('a stranger with nothing on this host reads as never having used tdoc', async () => {
  assert(await box.hasUsedTdoc(envWith(), 'ada') === false);
  assert(await box.hasUsedTdoc(envWith('recents:ada'), '') === false, 'empty login');
});

// ── who the author still has to reach by hand ────────────────────────────
ta('people already on the doc are not reported as newcomers', async () => {
  const out = await box.describeNewcomers(envWith('recents:ada'), {
    notified: ['ada', 'bo'],
    invited: [],
    insiders: ['ada'],
  });
  assert(out.length === 1, `expected only bo, got ${JSON.stringify(out)}`);
  assert(out[0].login === 'bo');
});

ta('each newcomer carries whether the mention can find them on its own', async () => {
  const out = await box.describeNewcomers(envWith('recents:bo'), {
    notified: ['bo', 'cy'],
    invited: ['cy'],
    insiders: [],
  });
  const by = Object.fromEntries(out.map((p) => [p.login, p]));
  assert(by.bo.known === true && by.bo.invited === false, 'bo uses tdoc, was not invited');
  assert(by.cy.known === false && by.cy.invited === true, 'cy is new to tdoc and was invited');
});

(async () => {
  for (const [n, f] of asyncTests) {
    try { await f(); ok(n); } catch (e) { bad(n, e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
