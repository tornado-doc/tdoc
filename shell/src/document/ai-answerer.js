// Who a comment's @ can hand to (Julie, 2026-10-24). The composer has one
// button, Comment; @ lists the agents, and once one is picked an "Ask only"
// box says whether it may edit the doc or only answer:
//   edit      (Ask only off) the agents the server allows for this doc
//             (agentEditPolicy): the owner's own; the team agent on a doc
//             it wrote; nobody's on a doc somebody else's agent wrote. The
//             server lists them, the one that edited last first.
//   ask only  an answer, never an edit: the commenter's own agent, the doc's
//             team agent (members), or tdoc AI when neither can answer.
//             Never somebody else's personal agent. "Only me" keeps the
//             question and answer private, with Make public later.
// composerAgents builds the one @ list (the agent pill's dropdown and the @
// picker); each row says whether it may edit. tdoc AI is offered to
// everyone. There is no mode to pick: the named agent answers or edits from
// the text, where authorship lets it edit, and answers only elsewhere.

import { AGENT_TAG_JOINER, orderedAgentChoices, sameTarget } from './agent-choices.js';

export const TDOC_AI = Object.freeze({ provider: 'tdoc', server_id: 'tdoc', agent_sub: 'tdoc-ai', agent_name: 'tdoc AI', tdoc_ai: true });

function reachable(t) {
  return Boolean(t) && (t.provider !== 'local' || t.status === 'active');
}

// The @ list: [{ ...target, can_edit }], first row the default. With an
// agent that may edit, that list (server order: the last editor first) and
// then the ones that may only answer; with none, own agents, the team's
// agent; tdoc AI last, for everyone.
export function composerAgents({ canSendToAgent = false, notifyTargets = null, mine = null } = {}) {
  const edit = canSendToAgent ? orderedAgentChoices(notifyTargets) : [];
  const out = edit.map((t) => ({ ...t, can_edit: true }));
  const has = (t) => out.some((x) => sameTarget(x, t));
  const ask = [
    ...((mine && mine.agents) || []).filter(reachable),
    ...((mine && mine.team_agents) || []).filter(reachable),
  ];
  for (const t of ask) if (!has(t)) out.push({ ...t, can_edit: false });
  // tdoc AI for everyone, within their free answers; always last.
  if (mine && mine.tdoc_ai) out.push({ ...TDOC_AI, can_edit: false });
  return out;
}

// A bare "@AI" typed by hand means the list's first row. Only whole words:
// "@AIDA" is somebody's handle.
const AI_TAG = new RegExp(`(^|[^A-Za-z0-9_@/-])@${AGENT_TAG_JOINER}?ai(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i');
const AI_TAG_ALL = new RegExp(AI_TAG.source, 'gi');

export const AI_MENTION = `@${AGENT_TAG_JOINER}AI`;

export function mentionsAi(text) {
  return AI_TAG.test(String(text || ''));
}

// A typed "@AI" gets the agent tags' word joiner before posting, so the
// server never reads it as the GitHub user "ai" (an @login invites them).
export function joinAiTags(text) {
  return String(text || '').replace(AI_TAG_ALL, (_, before) => `${before}${AI_MENTION}`);
}

// The question without the tag that asked it.
export function withoutAskTags(text, tag = '') {
  let s = joinAiTags(text);
  for (const t of [tag, AI_MENTION]) if (t) s = s.split(t).join('');
  return s.replace(/\s+/g, ' ').trim() || String(text || '').trim();
}

// tdoc AI's free answers are worth mentioning only when few are left (the
// allowance is large: ASK_FREE_LIMIT). null when there is nothing to say.
export const FEW_FREE_LEFT = 10;
export function freeLeftText(remaining) {
  if (typeof remaining !== 'number' || remaining > FEW_FREE_LEFT) return null;
  return remaining === 0 ? 'no free answers left' : `${remaining} free left`;
}

// "Only me" starts on for tdoc AI's answers, off for an agent's.
export function onlyMeDefault(target) {
  return Boolean(target && target.tdoc_ai);
}

// A tdoc AI reply the viewer asked for: the reply's author is tdoc AI and it
// acted for this viewer.
export function isOwnTdocAiReply(item, viewerKey) {
  const author = item && item.author;
  if (!author || author.kind !== 'agent' || author.login !== 'tdoc-ai') return false;
  const key = String(author.owner?.key || '').toLowerCase();
  return Boolean(key) && key === String(viewerKey || '').toLowerCase();
}
