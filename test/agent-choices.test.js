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

const raft = (sub, name, extra = {}) => ({ provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: sub, agent_name: name, ...extra });
const local = (device, cli) => ({ provider: 'local', server_id: device, device, cli, agent_sub: `${device}_${cli}`, agent_name: `${cli} on ${device}` });
const doc = raft('a', 'xiaocc', { source: 'doc' });
const targets = {
  default: doc,
  candidates: [raft('a', 'xiaocc'), local('juliesmac', 'claude'), local('juliesmac', 'codex'), raft('b', 'devin')],
  fallback: raft('b', 'devin'),
};
const names = (list) => JSON.stringify(list.map((x) => box.agentDisplayName(x)));

console.log('agent choices');

t('default, then candidates, then fallback — each agent once', () => {
  const list = box.orderedAgentChoices(targets);
  assert(names(list) === JSON.stringify(['xiaocc · acme', 'Claude Code · juliesmac', 'Codex · juliesmac', 'devin · acme']), names(list));
  assert(box.orderedAgentChoices({ default: null, candidates: [], fallback: raft('z', 'zed') }).length === 1);
  assert(box.orderedAgentChoices(null).length === 0, 'no targets offers nobody');
});

t('the dropdown and the picker read the same helper', () => {
  const panel = read('shell/src/document/notify-handoff.jsx');
  const field = read('shell/src/document/mention-field.jsx');
  const shell = read('shell/src/document-shell.jsx');
  assert(/const choices = orderedAgentChoices\(targets\);/.test(panel), 'panel forks the ordering');
  assert(/orderedAgentChoices\(notifyTargets\)/.test(shell), 'picker list not from orderedAgentChoices');
  assert(/choices: orderedAgentChoices\(notifyTargets\)[^]*: \{ choices: \[\], preselected: null \}/.test(shell), 'agents offered without canSendToAgent');
  assert(/matchAgentChoices\(agentsOnOffer\.choices/.test(field), 'picker does not filter the shared list');
});

t('nothing typed: the first two agents only', () => {
  const list = box.orderedAgentChoices(targets);
  assert(names(box.matchAgentChoices(list, '')) === JSON.stringify(['xiaocc · acme', 'Claude Code · juliesmac']));
});

t('typing searches every agent, not just the first two', () => {
  const list = box.orderedAgentChoices(targets);
  assert(names(box.matchAgentChoices(list, 'dev')) === JSON.stringify(['devin · acme']));
  assert(names(box.matchAgentChoices(list, 'codex')) === JSON.stringify(['Codex · juliesmac']));
  // A prefix hit ranks above a word hit: "cod" is Codex first, then Claude Code.
  assert(names(box.matchAgentChoices(list, 'cod')) === JSON.stringify(['Codex · juliesmac', 'Claude Code · juliesmac']));
  // The machine name finds both of its agents, in the dropdown's order.
  assert(names(box.matchAgentChoices(list, 'julies')) === JSON.stringify(['Claude Code · juliesmac', 'Codex · juliesmac']));
  // The stored name ("claude on juliesmac") still matches.
  assert(names(box.matchAgentChoices(list, 'claude')) === JSON.stringify(['Claude Code · juliesmac']));
  assert(box.matchAgentChoices(list, 'nobody').length === 0);
});

t('labels say which agent and where it runs', () => {
  assert(box.agentDisplayName(local('studio', 'claude')) === 'Claude Code · studio');
  assert(box.agentDisplayName(local('studio', 'codex')) === 'Codex · studio');
  assert(box.agentDisplayName(raft('c', 'bot — writes docs')) === 'bot · acme');
  // An opaque id is no name: say which kind of agent it is instead.
  assert(box.agentDisplayName(raft('0f0e3a4c-1111-2222-3333-444455556666', '')) === 'Raft agent · acme');
});

t('the inserted tag names the agent and is never read as a GitHub login', () => {
  const tag = `@${box.AGENT_TAG_JOINER}${box.agentMentionName(local('juliesmac', 'claude'))}`;
  const text = `please fix ${tag} thanks`;
  assert(!new RegExp(box.MENTION_RE.source, 'g').test(text), 'server would parse the tag as @login');
  assert(text.replace(box.AGENT_TAG_JOINER, '') === 'please fix @Claude Code · juliesmac thanks');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
