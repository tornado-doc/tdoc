// The agents a person can hand comments to, as one ordered list — the pure
// half shared by the Send to agent dropdown and the @ picker, so both offer
// the same agents in the same order. No React, no API: the shell feeds it
// what useNotifyTargets fetched.

function opaqueAgentId(s) {
  if (!s) return true;
  // Raft `sub` is often a UUID / long hex — fine as a key, useless as a label.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{24,}$/i.test(s)) return true;
  // A webhook's id (wh_…) names the hook, not an agent.
  if (/^wh_[0-9a-f]{16,40}$/i.test(s)) return true;
  return false;
}

function shortAgentName(name) {
  // "handle — bio…" / "handle - bio…" → keep the handle side.
  const cut = name.split(/\s+[—–-]\s+/)[0].trim();
  return (cut || name).slice(0, 48);
}

// Readable agent handle when we have one. Empty is fine — the UI falls back
// to the provider line so we never render "Hand to " with a blank.
export function readableHandle(t) {
  if (!t) return '';
  const name = (t.agent_name || '').trim();
  const sub = (t.agent_sub || '').trim();
  if (name && !opaqueAgentId(name)) return shortAgentName(name);
  if (sub && !opaqueAgentId(sub)) return sub;
  return '';
}

export function providerMeta(t) {
  const p = String(t?.provider || 'raft').trim().toLowerCase();
  if (p === 'raft') {
    return { key: 'raft', label: 'Raft', mark: 'raft' };
  }
  if (p === 'webhook') {
    return { key: 'webhook', label: 'Webhook', mark: 'webhook' };
  }
  if (p === 'local') {
    return { key: 'local', label: 'Local', mark: 'local' };
  }
  return { key: p || 'agent', label: p ? p[0].toUpperCase() + p.slice(1) : 'agent', mark: '' };
}

// The program a local daemon runs, by its product name.
const LOCAL_CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' };

// Which CLI a local agent is: a target names it (or its agent_sub does), an
// agent reply stamps it, and a reply older than that only has its login.
export function agentCli(t) {
  if (!t) return '';
  const cli = String(t.cli || '').toLowerCase();
  if (cli) return cli;
  if (t.kind === 'agent') return String(t.login || '').toLowerCase();
  return String(t.agent_sub || '').slice(String(t.device || t.server_id || '').length + 1).toLowerCase();
}

// The program behind an agent: the Raft / Claude Code / Codex / Webhook its
// mark shows, and what an agent with no name of its own is called.
export function agentProgram(t) {
  if (!t) return '';
  const { key, label } = providerMeta(t);
  if (key === 'local' || (t.kind === 'agent' && !t.provider)) {
    const cli = agentCli(t);
    return LOCAL_CLI_NAMES[cli] || (t.kind === 'agent' && t.name) || (cli ? cli[0].toUpperCase() + cli.slice(1) : 'Local agent');
  }
  return label;
}

// The agent's own readable name, else its program's ("Raft agent" for a
// Raft agent whose handle is an opaque id). A local agent has no name of its
// own: "claude on juliesmac" is the program and the computer.
export function agentName(t) {
  if (!t) return '';
  // tdoc's own cloud answerer (Ask only, when no agent can answer).
  if (t.tdoc_ai) return 'tdoc AI';
  // A team agent goes by the name its admin gave it, on its rows and replies.
  if (t.team_agent && t.team_agent.name) return String(t.team_agent.name);
  if (t.kind === 'agent') {
    const handle = String(t.handle || '').replace(/^@/, '').trim();
    if (handle) return handle;
  } else if (t.provider !== 'local') {
    const handle = readableHandle(t);
    if (handle) return handle;
  }
  const program = agentProgram(t);
  return t.provider === 'raft' || (!t.provider && t.kind !== 'agent') ? `${program} agent` : program;
}

// Where it runs: the Raft server, the daemon's computer, the webhook's host.
// Not part of the label unless two agents would otherwise read the same.
export function agentLocation(t) {
  if (!t) return '';
  if (t.kind === 'agent') return String(t.location || '');
  if (t.provider === 'raft') return t.server_slug || '';
  if (t.provider === 'local') return t.device || t.server_id || '';
  if (t.provider === 'webhook') {
    try { return new URL(t.url).host; } catch { return ''; }
  }
  return '';
}

// The tdoc account it acts for, as the server stamped it from the
// connection or the posting token. Never guessed here.
export function agentOwner(t) {
  return String((t && t.owner && t.owner.display) || '').trim();
}

function baseAgentName(t) {
  const name = agentName(t);
  const owner = agentOwner(t);
  return owner ? `${name} · ${owner}` : name;
}

