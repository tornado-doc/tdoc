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
  constLine(src, 'EMAIL_MENTION_RE'),
  constLine(src, 'MENTION_MAX_PER_COMMENT'),
  fn(src, 'sessionLogin'),
  fn(src, 'normalizeGithubLogin'),
  fn(src, 'normalizeEmail'),
  fn(src, 'normalizeActorKey'),
  fn(src, 'normalizeInvitee'),
  ...['emailTagAddress', 'looksLikeHost', 'handleStandsAlone', 'handleMayBeNamed'].map((name) => { try { return fn(src, name); } catch { return ''; } }), fn(src, 'parseMentionLogins'),
  fn(src, 'isNonHumanAuthor'),
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

t('a bare address in prose is not a mention; "@address" is a deliberate tag', () => {
  // Writing someone's address is not the same act as calling them in.
  assert(box.parseMentionLogins('write to dana@example.com').length === 0);
  assert(box.parseMentionLogins('ping @@dana').length === 0);
  // The summons form parses to the email actor key…
  assert(JSON.stringify(box.parseMentionLogins('cc @dana@example.com please'))
    === JSON.stringify(['email:dana@example.com']));
  // …never half-read as a GitHub user named dana,
  assert(!box.parseMentionLogins('cc @dana@example.com').includes('dana'));
  // trailing punctuation does not join the address,
  assert(JSON.stringify(box.parseMentionLogins('ask @dana@example.com.'))
    === JSON.stringify(['email:dana@example.com']));
  // and both shapes coexist in one comment.
  assert(JSON.stringify(box.parseMentionLogins('@alice and @dana@example.com'))
    === JSON.stringify(['email:dana@example.com', 'alice']));
});

t('an email tag ends where its address does, whatever is written against it', () => {
  const D = 'email:dana@example.com';
  for (const [text, ...want] of [
    ['@dana@example.com, please', D], ['@dana@example.com，请看', D], ['@dana@example.com请看', D], ['请@dana@example.com。', D],
    ['(@dana@example.com)', D], ['"@dana@example.com"', D], ['<@dana@example.com>', D], ['@<dana@example.com>', D], ['@dana@example.com/', D], ['@dana@example.com_', D], ['@dana@example.com!?', D],
    ['@dana@example.com,@eli@example.org', D, 'email:eli@example.org'], ['@dana@example.com，@eli@example.org;@fay@x.io', D, 'email:eli@example.org', 'email:fay@x.io'],
    ['@dana@example.com,@eli', D, 'eli'], ['@lee,@j.kim@example.com', 'email:j.kim@example.com', 'lee'],
    ['@dana@example.com/@eli@example.org', D], ['@dana@example.com/@eli', D, 'eli'], ['@dana@example.com@eli', D, 'eli'], ['@dana@example.com-@eli@example.org', D],
    // As they were.
    ['@o\'n+x@mail.example.co.uk', 'email:o\'n+x@mail.example.co.uk'], ['@Dana.Q@Example.COM', 'email:dana.q@example.com'], ['@dana@bücher.example, ok', 'email:dana@bücher.example'], ['@dana@example.例子 ok', 'email:dana@example.例子'],
    ['@dana@mail.paral·lel.example', 'email:dana@mail.paral·lel.example'], ['@dana@one.bücher.example，请看', 'email:dana@one.bücher.example'],
    ['@dana@localhost'], ['@dana.@eli', 'dana', 'eli'], ['@dana, @eli', 'dana', 'eli'],
    // Nobody's, and no handle read out of them.
    ['@dana@mail.one,com'], ['@dana@mail.one[.]example'], ['@dana@mail.one(dot)example'], ['@dana@mail.one.co．uk'], ['@dana@mail.one。com'], ['@dana@mail.one,x.example'],
    ['@dana@one.example,\u00adfoo'], ['@john.@example.com'], ['@john!@one.example\u8bf7@mail.example'], ['@john.@example.com@mail.example'], ['@dana!@example.com'], ['(@dana)@example.com'], ['@lee,@example.com'], ['@lee, @example.com', 'lee'], ['@one\u2011x.example'], ['@example.com'], ['@k_l and @x+y and @b.ob'],
    ['@k_l|@b.ob@x1.example', 'email:b.ob@x1.example'], ['@lee,@jkim@x.example', 'email:jkim@x.example', 'lee'], ['@lee,@eli', 'lee', 'eli'], ['@dana@x.example@eli@y.example', 'email:dana@x.example'], ['@dana@x.example@eli.example', 'email:dana@x.example'], ['@lee@example,com'], ['@dana\'s and @eli\u8bf7\u770b', 'dana', 'eli'],
    ['@o\'n,@j.kim@x.example', 'email:j.kim@x.example'], ['@dana@one._'], ['@john:x@example.com'], ['@a"b@example.com'],
  ]) {
    const got = box.parseMentionLogins(text);
    assert(JSON.stringify(got) === JSON.stringify(want), `${text}: ${JSON.stringify(got)}`);
  }
  for (const long of ['@a@b.example,'.repeat(8000), '@'.repeat(60000), 'a@'.repeat(60000), `@a@b.c${'_'.repeat(60000)}a`, `@a@${'.'.repeat(60000)}x`, `@a@b.c,${','.repeat(60000)}x`, `@a@${'b.'.repeat(60000)}`, `@a@b.example${'-'.repeat(60000)}`]) {
    const from = Date.now();
    box.parseMentionLogins(long);
    assert(Date.now() - from < 1000, `${long.slice(0, 20)} took ${Date.now() - from} ms`);
  }
});

