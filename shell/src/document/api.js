async function request(path, options) {
  const response = await fetch(path, {
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

export function createComment(payload) {
  return request('/api/comments', {
    method: 'POST',
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

export function listNotifications(offset = 0) {
  const query = new URLSearchParams({ offset: String(offset) });
  return request(`/api/notifications?${query}`);
}

export function getUnreadNotificationCount() {
  return request('/api/notifications/unread');
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

export function moveDocsToFolder(slugs, folder) {
  return request('/api/folders/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slugs, folder: folder || null }),
  });
}

export function createFolder(name, parent) {
  return request('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent: parent || undefined }),
  });
}

export function renameFolder(id, name) {
  return request('/api/folders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}

export function deleteFolder(id) {
  const query = new URLSearchParams({ id });
  return request(`/api/folders?${query}`, { method: 'DELETE' });
}