// Every agent, whatever runs it, in one shape: "<name> · <owner>", e.g.
// "smarter-tdoc-claw · yayashuxue" or "Claude Code · julie". Given the list
// it sits in, an agent that would read the same as another one gets where it
// runs appended ("Claude Code · julie · Mac mini") — and only then.
// The dropdown's rows and the @ tag both read this.
export function agentDisplayName(t, list = null) {
  if (!t) return '';
  const base = baseAgentName(t);
  const where = agentLocation(t);
  if (!where || !Array.isArray(list)) return base;
  const lower = base.toLowerCase();
  const clash = list.some((o) => o && o !== t && !sameTarget(o, t) && baseAgentName(o).toLowerCase() === lower);
  return clash ? `${base} · ${where}` : base;
}

// The five facts the hover card lists; the label carries only two of them.
export function agentFacts(t) {
  if (!t) return [];
  const scope = t.scope || '';
  // A Raft or webhook agent's reply also says which runtime answered.
  const runtime = t.kind === 'agent' && t.provider !== 'local' ? (t.principal && t.principal.terminal) || '' : '';
  const program = runtime && runtime !== agentProgram(t) ? `${agentProgram(t)} (${runtime})` : agentProgram(t);
  return [
    ['Name', agentName(t)],
    ['Acts for', agentOwner(t)],
    ['Program', program],
    ['Location', agentLocation(t)],
    ['Scope', scope ? scope[0].toUpperCase() + scope.slice(1) : ''],
  ].map(([label, value]) => ({ label, value: value || '—' }));
}

export function targetKey(t) {
  if (!t) return '';
  // Two team agents may run on computers of the same name: the agent tells
  // them apart.
  const agent = t.team_agent && t.team_agent.id ? `:${t.team_agent.id}` : '';
  return `${t.provider}:${t.server_id}:${t.agent_sub}${agent}`;
}

export function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider
    && a.server_id === b.server_id
    && a.agent_sub === b.agent_sub
    // Two team agents on computers of the same name differ by agent; a row
    // that does not say which (a stored handoff's recipient) still matches.
    && !(a.team_agent && b.team_agent && a.team_agent.id !== b.team_agent.id);
}

// One agent, several rows: a team agent's daemon registers one target per
// CLI on its computer (bin/lib/daemon.js register; worker teamAgentTargets),
// so "OpenTag" on "mac" came back twice, once for claude and once for codex,
// and both rows read the same. They are one agent on one computer: the key
// is the agent and the computer, not the program it runs.
function sameAgentKey(t) {
  if (!t || t.provider !== 'local' || !(t.team_agent && t.team_agent.id)) return '';
  return `local:${t.device || t.server_id}:${t.team_agent.id}`;
}

// Each agent once: of the rows that are one agent on one computer, the one
// in `keep` (the doc's default, the current pick) if there is one, else its
// Claude Code row, else the first. The kept row takes the first one's place.
export function oneRowPerAgent(list, keep = []) {
  const rows = (Array.isArray(list) ? list : []).filter(Boolean);
  const kept = (Array.isArray(keep) ? keep : [keep]).filter(Boolean);
  const groups = new Map();
  for (const t of rows) {
    const key = sameAgentKey(t);
    if (key) groups.set(key, [...(groups.get(key) || []), t]);
  }
  const out = [];
  const done = new Set();
  for (const t of rows) {
    const key = sameAgentKey(t);
    if (!key) { out.push(t); continue; }
    if (done.has(key)) continue;
    done.add(key);
    const group = groups.get(key);
    out.push(group.find((x) => kept.some((k) => sameTarget(k, x)))
      || group.find((x) => agentCli(x) === 'claude')
      || group[0]);
  }
  return out;
}

// This doc's agent (or the account default) first, then the others that
// worked with tdoc or are in the server's directory, then the fallback —
// each agent once.
export function orderedAgentChoices(targets) {
  const choices = [];
  if (!targets) return choices;
  if (targets.default) choices.push(targets.default);
  for (const c of (Array.isArray(targets.candidates) ? targets.candidates : [])) {
    if (c && !choices.some((x) => sameTarget(x, c))) choices.push(c);
  }
  if (targets.fallback && !choices.some((x) => sameTarget(x, targets.fallback))) {
    choices.push(targets.fallback);
  }
  return oneRowPerAgent(choices, [targets.default]);
}

// A word joiner after the `@`: the tag reads "@claude", but the server's
// mention pattern needs a letter right after the `@`, so it is never taken
// for the GitHub user "claude" (an owner's @login invites that person).
export const AGENT_TAG_JOINER = '⁠';