t('a handle with Chinese, Japanese or Korean written on after it is told, dots or not', () => {
  for (const text of ['@eli\u8fd9\u91cc\u6ca1\u95ee\u9898\u3002PR\u5df2\u5408\u5e76', '@eli\u770b\u8fc7\u4e86\u3002OK', '@eli\u8bf7\u770bREADME.md', '@eli\u8bf7\u770b\u4e00\u4e0b\u8fd9\u4e2a\u65b9\u6848\u3002\u53c2\u8003tdoc.dev', '@eli\u8fd9\u4e2a\u6539\u62103.5\u5427', '@eli\u770b\u4e0b\u7b2c2.3\u8282', '@eli\u3055\u3093\u3002OK\u3067\u3059', '@eli\ud655\uc778\ud574\uc8fc\uc138\uc694\u3002OK', '@eli\u3002OK', '@eli\u8fd9\u91cc\u6ca1\u95ee\u9898\u3002']) {
    assert(JSON.stringify(box.parseMentionLogins(text)) === '["eli"]', `${text}: ${JSON.stringify(box.parseMentionLogins(text))}`);
  }
  // Still a host, an address, or a label that is no handle at all.
  for (const text of ['@example.com', '@john.@gmail.com', '@\u4f8b\u3048.jp', '@john.@one\u516c\u53f8.cn', '@eli.@gmail.com', '@b\u00fccher.de', '@example!.com', '@john@gmail\uff61com', '\u3042\u308a\u304c\u3068\u3046@lee@corp\uff61ok \u3067\u3059']) {
    assert(!box.parseMentionLogins(text).some((k) => !k.startsWith('email:')), `${text}: ${JSON.stringify(box.parseMentionLogins(text))}`);
  }
});

t('handles written like a part of an address are weak, never mentions of their own', () => {
  const tails = ['。OK', '。PR已合并', '。pr已合并', '。app已上线', '。ai部分', '。README.md已更新', '。https://tdoc.dev', '看下package.json', '.OK', '...ok', '：v1.2已发', '👍。OK', 'さん。OKです', '님.OK입니다', '+1。OK', 'ー。OK', '。com'];
  for (const tail of tails) for (const list of ['@lee，@eli', '@Lee、@ELI', '@lee和@eli', '@lee,@eli']) {
    const weak = new Set();
    const told = [...box.parseMentionLogins(list + tail, weak), ...weak];
    if (!told.some((k) => k.startsWith('email:'))) assert(told.sort().join() === 'eli,lee', `${list + tail}: ${told}`);
  }
  for (const [text, strong, want] of [
    ['**@lee**，**@eli**。OK', '', 'lee eli'],
    ['@lee，@eli。OK', '', 'lee eli'],
    ['@lee，@eli。OK @eli', 'eli', 'lee'],
    ['@ana，@lee，@eli。OK', '', 'ana lee eli'],
    ['@ana @lee，@eli。OK', 'ana', 'lee eli'],
    ['@john，@gmail。com', '', 'john gmail'],
    ['@dana@example.com，@lee，@eli。OK', 'email:dana@example.com', 'lee eli'],
    ['@lee，@eli。OK，@dana@example.com', 'email:dana@example.com', 'lee eli'],
    // Not a handle of anybody's: a longer word, an address's name, its host.
    ['@k_l', '', ''],
    ['@bücher.de', '', ''],
    ['@dana@example.com', 'email:dana@example.com', ''],
    ['@dana.k@example.com请', 'email:dana.k@example.com', ''],
    ['@dana@bücher.example', 'email:dana@bücher.example', ''],
    ['@dana@example.com@eli.ok', 'email:dana@example.com', 'eli'],
    ['@dana+x.@example.com', '', 'example'],
    [`@${'d'.repeat(39)}1.ok`, '', ''],
    ['@dana@mail.one。com', '', ''],
    ['x@eli.OK', '', ''],
  ]) {
    const weak = new Set();
    const got = box.parseMentionLogins(text, weak);
    assert(got.join(' ') === strong && [...weak].join(' ') === want, `${text}: ${got} / ${[...weak]}`);
  }
  // The cap is shared, and never taken from the others.
  const ten = Array.from({ length: 10 }, (_, i) => `@p${i}`).join(' ');
  for (const [text, strong, rest] of [[`@lee，@eli。OK ${ten}`, 10, 0], [`@lee，@eli。OK ${ten.slice(0, -8)}`, 8, 2], [`${'@w，@v。OK '.replace(/w|v/g, (x) => x)}${Array.from({ length: 15 }, (_, i) => `@w${i}.ok`).join(' ')}`, 0, 10]]) {
    const weak = [];
    const named = box.mentionCandidates(text, weak);
    assert(named.length === strong && weak.length === rest, `${text}: ${named} / ${weak}`);
  }
});

