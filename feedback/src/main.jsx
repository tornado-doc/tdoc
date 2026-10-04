import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquarePlus, MessagesSquare, Plus, Link2, ExternalLink, X, Send } from 'lucide-react';
import { CommentCard } from '../../shell/src/document/comment-card.jsx';
import { CommentComposer } from '../../shell/src/document/comment-composer.jsx';
import { avatarFor } from '../../shell/src/document/model.js';
import { CONNECT_AGENT_PROMPT, NotifyHandoffPanel, deliveryErrorText } from '../../shell/src/document/notify-handoff.jsx';
import { summarizeHandoffSurfaces, threadPhase } from '../../shell/src/document/handoff-state.js';
import { setApiTransport } from '../../shell/src/document/api.js';
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
    #tdoc-feedback-root .tdoc-feedback-dock {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483642; pointer-events: auto;
      display: flex; align-items: center; gap: 4px; padding: 5px; border-radius: 999px;
      background: #fff; color: #1a1a1a; border: 1px solid #e5e5e7;
      box-shadow: 0 6px 24px rgba(0,0,0,.12); font: 600 12.5px/1.2 system-ui, -apple-system, sans-serif;
    }
    #tdoc-feedback-root .tdoc-feedback-dock button,
    #tdoc-feedback-root .tdoc-feedback-dock a {
      appearance: none; border: 0; background: transparent; color: #1a1a1a; cursor: pointer;
      border-radius: 999px; padding: 7px 11px; font: inherit; text-decoration: none;
      display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
    }
    #tdoc-feedback-root .tdoc-feedback-dock svg { width: 15px; height: 15px; }
    #tdoc-feedback-root .tdoc-feedback-dock button:hover,
    #tdoc-feedback-root .tdoc-feedback-dock a:hover,
    #tdoc-feedback-root .tdoc-feedback-dock .on { background: #f0f0ee; }
    #tdoc-feedback-root .tdoc-feedback-dock .icon, #tdoc-feedback-root .tdoc-feedback-dock a { padding: 7px; color: #6b6a66; }
    #tdoc-feedback-root .tdoc-feedback-dock button.primary { background: #1652f0; color: #fff; }
    #tdoc-feedback-root .tdoc-feedback-dock button.primary:hover,
    #tdoc-feedback-root .tdoc-feedback-dock button.primary.on { background: #1245d0; color: #fff; }
    #tdoc-feedback-root .tdoc-fb-badge {
      position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px;
      border-radius: 999px; background: #1652f0; color: #fff; font: 700 10px/17px system-ui, sans-serif; text-align: center;
    }
    #tdoc-feedback-root .tdoc-fb-banner {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483643; pointer-events: auto;
      display: flex; align-items: center; gap: 12px; padding: 9px 10px 9px 16px; border-radius: 999px;
      background: #1a1a1a; color: #fff; font: 600 13px/1.2 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.22);
    }
    #tdoc-feedback-root .tdoc-fb-banner button {
      appearance: none; border: 0; cursor: pointer; border-radius: 999px; padding: 5px 10px;
      background: rgba(255,255,255,.14); color: #fff; font: inherit;
    }
    #tdoc-feedback-root .tdoc-fb-toast {
      position: fixed; bottom: 70px; z-index: 2147483643; pointer-events: auto;
      padding: 9px 14px; border-radius: 10px; background: #1a1a1a; color: #fff;
      font: 500 13px/1.35 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.18);
    }
    #tdoc-feedback-root .tdoc-fb-toast.bad { background: #b42318; }
    #tdoc-feedback-root .tdoc-pin.is-active { outline: 2px solid #1652f0; outline-offset: 2px; }
    #tdoc-feedback-root .tdoc-fb-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 340px; z-index: 2147483641; pointer-events: auto;
      display: flex; flex-direction: column; background: #fff; color: #1a1a1a;
      border-left: 1px solid #e8e7e3; box-shadow: -8px 0 28px rgba(0,0,0,.08);
      font: 13px/1.45 system-ui, -apple-system, sans-serif;
    }
    #tdoc-feedback-root .tdoc-fb-panel header {
      display: flex; align-items: center; gap: 8px; padding: 14px 10px 12px 14px; border-bottom: 1px solid #efeeea;
    }
    #tdoc-feedback-root .tdoc-fb-panel header strong { font-size: 15px; }
    #tdoc-feedback-root .tdoc-fb-filter { display: inline-flex; gap: 2px; margin-left: auto; background: #f3f3f1; border-radius: 8px; padding: 2px; }
    #tdoc-feedback-root .tdoc-fb-filter button { appearance: none; border: 0; background: transparent; border-radius: 6px; padding: 4px 6px; font: 600 11.5px system-ui, sans-serif; color: #6b6a66; cursor: pointer; }
    #tdoc-feedback-root .tdoc-fb-filter button.on { background: #fff; color: #1a1a1a; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    #tdoc-feedback-root .tdoc-fb-panel .x { appearance: none; border: 0; background: none; font-size: 20px; line-height: 1; color: #8a8985; cursor: pointer; padding: 0 2px; }
    #tdoc-feedback-root .tdoc-fb-scroll { flex: 1; overflow-y: auto; padding: 6px 8px 16px; overscroll-behavior: contain; }
    #tdoc-feedback-root .tdoc-fb-scroll h4 { margin: 14px 8px 6px; font: 700 11px/1.2 system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #8a8985; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tdoc-feedback-root .tdoc-fb-scroll ul { list-style: none; margin: 0; padding: 0; }
    #tdoc-feedback-root .tdoc-fb-item {
      appearance: none; border: 0; background: none; width: 100%; text-align: left; cursor: pointer;
      display: grid; gap: 3px; padding: 9px 8px; border-radius: 8px; color: inherit; font: inherit;
    }
    #tdoc-feedback-root .tdoc-fb-item:hover { background: #f6f6f4; }
    #tdoc-feedback-root .tdoc-fb-item .who { font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
    #tdoc-feedback-root .tdoc-fb-item .when { font-weight: 400; color: #8a8985; font-size: 12px; }
    #tdoc-feedback-root .tdoc-fb-item .done { margin-left: auto; font: 600 11px system-ui, sans-serif; color: #0f7b3f; }
    #tdoc-feedback-root .tdoc-fb-item .done.replied { color: #3b5bdb; }
    #tdoc-feedback-root .tdoc-fb-item .what { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #tdoc-feedback-root .tdoc-fb-item .state { font-size: 12px; color: #6b6a66; }
    #tdoc-feedback-root .tdoc-fb-item .state.hidden { color: #9a5b00; }
    #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-send { position: relative; padding: 7px; }
    #tdoc-feedback-root .tdoc-fb-send-badge { position: absolute; top: 0; right: -2px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 999px; background: #1652f0; color: #fff; font: 700 9.5px/15px system-ui, sans-serif; text-align: center; }
    #tdoc-feedback-root .tdoc-fb-item .where { color: #8a8985; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tdoc-feedback-root .tdoc-fb-panel .empty { margin: 4px 8px; color: #8a8985; }
    #tdoc-feedback-root .tdoc-fb-panel .link { appearance: none; border: 0; background: none; padding: 0; color: #1652f0; font: inherit; cursor: pointer; }
    #tdoc-feedback-root .tdoc-fb-agent { border-top: 1px solid #efeeea; padding: 12px 14px 14px; background: #fafaf8; }
    #tdoc-feedback-root .tdoc-fb-agent p { margin: 0 0 8px; }
    #tdoc-feedback-root .tdoc-fb-agent code { display: block; margin: 0 0 8px; padding: 8px; border-radius: 6px; background: #fff; border: 1px solid #e8e7e3; font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: normal; }
    #tdoc-feedback-root .tdoc-fb-agent button { appearance: none; border: 0; border-radius: 8px; padding: 6px 12px; background: #1652f0; color: #fff; font: 600 12px system-ui, sans-serif; cursor: pointer; }
    .ui-dialog-backdrop, .ui-dialog-viewport { z-index: 2147483646 !important; }
    /* Dialogs render outside our root, where the host app's own button and
       text rules reach them. Pin the few that matter. */
    .ui-dialog-popup.tdoc-modal { color: #1a1a1a; font: 14px/1.45 system-ui, -apple-system, sans-serif; text-align: left; }
    .ui-dialog-popup.tdoc-modal button { font: 600 13px/1.2 system-ui, -apple-system, sans-serif; text-transform: none; letter-spacing: normal; box-shadow: none; }
    .ui-dialog-popup.tdoc-modal .actions button:not(.primary):not(.danger) { background: #fff !important; color: #1a1a1a !important; border: 1px solid #d9d8d4 !important; }
    .ui-dialog-popup.tdoc-modal .actions button.primary { background: #1652f0 !important; color: #fff !important; border: 1px solid #1652f0 !important; }
    .ui-dialog-popup.tdoc-modal textarea { color: #1a1a1a; background: #fff; }
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

  // The doc page's panels (Send to agent) call the shared API module; point
  // it at the tdoc host with this app's feedback token.
  setApiTransport({
    base,
    headers: () => {
      const session = readSession();
      return session && session.token ? { authorization: `Bearer ${session.token}` } : {};
    },
  });

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
    const attempt = new Promise((resolve, reject) => {
      const url = `${base}/feedback/connect?origin=${encodeURIComponent(location.origin)}`;
      let popup = null;
      let watch = null;
      const done = (fn) => (value) => {
        window.removeEventListener('message', onMessage);
        clearInterval(watch);
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
      // Listen before opening. A signed-in popup can answer immediately, and
      // registering afterwards leaves the app waiting for a message it missed.
      window.addEventListener('message', onMessage);
      popup = window.open(url, 'tdoc-feedback-connect', 'popup,width=520,height=640');
      if (!popup) {
        window.removeEventListener('message', onMessage);
        const error = new Error('Your browser blocked the tdoc window. Allow pop-ups for this site and try again.');
        error.status = 0;
        error.blocked = true;
        reject(error);
        return;
      }
      watch = setInterval(() => {
        if (popup.closed) {
          const error = new Error('The tdoc window was closed before connecting.');
          error.status = 0;
          fail(error);
        }
      }, 500);
    });
    // Every attempt, including a browser-blocked popup, must release the
    // single-flight slot. Otherwise the first rejected Promise is cached and
    // every later click fails without even trying to open a window.
    connecting = attempt.then(
      (session) => { connecting = null; return session; },
      (error) => { connecting = null; throw error; },
    );
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
        // 409: this person joined another space for the app (an invite) since
        // the token was minted — reconnect so it names the one they joined.
        if (![401, 403, 404, 409].includes(error.status)) throw error;
        writeSession(null);
      }
    }
    return connect();
  }

  // A page's key. The hash is dropped — except a hash route (#/creators),
  // which is how single-page apps name their pages: dropping it filed every
  // tab of a dashboard under one page, and comments left on another tab
  // read as lost. "#/" alone is the home route, same as no hash.
  const canonical = () => {
    const url = new URL(location.href);
    if (!/^#!?\/./.test(url.hash)) url.hash = '';
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

  // Where in the app's state the element lived: an open dialog, the selected
  // tabs. A comment on a modal cannot be found once the modal is closed; this
  // is what tells the reader which state to open to see it in place.
  function stateFor(element) {
    const text = (node) => String(node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
    const state = {};
    const dialog = element.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    if (dialog) {
      const labelled = dialog.getAttribute('aria-labelledby');
      const byId = labelled && document.getElementById(labelled.split(/\s+/)[0]);
      const heading = dialog.querySelector('h1, h2, h3, [role="heading"]');
      state.dialog = (dialog.getAttribute('aria-label') || text(byId) || text(heading) || 'dialog').slice(0, 80);
    } else {
      // Unlabelled overlays: a fixed-position ancestor above the page.
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && Number(cs.zIndex) > 0) {
          const heading = node.querySelector('h1, h2, h3, [role="heading"]');
          state.layer = (node.getAttribute('aria-label') || text(heading) || 'overlay').slice(0, 80);
          break;
        }
      }
    }
    const tabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .map((tab) => text(tab).slice(0, 40)).filter(Boolean).slice(0, 3);
    if (tabs.length) state.tabs = tabs;
    if (document.title) state.title = document.title.slice(0, 120);
    return state;
  }

  function contextFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      state: stateFor(element),
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

  // Finding a comment's element again. The selector is positional
  // (nth-of-type), so a regenerated page — a dashboard rebuilt with one more
  // card — can point it at a different element. In order of trust:
  //   1. the selector's element, still showing the text it showed then;
  //   2. any element of that tag showing that text (it moved);
  //   3. the selector's element if it is still the same kind of element —
  //      the text changed in place (a number updated), the spot did not.
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const shownText = (el) => norm(el.innerText || el.textContent);
  const found = new Map();
  function elementFor(comment) {
    const anchor = comment && comment.anchor;
    if (!anchor) return null;
    const want = norm(anchor.text);
    const cached = found.get(comment.id);
    if (cached && cached.isConnected) return cached;
    let bySelector = null;
    try { bySelector = anchor.selector ? document.querySelector(anchor.selector) : null; } catch (_) { bySelector = null; }
    let el = null;
    if (bySelector && (!want || shownText(bySelector) === want)) el = bySelector;
    if (!el && want) {
      let candidates = [];
      try { candidates = document.querySelectorAll(anchor.tag || '*'); } catch (_) { candidates = []; }
      for (const node of candidates) {
        if (node.closest('#tdoc-feedback-root')) continue;
        if (shownText(node) === want) el = node; // keep the last (deepest) match
      }
    }
    if (!el && bySelector && (!anchor.tag || bySelector.localName === anchor.tag)) el = bySelector;
    if (el) found.set(comment.id, el); else found.delete(comment.id);
    return el;
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
      // Every page of the app, not just this one: the list shows them all,
      // and only this page's get pins.
      allComments: (Array.isArray(comments) ? comments : []).filter((comment) =>
        comment && comment.anchor && comment.anchor.kind === 'product'),
      comments: (Array.isArray(comments) ? comments : []).filter((comment) =>
        comment && comment.anchor && comment.anchor.kind === 'product' && comment.anchor.url === pageUrl),
      mentionable, signedIn,
      currentUser: (mentions && mentions.identity && mentions.identity.login) || (session.identity && session.identity.login) || 'anon',
      isOwner: Boolean(mentions && mentions.is_owner),
    };
  }

  // @agent: the same handoff the doc page makes. Owner-only on the server;
  // the result says whether it reached the agent, so the UI can say so.
  async function sendToAgent(slug, commentIds) {
    try {
      const body = await request('/api/notify/handoff', {
        method: 'POST',
        body: JSON.stringify({ slug, comment_ids: [].concat(commentIds), instruction: 'address this comment' }),
      });
      const failed = body && body.delivery && body.delivery.status === 'failed';
      return { ok: !failed, message: failed ? `Posted — not delivered to the agent${body.delivery.error ? `: ${deliveryErrorText(body.delivery.error)}` : ''}` : 'Sent to your agent' };
    } catch (error) {
      return { ok: false, message: `Posted — could not send to the agent (${error.message})` };
    }
  }

  // Who @agent would reach, for the owner. `no_agent_bound` means nobody is
  // linked yet — the case the UI turns into "connect your agent".
  async function notifyTargets(slug) {
    try {
      const body = await request(`/api/notify/targets?slug=${encodeURIComponent(slug)}`);
      const any = Boolean(body && (body.default || (body.candidates || []).length || body.fallback));
      return { ready: true, canSend: any && body.reason !== 'no_agent_bound', reason: (body && body.reason) || null };
    } catch (_) {
      return { ready: true, canSend: false, reason: null };
    }
  }

  // Every action: do the thing, then hand back the page's fresh surface. A
  // failure comes back as { ok: false, status, error } so the UI can say why.
  async function call(message) {
    try {
      const session = await ensureSession();
      const { slug, version } = session;
      const pageUrl = message.pageUrl || (message.anchor && message.anchor.url) || canonical();
      const body = (fields) => JSON.stringify({ slug, version, ...fields });
      let handoff = null;
      switch (message.type) {
        case 'tdoc-feedback-load':
          break;
        case 'tdoc-feedback-submit': {
          const made = await request('/api/comments', { method: 'POST', body: body({ text: message.text, anchor: message.anchor }) });
          if (message.sendToAgent && made && made.id) handoff = await sendToAgent(slug, made.id);
          break;
        }
        case 'tdoc-feedback-reply': {
          const made = await request('/api/comments', { method: 'POST', body: body({ text: message.text, parent_id: message.parentId }) });
          const target = message.handoffCommentId || (made && made.id);
          if (message.sendToAgent && target) handoff = await sendToAgent(slug, target);
          break;
        }
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
      const surface = await loadSurface(session, pageUrl);
      return handoff ? { ...surface, handoff } : surface;
    } catch (error) {
      return { ok: false, status: error.status || 0, blocked: Boolean(error.blocked), error: String(error && error.message || error) };
    }
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }


  const PANEL_WIDTH = 340;
  const pathOf = (href) => { try { const u = new URL(href); return `${u.pathname}${u.search}` || '/'; } catch (_) { return href; } };
  const labelOf = (anchor) => {
    const a = anchor || {};
    const text = String(a.text || '').trim();
    return a.accessible_name || (text ? `${a.tag || 'element'} · “${text.slice(0, 48)}${text.length > 48 ? '…' : ''}”` : (a.selector || 'element'));
  };
  // "in dialog “Invite teammates” · tab Billing" — the state to open.
  const stateLabel = (anchor) => {
    const st = (anchor && anchor.state) || {};
    const parts = [];
    if (st.dialog) parts.push(`in dialog “${st.dialog}”`);
    else if (st.layer) parts.push(`in “${st.layer}”`);
    if (st.tabs && st.tabs.length) parts.push(`tab ${st.tabs.join(' › ')}`);
    return parts.join(' · ');
  };
  const ago = (iso) => {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  };
  const isOpen = (c) => threadPhase(c) === 'open';

  function Dock({ session, openCount, panelOpen, picking, onList, onPick, onHide, sendCount, onSend }) {
    const [copied, setCopied] = useState(false);
    const invite = session && (session.invite_url || session.doc_url);
    const share = async () => {
      if (!invite || !(await copyText(invite))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    return (
      <div className="tdoc-feedback-dock" role="toolbar" aria-label="tdoc feedback" style={panelOpen ? { right: PANEL_WIDTH + 18 } : null}>
        <button type="button" className={panelOpen ? 'on' : ''} onClick={onList} title="All comments on this app">
          <MessagesSquare aria-hidden="true" /> <strong>{openCount}</strong> open
        </button>
        <button type="button" className={`primary${picking ? ' on' : ''}`} onClick={onPick} title="Click anything on the page to comment on it">
          <Plus aria-hidden="true" /> Comment
        </button>
        {onSend ? (
          // The doc page's Send to agent: same icon, same count (comments
          // never sent, or with a human word since the last handoff).
          <button type="button" className="tdoc-fb-send" onClick={onSend} title={sendCount ? `Send to agent (${sendCount} ready)` : 'Send to agent'} aria-label="Send to agent">
            <Send aria-hidden="true" />{sendCount ? <span className="tdoc-fb-send-badge">{sendCount > 99 ? '99+' : sendCount}</span> : null}
          </button>
        ) : null}
        {invite ? (
          <button type="button" onClick={share} title="Copy an invite link — teammates who open it comment in this same thread">
            <Link2 aria-hidden="true" /> {copied ? 'Invite link copied' : 'Invite'}
          </button>
        ) : null}
        {session && session.doc_url ? (
          <a href={session.doc_url} target="_blank" rel="noopener noreferrer" title="Open this thread on tdoc"><ExternalLink aria-hidden="true" /></a>
        ) : null}
        <button type="button" className="icon" onClick={onHide} title="Hide tdoc (click the bookmark to bring it back)" aria-label="Hide tdoc"><X aria-hidden="true" /></button>
      </div>
    );
  }

  function ListPanel({ all, pageUrl, filter, setFilter, onPick, onOpen, onClose }) {
    const shown = all.filter((c) => !c.deleted && (filter === 'all' || threadPhase(c) === filter));
    const here = shown.filter((c) => c.anchor.url === pageUrl);
    const elsewhere = new Map();
    for (const c of shown) {
      if (c.anchor.url === pageUrl) continue;
      if (!elsewhere.has(c.anchor.url)) elsewhere.set(c.anchor.url, []);
      elsewhere.get(c.anchor.url).push(c);
    }
    const item = (c, local) => {
      const author = c.author || {};
      const where = stateLabel(c.anchor);
      const hidden = local && !elementFor(c);
      const replies = Array.isArray(c.replies) ? c.replies.filter((r) => !r.deleted).length : 0;
      return (
        <li key={c.id}>
          <button type="button" className="tdoc-fb-item" onClick={() => onOpen(c, local)}>
            <span className="who">{author.name || author.login || 'anon'} <span className="when">{ago(c.created || c.ts)}</span>{threadPhase(c) === 'resolved' ? <span className="done">Resolved</span> : threadPhase(c) === 'replied' ? <span className="done replied">Replied</span> : null}</span>
            <span className="what">{c.text}</span>
            {where || hidden ? <span className={`state${hidden ? ' hidden' : ''}`}>{hidden ? 'Not on screen now' : ''}{hidden && where ? ' — ' : ''}{where}</span> : null}
            <span className="where">{labelOf(c.anchor)}{replies ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}</span>
          </button>
        </li>
      );
    };
    return (
      <aside className="tdoc-fb-panel" aria-label="Feedback on this app">
        <header>
          <strong>Feedback</strong>
          <span className="tdoc-fb-filter" role="group" aria-label="Show">
            {['open', 'replied', 'resolved', 'all'].map((f) => (
              <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </span>
          <button type="button" className="x" aria-label="Close list" onClick={onClose}>×</button>
        </header>
        <div className="tdoc-fb-scroll">
          <h4>This page</h4>
          {here.length ? <ul>{here.map((c) => item(c, true))}</ul> : (
            <p className="empty">Nothing {filter === 'all' ? '' : filter} here yet. <button type="button" className="link" onClick={onPick}>Add a comment</button></p>
          )}
          {[...elsewhere.entries()].map(([url, list]) => (
            <section key={url}>
              <h4 title={url}>{pathOf(url)}</h4>
              <ul>{list.map((c) => item(c, false))}</ul>
            </section>
          ))}
        </div>
      </aside>
    );
  }

  function FeedbackApp() {
    const [shown, setShown] = useState(false);
    const [picking, setPicking] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [filter, setFilter] = useState('open');
    const [surface, setSurface] = useState(null);
    const [session, setSession] = useState(() => readSession());
    const [hovered, setHovered] = useState(null);
    const [selected, setSelected] = useState(null);
    const [openId, setOpenId] = useState(null);
    const [notice, setNotice] = useState(null);
    const [toast, setToast] = useState(null);
    const [reanchorId, setReanchorId] = useState(null);
    const [agent, setAgent] = useState(null);
    const [notifyIds, setNotifyIds] = useState(null);
    const [, setViewportTick] = useState(0);

    const say = useCallback((text, bad = false) => {
      setToast({ text, bad });
      setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3200);
    }, []);

    const apply = useCallback((result) => {
      if (result?.ok) {
        setSurface(result);
        if (result.config) setSession((prev) => ({ ...(prev || {}), ...result.config, token: (prev && prev.token) || result.config.token }));
        setNotice(result.signedIn === false ? { status: 401, error: 'Connect your tdoc account to comment here.' } : null);
        if (result.handoff) say(result.handoff.message, !result.handoff.ok);
        return true;
      }
      setNotice(result || { error: 'Could not load tdoc comments' });
      return false;
    }, [say]);

    const load = useCallback(async () => apply(await call({
      type: 'tdoc-feedback-load', pageUrl: canonical(),
    })), [apply]);

    // Showing the overlay loads the thread. The first time on an app with no
    // comments yet goes straight to picking — that is what someone who just
    // clicked the bookmark came to do; otherwise the list opens so they can
    // see what is already there.
    const hiddenKey = `${storageKey}:hidden`;
    const show = useCallback(async ({ intent } = {}) => {
      try { localStorage.removeItem(hiddenKey); } catch (_) {}
      setShown(true);
      const result = await call({ type: 'tdoc-feedback-load', pageUrl: canonical() });
      if (!apply(result)) return;
      if (intent === 'bookmark') {
        const any = (result.allComments || []).some((c) => !c.deleted);
        if (any) setPanelOpen(true); else setPicking(true);
      }
    }, [apply, hiddenKey]);

    // Hidden stays hidden across reloads of the app until the bookmark (or
    // the pill) is clicked again — the one-line install would otherwise put
    // the overlay back on every page load.
    const hide = useCallback(() => {
      try { localStorage.setItem(hiddenKey, '1'); } catch (_) {}
      setShown(false); setPicking(false); setPanelOpen(false);
      setSelected(null); setOpenId(null); setHovered(null); setReanchorId(null);
    }, [hiddenKey]);

    const toggle = useCallback(() => { if (shown) hide(); else show({ intent: 'bookmark' }); }, [shown, hide, show]);

    // Warm the counts and the session quietly; connecting needs a click.
    useEffect(() => {
      let cancelled = false;
      (async () => {
        if (!readSession()) return;
        try {
          const next = await ensureSession();
          if (cancelled || !next) return;
          setSession(next);
          const result = await call({ type: 'tdoc-feedback-load', pageUrl: canonical() });
          let hidden = false;
          try { hidden = localStorage.getItem(`${storageKey}:hidden`) === '1'; } catch (_) {}
          if (!cancelled && result?.ok) { setSurface(result); if (!hidden) setShown(true); }
        } catch (_) {}
      })();
      return () => { cancelled = true; };
    }, []);

    // @agent is the owner's: ask once who it would reach.
    const owner = Boolean(surface?.isOwner);
    const slug = session && session.slug;
    useEffect(() => {
      if (!owner || !slug || !(session && session.notify)) { setAgent(null); return undefined; }
      let cancelled = false;
      notifyTargets(slug).then((t) => { if (!cancelled) setAgent({ ...t, owner: true }); });
      return () => { cancelled = true; };
    }, [owner, slug, session && session.notify]);
    const canSendToAgent = Boolean(agent && agent.canSend);

    useEffect(() => {
      window.tdocFeedback = {
        toggle,
        open: () => { if (!shown) show({ intent: 'bookmark' }); },
        close: hide,
        comment: () => { setShown(true); setPicking(true); },
        disconnect: () => { writeSession(null); hide(); },
        base,
      };
    }, [shown, toggle, show, hide]);
    useEffect(() => {
      if (autoOpen) show({ intent: 'bookmark' });
      // Once: the bookmarklet asked for the overlay when it loaded us.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Picking: the only mode that takes over the page's clicks. Browsing
    // leaves the app fully usable with the pins on top.
    useEffect(() => {
      if (!picking && !reanchorId) return undefined;
      const priorCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
      const isTdocUi = (target) => target.closest?.('#tdoc-feedback-root, .ui-menu-positioner, .tdoc-picker-positioner, .tdoc-mention-menu, .ui-dialog-viewport, .ui-dialog-backdrop');
      const move = (event) => {
        if (selected || isTdocUi(event.target)) return;
        setHovered(event.target instanceof Element ? event.target : null);
      };
      const click = async (event) => {
        if (selected || isTdocUi(event.target)) return;
        const element = event.target instanceof Element ? event.target : null;
        if (!element || element === document.body || element === document.documentElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (reanchorId) {
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: contextFor(element), pageUrl: canonical() });
          if (apply(result)) setReanchorId(null);
          setHovered(null);
          return;
        }
        setOpenId(null);
        setSelected(element);
        setHovered(null);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('click', click, true);
      return () => {
        document.documentElement.style.cursor = priorCursor;
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('click', click, true);
      };
    }, [picking, reanchorId, selected, apply]);

    // Esc steps back one level: composer → picking → card → list → hidden.
    useEffect(() => {
      if (!shown) return undefined;
      const keydown = (event) => {
        if (event.key !== 'Escape') return;
        if (selected) setSelected(null);
        else if (picking || reanchorId) { setPicking(false); setReanchorId(null); setHovered(null); }
        else if (openId) setOpenId(null);
        else if (panelOpen) setPanelOpen(false);
        else return;
        event.preventDefault();
      };
      document.addEventListener('keydown', keydown, true);
      return () => document.removeEventListener('keydown', keydown, true);
    }, [shown, selected, picking, reanchorId, openId, panelOpen]);

    // Double-tap Option: start a comment from anywhere.
    useEffect(() => {
      let lastAlt = 0;
      const keydown = (event) => {
        if (event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.target.matches?.('input,textarea,select') || event.target.isContentEditable) return;
        const now = Date.now();
        if (now - lastAlt < 430) { event.preventDefault(); lastAlt = 0; setShown(true); setPicking((p) => !p); if (!surface) load(); } else lastAlt = now;
      };
      document.addEventListener('keydown', keydown, true);
      return () => document.removeEventListener('keydown', keydown, true);
    }, [surface, load]);

    // The list docks instead of floating over the app: the page gives up the
    // panel's width while it is open, so the app's own top bar and right
    // edge (an account menu, buttons) stay visible and clickable beside it.
    useEffect(() => {
      if (!shown || !panelOpen) return undefined;
      const root = document.documentElement;
      const prior = root.style.marginRight;
      const priorTransition = root.style.transition;
      root.style.transition = 'margin-right .15s ease';
      root.style.marginRight = `${PANEL_WIDTH}px`;
      return () => { root.style.marginRight = prior; root.style.transition = priorTransition; };
    }, [shown, panelOpen]);

    // Hash-route navigation is a new page: reload which comments are here.
    useEffect(() => {
      if (!shown) return undefined;
      let last = canonical();
      const onNav = () => { const now = canonical(); if (now !== last) { last = now; load(); } };
      window.addEventListener('hashchange', onNav);
      window.addEventListener('popstate', onNav);
      return () => { window.removeEventListener('hashchange', onNav); window.removeEventListener('popstate', onNav); };
    }, [shown, load]);

    // Modals, tabs and client-side routing change the page without a scroll
    // or resize. Watch the DOM (not our own overlay) and re-place the pins.
    useEffect(() => {
      if (!shown) return undefined;
      let frame = 0;
      const observer = new MutationObserver((records) => {
        if (records.every((r) => host.contains(r.target))) return;
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; setViewportTick((tick) => tick + 1); });
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-selected'] });
      return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
    }, [shown]);

    useEffect(() => {
      if (!shown) return undefined;
      const refresh = () => setViewportTick((tick) => tick + 1);
      window.addEventListener('scroll', refresh, { passive: true });
      window.addEventListener('resize', refresh);
      return () => {
        window.removeEventListener('scroll', refresh);
        window.removeEventListener('resize', refresh);
      };
    }, [shown]);

    const comments = surface?.comments || [];
    const allComments = surface?.allComments || comments;
    const openComment = allComments.find((comment) => comment.id === openId);
    const mentionable = surface?.mentionable || [];
    const mutate = async (message, keepOpen = true) => {
      const result = await call(message);
      if (!apply(result)) return false;
      if (!keepOpen) setOpenId(null);
      return true;
    };
    // Recomputed on every render, not memoised: a comment on a modal has no
    // element until the modal opens, and the mutation observer below renders
    // us again when it does.
    const pins = comments.filter((c) => !c.deleted).map((comment) => ({ comment, element: elementFor(comment) }));
    const openCount = allComments.filter(isOpen).length;
    const ready = summarizeHandoffSurfaces(allComments.filter((c) => !c.deleted)).ready;

    if (!shown) {
      return (
        <button className="tdoc-comment-pill tdoc-feedback-mode tdoc-feedback-idle" type="button" title="tdoc feedback" onClick={() => show({ intent: 'bookmark' })}>
          <MessageSquarePlus aria-hidden="true" />
          {openCount ? <span className="tdoc-fb-badge">{openCount}</span> : null}
        </button>
      );
    }

    const hoverRect = (picking || reanchorId) ? hovered?.getBoundingClientRect() : null;
    const rightInset = panelOpen ? PANEL_WIDTH : 0;
    const placeCard = (element) => {
      const rect = element?.getBoundingClientRect();
      const width = innerWidth - rightInset;
      if (!rect) return { top: 60, left: Math.max(8, width - 300) };
      const left = rect.right + 294 < width ? rect.right + 10 : Math.max(8, Math.min(rect.left - 290, width - 300));
      return { top: Math.max(12, rect.top), left };
    };
    const openFromList = (c, local) => {
      if (!local) {
        // Another route of this same app: switch to it and open the card
        // once the comments for that page are loaded.
        location.href = c.anchor.url;
        setTimeout(() => setOpenId(c.id), 600);
        return;
      }
      const el = elementFor(c);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (stateLabel(c.anchor)) say(`Left ${stateLabel(c.anchor)} — open it to see the comment in place.`);
      setPicking(false);
      setSelected(null);
      setOpenId(c.id);
    };

    return (
      <>
        {(picking || reanchorId) && !selected ? (
          <div className="tdoc-fb-banner" role="status">
            {reanchorId ? 'Click the element this comment should point at' : 'Click anything on the page to comment on it'}
            <button type="button" onClick={() => { setPicking(false); setReanchorId(null); setHovered(null); }}>Cancel · Esc</button>
          </div>
        ) : null}
        {hoverRect ? <div className="tdoc-hover-outline" style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }} /> : null}
        {pins.map(({ comment, element }) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > innerHeight) return null;
          const avatar = avatarFor(comment.author || comment);
          return (
            <button
              key={comment.id}
              type="button"
              className={`tdoc-pin${comment.status === 'applied' ? ' tdoc-pin-resolved' : ''}${openId === comment.id ? ' is-active' : ''}`}
              style={{ left: Math.min(innerWidth - rightInset - 32, Math.max(4, rect.right - 14)), top: Math.min(innerHeight - 32, Math.max(4, rect.top - 14)) }}
              onClick={() => { setSelected(null); setPicking(false); setOpenId(comment.id); }}
              title={comment.text || 'tdoc comment'}
            >
              {avatar ? <img src={avatar} alt="" /> : <span className="tdoc-pin-anon" />}
            </button>
          );
        })}

        {selected ? (
          <CommentComposer
            selection={{ kind: 'element', label: labelOf(contextFor(selected)), rect: selected.getBoundingClientRect() }}
            mentionable={mentionable}
            canSendToAgent={canSendToAgent}
            connectAgentPrompt={agent && agent.reason === 'no_agent_bound' ? CONNECT_AGENT_PROMPT : null}
            agentSetupHref={agent && agent.reason === 'no_agent_bound' ? `${base}/me/agents?tab=send` : null}
            onClose={() => setSelected(null)}
            onSubmit={async (text, opts = {}) => {
              const anchor = contextFor(selected);
              const result = await call({ type: 'tdoc-feedback-submit', text, anchor, sendToAgent: Boolean(opts.sendToAgent) });
              if (apply(result)) { setSelected(null); setPicking(false); }
            }}
          />
        ) : null}

        {openComment ? (
          <CommentCard
            comment={openComment}
            currentUser={surface.currentUser || 'anon'}
            isOwner={owner}
            mentionable={mentionable}
            canSendToAgent={canSendToAgent}
            agentSetupHref={agent && agent.reason === 'no_agent_bound' ? `${base}/me/agents?tab=send` : null}
            unanchored={!elementFor(openComment) && !stateLabel(openComment.anchor)}
            floating
            position={placeCard(elementFor(openComment))}
            onReply={(parentId, text, opts = {}) => mutate({ type: 'tdoc-feedback-reply', text, parentId, sendToAgent: Boolean(opts.sendToAgent), handoffCommentId: opts.handoffCommentId, pageUrl: canonical() })}
            onReact={(id, emoji) => mutate({ type: 'tdoc-feedback-react', id, emoji, pageUrl: canonical() })}
            onDelete={(id) => mutate({ type: 'tdoc-feedback-delete', id, pageUrl: canonical() }, false)}
            onResolve={(id, resolved) => mutate({ type: 'tdoc-feedback-resolve', id, resolved, pageUrl: canonical() })}
            onEdit={(id, text) => mutate({ type: 'tdoc-feedback-edit', id, text, pageUrl: canonical() })}
            onReanchor={(id) => { setOpenId(null); setReanchorId(id); }}
          />
        ) : null}

        {panelOpen ? (
          <ListPanel
            all={allComments}
            pageUrl={canonical()}
            filter={filter}
            setFilter={setFilter}
            agent={agent}
            onPick={() => { setOpenId(null); setPicking(true); }}
            onOpen={openFromList}
            onClose={() => setPanelOpen(false)}
          />
        ) : null}

        {notice ? (
          <section className="tdoc-popup tdoc-feedback-notice" style={{ top: 64, right: 18 + rightInset, left: 'auto' }}>
            <div className="head"><span className="h">{notice.status === 401 ? 'Connect to comment' : 'tdoc Feedback'}</span><button className="x" type="button" onClick={() => setNotice(null)}>×</button></div>
            <p>{notice.error}</p>
            <div className="foot"><span /><button className="submit" type="button" onClick={async () => {
              setNotice(null);
              const result = await call({ type: 'tdoc-feedback-signin', pageUrl: canonical() });
              // This button is the continuation of "leave a comment", not a
              // standalone account setting. After a successful first connect,
              // put the person back where they were headed: picking an element.
              if (apply(result)) setPicking(true);
            }}>Connect tdoc</button></div>
          </section>
        ) : null}

        {toast ? <div className={`tdoc-fb-toast${toast.bad ? ' bad' : ''}`} role="status" style={{ right: 18 + rightInset }}>{toast.text}</div> : null}

        <Dock
          session={session || surface?.config}
          openCount={openCount}
          panelOpen={panelOpen}
          picking={picking}
          onList={() => setPanelOpen((v) => !v)}
          onPick={() => { setOpenId(null); setSelected(null); setPicking((v) => !v); }}
          onHide={hide}
          sendCount={ready.length}
          onSend={owner && session && session.notify ? () => { setPicking(false); setNotifyIds(ready.map((c) => c.id)); } : null}
        />
        {notifyIds ? (
          <NotifyHandoffPanel
            slug={session.slug}
            open
            commentIds={notifyIds}
            onClose={() => setNotifyIds(null)}
            onSent={() => load()}
          />
        ) : null}
      </>
    );
  }

  createRoot(host).render(<FeedbackApp />);
}
