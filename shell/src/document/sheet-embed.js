import { EMBED_MAX_PER_PAGE, embedQuery, readEmbedRef } from '../../../shared/sheet-embed.mjs';

// Sheet embeds, the shell's half. A page's `<figure data-tdoc-embed="sheet">`
// is drawn by the embed viewer in the doc frame (server/sheet-embed-viewer.js),
// which cannot fetch: its origin is opaque and it carries no credentials. It
// asks here; this asks GET /api/embed/sheet as the person reading (their
// cookie), and the server applies the SHEET's access rules. The answer goes
// back on the MessagePort the request brought, never to '*'.
//
//   frame → shell { type:'tdoc:sheetEmbed', key, id, src, tab, view, rows, columns } + [port]
//   shell → port  { ok:true, data } | { ok:false, error, signedIn }
//
// The key: the frame is opened at <frameSrc>#tdoc-embed=<key>, random per
// frame load. Only the document the shell opened knows it; a page the
// frame is navigated to does not (a fragment is never sent on), so a request
// without it is a request from somebody else, and gets nothing.

function randomKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// One key per frame load: the frame's first address gets one, and every
// reload (the editor's Discard) a new one, so a key never outlives the
// document it was given to. `reload` also changes the address itself (the
// same address with another fragment would only scroll the frame).
let currentKey = '';
let loads = 0;
let requestsThisLoad = 0;
export function currentEmbedKey() { return currentKey; }
export function embedFrameSrc(src, reload = false) {
  const base = String(src || '').replace(/#.*$/, '');
  if (!base) return base;
  if (!currentKey || reload) { currentKey = randomKey(); requestsThisLoad = 0; }
  const url = reload ? `${base}${base.includes('?') ? '&' : '?'}tdoc_load=${++loads}` : base;
  return `${url}#tdoc-embed=${currentKey}`;
}

const ANSWER_CACHE_MS = 30_000;
// Requests one frame load may make: an embed per figure, and a few retries.
const MAX_REQUESTS = EMBED_MAX_PER_PAGE * 2;

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// `page`: this page's slug, from the shell's own config (never from the
// frame). The server embeds a sheet only if the reader can read this page
// and the sheet, and this page's author can read the sheet.
export function createSheetEmbedHandler({ enabled, page, fetchImpl = (...args) => fetch(...args) } = {}) {
  const answers = new Map();

  async function load(ref) {
    const slug = typeof page === 'function' ? page() : page;
    const query = `page=${encodeURIComponent(String(slug || ''))}&${embedQuery(ref)}`;
    const cached = answers.get(query);
    if (cached && Date.now() - cached.at < ANSWER_CACHE_MS) return cached.answer;
    const answer = (async () => {
      try {
        const res = await fetchImpl(`/api/embed/sheet?${query}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        let body = null;
        try { body = await res.json(); } catch {}
        if (res.ok && body && body.ok === true) return { ok: true, data: body };
        return { ok: false, error: str(body && body.error, 40) || (res.status === 429 ? 'rate_limited' : 'error'), signedIn: body && typeof body.signed_in === 'boolean' ? body.signed_in : undefined };
      } catch {
        return { ok: false, error: 'network' };
      }
    })();
    answers.set(query, { at: Date.now(), answer });
    const out = await answer;
    // A failure is not kept: the next ask tries again.
    if (!out.ok) answers.delete(query);
    return out;
  }

  return async function handle(message, event) {
    const port = event && event.ports && event.ports.length === 1 ? event.ports[0] : null;
    if (!port) return;
    const reply = (value) => { try { port.postMessage(value); port.close(); } catch {} };
    // Not the frame this shell opened: no answer at all.
    if (!message || !currentKey || message.key !== currentKey) { try { port.close(); } catch {} return; }
    if (!(typeof enabled === 'function' ? enabled() : enabled)) return reply({ ok: false, error: 'disabled' });
    if (++requestsThisLoad > MAX_REQUESTS) return reply({ ok: false, error: 'rate_limited' });
    const attrs = {
      'data-tdoc-embed': 'sheet',
      'data-src': str(message.src, 600),
      'data-tab': str(message.tab, 200),
      'data-view': str(message.view, 4000),
      'data-rows': str(String(message.rows ?? ''), 10),
      'data-columns': str(message.columns, 1000),
    };
    // Only this tdoc: a full link must be to this host; anything else is
    // not a reference at all (a tdoc.dev link on a self-hosted tdoc names
    // another server's doc, not the one with that slug here).
    const ref = readEmbedRef((name) => attrs[name] ?? null, [location.host]);
    if (!ref) return reply({ ok: false, error: 'invalid_reference' });
    reply(await load(ref));
  };
}