// What the @ tag (and the agent pill) says: the agent's short name --
// "tdoc-bot", "tdoc AI", "smarter-tdoc-claw" (Julie, 2026-10-25: the
// "· owner" suffix made the pill too long). Only when another agent in the
// list has the same short name does it take the full display name ("claude ·
// julie", then where it runs). Minus any `@` of its own (a second `@` inside
// the tag could read as an address).
export function agentMentionName(t, list = null) {
  if (!t) return '';
  const short = agentName(t);
  const lower = short.toLowerCase();
  const twin = Array.isArray(list)
    && list.some((o) => o && o !== t && !sameTarget(o, t) && agentName(o).toLowerCase() === lower);
  return (twin ? agentDisplayName(t, list) : short).replace(/@/g, '').trim();
}

// Ask AI is answer-only. Lead with the agent that most recently wrote this
// document when available. The server's remaining order reflects recent use.
export function orderedAskAiChoices(agents, recent = null) {
  return oneRowPerAgent((agents || []).filter((agent) => agent && agent.status !== 'stopped')
    .sort((a, b) => Number(Boolean(recent && sameTarget(b, recent))) - Number(Boolean(recent && sameTarget(a, recent)))
      || Number(Boolean(b.last_writer)) - Number(Boolean(a.last_writer))), [recent]);
}

// The @ list's order. Agents used on this doc first, most recent on top
// (used_here_at, from the server; the last editor counts as used), then the
// rest in the order given with the viewer's own most recent first (a team
// agent keeps its place), tdoc AI always last. composerDefault below picks from
// this same order, so the row on top is the row a composer's default means.
const relevance = (t) => (t.tdoc_ai ? 2 : t.used_here_at || t.last_writer ? 0 : 1);
const newestFirst = (a, b) => String(b || '').localeCompare(String(a || ''));
export function byRelevance(list) {
  const rows = (Array.isArray(list) ? list.filter(Boolean) : []).map((t, i) => ({ t, i }));
  const ranked = rows.sort((a, b) => (relevance(a.t) - relevance(b.t))
    || (relevance(a.t) === 0 ? newestFirst(a.t.used_here_at, b.t.used_here_at) : 0) || (a.i - b.i));
  const reorders = ({ t }) => relevance(t) === 1 && !t.team_agent;
  const own = ranked.filter(reorders).sort((a, b) => newestFirst(a.t.last_touched, b.t.last_touched) || (a.i - b.i));
  return ranked.map((row) => (reorders(row) ? own.shift().t : row.t));
}

// Who a composer means by default (⌘⇧Enter, the @agent button, a bare @AI): the
// top row of the @ list that may edit. On a doc page only a top row with
// evidence: an agent used here, or the server's `evidence` (its default). With
// none the person chooses (Connection order is not a recommendation). `orTop`:
// the feedback surfaces offer the top editable row either way.
export function composerDefault(choices, { evidence = null, orTop = false } = {}) {
  const top = byRelevance(choices).find((t) => t.can_edit);
  if (!top) return null;
  return orTop || top.used_here_at || top.last_writer || sameTarget(top, evidence) ? top : null;
}

// A poll for an answer does not look up use (worker handleMyAgent): the rows
// keep what the last full read said.
export function keepAgentUse(prev, body) {
  if (!prev || !body) return body;
  const carry = (rows, old) => (Array.isArray(rows) ? rows.map((t) => {
    const was = (old || []).find((o) => sameTarget(o, t));
    return was && was.used_here_at ? { ...t, used_here_at: was.used_here_at } : t;
  }) : rows);
  return { ...body, agents: carry(body.agents, prev.agents), team_agents: carry(body.team_agents, prev.team_agents) };
}

// The agents to offer for what is typed after `@`. With nothing typed, the
// first `limit` (the ones the dropdown would preselect or list first); once
// a name is typed, every agent it matches: its exact name, then prefix hits,
// then the rest, the list's own order within each, tdoc AI last. `labelOf` adds
// the dropdown's own label to what a query can match.
export function matchAgentChoices(choices, query, { limit = 2, labelOf = null } = {}) {
  const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
  const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return list.slice(0, limit);
  const rank = (t) => {
    // Where it runs is searchable even when the label leaves it out.
    const names = [agentDisplayName(t, list), readableHandle(t), t.agent_name || '', agentLocation(t), labelOf ? labelOf(t) : '']
      .map((s) => String(s || '').toLowerCase())
      .filter(Boolean);
    if ([agentName(t), agentMentionName(t), readableHandle(t)].some((s) => String(s || '').toLowerCase() === q)) return 0;
    if (names.some((s) => s.startsWith(q))) return 1;
    if (names.some((s) => s.split(/[\s()._·-]+/).some((w) => w.startsWith(q)))) return 2;
    if (names.some((s) => s.includes(q))) return 3;
    return -1;
  };
  return list
    .map((t, i) => ({ t, r: rank(t), i }))
    .filter((row) => row.r >= 0)
    .sort((a, b) => (Number(Boolean(a.t.tdoc_ai)) - Number(Boolean(b.t.tdoc_ai))) || (a.r - b.r)
      || (relevance(a.t) - relevance(b.t)) || (a.i - b.i))
    .map((row) => row.t);
}

