const DEFAULTS = { documentUrl: '' };

function parseDocumentUrl(value) {
  try {
    const url = new URL(value);
    const match = /^\/d\/([^/]+)(?:\/v\/(\d+))?\/?$/.exec(url.pathname);
    if (!/^https?:$/.test(url.protocol) || !match) return null;
    const slug = decodeURIComponent(match[1]);
    const version = Number(match[2] || 1);
    return { base: url.origin, slug, version, documentUrl: `${url.origin}/d/${encodeURIComponent(slug)}/v/${version}` };
  } catch (_) { return null; }
}

async function config() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...stored, parsed: parseDocumentUrl(stored.documentUrl) };
}

async function request(parsed, pathname, options = {}) {
  const response = await fetch(`${parsed.base}${pathname}`, {
    credentials: 'include', ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body && (body.message || body.error) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function canonicalPage(value) {
  try { const url = new URL(value); url.hash = ''; return url.href; }
  catch (_) { return value; }
}

async function loadSurface(parsed, pageUrl) {
  const query = new URLSearchParams({ slug: parsed.slug, version: String(parsed.version) });
  const comments = await request(parsed, `/api/comments?${query}`);
  let mentionable = [];
  let signedIn = true;
  try {
    const mentions = await request(parsed, `/api/mentions?slug=${encodeURIComponent(parsed.slug)}`);
    mentionable = Array.isArray(mentions && mentions.users) ? mentions.users : [];
  } catch (error) {
    if (error.status === 401) signedIn = false;
    else throw error;
  }
  const here = canonicalPage(pageUrl);
  return {
    comments: (Array.isArray(comments) ? comments : []).filter((comment) =>
      comment && comment.anchor && comment.anchor.kind === 'product' && canonicalPage(comment.anchor.url) === here),
    mentionable, signedIn
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function toggle(tab) {
  if (!tab || !tab.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'tdoc-feedback-toggle' }); } catch (_) {}
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-feedback') await toggle(await activeTab());
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== 'object') return false;
  (async () => {
    const current = await config();
    const parsed = current.parsed;
    if (message.type === 'tdoc-feedback-settings') return { documentUrl: current.documentUrl, configured: Boolean(parsed) };
    if (message.type === 'tdoc-feedback-open-options') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
    if (!parsed) return { ok: false, setup: true, error: 'Choose a tdoc document for this project first.' };
    if (message.type === 'tdoc-feedback-load') return { ok: true, config: parsed, ...(await loadSurface(parsed, message.pageUrl)) };
    if (message.type === 'tdoc-feedback-submit') {
      const comment = await request(parsed, '/api/comments', { method: 'POST', body: JSON.stringify({ slug: parsed.slug, version: parsed.version, text: message.text, anchor: message.anchor }) });
      return { ok: true, comment, ...(await loadSurface(parsed, message.anchor.url)) };
    }
    if (message.type === 'tdoc-feedback-reply') {
      await request(parsed, '/api/comments', { method: 'POST', body: JSON.stringify({ slug: parsed.slug, version: parsed.version, text: message.text, parent_id: message.parentId }) });
      return { ok: true, ...(await loadSurface(parsed, message.pageUrl)) };
    }
    if (message.type === 'tdoc-feedback-resolve') {
      await request(parsed, '/api/comments', { method: 'PATCH', body: JSON.stringify({ slug: parsed.slug, version: parsed.version, id: message.id, resolved: Boolean(message.resolved) }) });
      return { ok: true, ...(await loadSurface(parsed, message.pageUrl)) };
    }
    if (message.type === 'tdoc-feedback-signin') {
      // Open the real document instead of hard-coding one auth provider. Its
      // existing shell chooses the host's configured email/Google/GitHub door.
      await chrome.tabs.create({ url: parsed.documentUrl });
      return { ok: true };
    }
    return { ok: false, error: 'Unknown feedback action' };
  })().then(respond).catch((error) => respond({ ok: false, status: error.status || 0, error: String(error && error.message || error) }));
  return true;
});
