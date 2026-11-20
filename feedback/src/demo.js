// Try it on this page: the real widget on tdoc's own /feedback page, with
// no account and nothing sent anywhere. Everything the widget would ask the
// tdoc server (the comments, the @ list, read state, the session) is
// answered here from this tab's memory (sessionStorage), through the same
// request path (api.js setApiTransport `fetch`, the widget's own request),
// so the dock, picking, the composer, pins, threads and Copy for agent are
// the widget's own code, not a copy of it.
//
// Who may turn it on: only tdoc's own page. The script must have been
// loaded by a <script data-tdoc-demo> whose src is on the same origin as
// the page (the tdoc host that serves feedback.js), and the page must be
// /feedback (the homepage links there with #try). A site that loads tdoc.dev/feedback.js
// with the attribute, or sets a global, gets the normal widget, which
// signs in before it posts. There is no URL parameter. Either way demo mode
// never posts: it has no network path at all.

export const DEMO_PATHS = Object.freeze(['/feedback']);
export const DEMO_SLUG = 'try-tdoc-feedback';
export const DEMO_STORAGE_KEY = 'tdoc-feedback-demo:comments';

export function demoAllowed({ scriptSrc, href } = {}) {
  if (!scriptSrc || !href) return false;
  try {
    const page = new URL(String(href));
    const script = new URL(String(scriptSrc));
    if (page.protocol !== 'https:' && page.protocol !== 'http:') return false;
    if (script.origin !== page.origin) return false;
    const path = page.pathname.replace(/\/+$/, '') || '/';
    return DEMO_PATHS.includes(path);
  } catch (_) {
    return false;
  }
}

const IDENTITY = Object.freeze({ login: 'you', name: 'You', avatar_url: '', linked_actor_keys: ['you'] });

// The session the widget would get from connecting: a demo token that no
// server ever sees, no agent hand-off, no share, no own agent.
export function demoSession() {
  return {
    token: 'demo', demo: true, slug: DEMO_SLUG, version: 1,
    identity: { ...IDENTITY },
    notify: false, own_agent: false, can_share: false, share_here: false,
  };
}

// The local answers. `storage` is sessionStorage (or anything with getItem /
// setItem); without one, memory only.
export function createDemoBackend({ storage = null, now = () => new Date() } = {}) {
  let memory = null;
  let seq = 0;
  const load = () => {
    if (memory) return memory;
    let list = [];
    try { list = JSON.parse((storage && storage.getItem(DEMO_STORAGE_KEY)) || '[]'); } catch (_) { list = []; }
    memory = Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string') : [];
    return memory;
  };
  const save = () => { try { if (storage) storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(memory || [])); } catch (_) {} };
  const id = (prefix) => `${prefix}_demo_${Date.now().toString(36)}${(seq++).toString(36)}`;
  const author = () => ({ login: IDENTITY.login, name: IDENTITY.name, avatar_url: '' });
  const find = (cid) => {
    for (const c of load()) {
      if (c.id === cid) return { root: c, item: c };
      const reply = (c.replies || []).find((r) => r.id === cid);
      if (reply) return { root: c, item: reply };
    }
    return null;
  };
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const readBody = (options) => { try { return JSON.parse((options && options.body) || '{}') || {}; } catch (_) { return {}; } };

  function handle(method, path, params, body) {
    if (path === '/api/feedback/session' && method === 'GET') return answer(200, demoSession());
    if (path === '/api/mentions' && method === 'GET') {
      return answer(200, { users: [], identity: { ...IDENTITY }, is_owner: false, team_member: false });
    }
    if (path === '/api/comments/seen') return answer(200, { ok: true, seen: {} });
    if (path === '/api/comments' && method === 'GET') return answer(200, load().filter((c) => !c.deleted));
    if (path === '/api/comments' && method === 'POST') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return answer(400, { error: 'slug and text required' });
      const created = now().toISOString();
      if (body.parent_id) {
        const hit = find(body.parent_id);
        if (!hit) return answer(404, { error: 'parent_not_found' });
        const reply = { id: id('r'), author: author(), text, created, version: 1 };
        hit.root.replies = [...(hit.root.replies || []), reply];
        save();
        return answer(200, { ...reply, parent_id: body.parent_id, thread_id: hit.root.id });
      }
      const comment = {
        id: id('c'), author: author(), text, created, created_in: 1, version: 1,
        anchor: body.anchor || null, mentions: [], edited: null, status: 'open',
        replies: [], reactions: {}, deleted: false,
      };
      load().push(comment);
      save();
      return answer(200, comment);
    }
    if (path === '/api/comments' && method === 'PATCH') {
      const hit = find(body.id);
      if (!hit) return answer(404, { error: 'not_found' });
      if (typeof body.text === 'string' && body.text.trim()) { hit.item.text = body.text.trim(); hit.item.edited = now().toISOString(); }
      if (body.anchor && hit.item === hit.root) { hit.root.anchor = body.anchor; hit.root.status = 'open'; }
      if (typeof body.resolved === 'boolean' && hit.item === hit.root) hit.root.status = body.resolved ? 'applied' : 'open';
      save();
      return answer(200, { ok: true });
    }
    if (path === '/api/comments' && method === 'DELETE') {
      const cid = params.get('id');
      const list = load();
      const at = list.findIndex((c) => c.id === cid);
      if (at >= 0) list.splice(at, 1);
      else for (const c of list) c.replies = (c.replies || []).filter((r) => r.id !== cid);
      save();
      return answer(200, { ok: true });
    }
    if (path === '/api/reactions' && method === 'POST') {
      const hit = find(body.comment_id);
      if (!hit || typeof body.emoji !== 'string') return answer(404, { error: 'not_found' });
      const reactions = { ...(hit.item.reactions || {}) };
      const by = reactions[body.emoji] || [];
      reactions[body.emoji] = by.includes(IDENTITY.login) ? by.filter((x) => x !== IDENTITY.login) : [...by, IDENTITY.login];
      if (!reactions[body.emoji].length) delete reactions[body.emoji];
      hit.item.reactions = reactions;
      save();
      return answer(200, { ok: true });
    }
    // Agents, Share, invites, connect: not in the demo. Refused here, so
    // nothing ever falls through to the network.
    return answer(404, { error: 'not_in_demo' });
  }

  // fetch(url, options): the signature api.js and the widget call. The URL
  // may be absolute (the tdoc base) or a path; only its path and query count.
  async function demoFetch(url, options = {}) {
    let parsed;
    try { parsed = new URL(String(url), 'https://demo.invalid'); } catch (_) { return answer(400, { error: 'bad_url' }); }
    const method = String((options && options.method) || 'GET').toUpperCase();
    return handle(method, parsed.pathname, parsed.searchParams, method === 'GET' ? {} : readBody(options));
  }

  return { fetch: demoFetch, comments: () => load().slice() };
}