// The agent a posted text hands itself to: the first agent tag in it that
// the picker inserted, or null. One handoff addresses one agent, so a second
// tag does not fork the comment to a second agent.
// The row in `choices` for the agent whose reply is the thread's latest: who a
// reply box starts tagged with. Only a row the viewer already has, so this can
// never name an agent they could not pick after @, and nothing when the latest
// reply is a person's, when it is unclear which row it was, or for tdoc AI (a
// tag on it makes the reply a private question, and spends a free answer).
// `parentId` is what the box answers: the thread, or that latest reply; a box
// opened on anyone else's reply is talking to them.
// A reply says the route it came by (worker: provider, cli, location, handle);
// one that does not, an older client's, goes by who the thread was handed to.
export function agentForThread(thread, choices, parentId = null) {
  const replies = (thread && thread.replies) || [];
  const latest = replies.filter((r) => r && !r.deleted).reduce((a, b) => (a && Date.parse(a.created) > Date.parse(b.created) ? a : b), null);
  const who = latest && latest.author;
  if (!who || who.kind !== 'agent' || who.login === 'tdoc-ai') return null;
  if (parentId && parentId !== thread.id && parentId !== latest.id) return null;
  // Same name, same computer name, somebody else's: not this viewer's agent.
  // The key where both have one: a display name is not unique.
  const owned = (t) => Boolean(who.owner && t.owner) && (who.owner.key && t.owner.key
    ? who.owner.key === t.owner.key : who.owner.display === t.owner.display);
  const list = (Array.isArray(choices) ? choices : []).filter((t) => t && !t.tdoc_ai && owned(t));
  const handle = String(who.handle || '').replace(/^@/, '').toLowerCase();
  const rows = who.team_agent && who.team_agent.id
    ? list.filter((t) => t.team_agent && t.team_agent.id === who.team_agent.id)
    : who.provider === 'local'
      ? list.filter((t) => !t.team_agent && t.provider === 'local' && agentCli(t) === agentCli(who) && String(t.device || t.server_id) === String(who.location || ''))
      : who.provider
        ? list.filter((t) => !t.team_agent && t.provider === who.provider && String(t.agent_name || '').replace(/^@/, '').toLowerCase() === handle
          && (who.provider !== 'raft' || String(t.server_slug || '') === String(who.location || '')))
        : list.filter((t) => sameTarget(t, thread.handoff_to));
  return rows.length === 1 ? rows[0] : null;
}

export function taggedAgent(text, choices) {
  const span = taggedAgentSpan(text, choices);
  return span ? span.target : null;
}

// The same tag with where it sits: { target, start, end } (end exclusive),
// or null. The composers draw it as the agent pill.
export function taggedAgentSpan(text, choices) {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const list = Array.isArray(choices) ? choices : [];
  let best = null;
  let at = Infinity;
  let bestLength = 0;
  for (const t of list) {
    if (!t) continue;
    // The tag as the picker inserted it, the short name in case the list it
    // was picked from had no twin, and the full display name a draft from
    // before the short tags may still hold.
    const tags = [...new Set([agentMentionName(t, list), agentMentionName(t),
      agentDisplayName(t, list).replace(/@/g, '').trim(), agentDisplayName(t).replace(/@/g, '').trim()])]
      .map((name) => `@${AGENT_TAG_JOINER}${name}`.toLowerCase());
    for (const tag of tags) {
      let i = lower.indexOf(tag);
      while (i !== -1) {
        const next = source[i + tag.length];
        if (next === undefined || !/[A-Za-z0-9_-]/.test(next)) break;
        i = lower.indexOf(tag, i + 1);
      }
      // Two tags can start at one `@` ("devin" and "devin · acme"): the
      // longer one is what the picker inserted.
      if (i !== -1 && (i < at || (i === at && tag.length > bestLength))) { at = i; best = t; bestLength = tag.length; }
    }
  }
  return best ? { target: best, start: at, end: at + bestLength } : null;
}

