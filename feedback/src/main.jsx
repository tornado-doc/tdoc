import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquarePlus } from 'lucide-react';
import { CommentCard } from '../../shell/src/document/comment-card.jsx';
import { CommentComposer } from '../../shell/src/document/comment-composer.jsx';
import { avatarFor } from '../../shell/src/document/model.js';
import chromeCss from '../../server/chrome.css?inline';
// ui.css resets <button> chrome on Reply / Edit / Resolve — without it those
// controls keep the browser's default button look on foreign pages.
import uiCss from '../../shell/src/ui/ui.css?inline';

if (window.top === window && !window.__TDOC_FEEDBACK__) {
  window.__TDOC_FEEDBACK__ = true;

  const style = document.createElement('style');
  style.id = 'tdoc-feedback-styles';
  style.textContent = `${chromeCss}
${uiCss}
    #tdoc-feedback-root { position: fixed; inset: 0; z-index: 2147483640; pointer-events: none; }
    #tdoc-feedback-root * { box-sizing: border-box; }
    #tdoc-feedback-root .tdoc-hover-outline { position: fixed; }
    #tdoc-feedback-root .tdoc-pin { position: fixed; z-index: 2147483642; }
    #tdoc-feedback-root .tdoc-popup,
    #tdoc-feedback-root .tdoc-margin-comment { pointer-events: auto; }
    #tdoc-feedback-root .tdoc-margin-comment.tdoc-floating-open {
      position: fixed; max-height: calc(100vh - 24px); overflow-y: auto;
      overscroll-behavior: contain; z-index: 2147483643;
    }
    #tdoc-feedback-root .tdoc-feedback-mode {
      position: fixed !important; right: 18px !important; bottom: 18px !important;
      left: auto !important; top: auto !important; pointer-events: auto;
    }
    #tdoc-feedback-root .tdoc-feedback-idle { opacity: .82; }
    #tdoc-feedback-root .tdoc-feedback-idle:hover { opacity: 1; }
    #tdoc-feedback-root .tdoc-feedback-notice { width: 320px; }
    #tdoc-feedback-root .tdoc-feedback-notice p { color: #ccc; line-height: 1.45; }
    #tdoc-feedback-root .tdoc-feedback-notice a,
    #tdoc-feedback-root .tdoc-feedback-notice button { color: #fff; }
    .ui-menu-positioner, .tdoc-picker-positioner, .tdoc-mention-menu {
      z-index: 2147483647 !important;
    }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = 'tdoc-feedback-root';
  document.documentElement.appendChild(host);

  // Where we came from is where the comments go: the worker that served this
  // script. The bookmarklet and the one-line install both load it by URL.
  const base = (() => {
    try {
      const own = document.currentScript && document.currentScript.src;
      if (own) return new URL(own).origin;
    } catch (_) {}
    return window.__TDOC_FEEDBACK_BASE__ || 'https://tdoc.dev';
  })();
  const autoOpen = Boolean(document.currentScript && document.currentScript.getAttribute('data-tdoc-open'));
  const storageKey = `tdoc-feedback:${base}`;

  // The connect popup mints a token that stands in for our missing cookie
  // (see getSession in the worker). It lives with the app's origin: one per
  // app, not one per page.
  const readSession = () => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) { return null; }
  };
  const writeSession = (session) => {
    try {
      if (session) localStorage.setItem(storageKey, JSON.stringify(session));
      else localStorage.removeItem(storageKey);
    } catch (_) {}
  };

  async function request(pathname, options = {}) {
    const session = readSession();
    const response = await fetch(`${base}${pathname}`, {
      credentials: 'omit', ...options,
      headers: {
        'content-type': 'application/json',
        ...(session && session.token ? { authorization: `Bearer ${session.token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body && (body.message || body.error) || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  // First run on an app: a small window on the worker's origin, where the
  // cookie is, signs the person in if needed and posts the token back here.
  let connecting = null;
  function connect() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const url = `${base}/feedback/connect?origin=${encodeURIComponent(location.origin)}`;
      const popup = window.open(url, 'tdoc-feedback-connect', 'popup,width=520,height=640');
      if (!popup) {
        const error = new Error('Your browser blocked the tdoc window. Allow pop-ups for this site and try again.');
        error.status = 0;
        error.blocked = true;
        reject(error);
        return;
      }
      const done = (fn) => (value) => {
        window.removeEventListener('message', onMessage);
        clearInterval(watch);
        connecting = null;
        fn(value);
      };
      const finish = done(resolve);
      const fail = done(reject);
      const onMessage = (event) => {
        if (event.origin !== base || !event.data || event.data.type !== 'tdoc-feedback-connected') return;
        if (event.data.origin !== location.origin) return;
        const session = event.data.session;
        if (!session || !session.token) return;
        writeSession(session);
        finish(session);
      };
      window.addEventListener('message', onMessage);
      const watch = setInterval(() => {
        if (popup.closed) {
          const error = new Error('The tdoc window was closed before connecting.');
          error.status = 0;
          fail(error);
        }
      }, 500);
    });
    return connecting;
  }

  // A stored token that the worker no longer honours is dropped, not retried.
  async function ensureSession() {
    const stored = readSession();
    if (stored && stored.token) {
      try {
        const fresh = await request('/api/feedback/session');
        const session = { ...stored, ...fresh, token: stored.token };
        writeSession(session);
        return session;
      } catch (error) {
        if (error.status !== 401 && error.status !== 403 && error.status !== 404) throw error;
        writeSession(null);
      }
    }
    return connect();
  }

  const canonical = () => {
    const url = new URL(location.href);
    url.hash = '';
    return url.href;
  };
  const cssEscape = (value) => window.CSS?.escape
    ? CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    for (let current = element; current && current.nodeType === 1 && parts.length < 7; current = current.parentElement) {
      let part = current.localName;
      const stable = [...current.classList]
        .filter((name) => !/^(active|hover|focus|selected|open|css-|sc-)/.test(name))
        .slice(0, 2);
      if (stable.length) part += stable.map((name) => `.${cssEscape(name)}`).join('');
      const parent = current.parentElement;
      if (parent) {
        const peers = [...parent.children].filter((peer) => peer.localName === current.localName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current.matches('main,nav,header,footer,[role="main"]')) break;
    }
    return parts.join(' > ');
  }

  function contextFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      kind: 'product',
      url: canonical(),
      selector: selectorFor(element),
      tag: element.localName,
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      accessible_name: element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '',
      rect: {
        x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
    };
  }

  function elementFor(comment) {
    try { return document.querySelector(comment?.anchor?.selector || ''); }
    catch (_) { return null; }
  }

  function cardPosition(element) {
    const rect = element?.getBoundingClientRect();
    if (!rect) return { top: 60, left: Math.max(8, innerWidth - 300) };
    const left = rect.right + 294 < innerWidth ? rect.right + 10 : Math.max(8, rect.left - 290);
    return { top: Math.max(12, rect.top), left };
  }

  async function loadSurface(session, pageUrl) {
    const query = new URLSearchParams({ slug: session.slug, version: String(session.version) });
    const comments = await request(`/api/comments?${query}`);
    let mentionable = [];
    let mentions = null;
    let signedIn = true;
    try {
      mentions = await request(`/api/mentions?slug=${encodeURIComponent(session.slug)}`);
      mentionable = Array.isArray(mentions && mentions.users) ? mentions.users : [];
    } catch (error) {
      if (error.status === 401 || error.status === 403) signedIn = false;
      else throw error;
    }
    return {
      ok: true,
      config: session,
      comments: (Array.isArray(comments) ? comments : []).filter((comment) =>
        comment && comment.anchor && comment.anchor.kind === 'product' && comment.anchor.url === pageUrl),
      mentionable, signedIn,
      currentUser: (mentions && mentions.identity && mentions.identity.login) || (session.identity && session.identity.login) || 'anon',
      isOwner: Boolean(mentions && mentions.is_owner),
    };
  }

  // Every action: do the thing, then hand back the page's fresh surface. A
  // failure comes back as { ok: false, status, error } so the UI can say why.
  async function call(message) {
    try {
      const session = await ensureSession();
      const { slug, version } = session;
      const pageUrl = message.pageUrl || (message.anchor && message.anchor.url) || canonical();
      const body = (fields) => JSON.stringify({ slug, version, ...fields });
      switch (message.type) {
        case 'tdoc-feedback-load':
          break;
        case 'tdoc-feedback-submit':
          await request('/api/comments', { method: 'POST', body: body({ text: message.text, anchor: message.anchor }) });
          break;
        case 'tdoc-feedback-reply':
          await request('/api/comments', { method: 'POST', body: body({ text: message.text, parent_id: message.parentId }) });
          break;
        case 'tdoc-feedback-resolve':
          await request('/api/comments', { method: 'PATCH', body: body({ id: message.id, resolved: Boolean(message.resolved) }) });
          break;
        case 'tdoc-feedback-edit':
          await request('/api/comments', { method: 'PATCH', body: body({ id: message.id, text: message.text }) });
          break;
        case 'tdoc-feedback-reanchor':
          await request('/api/comments', { method: 'PATCH', body: body({ id: message.id, anchor: message.anchor }) });
          break;
        case 'tdoc-feedback-delete': {
          const query = new URLSearchParams({ slug, version: String(version), id: message.id });
          await request(`/api/comments?${query}`, { method: 'DELETE' });
          break;
        }
        case 'tdoc-feedback-react':
          await request('/api/reactions', { method: 'POST', body: body({ comment_id: message.id, emoji: message.emoji }) });
          break;
        case 'tdoc-feedback-signin':
          writeSession(null);
          await connect();
          break;
        default:
          return { ok: false, error: 'Unknown feedback action' };
      }
      return loadSurface(session, pageUrl);
    } catch (error) {
      return { ok: false, status: error.status || 0, blocked: Boolean(error.blocked), error: String(error && error.message || error) };
    }
  }

  function FeedbackApp() {
    const [active, setActive] = useState(false);
    const [surface, setSurface] = useState(null);
    const [hovered, setHovered] = useState(null);
    const [selected, setSelected] = useState(null);
    const [openId, setOpenId] = useState(null);
    const [notice, setNotice] = useState(null);
    const [reanchorId, setReanchorId] = useState(null);
    const [, setViewportTick] = useState(0);

    const apply = useCallback((result) => {
      if (result?.ok) {
        setSurface(result);
        setNotice(result.signedIn === false ? { status: 401, error: 'Connect your tdoc account to comment here.' } : null);
        return true;
      }
      setNotice(result || { error: 'Could not load tdoc comments' });
      return false;
    }, []);

    const load = useCallback(async () => apply(await call({
      type: 'tdoc-feedback-load', pageUrl: canonical(),
    })), [apply]);

    const toggle = useCallback(async () => {
      const next = !active;
      setActive(next);
      setSelected(null);
      setOpenId(null);
      setHovered(null);
      if (next) await load();
    }, [active, load]);

    // The bookmarklet's second click, and anything else on the page that
    // wants to drive us, goes through window.tdocFeedback.
    useEffect(() => {
      window.tdocFeedback = {
        toggle,
        open: () => { if (!active) toggle(); },
        close: () => { if (active) toggle(); },
        disconnect: () => { writeSession(null); if (active) toggle(); },
        base,
      };
    }, [active, toggle]);
    useEffect(() => {
      if (autoOpen) toggle();
      // Once: the bookmarklet asked for the mode to be on when it loaded us.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!active) return undefined;
      const priorCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
      let lastAlt = 0;

      const isTdocUi = (target) => target.closest?.('#tdoc-feedback-root, .ui-menu-positioner, .tdoc-picker-positioner, .tdoc-mention-menu');
      const move = (event) => {
        if (selected || openId || notice || isTdocUi(event.target)) return;
        setHovered(event.target instanceof Element ? event.target : null);
      };
      const click = async (event) => {
        if (selected || openId || notice || isTdocUi(event.target)) return;
        const element = event.target instanceof Element ? event.target : null;
        if (!element || element === document.body || element === document.documentElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (reanchorId) {
          const result = await call({
            type: 'tdoc-feedback-reanchor', id: reanchorId,
            anchor: contextFor(element), pageUrl: canonical(),
          });
          if (apply(result)) setReanchorId(null);
          setHovered(null);
          return;
        }
        setSelected(element);
        setHovered(null);
      };
      const keydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSelected(null); setOpenId(null); setHovered(null); setReanchorId(null); setActive(false);
          return;
        }
        if (event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.target.matches?.('input,textarea,select') || event.target.isContentEditable) return;
        const now = Date.now();
        if (now - lastAlt < 430) { event.preventDefault(); lastAlt = 0; toggle(); } else lastAlt = now;
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', keydown, true);
      return () => {
        document.documentElement.style.cursor = priorCursor;
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', keydown, true);
      };
    }, [active, selected, openId, notice, reanchorId, apply, toggle]);

    useEffect(() => {
      if (!active) return undefined;
      const refresh = () => setViewportTick((tick) => tick + 1);
      window.addEventListener('scroll', refresh, { passive: true });
      window.addEventListener('resize', refresh);
      return () => {
        window.removeEventListener('scroll', refresh);
        window.removeEventListener('resize', refresh);
      };
    }, [active]);

    useEffect(() => {
      let lastAlt = 0;
      const keydown = (event) => {
        if (active || event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.target.matches?.('input,textarea,select') || event.target.isContentEditable) return;
        const now = Date.now();
        if (now - lastAlt < 430) { event.preventDefault(); lastAlt = 0; toggle(); } else lastAlt = now;
      };
      document.addEventListener('keydown', keydown, true);
      return () => document.removeEventListener('keydown', keydown, true);
    }, [active, toggle]);

    const comments = surface?.comments || [];
    const openComment = comments.find((comment) => comment.id === openId);
    const mentionable = surface?.mentionable || [];
    const mutate = async (message, keepOpen = true) => {
      const result = await call(message);
      if (!apply(result)) return false;
      if (!keepOpen) setOpenId(null);
      return true;
    };
    const pins = useMemo(() => comments.map((comment) => ({ comment, element: elementFor(comment) })), [comments]);

    if (!active) {
      return (
        <button className="tdoc-comment-pill tdoc-feedback-mode tdoc-feedback-idle" type="button" title="Leave feedback · tdoc" onClick={toggle}>
          <MessageSquarePlus aria-hidden="true" />
        </button>
      );
    }
    const hoverRect = hovered?.getBoundingClientRect();
    return (
      <>
        {hoverRect ? <div className="tdoc-hover-outline" style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }} /> : null}
        {pins.map(({ comment, element }) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const avatar = avatarFor(comment.author || comment);
          return (
            <button
              key={comment.id}
              type="button"
              className={`tdoc-pin${comment.status === 'applied' ? ' tdoc-pin-resolved' : ''}${comment.deleted ? ' tdoc-pin-deleted' : ''}`}
              style={{ left: Math.min(innerWidth - 32, Math.max(4, rect.right - 14)), top: Math.min(innerHeight - 32, Math.max(4, rect.top - 14)) }}
              onClick={() => { setSelected(null); setOpenId(comment.id); }}
              title={comment.text || 'tdoc comment'}
            >
              {avatar ? <img src={avatar} alt="" /> : <span className="tdoc-pin-anon" />}
            </button>
          );
        })}

        {selected ? (
          <CommentComposer
            selection={{ kind: 'element', label: contextFor(selected).accessible_name || contextFor(selected).selector, rect: selected.getBoundingClientRect() }}
            mentionable={mentionable}
            onClose={() => setSelected(null)}
            onSubmit={async (text) => {
              const anchor = contextFor(selected);
              const result = await call({ type: 'tdoc-feedback-submit', text, anchor });
              if (apply(result)) setSelected(null);
            }}
          />
        ) : null}

        {openComment ? (
          <CommentCard
            comment={openComment}
            currentUser={surface.currentUser || 'anon'}
            isOwner={Boolean(surface.isOwner)}
            mentionable={mentionable}
            unanchored={!elementFor(openComment)}
            floating
            position={cardPosition(elementFor(openComment))}
            onReply={(parentId, text) => mutate({ type: 'tdoc-feedback-reply', text, parentId, pageUrl: canonical() })}
            onReact={(id, emoji) => mutate({ type: 'tdoc-feedback-react', id, emoji, pageUrl: canonical() })}
            onDelete={(id) => mutate({ type: 'tdoc-feedback-delete', id, pageUrl: canonical() }, false)}
            onResolve={(id, resolved) => mutate({ type: 'tdoc-feedback-resolve', id, resolved, pageUrl: canonical() })}
            onEdit={(id, text) => mutate({ type: 'tdoc-feedback-edit', id, text, pageUrl: canonical() })}
            onReanchor={(id) => { setOpenId(null); setReanchorId(id); }}
          />
        ) : null}

        {notice ? (
          <section className="tdoc-popup tdoc-feedback-notice" style={{ top: 64, right: 18, left: 'auto' }}>
            <div className="head"><span className="h">{notice.status === 401 ? 'Connect to comment' : 'tdoc Feedback'}</span><button className="x" type="button" onClick={() => setNotice(null)}>×</button></div>
            <p>{notice.error}</p>
            <div className="foot"><span /><button className="submit" type="button" onClick={async () => { setNotice(null); apply(await call({ type: 'tdoc-feedback-signin', pageUrl: canonical() })); }}>Connect tdoc</button></div>
          </section>
        ) : null}

        <button className="tdoc-comment-pill tdoc-feedback-mode" type="button" title={reanchorId ? 'Choose the new anchor · Esc to exit' : 'Exit tdoc feedback · Esc'} onClick={() => setActive(false)}>
          <MessageSquarePlus aria-hidden="true" />
        </button>
      </>
    );
  }

  createRoot(host).render(<FeedbackApp />);
}
