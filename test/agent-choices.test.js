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
vm.runInContext(`${read('shell/src/document/agent-choices.js').replace(/^export /gm, '')}\nthis.AGENT_TAG_JOINER = AGENT_TAG_JOINER;\nthis.SEND_TO_AGENT_WHO = SEND_TO_AGENT_WHO;`, box);
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

t('Ask AI ranks the last editor first and keeps the server recency order, excluding stopped agents', () => {
  const alice = raft('a', 'alice');
  const charlie = raft('c', 'charlie');
  const bob = raft('b', 'bob');
  const stopped = raft('z', 'zzz', { status: 'stopped' });
  const list = box.orderedAskAiChoices([charlie, stopped, bob, alice], bob);
  assert(JSON.stringify(list.map((agent) => agent.agent_name)) === JSON.stringify(['bob', 'charlie', 'alice']), names(list));
});

t('one row per agent: a team agent\'s claude and codex on one computer read once; claude by default, the doc\'s pick kept', () => {
  const team = (device, cli, id = 'ta_1', name = 'OpenTag') => ({ ...local(device, cli), team_agent: { id, name }, owner: { key: 'team-agent:ta_1', display: 'befreed team agent' } });
  const both = [team('mac', 'codex'), team('mac', 'claude'), local('juliesmac', 'claude'), local('juliesmac', 'codex')];
  const rows = box.oneRowPerAgent(both);
  assert(rows.length === 3, names(rows));
  assert(rows[0].cli === 'claude' && rows[0].team_agent.id === 'ta_1', 'the team agent row is not its Claude Code row');
  // The person's own Claude Code and Codex are two agents with two names.
  assert(rows.filter((t) => !t.team_agent).length === 2, 'own local agents were merged');
  assert(box.oneRowPerAgent(both, [team('mac', 'codex')])[0].cli === 'codex', 'the doc\'s own pick was replaced');
  // Two team agents on one computer stay two; one agent on two computers too.
  assert(box.oneRowPerAgent([team('mac', 'claude'), team('mac', 'claude', 'ta_2', 'Other')]).length === 2);
  assert(box.oneRowPerAgent([team('mac', 'claude'), team('box', 'claude')]).length === 2);
  const offered = box.orderedAgentChoices({ default: team('mac', 'codex'), candidates: [team('mac', 'claude'), raft('b', 'devin')] });
  assert(offered.length === 2 && offered[0].cli === 'codex', names(offered));
  const asked = box.orderedAskAiChoices([team('mac', 'codex'), team('mac', 'claude')]);
  assert(asked.length === 1 && asked[0].cli === 'claude', names(asked));
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
  assert(/matchAgentChoices\(byRelevance\(agentsOnOffer\.choices\)/.test(field), 'picker does not filter the shared list');
  // Every agent pill's menu, Ask AI's included, in that one order.
  assert(/AgentMenuItems choices=\{byRelevance\(choices\)\}/.test(field), 'the pill forks the order');
  assert(read('shell/src/document/ask-ai-panel.jsx').match(/AgentMenuItems choices=\{byRelevance\(choices\)\}/g)?.length === 2, 'Ask AI forks the order');
});

t('@ order: the agent that edited last, then the rest, tdoc AI last -- also once a name is typed', () => {
  const team = (id, name, extra = {}) => raft(id, name, { team_agent: { id, name }, ...extra });
  const list = [raft('m1', 'smart-julie-claude'), raft('m2', 'tdoc-bot'), team('ta2', 'tdoc-reviewer'),
    team('ta1', 'smarter-tdoc-claw', { last_writer: true }), { provider: 'tdoc', server_id: 'tdoc', agent_sub: 'tdoc-ai', agent_name: 'tdoc AI', tdoc_ai: true }];
  const order = box.byRelevance(list);
  const pick = (q) => box.matchAgentChoices(order, q, { limit: Infinity }).map((t) => box.agentMentionName(t, list));
  assert(JSON.stringify(pick('')) === JSON.stringify(['smarter-tdoc-claw', 'smart-julie-claude', 'tdoc-bot', 'tdoc-reviewer', 'tdoc AI']), JSON.stringify(pick('')));
  // Both prefix hits: use breaks the tie.
  assert(pick('sma')[0] === 'smarter-tdoc-claw', JSON.stringify(pick('sma')));
  assert(pick('tdoc-r')[0] === 'tdoc-reviewer', JSON.stringify(pick('tdoc-r')));
  // Typed, a prefix hit beats use (Enter picks the first); tdoc AI stays last.
  assert(JSON.stringify(pick('tdoc')) === JSON.stringify(['tdoc-bot', 'tdoc-reviewer', 'smarter-tdoc-claw', 'tdoc AI']), JSON.stringify(pick('tdoc')));
});

t('@ order: most recent use here beats the last editor; the viewer\'s others by recency; a team agent keeps its place', () => {
  const at = (h) => `2026-11-04T0${h}:00:00.000Z`;
  const team = raft('ta', 'crew', { team_agent: { id: 'ta', name: 'crew' } });
  const list = [
    raft('w', 'writer', { last_writer: true, used_here_at: at(1), last_touched: at(1) }),
    raft('r', 'replier', { used_here_at: at(2), last_touched: at(2) }),
    team,
    raft('o', 'older', { last_touched: at(3) }),
    raft('n', 'newer', { last_touched: at(4) }),
    { provider: 'tdoc', server_id: 'tdoc', agent_sub: 'tdoc-ai', agent_name: 'tdoc AI', tdoc_ai: true },
  ];
  const order = box.byRelevance(list).map((t) => t.agent_name);
  assert(JSON.stringify(order) === JSON.stringify(['replier', 'writer', 'crew', 'newer', 'older', 'tdoc AI']), JSON.stringify(order));
  assert(list[0].agent_name === 'writer', 'byRelevance moved the list it was given');
});

t('every surface names its default through composerDefault; the dialog keeps the server\'s', () => {
  const uses = (p) => /composerDefault\(agentChoices/.test(read(p));
  for (const p of ['shell/src/document-shell.jsx', 'shell/src/feedback-space.jsx', 'feedback/src/main.jsx']) assert(uses(p), `${p} forks the default`);
  assert(!/preselected: agentChoices\.find/.test(read('shell/src/feedback-space.jsx') + read('feedback/src/main.jsx') + read('shell/src/document-shell.jsx')), 'a first-row default is back');
  assert(/byRelevance\(agentChoices\)\[0\]/.test(read('shell/src/document-shell.jsx')), 'the Ask prefill is not the row on top');
  assert(/targets\.default \|\| null/.test(read('shell/src/document/notify-handoff.jsx')), 'the dialog moved off the server default');
});

t('a poll keeps the use the last full read gave', () => {
  const prev = { agents: [raft('a', 'a', { used_here_at: 'T' }), raft('b', 'b')], team_agents: [] };
  const body = { tier: 'online', agents: [raft('a', 'a', { status: 'active' }), raft('b', 'b')], team_agents: [], asks: [1] };
  const kept = box.keepAgentUse(prev, body);
  assert(kept.agents[0].used_here_at === 'T' && kept.agents[0].status === 'active' && !kept.agents[1].used_here_at, JSON.stringify(kept.agents));
  assert(kept.asks[0] === 1, 'the poll\'s news was lost');
  assert(box.keepAgentUse(null, body) === body, 'first read');
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
  assert(text.replace(box.AGENT_TAG_JOINER, '') === 'please fix @Claude Code thanks', text);
  const raw = `@${box.AGENT_TAG_JOINER}${box.agentMentionName(raft('c', 'smarter-tdoc-claw'))}`;
  assert(!new RegExp(box.MENTION_RE.source, 'g').test(`see ${raw}`), 'a handle-named tag reads as @login');
});

t('the tag is the short name; the owner only when two agents share it (Julie, 2026-10-25)', () => {
  const list = box.orderedAgentChoices(targets);
  assert(JSON.stringify(list.map((x) => box.agentMentionName(x, list))) === JSON.stringify(['xiaocc', 'Claude Code', 'Codex', 'devin']));
  assert(box.agentMentionName({ tdoc_ai: true }, list) === 'tdoc AI');
  assert(box.agentMentionName({ ...raft('t', 'bot'), team_agent: { id: 'ta', name: 'tdoc-bot' }, owner: { display: 'Tdoc team agent' } }, list) === 'tdoc-bot');
  const owners = [local('juliesmac', 'claude'), { ...local('bobmac', 'claude'), owner: { display: 'bob' } }];
  assert(JSON.stringify(owners.map((x) => box.agentMentionName(x, owners))) === JSON.stringify(['Claude Code · julie', 'Claude Code · bob']));
  // A draft from before the short tags still names its agent, whole.
  const old = `@${box.AGENT_TAG_JOINER}Claude Code · julie`;
  const span = box.taggedAgentSpan(`fix ${old} now`, list);
  assert(span && span.target === list[1] && span.end - span.start === old.length, JSON.stringify(span));
});

t('a posted text hands itself to the first agent it tags', () => {
  const list = box.orderedAgentChoices(targets);
  const tag = (x, from = list) => `@${box.AGENT_TAG_JOINER}${box.agentMentionName(x, from)}`;
  assert(box.taggedAgent(`fix ${tag(list[2])} and ${tag(list[3])}`, list) === list[2]);
  assert(box.taggedAgent(`${tag(list[3])}: please`, list) === list[3]);
  // Typed by hand, without the picker, it is a person's @login as before.
  assert(box.taggedAgent('fix @devin please', list) === null);
  assert(box.taggedAgent(`fix ${tag(list[2])}`, []) === null, 'no agents on offer, no handoff');
  const bare = { provider: 'raft', server_id: 'S2', agent_sub: 'd2', agent_name: 'devin' };
  assert(box.taggedAgent(`fix ${tag(list[3], [bare, ...list])}`, [bare, ...list]) === list[3], 'a shorter name took the longer tag');
});

t('a tag with the location suffix hands itself to the right twin', () => {
  const two = [local('juliesmac', 'claude'), local('mac-mini', 'claude')];
  const tag = (x) => `@${box.AGENT_TAG_JOINER}${box.agentMentionName(x, two)}`;
  assert(tag(two[1]).endsWith('Claude Code · julie · mac-mini'), tag(two[1]));
  assert(box.taggedAgent(`fix ${tag(two[1])}`, two) === two[1], 'the suffixed tag went to the other machine');
  assert(box.taggedAgent(`fix ${tag(two[0])} now`, two) === two[0]);
});

t('a reply box answers an agent only for the viewer\'s own agent: not tdoc AI, not a person, not a reply further up', () => {
  const choices = [local('juliesmac', 'claude'), { tdoc_ai: true, owner }];
  const reply = (id, author) => ({ id, created: '2026-11-04T00:00:00Z', author });
  const claude = { kind: 'agent', login: 'claude', handle: 'claude', provider: 'local', cli: 'claude', location: 'juliesmac', owner };
  const thread = (replies) => ({ id: 'c', replies });
  assert(box.agentForThread(thread([reply('r', claude)]), choices, 'c') === choices[0], 'own agent');
  assert(box.agentForThread(thread([reply('r', { kind: 'agent', login: 'tdoc-ai', owner })]), choices, 'c') === null, 'tdoc AI costs quota');
  assert(box.agentForThread(thread([reply('r', { kind: 'user', login: 'dana' })]), choices, 'c') === null, 'a person');
  assert(box.agentForThread(thread([reply('r', claude)]), choices, 'other') === null, 'a box answering someone else');
});

t('Send to agent is one state for every surface: ready, connect, or disabled with the reason', () => {
  const editable = [{ ...local('juliesmac', 'claude'), can_edit: true }];
  const answerOnly = [{ ...local('bobmac', 'codex'), can_edit: false }];
  const ready = box.sendToAgentState({ canSendToAgent: true, choices: [...answerOnly, ...editable] });
  assert(ready.kind === 'ready' && ready.choices.length === 1 && ready.choices[0].can_edit, JSON.stringify(ready));
  const connect = box.sendToAgentState({ canSendToAgent: false, choices: answerOnly, connectPrompt: 'prompt', setupHref: '/me?view=settings#agents' });
  assert(connect.kind === 'connect' && connect.href === '/me?view=settings#agents', JSON.stringify(connect));
  const denied = box.sendToAgentState({ canSendToAgent: false, choices: editable, disabledReason: 'Only the doc author or a team admin can send comments to an agent' });
  assert(denied.kind === 'disabled' && /doc author/.test(denied.reason), JSON.stringify(denied));
  assert(box.sendToAgentState({ canSendToAgent: true, choices: answerOnly }).kind === 'disabled', 'answer-only agents are not send targets');
  for (const p of ['shell/src/document-shell.jsx', 'shell/src/feedback-space.jsx', 'feedback/src/main.jsx']) {
    assert(/sendToAgentState\(/.test(read(p)), `${p} does not use the shared Send to agent state`);
  }
  const ask = read('shell/src/document/agent-ask.jsx');
  const composer = read('shell/src/document/comment-composer.jsx');
  const card = read('shell/src/document/comment-card.jsx');
  assert(/export function SendToAgentToggle/.test(ask), 'the shared control is missing');
  assert(/<SendToAgentToggle/.test(composer) && /<SendToAgentToggle/.test(card), 'a composer forked the control');
});

t('notify target reasons become the control\'s hover text', () => {
  assert(box.notifyHandoffReasonText('no_agent_bound') === null, 'no_agent_bound is the connect state, not a reason');
  assert(/workspace admin/.test(box.notifyHandoffReasonText('team_admin_only')));
  assert(/always-on agent/.test(box.notifyHandoffReasonText('no_team_daemon')));
  assert(/team has no agent/.test(box.notifyHandoffReasonText('no_team_agent')));
  assert(/did not write this doc/.test(box.notifyHandoffReasonText('team_agent_not_writer')));
  assert(box.notifyHandoffReasonText('something_new') === 'No agent can take comments here yet.');
});

t('who may send to an agent: one rule and one sentence, the server\'s, on the doc page, the space page and the widget', () => {
  // The server (POST /api/notify/handoff): the owner (authorizeOwnerMutation)
  // or, on a team doc, any current member (teamAgentCaller).
  const route = workerSrc.slice(workerSrc.indexOf("if (p === '/api/notify/handoff' && method === 'POST')"));
  assert(/Any current member may send to the team's own agent \(teamAgentCaller\)/.test(route.slice(0, 6000)), 'the server rule moved; re-check SEND_TO_AGENT_WHO');
  assert(box.maySendToAgent({ owner: true }) && box.maySendToAgent({ teamMember: true }) && !box.maySendToAgent({}), 'owner or member');
  assert(/owner or a member of its team/.test(box.SEND_TO_AGENT_WHO), box.SEND_TO_AGENT_WHO);
  const surfaces = {
    'shell/src/document-shell.jsx': read('shell/src/document-shell.jsx'),
    'shell/src/feedback-space.jsx': read('shell/src/feedback-space.jsx'),
    'feedback/src/main.jsx': read('feedback/src/main.jsx'),
  };
  for (const [p, src] of Object.entries(surfaces)) {
    assert(/maySendToAgent\(\{/.test(src), `${p} does not use the shared owner/member rule`);
    assert(/sendToAgentSetup\(\{/.test(src), `${p} does not use the shared reason and setup link`);
    assert(!/Only the (doc|space) (author|owner)/.test(src) && !/can send comments to an agent'/.test(src), `${p} has its own wording`);
    // The setup link is never decided from the owner alone.
    assert(!/SetupHref = isOwner/.test(src) && !/SetupHref = owner/.test(src), `${p} builds the setup link from the owner only`);
  }
  // Same inputs, same answer, whichever surface asks.
  const no = box.sendToAgentSetup({ canSendToAgent: false, may: false, targets: { ready: true, reason: 'no_agent_bound' }, href: '/x' });
  assert(no.disabledReason === box.SEND_TO_AGENT_WHO && no.setupHref === null, JSON.stringify(no));
  const member = box.sendToAgentSetup({ canSendToAgent: false, may: box.maySendToAgent({ teamMember: true }), targets: { ready: true, reason: 'no_agent_bound' }, href: '/x' });
  assert(member.setupHref === '/x', `a team member gets the setup link: ${JSON.stringify(member)}`);
  assert(box.sendToAgentSetup({ may: true, notifyOn: false, targets: { ready: true, reason: 'no_agent_bound' }, href: '/x' }).setupHref === null, 'no host notify, no link');
  assert(/Finding/.test(box.sendToAgentSetup({ may: true, targets: { ready: false } }).disabledReason));
  assert(/workspace admin/.test(box.sendToAgentSetup({ may: true, targets: { ready: true, reason: 'team_admin_only' } }).disabledReason));
  assert(box.sendToAgentSetup({ canSendToAgent: true, may: true, targets: { ready: true } }).disabledReason === null);
});

t('the control\'s words: @agent for a send target (the pre-#1034 label), Ask for an agent that may only answer; the click puts in the box\'s default', () => {
  const editable = [{ ...local('juliesmac', 'claude'), can_edit: true }];
  const answerOnly = [{ ...local('bobmac', 'codex'), can_edit: false }];
  const send = box.sendToAgentWords(editable[0], { editable, offer: [...editable, ...answerOnly] });
  assert(send.label === '@agent' && /^Send this comment to /.test(send.title) && send.off === "Don't send", JSON.stringify(send));
  assert(!/Send to agent/.test(send.label), 'the button is named "Send to agent" again');
  const askW = box.sendToAgentWords(answerOnly[0], { editable: [], offer: answerOnly });
  assert(/^Ask /.test(askW.label) && !/Send/.test(askW.label) && /^Ask .* about this comment$/.test(askW.title) && askW.off === "Don't ask", JSON.stringify(askW));
  // In a ready box, an answer-only agent picked from @ is still asked.
  assert(/^Ask /.test(box.sendToAgentWords(answerOnly[0], { editable, offer: [...editable, ...answerOnly] }).label));
  assert(box.sendToAgentWords(null).label === '@agent');
  assert(box.sendToAgentWords(null, { asking: true }).label === 'Ask agent' && /^Ask an agent/.test(box.sendToAgentWords(null, { asking: true }).title));
  // The toggle, as the pre-#1034 @agent button (AgentButton): its click puts
  // in the box's default (putDefault: composerDefault, never somebody
  // else's agent for a member or reader), else a bare @ to pick from.
  const ask = read('shell/src/document/agent-ask.jsx');
  const toggle = ask.slice(ask.indexOf('export function SendToAgentToggle'), ask.indexOf('// "Ask only", beside the send button'));
  assert(/onClick=\{ask\.putDefault\}/.test(toggle), 'the click does not put in the box\'s default');
  assert(!/>Send to agent</.test(toggle), 'a "Send to agent" label in the comment boxes');
  assert(/sendToAgentWords\(shown/.test(toggle), 'the label is not the shared wording');
  assert(!/editable\[0\]|offer\[0\]/.test(toggle.slice(toggle.indexOf('const fallback'), toggle.indexOf('const shown'))), 'the tooltip names an agent the click would not put in');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