// The one Send to agent control both composers show. `choices` is the
// composer's @ list; only rows that may edit are send targets. The state is
// decided once here so the doc page and the feedback widget cannot drift:
//   ready    - at least one agent may take the comment
//   connect  - this viewer could send, but nobody is linked yet
//   disabled - this viewer cannot hand comments to an agent (say why)
export function sendToAgentState({ canSendToAgent = false, choices = [], disabledReason = null, connectPrompt = null, setupHref = null } = {}) {
  const editable = (Array.isArray(choices) ? choices : []).filter((t) => t && t.can_edit);
  if (canSendToAgent && editable.length) return { kind: 'ready', choices: editable };
  if (connectPrompt || setupHref) return { kind: 'connect', prompt: connectPrompt, href: setupHref, reason: disabledReason };
  return { kind: 'disabled', reason: disabledReason || 'No agent can take comments here yet.' };
}

// Who may hand a comment to an agent, as POST /api/notify/handoff decides
// it: the doc's (space's) owner, or on a team doc any current member of
// that team (the team's agent; an admin also their own). A team guest is not
// a member. One rule and one sentence for the doc page, the feedback space
// and the widget, so the three cannot drift again.
export const SEND_TO_AGENT_WHO = 'Only the owner or a member of its team can send comments to an agent';
export function maySendToAgent({ owner = false, teamMember = false } = {}) {
  return Boolean(owner || teamMember);
}

// The rest of the control's inputs, from that rule and the notify targets
// (useNotifyTargets): the Connect link while this viewer may send but nobody
// is linked, and the hover text while the control is disabled.
//   may       - maySendToAgent for this viewer
//   notifyOn  - this host can notify at all
//   targets   - { ready, reason } from useNotifyTargets
//   href      - where Connect an agent lives on this surface
export function sendToAgentSetup({ canSendToAgent = false, may = false, notifyOn = true, targets = null, href = null } = {}) {
  const ready = Boolean(targets && targets.ready);
  const setupHref = may && notifyOn && ready && targets.reason === 'no_agent_bound' ? href : null;
  const disabledReason = canSendToAgent ? null
    : !may ? SEND_TO_AGENT_WHO
      : !notifyOn ? 'Notify is not available on this host yet.'
        : !ready ? 'Finding your agents…'
          : notifyHandoffReasonText(targets.reason) || 'No agent can take comments here yet.';
  return { setupHref, disabledReason };
}

// Why the server would not hand this doc's comments to an agent, in the
// words the control's tooltip uses. null where the answer is "connect one".
export function notifyHandoffReasonText(reason) {
  if (reason === 'team_admin_only') return 'Only a workspace admin can send this team doc to an agent.';
  if (reason === 'no_team_daemon') return 'Set up an always-on agent before sending comments to an agent.';
  if (reason === 'no_team_agent') return 'This team has no agent yet.';
  if (reason === 'team_agent_not_writer') return 'The team agent did not write this doc, so it cannot take these comments.';
  if (reason === 'no_agent_bound') return null;
  return reason ? 'No agent can take comments here yet.' : null;
}

// The comment boxes' agent button reads "@agent" (Julie, 2026-11-14: the
// pre-#1034 label, not "Send to agent · Name"); who it sends to is in the
// tooltip and, once named, in the pill.
export const AGENT_BUTTON_LABEL = '@agent';

// The control's words for the agent it names. One that may take the comment
// (a send target) is "@agent" (sends to X); one that may only answer -- the
// viewer's own agent or tdoc AI where they cannot hand off -- is asked, so the
// control says "Ask X", which is what submitting does. With no agent named,
// `asking` (the viewer cannot hand off, only ask) picks the words.
export function sendToAgentWords(agent, { editable = [], offer = [], asking = false } = {}) {
  if (!agent) {
    return asking
      ? { label: 'Ask agent', title: 'Ask an agent about this comment', switchTitle: 'Ask an agent about this comment', off: "Don't ask" }
      : { label: AGENT_BUTTON_LABEL, title: 'Send this comment to an agent', switchTitle: 'Send this comment to an agent', off: "Don't send" };
  }
  const sends = editable.some((t) => targetKey(t) === targetKey(agent));
  const list = sends ? editable : offer;
  const short = agentMentionName(agent, list);
  const full = agentDisplayName(agent, list);
  return sends
    ? { label: AGENT_BUTTON_LABEL, title: `Send this comment to ${full}`, switchTitle: `Sending to ${full} — pick another or turn it off`, off: "Don't send" }
    : { label: `Ask ${short}`, title: `Ask ${full} about this comment`, switchTitle: `Asking ${full} — pick another or turn it off`, off: "Don't ask" };
}