t('every parsed mention is one an invitation takes', () => {
  const pieces = ['@lee', '@john', 'x@corp', '@a@b.c', '@gmail', '.com', '\uff61com', '\uff0ecom', '\u3002com', '.', ',', '\u8bf7\u770b', ' ', '!', '(', '\u00fc', '@'.repeat(2), 'a'.repeat(260), '-', '_', '\u200b', '\u0130', "'", '"'];
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  for (let i = 0; i < 20000; i++) {
    let text = '';
    for (let j = 2 + next(6); j > 0; j--) text += pieces[next(pieces.length)];
    for (const k of box.parseMentionLogins(text)) {
      assert(box.normalizeActorKey(k) === k && box.normalizeInvitee(k.replace(/^email:/, '')) === k.replace(/^email:/, ''), `${JSON.stringify(text)}: ${k}`);
    }
  }
});

t('no part of an address is a handle, whatever character stands in it', () => {
  const marks = [];
  for (let c = 0x21; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    if ((c < 0xd800 || c > 0xdfff) && ch !== '@' && !/\s/.test(ch) && /[\p{P}\p{S}]/u.test(ch)) marks.push(ch);
  }
  const alone = { '@lee @john{}@example.com': ['lee'] };
  for (const shape of ['@john{}@example.com', '@jo{}hn@example.com', '@john{}{}@sub.example.com', '(@john{}@example.com)', '@john@exam{}ple.com', '@john@example.com{}@mail.example.org', '@dana@x.io{}@john{}@example.com', '@john{}@example.com{}tail', '{}@example.com', '@lee @john{}@example.com']) {
    for (const mark of marks) {
      const text = shape.replaceAll('{}', mark);
      const told = box.parseMentionLogins(text);
      const handles = told.filter((k) => !k.startsWith('email:'));
      assert(handles.every((h) => (alone[shape] || []).includes(h)), `${JSON.stringify(text)}: ${JSON.stringify(told)}`);
      for (const k of told) if (k.startsWith('email:')) assert(text.toLowerCase().includes(k.slice(6)), `${JSON.stringify(text)}: ${k}`);
    }
  }
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

t('agents and the tdoc note are not participants; people keep their order', () => {
  const people = box.commentParticipants([
    { id: 'c0', author: { login: 'tdoc', name: 'tdoc', kind: 'system' } },
    {
      id: 'c1', author: { login: 'bo' },
      replies: [{ author: { login: 'claude', kind: 'agent' } }, { author: { login: 'cy' } }],
      events: [{ kind: 'reply_added', reply: { author: { login: 'codex', kind: 'agent' } } }],
    },
    { id: 'c2', author: { login: 'dee', kind: 'human' } },
  ]);
  assert(JSON.stringify(people.map(p => p.login)) === '["bo","cy","dee"]', JSON.stringify(people));
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

t('matches rank prefix hits first, keep the server\'s relevance order, and cap at six', () => {
  const people = [{ login: 'cydana' }, { login: 'dana' }, { login: 'dan', name: 'X' }];
  const m = shell.matchMentionable(people, 'da');
  assert(JSON.stringify(m.map(p => p.login)) === '["dana","dan","cydana"]', JSON.stringify(m));
  // A name matches on any word, an email person on the address's parts.
  const folks = [{ login: 'yayashuxue', name: 'Jingyu Shi (Julie)' }, { login: 'email:claire@befreed.ai', name: 'claire' }];
  assert(shell.matchMentionable(folks, 'julie')[0].login === 'yayashuxue', 'name word');
  assert(shell.matchMentionable(folks, 'befreed')[0].login === 'email:claire@befreed.ai', 'email domain part');
  assert(shell.mentionReason({ tags: ['recent', 'teammate'] }) === 'teammate');
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
  for (const name of ['parseMentionLogins', 'emailTagAddress', 'looksLikeHost', 'handleStandsAlone', 'handleMayBeNamed', 'mentionCandidates', 'positionalRecipient']) {
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
