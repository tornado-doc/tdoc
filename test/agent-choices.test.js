// The agents @ offers are the Send to agent dropdown's agents, in its order:
// one helper (shell/src/document/agent-choices.js) feeds both. With nothing
// typed the picker shows the first two; a typed name searches all of them.
// The tag it inserts names the agent clearly and is never a GitHub @login.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(n, fn) {
  try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const box = {};
vm.createContext(box);
// `const` stays script-scoped in a vm context; hand the joiner out by name.
vm.runInContext(`${read('shell/src/document/agent-choices.js').replace(/^export /gm, '')}\nthis.AGENT_TAG_JOINER = AGENT_TAG_JOINER;`, box);
// The server's own mention pattern, so the tag is checked against the real one.
const workerSrc = read('worker/worker.js');
const reLine = workerSrc.slice(workerSrc.indexOf('const MENTION_RE ='), workerSrc.indexOf('\n', workerSrc.indexOf('const MENTION_RE =')));
vm.runInContext(`${reLine}\nthis.MENTION_RE = MENTION_RE;`, box);

// The worker stamps who each connection belongs to; here, julie.
const owner = { key: 'julie', display: 'julie' };
const raft = (sub, name, extra = {}) => ({ provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: sub, agent_name: name, owner, ...extra });
const local = (device, cli) => ({ provider: 'local', server_id: device, device, cli, agent_sub: `${device}_${cli}`, agent_name: `${cli} on ${device}`, owner });
const doc = raft('a', 'xiaocc', { source: 'doc' });
const targets = {
  default: doc,
  candidates: [raft('a', 'xiaocc'), local('juliesmac', 'claude'), local('juliesmac', 'codex'), raft('b', 'devin')],
  fallback: raft('b', 'devin'),
};
const names = (list) => JSON.stringify(list.map((x) => box.agentDisplayName(x, list)));

console.log('agent choices');

t('default, then candidates, then fallback — each agent once', () => {
  const list = box.orderedAgentChoices(targets);
  assert(names(list) === JSON.stringify(['xiaocc · julie', 'Claude Code · julie', 'Codex · julie', 'devin · julie']), names(list));
  assert(box.orderedAgentChoices({ default: null, candidates: [], fallback: raft('z', 'zed') }).length === 1);
  assert(box.orderedAgentChoices(null).length === 0, 'no targets offers nobody');
});

