// The progress line on a comment handed to an agent, built only from what
// tdoc already records on the handoff -- no agent cooperation needed:
//
//   Delivered · Reading the doc · Suggested 3 edits · New version · Working · 4 min
//
// Before this the card said Delivered -> On it -> replied, and sat on "On it"
// for minutes with nothing to show that anything was happening (Julie,
// 2026-11). Each step is a fact with its own clock (worker withHandoffStatus):
//   handoff_delivery        Sent (a local daemon's queue) / Delivered
//   handoff_acked_at        the agent pulled the comments: Reading the doc
//   handoff_suggested_edits propose_edits sets on these comments: Suggested N edits
//   handoff_last_version    it published a version while open: New version
//                           (never the number: Julie, 2026-11-14)
//   handoff_first_reply_at  Replied
//   handoff_progress        the agent's own one-line status, when it posts one
//                           (report_progress / tdoc-agent-reply --progress),
//                           shown as the current step while it is the newest,
//                           in the tooltip only.
// Plain words only: never "handoff", never a version number.
//
// Two lengths (Julie, 2026-11-14: the long line in the pill "doesn't feel
// native", and a detail line in the thread was "far too much text inside
// the comment"): the status pill is the only progress UI and shows only the
// short current stage (handoffProgressStage: "Reading", "3 edits", "New
// version"), the same size as every other status pill; the whole timeline,
// the agent's own words included, is the pill's tooltip (title) only.

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

/**
 * The steps that have happened, oldest first: [{ key, label, at }].
 * A step with no clock of its own sorts after the ones that have one.
 */
export function handoffProgressSteps(comment) {
  if (!comment || !comment.handoff_at) return [];
  const steps = [];
  const d = comment.handoff_delivery;
  if (d?.status === 'delivered') steps.push({ key: 'delivered', label: 'Delivered', at: d.first_at || d.at || comment.handoff_at });
  else if (d?.status === 'queued') steps.push({ key: 'delivered', label: 'Sent', at: d.first_at || d.at || comment.handoff_at });
  if (comment.handoff_acked_at) steps.push({ key: 'reading', label: 'Reading the doc', at: comment.handoff_acked_at });
  const edits = Number(comment.handoff_suggested_edits);
  if (Number.isInteger(edits) && edits > 0) {
    steps.push({ key: 'suggested', label: `Suggested ${edits} ${edits === 1 ? 'edit' : 'edits'}`, at: comment.handoff_suggested_at || null });
  }
  const version = Number(comment.handoff_last_version);
  if ((Number.isInteger(version) && version > 0) || comment.handoff_first_version_at) {
    steps.push({ key: 'published', label: 'New version', at: comment.handoff_last_version_at || comment.handoff_first_version_at || null });
  }
  if (comment.handoff_first_reply_at) steps.push({ key: 'replied', label: 'Replied', at: comment.handoff_first_reply_at });
  return steps
    .map((step, i) => ({ step, i, t: ts(step.at) || Infinity }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(({ step }) => step);
}

// The pill's word for each step: short, one or two words.
function shortStage(step, comment) {
  if (step.key === 'delivered') return step.label; // Sent / Delivered
  if (step.key === 'reading') return 'Reading';
  if (step.key === 'suggested') {
    const n = Number(comment.handoff_suggested_edits);
    return `${n} ${n === 1 ? 'edit' : 'edits'}`;
  }
  if (step.key === 'published') return 'New version';
  if (step.key === 'replied') return 'Replied';
  return 'Working';
}

/**
 * The short current stage for the status pill, or '' when there is no
 * progress to show (the pill then says what it always did, "On it").
 */
export function handoffProgressStage(comment, state) {
  if (state !== 'received') return '';
  const steps = handoffProgressSteps(comment);
  return steps.length ? shortStage(steps[steps.length - 1], comment) : '';
}

/**
 * The whole timeline for a handoff the agent is working on (surface state
 * 'received': picked up, no reply yet), for the pill's tooltip only, or null
 * when there is nothing more to say than the plain status chip already does.
 *   { steps: ['Delivered', 'Reading the doc', ...], current: 'Working' | the
 *     agent's own status, elapsed: '4 min', text: the whole line }
 */
export function handoffProgressLine(comment, state, now = Date.now()) {
  if (state !== 'received') return null;
  const steps = handoffProgressSteps(comment);
  if (!steps.length) return null;
  const latest = Math.max(0, ...steps.map((s) => ts(s.at)));
  // The agent's own word is the current step only while it is news: once a
  // later fact lands (a version, suggestions), that fact speaks instead.
  const own = comment.handoff_progress;
  const ownText = own && typeof own.text === 'string' ? own.text.trim() : '';
  const current = ownText && ts(own.at) >= latest ? ownText : 'Working';
  const started = ts(comment.handoff_acked_at);
  const elapsed = started ? formatWorkingFor(now - started) : '';
  const labels = steps.map((s) => s.label);
  const text = [...labels, current, elapsed].filter(Boolean).join(' · ');
  return { steps: labels, current, elapsed, text };
}
