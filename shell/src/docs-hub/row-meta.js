// The words on a My docs row, apart from its title: when (relative, as the
// doc bar's "Edited 3m ago" says it), what it is (doc / sheet / slides), who
// can open it, and what is unread on it. Plain functions, no React, so the
// offline tests read them directly (test/me-rows.test.js).

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

// "just now", "5m ago", "3h ago", "2d ago", then the date ("Nov 3", with the
// year once it is not this year). '' for a missing or broken stamp, so a row
// never says "visited" with nothing after it.
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < MINUTE) return 'just now';
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m ago`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h ago`;
  if (s < 7 * DAY) return `${Math.floor(s / DAY)}d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

// The full stamp, for the hover title on a relative date.
export function absoluteTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "visited 3h ago" -- or nothing at all when there is no date to give.
export function datedLabel(label, iso, now = Date.now()) {
  const when = relativeTime(iso, now);
  return when ? `${label} ${when}` : '';
}

export function docTypeOf(doc) {
  const type = doc && doc.doc_type;
  return type === 'sheet' || type === 'slides' ? type : 'doc';
}

export function docTypeLabel(type) {
  return type === 'sheet' ? 'Sheet' : type === 'slides' ? 'Slides' : 'Doc';
}

// Who can open it, short for the row and long for its tooltip / label. The
// Share dialog's own words (owner-access-dialog.jsx). null when the row does
// not say (somebody else's doc).
export function sharingText(doc) {
  const sharing = doc && doc.sharing;
  const n = Math.max(0, Number(doc && doc.shared_with) || 0);
  const people = `${n} ${n === 1 ? 'person' : 'people'}`;
  switch (sharing) {
    case 'public': return { short: 'Public', long: 'Public: anyone can find and read it' };
    case 'link': return { short: 'Link', long: 'Anyone with the link can read it' };
    case 'team': return { short: n ? `Team + ${people}` : 'Team', long: n ? `Everyone in the team, plus ${people} invited` : 'Everyone in the team can open it' };
    case 'people': return { short: people, long: `Only you and ${people} invited can open it` };
    case 'private': return { short: 'Only you', long: 'Only you can open it' };
    default: return null;
  }
}

// Unread on the row: new comments (the bell's rows for this doc) and agent
// replies not opened yet. null when there is nothing.
export function activityText(doc) {
  const a = (doc && doc.activity) || {};
  const comments = Math.max(0, Number(a.comments) || 0);
  const agent = Math.max(0, Number(a.agent) || 0);
  if (!comments && !agent) return null;
  const parts = [];
  if (comments) parts.push(`${comments} new ${comments === 1 ? 'comment' : 'comments'}`);
  if (agent) parts.push(`${agent} agent ${agent === 1 ? 'reply' : 'replies'}`);
  return { comments, agent, label: parts.join(', ') };
}

// "Finish setting up" belongs to the start: on the Docs tab only, and only
// while the account has fewer than three docs. Whether the walk began, is
// done, or was hidden is the card's own decision (onboarding-checklist.jsx).
export const ONBOARDING_MAX_DOCS = 3;
export function onboardingChecklistShown({ view, docCount }) {
  return view === 'docs' && (Number(docCount) || 0) < ONBOARDING_MAX_DOCS;
}