t('the dropdown and the picker read the same helper', () => {
  const panel = read('shell/src/document/notify-handoff.jsx');
  const field = read('shell/src/document/mention-field.jsx');
  const shell = read('shell/src/document-shell.jsx');
  assert(/const choices = orderedAgentChoices\(targets\);/.test(panel), 'panel forks the ordering');
  // The @ list is composerAgents (ai-answerer.js): the edit list is
  // orderedAgentChoices of the same targets, and only when the viewer may send.
  const answerer = read('shell/src/document/ai-answerer.js');
  assert(/const edit = canSendToAgent \? orderedAgentChoices\(notifyTargets\) : \[\];/.test(answerer), 'picker list not from orderedAgentChoices');
  assert(/composerAgents\(\{\s*canSendToAgent,\s*notifyTargets,/.test(shell), 'the shell does not build the @ list from the send targets');
  assert(/matchAgentChoices\(agentsOnOffer\.choices/.test(field), 'picker does not filter the shared list');
});

t('nothing typed: the first two agents only', () => {
  const list = box.orderedAgentChoices(targets);
  assert(names(box.matchAgentChoices(list, '')) === JSON.stringify(['xiaocc · julie', 'Claude Code · julie']));
});

t('typing searches every agent, not just the first two', () => {
  const list = box.orderedAgentChoices(targets);
  const found = (q) => JSON.stringify(box.matchAgentChoices(list, q).map((x) => box.agentDisplayName(x, list)));
  assert(found('dev') === JSON.stringify(['devin · julie']));
  assert(found('codex') === JSON.stringify(['Codex · julie']));
  // A prefix hit ranks above a word hit: "cod" is Codex first, then Claude Code.
  assert(found('cod') === JSON.stringify(['Codex · julie', 'Claude Code · julie']));
  // The machine name finds both of its agents, though the label leaves it out.
  assert(found('julies') === JSON.stringify(['Claude Code · julie', 'Codex · julie']));
  // The Raft server too.
  assert(found('acme') === JSON.stringify(['xiaocc · julie', 'devin · julie']));
  // The stored name ("claude on juliesmac") still matches.
  assert(found('claude') === JSON.stringify(['Claude Code · julie']));
  assert(box.matchAgentChoices(list, 'nobody').length === 0);
});

t('every agent reads "<name> · <owner>", whatever runs it', () => {
  assert(box.agentDisplayName(local('studio', 'claude')) === 'Claude Code · julie');
  assert(box.agentDisplayName(local('studio', 'codex')) === 'Codex · julie');
  assert(box.agentDisplayName(raft('c', 'bot — writes docs')) === 'bot · julie');
  // The Raft server is where it runs, not who it acts for.
  assert(box.agentDisplayName(raft('c', 'smarter-tdoc-claw', { server_slug: 'julie', owner: { display: 'yayashuxue' } })) === 'smarter-tdoc-claw · yayashuxue');
  // An opaque id is no name: say which kind of agent it is instead.
  assert(box.agentDisplayName(raft('0f0e3a4c-1111-2222-3333-444455556666', '')) === 'Raft agent · julie');
  const hook = { provider: 'webhook', server_id: 'webhook', agent_sub: 'wh_0123456789abcdef', agent_name: '', url: 'https://hooks.example.com/x', owner };
  assert(box.agentDisplayName(hook) === 'Webhook · julie', box.agentDisplayName(hook));
  // A server that sent no owner: the name alone, never a guess.
  assert(box.agentDisplayName({ ...local('studio', 'claude'), owner: undefined }) === 'Claude Code');
});

t('where it runs is added only to tell two otherwise identical agents apart', () => {
  const two = [local('juliesmac', 'claude'), local('mac-mini', 'claude'), local('juliesmac', 'codex')];
  assert(names(two) === JSON.stringify(['Claude Code · julie · juliesmac', 'Claude Code · julie · mac-mini', 'Codex · julie']), names(two));
  const servers = [raft('a', 'devin'), raft('b', 'devin', { server_id: 'S2', server_slug: 'beta' })];
  assert(names(servers) === JSON.stringify(['devin · julie · acme', 'devin · julie · beta']), names(servers));
  // Another owner is already a different label.
  const owners = [local('juliesmac', 'claude'), { ...local('bobmac', 'claude'), owner: { display: 'bob' } }];
  assert(names(owners) === JSON.stringify(['Claude Code · julie', 'Claude Code · bob']), names(owners));
});

t('the hover card lists all five facts', () => {
  const facts = box.agentFacts({ ...raft('c', 'smarter-tdoc-claw', { server_slug: 'acme' }), scope: 'personal' });
  assert(JSON.stringify(facts.map((f) => `${f.label}=${f.value}`)) === JSON.stringify(['Name=smarter-tdoc-claw', 'Acts for=julie', 'Program=Raft', 'Location=acme', 'Scope=Personal']), JSON.stringify(facts));
  // An agent reply as the worker stamps it.
  const reply = { kind: 'agent', login: 'claude', name: 'Claude', provider: 'local', cli: 'claude', location: 'juliesmac', owner, scope: 'team' };
  assert(box.agentDisplayName(reply) === 'Claude Code · julie');
  assert(JSON.stringify(box.agentFacts(reply).map((f) => f.value)) === JSON.stringify(['Claude Code', 'julie', 'Claude Code', 'juliesmac', 'Team']));
  const raftReply = { kind: 'agent', login: 'claude', name: 'Claude', provider: 'raft', handle: '@smarter-tdoc-claw', location: 'julie', owner: { display: 'yayashuxue' }, principal: { display: '@yayashuxue', terminal: 'Claude' } };
  assert(box.agentDisplayName(raftReply) === 'smarter-tdoc-claw · yayashuxue');
  assert(box.agentFacts(raftReply)[2].value === 'Raft (Claude)');
});

t('the inserted tag names the agent and is never read as a GitHub login', () => {
  const tag = `@${box.AGENT_TAG_JOINER}${box.agentMentionName(local('juliesmac', 'claude'))}`;
  const text = `please fix ${tag} thanks`;
  assert(!new RegExp(box.MENTION_RE.source, 'g').test(text), 'server would parse the tag as @login');
  assert(text.replace(box.AGENT_TAG_JOINER, '') === 'please fix @Claude Code · julie thanks');
  const raw = `@${box.AGENT_TAG_JOINER}${box.agentMentionName(raft('c', 'smarter-tdoc-claw'))}`;
  assert(!new RegExp(box.MENTION_RE.source, 'g').test(`see ${raw}`), 'a handle-named tag reads as @login');
});

t('a posted text hands itself to the first agent it tags', () => {
  const list = box.orderedAgentChoices(targets);
  const tag = (x) => `@${box.AGENT_TAG_JOINER}${box.agentMentionName(x)}`;
  assert(box.taggedAgent(`fix ${tag(list[2])} and ${tag(list[3])}`, list) === list[2]);
  assert(box.taggedAgent(`${tag(list[3])}: please`, list) === list[3]);
  // Typed by hand, without the picker, it is a person's @login as before.
  assert(box.taggedAgent('fix @devin please', list) === null);
  assert(box.taggedAgent(`fix ${tag(list[2])}`, []) === null, 'no agents on offer, no handoff');
  const bare = { provider: 'raft', server_id: 'S2', agent_sub: 'd2', agent_name: 'devin' };
  assert(box.taggedAgent(`fix ${tag(list[3])}`, [bare, ...list]) === list[3], 'a shorter name took the longer tag');
});

t('a tag with the location suffix hands itself to the right twin', () => {
  const two = [local('juliesmac', 'claude'), local('mac-mini', 'claude')];
  const tag = (x) => `@${box.AGENT_TAG_JOINER}${box.agentMentionName(x, two)}`;
  assert(tag(two[1]).endsWith('Claude Code · julie · mac-mini'), tag(two[1]));
  assert(box.taggedAgent(`fix ${tag(two[1])}`, two) === two[1], 'the suffixed tag went to the other machine');
  assert(box.taggedAgent(`fix ${tag(two[0])} now`, two) === two[0]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
