// Where requests go. On a tdoc page: this origin, with the cookie. The
// feedback overlay runs inside someone else's app, so it points the same
// calls at the tdoc host with its feedback token instead — that is what lets
// it reuse panels written for the doc page (Send to agent) unchanged.
let transport = null;
export function setApiTransport(next) { transport = next || null; }
// Account settings (/api/me/*) need the tdoc browser session, which the
// overlay's feedback token is not.
export function hasAccountSession() { return !transport; }
export function tdocUrl(path) { return transport ? `${transport.base}${path}` : path; }

async function request(path, options) {
  const response = transport
    ? await fetch(`${transport.base}${path}`, {
      credentials: 'omit',
      ...options,
      headers: { ...((options && options.headers) || {}), ...transport.headers() },
    })
    : await fetch(path, {
      credentials: 'same-origin',
      ...options,
    });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function listComments(slug, version) {
  const query = new URLSearchParams({ slug, version: String(version) });
  return request(`/api/comments?${query}`);
}

// The people this session may name after `@` on this doc.
// Onboarding. The record is a set of timestamps the server stamps as the
// person and their agent move through the journey; the events are every
// action the page saw. Both live on the account, never in localStorage, so a
// second device resumes where the first one stopped.
export function getOnboarding(options) {
  // `docs` asks the server to also name the newest doc this account owns. It
  // costs a catalog walk, so only the page that waits for a doc to appear
  // asks for it.
  return request(options && options.docs ? '/api/onboarding?docs=1' : '/api/onboarding');
}

export function postOnboardingEvent(action, doc) {
  return request('/api/onboarding/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc ? { action, doc } : { action }),
  });
}

// The person's own tick on a checklist row. Kept beside the stamps, not as
// one: the funnel still reads only what the server saw.
export function postOnboardingCheck(step, checked) {
  return request('/api/onboarding/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: checked ? 'step_checked' : 'step_unchecked', step }),
  });
}

// What the owner's agent has done to this doc lately: when it last read the
// comments, and the latest version it published. The bridge-2 card polls this
// while it waits.
export function getAgentStatus(slug) {
  const query = new URLSearchParams({ slug });
  return request(`/api/doc/agent-status?${query}`);
}

export function listMentionableUsers(slug) {
  const query = new URLSearchParams({ slug });
  return request(`/api/mentions?${query}`);
}

export function createComment(payload) {
  return request('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Same PATCH as the re-anchor below; a `text` in the body is what makes it an
// edit. The worker allows it for the record's author only.
export function updateCommentText(payload) {
  return request('/api/comments', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateCommentAnchor(payload) {
  return request('/api/comments', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Marking a thread handled, and taking it back. One status per version, so
// this converges however two people interleave it.
export function setCommentResolved({ slug, version, id, resolved }) {
  return request('/api/comments', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, version, id, resolved }),
  });
}

export function removeComment(slug, version, id) {
  const query = new URLSearchParams({ slug, version: String(version), id });
  return request(`/api/comments?${query}`, { method: 'DELETE' });
}

export function toggleReaction(payload) {
  return request('/api/reactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function setDocumentStar(slug, starred) {
  return request('/api/star', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, starred }),
  });
}

// Start from scratch. There is no title yet — the author types one into the
// page — so the server mints an opaque slug and returns the new doc's URL,
// already carrying ?edit=1.
export function createDocument(team) {
  return request('/api/doc/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(team ? { team } : {}),
  });
}

export function duplicateDocument(slug, version) {
  return request('/api/doc/duplicate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, version }),
  });
}

export function saveDocumentVersion(slug, baseVersion, html) {
  return request('/api/doc/versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, baseVersion, html }),
  });
}

// What the in-flight publish is waiting on, if anything. The CLI's device code
// goes to stderr, which the modal never sees, so the local server reads it off
// a file the CLI writes. Returns null whenever nothing is pending.
export function getPublishSignin(slug) {
  const query = new URLSearchParams({ slug });
  return request(`/api/publish/signin?${query}`).then((body) => body?.signin || null);
}

export function publishDocument(slug) {
  return request('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
}

// Self-serve raise of the hosted-doc cap (50→100, then →200). Requires a
// reason; agents use the same route with the upload token.
export function requestQuotaBump(reason) {
  return request('/api/quota/bump', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: String(reason || '').trim() }),
  });
}

