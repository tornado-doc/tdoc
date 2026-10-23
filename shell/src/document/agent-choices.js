// The agents a person can hand comments to, as one ordered list — the pure
// half shared by the Send to agent dropdown and the @ picker, so both offer
// the same agents in the same order. No React, no API: the shell feeds it
// what useNotifyTargets fetched.

function opaqueAgentId(s) {
  if (!s) return true;
  // Raft `sub` is often a UUID / long hex — fine as a key, useless as a label.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{24,}$/i.test(s)) return true;
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

// Who an agent is and where it runs, in one line nobody can mistake for
// another agent: "Claude Code · juliesmac" for a local daemon (which computer
// matters, there may be two), "xiaocc · acme" for a Raft agent on its server.
// The dropdown's rows and the @ tag both read this.
export function agentDisplayName(t) {
  if (!t) return '';
  const { label } = providerMeta(t);
  if (t.provider === 'local') {
    const cli = String(t.cli || '').toLowerCase()
      || String(t.agent_sub || '').slice(String(t.device || t.server_id || '').length + 1);
    const program = LOCAL_CLI_NAMES[cli] || (cli ? cli[0].toUpperCase() + cli.slice(1) : 'Local agent');
    const device = t.device || t.server_id || '';
    return device ? `${program} · ${device}` : program;
  }
  const who = readableHandle(t) || `${label} agent`;
  const where = t.provider === 'raft' && t.server_slug ? ` · ${t.server_slug}` : (t.provider === 'raft' ? '' : ` · ${label}`);
  return `${who}${where}`;
}

export function targetKey(t) {
  if (!t) return '';
  return `${t.provider}:${t.server_id}:${t.agent_sub}`;
}

export function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider
    && a.server_id === b.server_id
    && a.agent_sub === b.agent_sub;
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

// What the @ tag says: the agent's display name, minus any `@` of its own
// (a second `@` inside the tag could read as an address).
export function agentMentionName(t) {
  return agentDisplayName(t).replace(/@/g, '').trim();
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
    const names = [agentDisplayName(t), readableHandle(t), t.agent_name || '', labelOf ? labelOf(t) : '']
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
  const source = String(text || '');
  let best = null;
  let at = Infinity;
  let bestLength = 0;
  for (const t of (Array.isArray(choices) ? choices : [])) {
    if (!t) continue;
    const tag = `@${AGENT_TAG_JOINER}${agentMentionName(t)}`.toLowerCase();
    const lower = source.toLowerCase();
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
  return best;
}
