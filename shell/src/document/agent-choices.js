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
  return choices;
}

// A word joiner after the `@`: the tag reads "@claude", but the server's
// mention pattern needs a letter right after the `@`, so it is never taken
// for the GitHub user "claude" (an owner's @login invites that person).
export const AGENT_TAG_JOINER = '⁠';

// What the @ tag says: the agent's display name in its list, minus any `@`
// of its own (a second `@` inside the tag could read as an address).
export function agentMentionName(t, list = null) {
  return agentDisplayName(t, list).replace(/@/g, '').trim();
}

// The agents to offer for what is typed after `@`. With nothing typed, the
// first `limit` (the ones the dropdown would preselect or list first); once
// a name is typed, every agent it matches, prefix hits first. `labelOf` adds
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
    if (names.some((s) => s.startsWith(q))) return 0;
    if (names.some((s) => s.split(/[\s()._·-]+/).some((w) => w.startsWith(q)))) return 1;
    if (names.some((s) => s.includes(q))) return 2;
    return -1;
  };
  return list
    .map((t, i) => ({ t, r: rank(t), i }))
    .filter((row) => row.r >= 0)
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((row) => row.t);
}

// The agent a posted text hands itself to: the first agent tag in it that
// the picker inserted, or null. One handoff addresses one agent, so a second
// tag does not fork the comment to a second agent.
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
    // The label as the picker inserted it, and without the location suffix
    // in case the list it was picked from had no twin.
    const tags = [...new Set([agentMentionName(t, list), agentMentionName(t)])]
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