// Renaming is a metadata edit: it changes what the document is called and
// touches neither its text nor its version history.
export function renameDocument(slug, title) {
  return request('/api/doc/title', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, title }),
  });
}

export function updateDocumentAccess(slug, access) {
  return request('/api/doc/access', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, access }),
  });
}

export function deleteDocument(slug) {
  const query = new URLSearchParams({ slug });
  return request(`/api/doc?${query}`, { method: 'DELETE' });
}

// Trash. Delete moves a doc (or a folder with its docs) here for 30 days;
// `target` is { slug } for a doc, { folder, team? } for a folder.
export function listTrash(team) {
  const query = team ? `?${new URLSearchParams({ team })}` : '';
  return request(`/api/trash${query}`);
}

export function restoreFromTrash(target) {
  return request('/api/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
}

export function deleteForever(target) {
  return request('/api/trash/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
}

export function listNotifications(offset = 0) {
  const query = new URLSearchParams({ offset: String(offset) });
  return request(`/api/notifications?${query}`);
}

export function listTeamComments(team, offset = 0) {
  const query = new URLSearchParams({ id: team, offset: String(offset) });
  return request(`/api/team/comments?${query}`);
}

// Raft / provider notify handoff (Connected App). Same endpoint for doc-level
// and single-comment "send to agent" — comment_ids length is what differs.
export function listNotifyTargets(slug) {
  const query = new URLSearchParams({ slug });
  return request(`/api/notify/targets?${query}`);
}

export function listNotifyHandoffs(slug, limit = 10) {
  const query = new URLSearchParams({ slug, limit: String(limit) });
  return request(`/api/notify/handoffs?${query}`);
}

export function postNotifyHandoff({ slug, comment_ids, instruction, recipient }) {
  const body = { slug, comment_ids: comment_ids || [] };
  if (instruction != null) body.instruction = instruction;
  if (recipient) body.recipient = recipient;
  return request('/api/notify/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Which agent on a connected Raft server gets comments on docs no agent has
// worked on yet. Delivery is by handle.
export function setRaftFallbackAgent({ server_id, agent_name, agent_sub }) {
  return request('/api/me/connectors/raft/default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server_id, agent_name, agent_sub }),
  });
}

export function getRaftConnectAttempt(id) {
  return request(`/api/me/connectors/raft/attempt?id=${encodeURIComponent(id)}`);
}

export function resendNotifyHandoff({ slug, handoff_id }) {
  return request('/api/notify/handoff/resend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, handoff_id }),
  });
}

export function getUnreadNotificationCount() {
  return request('/api/notifications/unread');
}

export function answerAccessRequest({ slug, requester, action }) {
  return request('/api/doc/access-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, requester, action }),
  });
}

// Notification email (#772): { available, on } for the signed-in person.
export function getEmailNotifications() {
  return request('/api/notifications/email');
}

export function setEmailNotifications(on) {
  return request('/api/notifications/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  });
}

// Web push (#771): this browser's subscription for the bell.
export function getPushKey() {
  return request('/api/push/key');
}

export function savePushSubscription(subscription) {
  return request('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription }),
  });
}

export function dropPushSubscription(endpoint) {
  return request('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
}

export function markAllNotificationsRead() {
  return request('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
}

export function markNotificationsRead(ids) {
  return request('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export function startDeviceSignIn() {
  return request('/api/auth/device/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export function pollDeviceSignIn(deviceCode) {
  return request('/api/auth/device/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

// `team` (optional) targets that team's folders instead of My docs'.
export function moveDocsToFolder(slugs, folder, team) {
  return request('/api/folders/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slugs, folder: folder || null, team: team || undefined }),
  });
}

export function createFolder(name, parent, team) {
  return request('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent: parent || undefined, team: team || undefined }),
  });
}

export function renameFolder(id, name, team) {
  return request('/api/folders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, team: team || undefined }),
  });
}

// `share: false` stops sharing (the link dies); `team` names a team folder.
export function updateFolderAccess(id, { visibility, allowed_users, share } = {}, team) {
  const body = { id };
  if (visibility !== undefined) body.visibility = visibility;
  if (allowed_users !== undefined) body.allowed_users = allowed_users;
  if (share === false) body.share = false;
  if (team) body.team = team;
  return request('/api/folders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteFolder(id, team) {
  const query = new URLSearchParams(team ? { id, team } : { id });
  return request(`/api/folders?${query}`, { method: 'DELETE' });
}

function teamRequest(path, method, body) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function createTeam(name, invites) {
  return teamRequest('/api/teams', 'POST', { name, invites });
}

export function listTeams() {
  return request('/api/teams');
}

export function getTeam(id) {
  return request(`/api/team?${new URLSearchParams({ id })}`);
}

export function updateTeam(id, patch) {
  return teamRequest('/api/team', 'PATCH', { id, ...patch });
}

export function getTeamBackup(id) {
  return request(`/api/team/backup?${new URLSearchParams({ id })}`);
}

export function saveTeamBackup(id, backup) {
  return teamRequest('/api/team/backup', 'PUT', { id, ...backup });
}

export function syncTeamBackup(id) {
  return teamRequest('/api/team/backup', 'POST', { id });
}

export function removeTeamBackup(id) {
  return teamRequest('/api/team/backup', 'DELETE', { id });
}

// Team agents: every member lists them; an admin adds one (a one-time
// setup command comes back) or removes it.
export function listTeamAgents(id) {
  return request(`/api/team/agents?${new URLSearchParams({ id })}`);
}

export function addTeamAgent(id, name) {
  return teamRequest('/api/team/agents', 'POST', { id, name });
}

export function removeTeamAgent(id, agent) {
  return teamRequest('/api/team/agents', 'DELETE', { id, agent });
}

export function getTeamBilling(id) {
  return request(`/api/team/billing?${new URLSearchParams({ id })}`);
}

// Returns a Stripe-hosted URL: Checkout (`interval` month|year) or the
// Customer Portal.
export function openTeamBilling(id, action, interval) {
  return teamRequest('/api/team/billing', 'POST', { id, action, ...(interval ? { interval } : {}) });
}

export function setTeamRole(id, accountId, role) {
  return teamRequest('/api/team/role', 'POST', { id, account_id: accountId, role });
}

export function removeTeamMember(id, accountId) {
  return teamRequest('/api/team/remove', 'POST', { id, account_id: accountId });
}

export function joinTeam(token) {
  return teamRequest('/api/team/join', 'POST', { token });
}

// Join without a link: the team's invite list names this handle or address.
export function acceptTeamInvite(id) {
  return teamRequest('/api/team/accept-invite', 'POST', { id });
}

export function moveDocsToTeam(slugs, team) {
  return teamRequest('/api/team/move', 'POST', { slugs, team: team || null });
}

// A whole My docs folder into a team. The server moves a bounded batch per
// call and says how many are `remaining`; each call hands back the team
// folders it made (`known`) and the docs already moved (`done`) so a stale
// read on the next one neither duplicates a folder nor re-reads every doc.
export async function moveFolderToTeam(folder, team, onProgress) {
  let known = [];
  const done = [];
  let moved = 0;
  const skipped = [];
  for (let round = 0; round < 100; round += 1) {
    const r = await teamRequest('/api/folders/move-to-team', 'POST', { folder, team, known, done });
    const progress = (r.results || []).filter((x) => !(x.status === 'skipped' && x.reason === 'not_owner'));
    known = r.folders || known;
    for (const x of progress) done.push(x.slug);
    for (const x of r.results || []) if (x.status === 'skipped' && !skipped.some((y) => y.slug === x.slug)) skipped.push(x);
    moved += r.moved || 0;
    if (onProgress) onProgress({ moved, remaining: r.remaining || 0 });
    if (!r.remaining || !progress.length) return { ...r, moved, skipped };
  }
  throw new Error('The move did not finish; try again to pick up where it stopped.');
}

// Ask this doc: the free server-side answer for a reader without an agent.
// Browser session only; the server keeps nothing but the count.
export function getAskAllowance(slug) {
  return request(`/api/docs/${encodeURIComponent(slug)}/ask`);
}

export function askDocument(slug, { question, version, selection }) {
  return request(`/api/docs/${encodeURIComponent(slug)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, version, ...(selection ? { selection } : {}) }),
  });
}

// Send to my agent: the reader's own agents and the questions this reader
// sent them about this doc. Browser session only; the server never offers
// anyone else's agent, and nobody else ever sees these answers.
export function getMyAgent(slug) {
  return request(`/api/docs/${encodeURIComponent(slug)}/my-agent`);
}

export function sendToMyAgent(slug, { question, passage }) {
  return request(`/api/docs/${encodeURIComponent(slug)}/my-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, ...(passage ? { passage } : {}) }),
  });
}
