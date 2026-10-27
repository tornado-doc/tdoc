import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquarePlus, MessagesSquare, Plus, Link2, ExternalLink, X, Send, RefreshCw } from 'lucide-react';
import { CommentCard } from '../../shell/src/document/comment-card.jsx';
import { CommentThreadList } from '../../shell/src/document/comment-thread-list.jsx';
import { CommentPinFace, commentPinState } from '../../shell/src/document/comment-pin.jsx';
import { useCommentArea } from '../../shell/src/document/comment-area.js';
import { productPageUrl } from '../../shell/src/document/product-url.js';
import { AgentButtonsContext, AgentMentionContext } from '../../shell/src/document/mention-field.jsx';
import { CommentComposer, COMPOSER_WIDTH } from '../../shell/src/document/comment-composer.jsx';
import { composerAgents } from '../../shell/src/document/ai-answerer.js';
import { TOP_BAR_HEIGHT } from '../../shell/src/document/model.js';
import { CONNECT_AGENT_PROMPT, NotifyHandoffPanel, deliveryErrorText, resendResultText, useNotifyTargets } from '../../shell/src/document/notify-handoff.jsx';
import {
  createComment, listComments, listMentionableUsers, postNotifyHandoff,
  removeComment, resendNotifyHandoff, setApiTransport, setCommentResolved,
  toggleReaction, updateCommentAnchor, updateCommentText,
} from '../../shell/src/document/api.js';
import { PortalContainerContext } from '../../shell/src/ui/portal.js';
import chromeCss from '../../server/chrome.css?inline';
// ui.css resets <button> chrome on Reply / Edit / Resolve — without it those
// controls keep the browser's default button look on foreign pages.
import uiCss from '../../shell/src/ui/ui.css?inline';

