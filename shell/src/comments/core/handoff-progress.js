// The steps of a comment handed to an agent, built only from what tdoc
// already records on the handoff -- no agent cooperation needed. Each step is
// a plain action with the agent's name (Julie, 2026-11-14: "New version" was
// confusing; say what the agent did):
//
//   Sent to Claude · Claude is reading · Claude suggested 3 edits · Claude updated the doc
//
// Before this the card said Delivered -> On it -> replied, and sat on "On it"
// for minutes with nothing to show that anything was happening (Julie,
// 2026-11). Each step is a fact with its own clock (worker withHandoffStatus):
//   handoff_delivery        Sent to <agent> (queued or delivered alike)
//   handoff_acked_at        the agent pulled the comments: <agent> is reading
//   handoff_suggested_edits propose_edits sets on these comments: <agent> suggested N edits
//   handoff_last_version    it published a version while open: <agent> updated the doc
//                           (never the number: Julie, 2026-11-14)
//   handoff_first_reply_at  <agent> replied
//   handoff_progress        the agent's own one-line status, when it posts one
//                           (report_progress / tdoc-agent-reply --progress):
//                           while it is the newest fact, a muted line under the
//                           current step in the step list, and in the tooltip;
//                           never in the pill.
// Plain words only: never "handoff", never a version number. No name: "Agent".
//
// Where it shows (handoff-status-line.jsx): the status pill names the current
// step, the same size as every other status pill; tapping it opens the list
// of steps under it inside the comment (collapsed by default, so the comment
// stays clean); the pill's tooltip holds the whole line.

function ts(iso) {
  const n = Date.parse(iso || '');
  return Number.isFinite(n) ? n : 0;
}

/** "4 min", "1 h 5 min": how long the agent has been at it. */
export function formatWorkingFor(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const NAME_MAX = 20;

/** The agent's name for a step: "Agent" without one, capped with an ellipsis. */
export function progressAgentName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Agent';
  const chars = [...n];
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('').trimEnd()}…` : n;
}

// [before, name, after]: the name is the part a narrow pill shortens.
function step(key, at, name, before, after) {
  return { key, at, parts: [before, name, after], label: `${before}${name}${after}` };
}

/**
 * The steps that have happened, oldest first: [{ key, label, parts, at }].
 * `name` is the agent's readable name (readableHandle), '' for "Agent".
 * A step with no clock of its own sorts after the ones that have one.
 */
export function handoffProgressSteps(comment, name = '') {
  if (!comment || !comment.handoff_at) return [];
  const who = progressAgentName(name);
  const steps = [];
  const d = comment.handoff_delivery;
  if (d?.status === 'delivered' || d?.status === 'queued') steps.push(step('sent', d.first_at || d.at || comment.handoff_at, who, 'Sent to ', ''));
  if (comment.handoff_acked_at) steps.push(step('reading', comment.handoff_acked_at, who, '', ' is reading'));
  const edits = Number(comment.handoff_suggested_edits);
  if (Number.isInteger(edits) && edits > 0) {
    steps.push(step('suggested', comment.handoff_suggested_at || null, who, '', ` suggested ${edits} ${edits === 1 ? 'edit' : 'edits'}`));
  }
  const version = Number(comment.handoff_last_version);
  if ((Number.isInteger(version) && version > 0) || comment.handoff_first_version_at) {
    steps.push(step('updated', comment.handoff_last_version_at || comment.handoff_first_version_at || null, who, '', ' updated the doc'));
  }
  if (comment.handoff_first_reply_at) steps.push(step('replied', comment.handoff_first_reply_at, who, '', ' replied'));
  return steps
    .map((st, i) => ({ st, i, t: ts(st.at) || Infinity }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(({ st }) => st);
}

// While the agent has it: sent and waiting, or picked up with no reply yet.
const WORKING_STATES = new Set(['waiting', 'received']);

/**
 * The current step for the status pill ({ key, label, parts }), or null when
 * there is no progress to show (the pill then says what it always did).
 */
export function handoffProgressCurrent(comment, state, name = '') {
  if (!WORKING_STATES.has(state)) return null;
  const steps = handoffProgressSteps(comment, name);
  return steps.length ? steps[steps.length - 1] : null;
}

/** The current step's words ("Claude is reading"), or ''. */
export function handoffProgressStage(comment, state, name = '') {
  return handoffProgressCurrent(comment, state, name)?.label || '';
}

/**
 * Everything about a handoff the agent has (surface state 'waiting' or
 * 'received'), or null when there is nothing more to say than the plain
 * status chip already does.
 *   { steps: [{ key, label, parts, at }], note: the agent's own status while
 *     it is the newest fact, elapsed: '4 min', text: the tooltip line }
 */
export function handoffProgressLine(comment, state, now = Date.now(), name = '') {
  if (!WORKING_STATES.has(state)) return null;
  const steps = handoffProgressSteps(comment, name);
  if (!steps.length) return null;
  const latest = Math.max(0, ...steps.map((s) => ts(s.at)));
  // The agent's own word counts only while it is news: once a later fact
  // lands (a version, suggestions), that fact speaks instead.
  const own = comment.handoff_progress;
  const ownText = own && typeof own.text === 'string' ? own.text.trim() : '';
  const note = ownText && ts(own.at) >= latest ? ownText : '';
  const started = ts(comment.handoff_acked_at);
  const elapsed = started ? formatWorkingFor(now - started) : '';
  const text = [...steps.map((s) => s.label), note, elapsed].filter(Boolean).join(' · ');
  return { steps, note, elapsed, text };
}