if (window.top === window && !window.__TDOC_FEEDBACK__) {
  window.__TDOC_FEEDBACK__ = true;

  const style = document.createElement('style');
  style.id = 'tdoc-feedback-styles';
  style.textContent = `${chromeCss.replace(/:root\s*\{/, ':host { all: initial; display: block; font: 13px/1.45 system-ui, -apple-system, sans-serif; color: #1a1a1a; direction: ltr; text-transform: none; text-align: left;')}
${uiCss}
    /* The feedback layer is injected into arbitrary products. Put its single
       stacking context at the browser maximum and append it last, so even a
       host nav using an extreme z-index cannot cover comments or the drawer. */
    #tdoc-feedback-root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; isolation: isolate;
      margin: 0; padding: 0; border: 0; background: none; color: inherit; width: auto; height: auto; max-width: none; max-height: none; overflow: visible; }
    #tdoc-feedback-root * { box-sizing: border-box; }
    #tdoc-feedback-root .tdoc-fb-portals { pointer-events: auto; }
    #tdoc-feedback-root .tdoc-hover-outline { position: fixed; }
    #tdoc-feedback-root .tdoc-pin { position: fixed; z-index: 2147483642; }
    #tdoc-feedback-root .tdoc-popup,
    #tdoc-feedback-root .tdoc-margin-comment { pointer-events: auto; }
    /* Inside the root the order is: composer > open comment > comments panel
       > pins and dock. The panel covers pins on narrow screens. */
    #tdoc-feedback-root .tdoc-popup { z-index: 2147483646; max-width: calc(100vw - 16px); }
    #tdoc-feedback-root .tdoc-margin-comment.tdoc-floating-open {
      position: fixed; max-height: calc(100vh - 24px); overflow-y: auto;
      overscroll-behavior: contain; z-index: 2147483645;
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
    #tdoc-feedback-root .tdoc-feedback-dock a.tdoc-fb-share { padding: 7px 11px; color: #1a1a1a; }
    #tdoc-feedback-root .tdoc-feedback-dock button.primary { background: #1652f0; color: #fff; }
    #tdoc-feedback-root .tdoc-feedback-dock button.primary:hover,
    #tdoc-feedback-root .tdoc-feedback-dock button.primary.on { background: #1245d0; color: #fff; }
    #tdoc-feedback-root .tdoc-fb-badge {
      position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px;
      border-radius: 999px; background: #1652f0; color: #fff; font: 700 10px/17px system-ui, sans-serif; text-align: center;
    }
    #tdoc-feedback-root .tdoc-fb-inline-unread-dot {
      width: 7px; height: 7px; margin-left: 2px; border-radius: 50%; background: var(--td-accent);
    }
    #tdoc-feedback-root .tdoc-fb-banner {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483643; pointer-events: none;
      display: flex; align-items: center; gap: 12px; padding: 9px 10px 9px 16px; border-radius: 999px;
      background: #1a1a1a; color: #fff; font: 600 13px/1.2 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.22);
    }
    #tdoc-feedback-root .tdoc-fb-banner button {
      appearance: none; border: 0; cursor: pointer; pointer-events: auto; border-radius: 999px; padding: 5px 10px;
      background: rgba(255,255,255,.14); color: #fff; font: inherit;
    }
    #tdoc-feedback-root .tdoc-fb-toast {
      position: fixed; bottom: 70px; z-index: 2147483646; pointer-events: auto;
      padding: 9px 14px; border-radius: 10px; background: #1a1a1a; color: #fff;
      font: 500 13px/1.35 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.18);
    }
    #tdoc-feedback-root .tdoc-fb-toast.bad { background: #b42318; }
    #tdoc-feedback-root .tdoc-pin.is-active { outline: 2px solid #1652f0; outline-offset: 2px; }
    #tdoc-feedback-root .tdoc-fb-panel {
      position: fixed; top: 0; right: 0 !important; bottom: 0; width: min(340px, 100vw); max-width: 100vw; z-index: 2147483644; pointer-events: auto;
      display: flex; flex-direction: column; background: #fff; color: #1a1a1a;
      border-left: 1px solid #e8e7e3; box-shadow: -8px 0 28px rgba(0,0,0,.08);
      font: 13px/1.45 system-ui, -apple-system, sans-serif;
      animation: tdoc-fb-panel-in .16s ease-out;
    }
    @media (max-width: 700px) {
      #tdoc-feedback-root .tdoc-feedback-dock.panel-open { display: none; }
      #tdoc-feedback-root .tdoc-fb-panel { width: 100vw; }
    }
    @keyframes tdoc-fb-panel-in { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0); } }
    @media (prefers-reduced-motion: reduce) { #tdoc-feedback-root .tdoc-fb-panel { animation: none; } }
    /* The header wraps instead of running past the panel: title, refresh and
       close stay on the first row (close always visible), filters below. */
    #tdoc-feedback-root .tdoc-fb-panel header {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 10px 12px 14px; border-bottom: 1px solid #efeeea;
    }
    #tdoc-feedback-root .tdoc-fb-panel header strong { flex: 1 1 auto; min-width: 0; }
    #tdoc-feedback-root .tdoc-fb-panel header .tdoc-fb-filter { order: 3; flex: 1 1 100%; margin-left: 0; justify-content: space-between; }
    #tdoc-feedback-root .tdoc-fb-panel header .tdoc-fb-filter button { flex: 1 1 0; }
    #tdoc-feedback-root .tdoc-fb-panel header strong { font-size: 15px; }
    #tdoc-feedback-root .tdoc-fb-filter { display: inline-flex; gap: 2px; margin-left: auto; background: #f3f3f1; border-radius: 8px; padding: 2px; }
    #tdoc-feedback-root .tdoc-fb-filter button { appearance: none; border: 0; background: transparent; border-radius: 6px; padding: 4px 6px; font: 600 11.5px system-ui, sans-serif; color: #6b6a66; cursor: pointer; }
    #tdoc-feedback-root .tdoc-fb-filter button.on { background: #fff; color: #1a1a1a; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    #tdoc-feedback-root .tdoc-fb-panel .x { appearance: none; border: 0; background: none; font-size: 20px; line-height: 1; color: #8a8985; cursor: pointer; padding: 0 2px; }
    #tdoc-feedback-root .tdoc-fb-refresh { appearance: none; border: 0; background: none; color: #6b6a66; cursor: pointer; border-radius: 6px; padding: 5px; display: inline-flex; }
    #tdoc-feedback-root .tdoc-fb-refresh:hover { background: #f0f0ee; color: #1a1a1a; }
    #tdoc-feedback-root .tdoc-fb-refresh svg { width: 15px; height: 15px; }
    #tdoc-feedback-root .tdoc-fb-refresh[aria-busy="true"] svg { animation: tdoc-fb-spin .7s linear infinite; }
    #tdoc-feedback-root .tdoc-fb-add { appearance: none; border: 0; border-radius: 6px; background: #1652f0; color: #fff; cursor: pointer; padding: 5px 8px; font: 600 11.5px system-ui, sans-serif; }
    @keyframes tdoc-fb-spin { to { transform: rotate(360deg); } }
    #tdoc-feedback-root .tdoc-fb-readbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 14px; border-bottom: 1px solid #efeeea; color: #6b6a66; font: 12px system-ui, sans-serif; }
    #tdoc-feedback-root .tdoc-fb-readbar button { appearance: none; border: 0; background: none; color: var(--td-accent); cursor: pointer; font: 600 12px system-ui, sans-serif; }
    #tdoc-feedback-root .tdoc-fb-scroll { flex: 1; overflow-y: auto; padding: 6px 8px 16px; overscroll-behavior: contain; }
    #tdoc-feedback-root .tdoc-fb-scroll h4 { margin: 14px 8px 6px; font: 700 11px/1.2 system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: #8a8985; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tdoc-feedback-root .tdoc-fb-item {
      margin: 0 0 10px; padding: 0 6px;
    }
    #tdoc-feedback-root .tdoc-fb-item .tdoc-margin-comment {
      position: relative; inset: auto; width: 100%; max-width: 100%; box-shadow: none;
      cursor: default;
    }
    #tdoc-feedback-root .tdoc-fb-item .tdoc-margin-comment:hover { box-shadow: 0 4px 16px var(--td-accent-ring-soft); }
    #tdoc-feedback-root .tdoc-fb-context {
      appearance: none; display: block; width: 100%; margin: 0 0 5px; padding: 0 2px;
      border: 0; background: none; color: #6b6a66; cursor: pointer;
      font: 500 11px/1.35 system-ui, sans-serif; text-align: left;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #tdoc-feedback-root .tdoc-fb-context:hover { color: var(--td-accent); }
    #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-send { position: relative; padding: 7px; }
    #tdoc-feedback-root .tdoc-fb-send-badge { position: absolute; top: 0; right: -2px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 999px; background: #1652f0; color: #fff; font: 700 9.5px/15px system-ui, sans-serif; text-align: center; }
    #tdoc-feedback-root .tdoc-fb-panel .empty { margin: 4px 8px; color: #8a8985; }
    #tdoc-feedback-root .tdoc-fb-panel .link { appearance: none; border: 0; background: none; padding: 0; color: #1652f0; font: inherit; cursor: pointer; }
    #tdoc-feedback-root .tdoc-fb-agent { border-top: 1px solid #efeeea; padding: 12px 14px 14px; background: #fafaf8; }
    #tdoc-feedback-root .tdoc-fb-agent p { margin: 0 0 8px; }
    #tdoc-feedback-root .tdoc-fb-agent code { display: block; margin: 0 0 8px; padding: 8px; border-radius: 6px; background: #fff; border: 1px solid #e8e7e3; font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: normal; }
    #tdoc-feedback-root .tdoc-fb-agent button { appearance: none; border: 0; border-radius: 8px; padding: 6px 12px; background: #1652f0; color: #fff; font: 600 12px system-ui, sans-serif; cursor: pointer; }
    #tdoc-feedback-root .ui-dialog-backdrop, #tdoc-feedback-root .ui-dialog-viewport { z-index: 2147483647 !important; }
    /* Keep the dialog controls consistent with the rest of feedback UI. */
    #tdoc-feedback-root .ui-dialog-popup.tdoc-modal { color: #1a1a1a; font: 14px/1.45 system-ui, -apple-system, sans-serif; text-align: left; }
    #tdoc-feedback-root .ui-dialog-popup.tdoc-modal button { font: 600 13px/1.2 system-ui, -apple-system, sans-serif; text-transform: none; letter-spacing: normal; box-shadow: none; }
    #tdoc-feedback-root .ui-dialog-popup.tdoc-modal .actions button:not(.primary):not(.danger) { background: #fff !important; color: #1a1a1a !important; border: 1px solid #d9d8d4 !important; }
    #tdoc-feedback-root .ui-dialog-popup.tdoc-modal .actions button.primary { background: #1652f0 !important; color: #fff !important; border: 1px solid #1652f0 !important; }
    #tdoc-feedback-root .ui-dialog-popup.tdoc-modal textarea { color: #1a1a1a; background: #fff; }
    #tdoc-feedback-root :is(.ui-menu-positioner, .tdoc-picker-positioner, .tdoc-mention-menu) {
      z-index: 2147483647 !important;
    }
  `;
  const host = document.createElement('div');
  host.id = 'tdoc-feedback-root';
  // The layer lives in an open shadow tree: host applications often style
  // every descendant of a dialog, sometimes with !important. Moving our
  // light-DOM root into their dialog would otherwise restyle the composer.
  const shadow = host.attachShadow({ mode: 'open' });
  const feedbackRoot = document.createElement('div');
  feedbackRoot.id = 'tdoc-feedback-root';
  shadow.append(style, feedbackRoot);
  host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;overflow:visible!important;visibility:visible!important;font:13px/1.45 system-ui,-apple-system,sans-serif!important;color:#1a1a1a!important;text-transform:none!important;direction:ltr!important;text-align:left!important;letter-spacing:normal!important;word-spacing:normal!important;white-space:normal!important;line-height:1.45!important';
  document.documentElement.appendChild(host);

  // Keep the feedback layer inside the active modal, including script-driven
  // dialogs. Outside-press and focus traps often run in document capture;
  // stopping an event on our host in bubble is too late for those libraries.
  // The popover puts the layer above a native dialog and avoids clipping by a
  // transformed modal. Move it back when the modal closes or unmounts.
  (function followModals() {
    const modalSelector = 'dialog[open], [aria-modal="true"], [role="dialog"][data-state="open"]';
    const isHostNode = (node) => node === host || host.contains(node);
    const hasModal = (node) => node instanceof Element && !isHostNode(node)
      && (node.matches(modalSelector) || !!node.querySelector(modalSelector));
    const isVisibleModal = (node) => {
      if (node.localName === 'dialog') {
        try { if (!node.matches(':modal')) return false; } catch (_) { return false; }
      }
      // Radix Dialog marks its content role=dialog/data-state=open, but does
      // not set aria-modal. Without an Overlay it skips the scroll lock, yet
      // its modal DismissableLayer still disables body pointer events. A
      // nonmodal banner must not be mistaken for it; Radix Popover also has
      // the same role/state and is identified by its popper wrapper.
      if (node.matches('[role="dialog"][data-state="open"]') && node.getAttribute('aria-modal') !== 'true'
        && (node.closest('[data-radix-popper-content-wrapper]')
          || (!document.body.hasAttribute('data-scroll-locked') && document.body.style.pointerEvents !== 'none'))) return false;
      if (!node.getClientRects().length || getComputedStyle(node).pointerEvents === 'none') return false;
      // Headless UI starts an entering DialogPanel at opacity 0. The panel is
      // still the library's outside-press boundary during its fade-in, so keep
      // our layer inside it as soon as the entry animation begins.
      const enteringPanel = node.matches('[data-headlessui-dialog-panel], [id^="headlessui-dialog-panel-"], [data-headlessui-state]')
        && node.hasAttribute('data-enter') && !node.hasAttribute('data-leave')
        && typeof node.getAnimations === 'function'
        && node.getAnimations().some((animation) => animation.playState === 'running');
      for (let el = node; el instanceof Element; el = el.parentElement) {
        if (el.hidden || el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') return false;
        const css = getComputedStyle(el);
        if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse'
          || (Number(css.opacity) === 0 && !(el === node && enteringPanel))) return false;
      }
      return true;
    };
    const modalPriority = (node) => {
      try { if (node.matches(':modal')) return 1_000_000_000; } catch (_) {}
      let z = 0;
      for (let el = node; el instanceof Element; el = el.parentElement) {
        const parsed = Number.parseInt(getComputedStyle(el).zIndex, 10);
        if (Number.isFinite(parsed)) z = Math.max(z, parsed);
      }
      return z + (node.contains(document.activeElement) ? 100_000_000 : 0);
    };
    const modalContent = (dialog) => {
      // Headless UI's DialogPanel can have a caller-supplied id. Its state
      // attribute, or the focused child when present, identifies the panel.
      const panels = [...dialog.querySelectorAll('[data-headlessui-dialog-panel], [id^="headlessui-dialog-panel-"], [data-headlessui-state]')]
        .filter((node) => isVisibleModal(node) && !node.matches('h1,h2,h3,h4,h5,h6,[id^="headlessui-dialog-title-"]'));
      if (panels.length) {
        return panels.find((node) => node.contains(document.activeElement)) || panels[0];
      }
      return dialog;
    };
    const activeModal = () => {
      const dialog = [...document.querySelectorAll(modalSelector)]
        .filter((node) => !isHostNode(node) && isVisibleModal(node))
        .sort((a, b) => modalPriority(a) - modalPriority(b)).at(-1);
      // Headless UI puts role=dialog on a wrapper, but outside-press tests
      // against DialogPanel. The layer must be inside that panel too.
      return dialog ? modalContent(dialog) : null;
    };
    const withinActiveModal = (node) => {
      const modal = activeModal();
      return !!modal && (modal === node || modal.contains(node));
    };
    const lift = () => {
      if (!host.showPopover || host.matches(':popover-open')) return;
      host.popover = 'manual';
      try { host.showPopover(); } catch (_) {}
    };
    const lower = () => {
      if (!host.hasAttribute('popover')) return;
      try { host.hidePopover(); } catch (_) {}
      host.removeAttribute('popover');
    };
    const place = () => {
      const modal = activeModal();
      if (modal) {
        if (host.parentNode !== modal) { lower(); modal.appendChild(host); }
        // A script modal may use transform/filter/overflow on its panel, which
        // would otherwise shrink or clip our fixed-position viewport layer.
        lift();
      } else if (host.parentNode !== document.documentElement) {
        lower();
        document.documentElement.appendChild(host);
      }
    };
    new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList'
        ? [...r.addedNodes, ...r.removedNodes].some(hasModal)
        : r.target !== host && !isHostNode(r.target)
          && r.target instanceof Element && (r.target.contains(host) || hasModal(r.target) || withinActiveModal(r.target)))) place();
      if (host.hasAttribute('inert')) host.removeAttribute('inert');
      if (host.getAttribute('aria-hidden') === 'true') host.removeAttribute('aria-hidden');
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'inert', 'aria-hidden', 'aria-modal', 'class', 'style', 'data-state', 'data-closed', 'data-enter', 'data-leave'] });
    document.addEventListener('close', (e) => { if (e.target && e.target.localName === 'dialog') place(); }, true);
    const onModalTransition = (e) => { if (e.target instanceof Element && (hasModal(e.target) || withinActiveModal(e.target))) place(); };
    ['transitionrun', 'transitionend', 'animationstart', 'animationend'].forEach((type) => {
      document.addEventListener(type, onModalTransition, true);
    });
    // A dialog removed without closing (a React unmount) takes the layer with it.
    new MutationObserver(() => { if (!host.isConnected) place(); }).observe(document.documentElement, { childList: true, subtree: true });
    // Script-driven modals (Base UI, Radix, Headless UI) close on a press
    // outside them and pull focus back inside. Presses and focus on the layer
    // stay on the layer, so commenting on a modal neither closes it nor loses
    // the typing.
    ['pointerdown', 'mousedown', 'touchstart', 'focusin', 'focusout', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'submit'].forEach((type) => {
      host.addEventListener(type, (e) => e.stopPropagation());
    });
    // Focus leaving the modal for the layer is announced on the modal's own
    // field, before the layer sees it; focus traps (Radix, Headless UI) take
    // that as an escape and pull focus back. Stop it on the way down.
    window.addEventListener('focusout', (e) => {
      if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) e.stopImmediatePropagation();
    }, true);
    place();
  })();

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
  // A site's own comment space (the SDK): <script … data-tdoc-space="…">.
  // Its visitors comment there, so their session is kept apart from any
  // personal feedback space the same browser has for this origin.
  const space = (() => {
    const raw = (document.currentScript && document.currentScript.getAttribute('data-tdoc-space'))
      || window.__TDOC_SPACE__ || '';
    return /^[a-z0-9][a-z0-9-]{0,80}$/.test(String(raw)) ? String(raw) : '';
  })();
  const storageKey = space ? `tdoc-feedback:${base}:${space}` : `tdoc-feedback:${base}`;

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

  // tdoc.on(...) listeners, for pages that build their own controls.
  const listeners = {};
  const emit = (event, detail) => {
    for (const fn of (listeners[event] || []).slice()) { try { fn(detail); } catch (_) {} }
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
    const attempt = new Promise((resolve, reject) => {
      const url = `${base}/feedback/connect?origin=${encodeURIComponent(location.origin)}${space ? `&space=${encodeURIComponent(space)}` : ''}`;
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

  async function loadSurface(session) {
    const comments = await listComments(session.slug, session.version);
    let mentionable = [];
    let mentions = null;
    let signedIn = true;
    try {
      mentions = await listMentionableUsers(session.slug);
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
      mentionable, signedIn,
      currentUser: (mentions && mentions.identity && mentions.identity.login) || (session.identity && session.identity.login) || 'anon',
      handoffViewer: [mentions?.identity?.login || session.identity?.login, ...(mentions?.identity?.linked_actor_keys || session.identity?.linked_actor_keys || [])],
      isOwner: Boolean(mentions && mentions.is_owner),
    };
  }

  // @agent: the same handoff the doc page makes. Owner-only on the server;
  // the result says whether it reached the agent, so the UI can say so.
  async function sendToAgent(slug, commentIds, recipient = null) {
    try {
      const body = await postNotifyHandoff({ slug, comment_ids: [].concat(commentIds), instruction: 'address this comment', recipient });
      const failed = body && body.delivery && body.delivery.status === 'failed';
      return { ok: !failed, message: failed ? `Posted — not delivered to the agent${body.delivery.error ? `: ${deliveryErrorText(body.delivery.error)}` : ''}` : 'Sent to your agent' };
    } catch (error) {
      return { ok: false, message: `Posted — could not send to the agent (${error.message})` };
    }
  }

  // Every action: do the thing, then hand back the page's fresh surface. A
  // failure comes back as { ok: false, status, error } so the UI can say why.
  async function call(message) {
    try {
      const session = await ensureSession();
      const { slug, version } = session;
      const body = (fields) => ({ slug, version, ...fields });
      let handoff = null;
      switch (message.type) {
        case 'tdoc-feedback-load':
          break;
        case 'tdoc-feedback-submit': {
          const made = await createComment(body({ text: message.text, anchor: message.anchor }));
          emit('comment', { id: made && made.id, text: message.text });
          if (message.sendToAgent && made && made.id) handoff = await sendToAgent(slug, made.id, message.recipient);
          break;
        }
        case 'tdoc-feedback-reply': {
          const made = await createComment(body({ text: message.text, parent_id: message.parentId }));
          emit('comment', { id: made && made.id, text: message.text, parentId: message.parentId });
          const target = message.handoffCommentId || (made && made.id);
          if (message.sendToAgent && target) handoff = await sendToAgent(slug, target, message.recipient);
          break;
        }
        case 'tdoc-feedback-resolve':
          await setCommentResolved(body({ id: message.id, resolved: Boolean(message.resolved) }));
          break;
        case 'tdoc-feedback-edit':
          await updateCommentText(body({ id: message.id, text: message.text }));
          break;
        case 'tdoc-feedback-reanchor':
          await updateCommentAnchor(body({ id: message.id, anchor: message.anchor }));
          break;
        case 'tdoc-feedback-delete': {
          await removeComment(slug, version, message.id);
          break;
        }
        case 'tdoc-feedback-react':
          await toggleReaction(body({ comment_id: message.id, emoji: message.emoji }));
          break;
        case 'tdoc-feedback-signin':
          writeSession(null);
          await connect();
          break;
        default:
          return { ok: false, error: 'Unknown feedback action' };
      }
      const surface = await loadSurface(session);
      return handoff ? { ...surface, handoff } : surface;
    } catch (error) {
      return { ok: false, status: error.status || 0, blocked: Boolean(error.blocked), error: String(error && error.message || error) };
    }
  }

  const PANEL_WIDTH = 340;
  const POLL_MS = 15_000;
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

  function Dock({ session, openCount, unreadCount = 0, panelOpen, picking, onList, onPick, onHide, sendCount, onSend }) {
    // Share is the space doc's own Share dialog, as on any doc: who can
    // comment here is whoever it lets in.
    const shareUrl = session && session.share_url;
    return (
      <div className={`tdoc-feedback-dock${panelOpen ? ' panel-open' : ''}`} role="toolbar" aria-label="tdoc feedback" style={panelOpen && innerWidth > 700 ? { right: PANEL_WIDTH + 18 } : null}>
        <button type="button" className={panelOpen ? 'on' : ''} onClick={onList} title={unreadCount ? `${unreadCount} new agent ${unreadCount === 1 ? 'reply' : 'replies'}` : 'All comments on this app'}>
          <MessagesSquare aria-hidden="true" /> <strong>{openCount}</strong> open
          {unreadCount ? <span className="tdoc-fb-inline-unread-dot" aria-label="New agent reply" /> : null}
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
        {shareUrl ? (
          <a className="tdoc-fb-share" href={shareUrl} target="_blank" rel="noopener noreferrer" title="Choose who can see and comment, like any tdoc doc">
            <Link2 aria-hidden="true" /> Share
          </a>
        ) : null}
        {session && session.doc_url ? (
          <a href={session.doc_url} target="_blank" rel="noopener noreferrer" title="Open this thread on tdoc"><ExternalLink aria-hidden="true" /></a>
        ) : null}
        <button type="button" className="icon" onClick={onHide} title="Hide tdoc (click the bookmark to bring it back)" aria-label="Hide tdoc"><X aria-hidden="true" /></button>
      </div>
    );
  }

  function ListPanel({ area, unreadComments, pageUrl, filter, setFilter, cardProps, onPick, onOpen, onClose, onRefresh, refreshing }) {
    const here = area.shownPageComments;
    const unreadIds = new Set(unreadComments.map((comment) => comment.id));
    const elsewhere = new Map();
    for (const c of area.shown) {
      if (c.anchor.url === pageUrl) continue;
      if (!elsewhere.has(c.anchor.url)) elsewhere.set(c.anchor.url, []);
      elsewhere.get(c.anchor.url).push(c);
    }
    const threadList = (list) => <CommentThreadList
      comments={list}
      cardProps={cardProps}
      selectedId={area.selected?.id}
      expandReplies
      itemClassName="tdoc-fb-item"
      isAnchored={(c) => c.anchor.url !== pageUrl || Boolean(elementFor(c)) || Boolean(stateLabel(c.anchor))}
      isUnread={(c) => unreadIds.has(c.id)}
      onNavigate={(id) => { const c = area.byId.get(id); if (c) onOpen(c, c.anchor.url === pageUrl); }}
      beforeCard={(c) => <button type="button" className="tdoc-fb-context" onClick={() => onOpen(c, c.anchor.url === pageUrl)}>
        {c.anchor.url === pageUrl && !elementFor(c) ? 'Not on screen now · ' : ''}
        {stateLabel(c.anchor) ? `${stateLabel(c.anchor)} · ` : ''}{labelOf(c.anchor)}
      </button>}
    />;
    return (
      <aside className="tdoc-fb-panel" aria-label="Feedback on this app">
        <header>
          <strong>Feedback</strong>
          <span className="tdoc-fb-filter" role="group" aria-label="Show">
            {['open', 'replied', 'resolved', 'all'].map((f) => (
              <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
            ))}
          </span>
          <button type="button" className="tdoc-fb-add" onClick={onPick}>+ Comment</button>
          <button type="button" className="tdoc-fb-refresh" aria-label="Refresh feedback" title="Refresh feedback" aria-busy={refreshing ? 'true' : 'false'} onClick={onRefresh}><RefreshCw aria-hidden="true" /></button>
          <button type="button" className="x" aria-label="Close list" onClick={onClose}><X size={14} aria-hidden="true" /></button>
        </header>
        {unreadComments.length ? <div className="tdoc-fb-readbar"><span>{unreadComments.length} new agent {unreadComments.length === 1 ? 'reply' : 'replies'}</span><button type="button" onClick={() => area.markAllRead(unreadComments)}>Mark all as read</button></div> : null}
        <div className="tdoc-fb-scroll">
          <h4>This page</h4>
          {here.length ? threadList(here) : (
            <p className="empty">Nothing {filter === 'all' ? '' : filter} here yet. <button type="button" className="link" onClick={onPick}>Add a comment</button></p>
          )}
          {[...elsewhere.entries()].map(([url, list]) => (
            <section key={url}>
              <h4 title={url}>{pathOf(url)}</h4>
              {threadList(list)}
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
    const [refreshing, setRefreshing] = useState(false);
    const refreshingRef = useRef(false);
    const [reanchorId, setReanchorId] = useState(null);
    const [notifyIds, setNotifyIds] = useState(null);
    const [notifyAvoid, setNotifyAvoid] = useState(null);
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

    const load = useCallback(async () => apply(await call({ type: 'tdoc-feedback-load' })), [apply]);
    const refresh = useCallback(async () => {
      if (refreshingRef.current) return false;
      refreshingRef.current = true;
      setRefreshing(true);
      try { return await load(); }
      finally { refreshingRef.current = false; setRefreshing(false); }
    }, [load]);

    // Showing the overlay loads the thread. The first time on an app with no
    // comments yet goes straight to picking — that is what someone who just
    // clicked the bookmark came to do; otherwise the list opens so they can
    // see what is already there.
    const hiddenKey = `${storageKey}:hidden`;
    const show = useCallback(async ({ intent } = {}) => {
      try { localStorage.removeItem(hiddenKey); } catch (_) {}
      setShown(true);
      const result = await call({ type: 'tdoc-feedback-load' });
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
          const result = await call({ type: 'tdoc-feedback-load' });
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
    const handoffViewer = useMemo(() => surface?.handoffViewer || [surface?.currentUser || 'anon'], [surface?.handoffViewer, surface?.currentUser]);
    const area = useCommentArea({
      comments: surface?.allComments || [], slug, selectedId: openId,
      filter, filterMode: 'phase', handoffViewer, isOwner: owner,
      pageUrl: canonical(),
    });
    const unreadComments = area.unread.filter((comment) => commentPinState(comment, {
      seenMap: area.seenMap, handoffViewer, isOwner: owner,
    }).unread);
    const agent = useNotifyTargets(slug, Boolean(owner && slug && session?.notify));
    const canSendToAgent = Boolean(agent.ready && agent.available && agent.reason !== 'no_agent_bound'
      && (agent.default || agent.candidates.length || agent.fallback));
    const agentChoices = useMemo(() => composerAgents({ canSendToAgent, notifyTargets: agent }), [canSendToAgent, agent]);
    const agentMentions = useMemo(() => ({
      choices: agentChoices, preselected: agentChoices[0] || null,
      ai: null, privateAskSupported: false,
    }), [agentChoices]);

    useEffect(() => {
      const api = {
        toggle,
        open: () => { if (!shown) show({ intent: 'bookmark' }); },
        close: hide,
        hide,
        comment: () => { setShown(true); setPicking(true); },
        disconnect: () => { writeSession(null); hide(); },
        // tdoc.on('open' | 'close' | 'comment', fn) → returns an unsubscribe.
        on: (event, fn) => {
          if (typeof fn !== 'function') return () => {};
          const list = (listeners[event] = listeners[event] || []);
          list.push(fn);
          return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
        },
        base,
        space: space || null,
      };
      window.tdocFeedback = api;
      // The public name. A page that already defines `tdoc` keeps its own.
      if (!window.tdoc || window.tdoc.__tdocFeedback) window.tdoc = Object.assign(api, { __tdocFeedback: true });
    }, [shown, toggle, show, hide]);
    useEffect(() => { emit(shown ? 'open' : 'close'); }, [shown]);
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
      const isTdocUi = (target) => target.closest?.('#tdoc-feedback-root');
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
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: contextFor(element) });
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
        // Ours alone: a modal underneath must not close on the same press.
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('keydown', keydown, true);
      return () => window.removeEventListener('keydown', keydown, true);
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

    // Hash-route navigation is a new page: reload which comments are here.
    useEffect(() => {
      if (!shown) return undefined;
      let last = canonical();
      const onNav = () => { const now = canonical(); if (now !== last) { last = now; load(); } };
      window.addEventListener('hashchange', onNav);
      window.addEventListener('popstate', onNav);
      return () => { window.removeEventListener('hashchange', onNav); window.removeEventListener('popstate', onNav); };
    }, [shown, load]);

    // Refresh lightly while the overlay is visible. Hidden tabs make no
    // requests, and a composer/thread stays still while somebody is typing.
    // Returning to the tab refreshes immediately; the list also has a manual
    // refresh button for the moments when a person wants certainty now.
    useEffect(() => {
      if (!shown || !surface || !(session && session.token) || selected || openId) return undefined;
      const tick = () => { if (document.visibilityState === 'visible') refresh(); };
      const timer = setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', tick);
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
    }, [shown, surface, session && session.token, selected, openId, refresh]);

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

    const comments = area.pageComments;
    const openComment = area.byId.get(openId);
    const mentionable = surface?.mentionable || [];
    const mutate = async (message, keepOpen = true) => {
      const result = await call(message);
      if (!apply(result)) return false;
      if (!keepOpen) setOpenId(null);
      return true;
    };
    const cardProps = {
      currentUser: surface?.currentUser || 'anon',
      handoffViewer,
      isOwner: owner,
      mentionable,
      productLinkOrigin: location.origin,
      canSendToAgent,
      agentSetupHref: agent && agent.reason === 'no_agent_bound' ? `${base}/me/agents?tab=send` : null,
      onReply: (parentId, text, opts = {}) => mutate({ type: 'tdoc-feedback-reply', text, parentId, sendToAgent: Boolean(opts.sendToAgent), recipient: opts.recipient, handoffCommentId: opts.handoffCommentId }),
      onReact: (id, emoji) => mutate({ type: 'tdoc-feedback-react', id, emoji }),
      onDelete: (id) => mutate({ type: 'tdoc-feedback-delete', id }, false),
      onResolve: (id, resolved) => mutate({ type: 'tdoc-feedback-resolve', id, resolved }),
      onEdit: (id, text) => mutate({ type: 'tdoc-feedback-edit', id, text }),
      onReanchor: (id) => { setOpenId(null); setPanelOpen(false); setReanchorId(id); },
      onMarkRead: area.markRead,
      onResendHandoff: owner && session?.notify ? async (c) => {
        try {
          const body = await resendNotifyHandoff({ slug: session.slug, handoff_id: c.handoff_id });
          say(resendResultText(body), body?.delivery?.status === 'failed');
          await load();
        } catch (err) { say(err.message || 'Could not resend', true); }
      } : null,
      onSendHandoffElsewhere: owner && session?.notify
        ? (c) => { setNotifyAvoid(c.handoff_to || null); setNotifyIds([c.id]); }
        : null,
    };
    // Recomputed on every render, not memoised: a comment on a modal has no
    // element until the modal opens, and the mutation observer below renders
    // us again when it does.
    const pins = comments.filter((c) => !c.deleted).map((comment) => ({ comment, element: elementFor(comment) }));
    const openCount = area.openCount;
    const ready = area.handoffBuckets.ready;
    if (!shown) {
      return (
        <button className="tdoc-comment-pill tdoc-feedback-mode tdoc-feedback-idle" type="button" title="tdoc feedback" onClick={() => show({ intent: 'bookmark' })}>
          <MessageSquarePlus aria-hidden="true" />
          {openCount ? <span className="tdoc-fb-badge">{openCount}</span> : null}
        </button>
      );
    }

    const hoverRect = (picking || reanchorId) ? hovered?.getBoundingClientRect() : null;
    const rightInset = panelOpen ? Math.min(PANEL_WIDTH, innerWidth) : 0;
    const composerRect = selected?.getBoundingClientRect();
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
        const target = productPageUrl(c.anchor?.url, location.origin);
        if (!target) { say('This comment points outside this site or has an invalid page link.', true); return; }
        location.href = target;
        setTimeout(() => setOpenId(c.id), 600);
        return;
      }
      const el = elementFor(c);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (stateLabel(c.anchor)) say(`Left ${stateLabel(c.anchor)} — open it to see the comment in place.`);
      setPicking(false);
      setSelected(null);
      setPanelOpen(false);
      setOpenId(c.id);
    };

    return (
      <AgentMentionContext.Provider value={agentMentions}>
      <AgentButtonsContext.Provider value={!canSendToAgent}>
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
          const pinState = commentPinState(comment, { seenMap: area.seenMap, handoffViewer, isOwner: owner });
          return (
            <button
              key={comment.id}
              type="button"
              data-id={comment.id}
              className={`tdoc-pin${comment.status === 'applied' ? ' tdoc-pin-resolved' : ''}${openId === comment.id ? ' is-active' : ''}${pinState.waiting ? ' is-waiting-handoff' : ''}${pinState.unread ? ' is-unread-handoff' : ''}`}
              style={{ left: Math.min(innerWidth - rightInset - 32, Math.max(4, rect.right - 14)), top: Math.min(innerHeight - 32, Math.max(4, rect.top - 14)) }}
              onClick={() => { setSelected(null); setPicking(false); setOpenId(comment.id); }}
              title={pinState.title}
            >
              <CommentPinFace comment={comment} state={pinState} />
            </button>
          );
        })}

        {selected ? (
          /* The shared composer adds the document shell's 48px bar. Feedback
             already has viewport coordinates, so cancel that offset here. */
          <CommentComposer
            selection={{ kind: 'element', label: labelOf(contextFor(selected)), rect: {
              top: composerRect.top - TOP_BAR_HEIGHT,
              bottom: composerRect.bottom - TOP_BAR_HEIGHT,
              left: Math.min(composerRect.left, Math.max(8, innerWidth - rightInset - COMPOSER_WIDTH - 8)),
            } }}
            mentionable={mentionable}
            canSendToAgent={canSendToAgent}
            connectAgentPrompt={agent && agent.reason === 'no_agent_bound' ? CONNECT_AGENT_PROMPT : null}
            agentSetupHref={agent && agent.reason === 'no_agent_bound' ? `${base}/me/agents?tab=send` : null}
            onClose={() => setSelected(null)}
            onSubmit={async (text, opts = {}) => {
              const anchor = contextFor(selected);
              const result = await call({ type: 'tdoc-feedback-submit', text, anchor, sendToAgent: Boolean(opts.sendToAgent), recipient: opts.recipient });
              if (apply(result)) { setSelected(null); setPicking(false); }
            }}
          />
        ) : null}

        {openComment ? (
          <CommentCard
            {...cardProps}
            comment={openComment}
            unanchored={!elementFor(openComment) && !stateLabel(openComment.anchor)}
            floating
            position={placeCard(elementFor(openComment))}
          />
        ) : null}

        {panelOpen ? (
          <ListPanel
            area={area}
            unreadComments={unreadComments}
            pageUrl={canonical()}
            filter={filter}
            setFilter={setFilter}
            cardProps={cardProps}
            onPick={() => { setOpenId(null); setPanelOpen(false); setPicking(true); }}
            onOpen={openFromList}
            onClose={() => setPanelOpen(false)}
            onRefresh={refresh}
            refreshing={refreshing}
          />
        ) : null}

        {notice ? (
          <section className="tdoc-popup tdoc-feedback-notice" style={{ top: 64, right: 18 + rightInset, left: 'auto' }}>
            <div className="head"><span className="h">{notice.status === 401 ? 'Connect to comment' : 'tdoc Feedback'}</span><button className="x" type="button" aria-label="Close" onClick={() => setNotice(null)}><X size={14} aria-hidden="true" /></button></div>
            <p>{notice.error}</p>
            <div className="foot"><span /><button className="submit ui-btn ui-btn-primary ui-btn-m" type="button" onClick={async () => {
              setNotice(null);
              const result = await call({ type: 'tdoc-feedback-signin' });
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
          unreadCount={unreadComments.length}
          panelOpen={panelOpen}
          picking={picking}
          onList={() => setPanelOpen((v) => !v)}
          onPick={() => { setOpenId(null); setSelected(null); setPanelOpen(false); setPicking((v) => !v); }}
          onHide={hide}
          sendCount={ready.length}
          onSend={owner && session && session.notify ? () => { setPicking(false); setNotifyAvoid(null); setNotifyIds(ready.map((c) => c.id)); } : null}
        />
        {notifyIds ? (
          <NotifyHandoffPanel
            slug={session.slug}
            open
            commentIds={notifyIds}
            avoid={notifyAvoid}
            onClose={() => setNotifyIds(null)}
            onSent={() => load()}
          />
        ) : null}
      </AgentButtonsContext.Provider>
      </AgentMentionContext.Provider>
    );
  }

  // The app and its popups each get a box inside the layer: popups stay on
  // the layer (above the page, never mistaken for the page's own) and follow
  // it into a modal.
  const appBox = document.createElement('div');
  const portals = document.createElement('div');
  portals.className = 'tdoc-fb-portals';
  feedbackRoot.append(appBox, portals);
  createRoot(appBox).render(<PortalContainerContext.Provider value={portals}><FeedbackApp /></PortalContainerContext.Provider>);
}
