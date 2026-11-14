import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquarePlus, MessagesSquare, Plus, Share2, ExternalLink, X, Send, RefreshCw, ChevronDown, Check } from 'lucide-react';
import { FLAGS, isPreviewHostname } from '../../shell/src/feature-flags.js';
import { CommentCard } from '../../shell/src/document/comment-card.jsx';
import { CommentThreadList } from '../../shell/src/document/comment-thread-list.jsx';
import { CommentPinFace, commentPinState } from '../../shell/src/document/comment-pin.jsx';
import { useCommentArea, useCommentListPrefs } from '../../shell/src/comments/core/comment-area.js';
import { groupBy } from '../../shell/src/comments/core/comment-query.js';
import { CommentPanel } from '../../shell/src/comments/panel/comment-panel.jsx';
import { CommentSheet, SheetContent } from '../../shell/src/comments/panel/comment-sheet.jsx';
import { AgentActivityButton, agentActivitySummary } from '../../shell/src/comments/panel/agent-activity.jsx';
import { useDoubleTapOption, useEscapeLadder } from '../../shell/src/comments/panel/keyboard.js';
import { findElement, selectorFor as sharedSelectorFor } from '../../shell/src/comments/selection/anchors/element.js';
import { enclosingFor as sharedEnclosingFor, regionOf, regionRect, toRect as sharedToRect } from '../../shell/src/comments/selection/anchors/region.js';
import { captureTextAnchor, collectTextNodes, findTextRange } from '../../shell/src/comments/selection/anchors/text-range.js';
import { cleanFrameAnchor, cleanRect, frameLabel } from '../../shell/src/comments/selection/anchors/frame-part.js';
import { createPickGesture, rangeBetweenPoints } from '../../shell/src/comments/selection/pick-gesture.js';
import { useCommentFeed } from '../../shell/src/comments/core/use-comment-feed.js';
import { isNarrowViewport } from '../../shell/src/comments/core/narrow.js';
import { AppSelect } from '../../shell/src/ui/select.jsx';
import { withPostedComment } from '../../shell/src/comments/core/posted-comment.js';
import { productPageUrl } from '../../shell/src/document/product-url.js';
import { AgentMentionContext } from '../../shell/src/document/mention-field.jsx';
import { CommentComposer, COMPOSER_WIDTH } from '../../shell/src/document/comment-composer.jsx';
import { composerAgents } from '../../shell/src/document/ai-answerer.js';
import { composerDefault, maySendToAgent, sendToAgentSetup, sendToAgentState } from '../../shell/src/document/agent-choices.js';
import { askOwnAgent, threadAskPick, useMyAgent } from '../../shell/src/document/my-agent.js';
import { TOP_BAR_HEIGHT, setTdocOrigin } from '../../shell/src/document/model.js';
import { CONNECT_AGENT_PROMPT, NotifyHandoffPanel, clearNotifyTargetsCache, deliveryErrorText, resendResultText, useNotifyTargets } from '../../shell/src/document/notify-handoff.jsx';
import {
  createComment, getThreadSeen, listComments, listMentionableUsers, postNotifyHandoff,
  removeComment, resendNotifyHandoff, setApiTransport, setCommentResolved,
  toggleReaction, updateCommentAnchor, updateCommentText,
} from '../../shell/src/document/api.js';
import { PortalContainerContext } from '../../shell/src/ui/portal.js';
import { AppMenu, AppMenuItem } from '../../shell/src/ui/menu.jsx';
import { SideResizeHandle, useSideWidth } from '../../shell/src/ui/side-resize.jsx';
import { FeedbackSharePanel } from '../../shell/src/feedback-share-panel.jsx';
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
      position: fixed; z-index: 2147483645;
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
    #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-share { color: #1a1a1a; }
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
    /* A phone wraps the words, never the Cancel button. */
    #tdoc-feedback-root .tdoc-fb-banner { width: max-content; max-width: calc(100vw - 24px); }
    #tdoc-feedback-root .tdoc-fb-banner button {
      flex: none; white-space: nowrap;
      appearance: none; border: 0; cursor: pointer; pointer-events: auto; border-radius: 999px; padding: 5px 10px;
      background: rgba(255,255,255,.14); color: #fff; font: inherit;
    }
    #tdoc-feedback-root .tdoc-fb-toast {
      position: fixed; bottom: 70px; z-index: 2147483646; pointer-events: auto;
      padding: 9px 14px; border-radius: 10px; background: #1a1a1a; color: #fff;
      font: 500 13px/1.35 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.18);
      max-width: calc(100vw - 36px); box-sizing: border-box;
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
    #tdoc-feedback-root .tdoc-fb-panel .tdoc-cpanel { flex: 1 1 auto; }
    @media (max-width: 700px) {
      #tdoc-feedback-root .tdoc-feedback-dock.panel-open { display: none; }
      #tdoc-feedback-root .tdoc-fb-panel { width: 100vw; }
    }
    @keyframes tdoc-fb-panel-in { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0); } }
    @media (prefers-reduced-motion: reduce) { #tdoc-feedback-root .tdoc-fb-panel { animation: none; } }
    @keyframes tdoc-fb-spin { to { transform: rotate(360deg); } }
    #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-send { position: relative; padding: 7px; }
    #tdoc-feedback-root .tdoc-fb-send .tdoc-send-agent-badge { position: absolute; top: 3px; right: 3px; }
    /* Named like the feedback page's "Send to agent (2)" where there is room;
       a phone keeps the icon and its corner count. */
    #tdoc-feedback-root .tdoc-fb-send-label, #tdoc-feedback-root .tdoc-fb-share-label { display: none; }
    @media (min-width: 701px) {
      #tdoc-feedback-root .tdoc-fb-send-label, #tdoc-feedback-root .tdoc-fb-share-label { display: inline; }
      #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-share { padding: 7px 11px; }
      #tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-send { padding: 7px 11px; color: #1a1a1a; }
      #tdoc-feedback-root .tdoc-fb-send .tdoc-send-agent-badge { position: static; align-self: flex-start; margin: 0 0 0 -3px; }
    }
    /* A click on an icon lands on its button (the X used to be the svg). */
    #tdoc-feedback-root .tdoc-feedback-dock svg, #tdoc-feedback-root .tdoc-cpanel button svg { pointer-events: none; }
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
    /* Picking: a transparent sheet over the whole page takes every press, so
       the app gets no click, drag or outside-press while someone points at
       it (iframes and disabled controls included). Pins, dock and banner sit
       above it. */
    #tdoc-feedback-root .tdoc-fb-shield {
      position: fixed; inset: 0; z-index: 2147483640; pointer-events: auto; background: transparent;
      cursor: crosshair; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    #tdoc-feedback-root .tdoc-fb-shield[hidden] { display: none; }
    #tdoc-feedback-root .tdoc-drag-marquee { position: fixed; z-index: 2147483641; border-radius: 4px; }
    #tdoc-feedback-root .tdoc-fb-area-tag {
      position: absolute; left: -1.5px; bottom: 100%; margin-bottom: 4px; padding: 3px 7px; border-radius: 6px;
      background: var(--td-accent); color: var(--td-ground); font: 600 11.5px/1.2 system-ui, -apple-system, sans-serif; white-space: nowrap;
    }
    #tdoc-feedback-root .tdoc-fb-area-tag.below { bottom: auto; top: 100%; margin: 4px 0 0; }
    /* The box keeps a ground-colored hairline so it shows on accent-colored
       content (a blue chart) as well as on white. */
    #tdoc-feedback-root .tdoc-drag-marquee { box-shadow: 0 0 0 1px var(--td-ground); }
    /* The space switcher: the list's title, a menu of My space and the
       spaces this person was invited to on this site. */
    #tdoc-feedback-root .tdoc-fb-space { appearance: none; border: 0; background: none; padding: 2px 4px; margin: -2px -4px; border-radius: 6px;
      display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; cursor: pointer; color: var(--td-ink); font: 700 15px/1.3 system-ui, -apple-system, sans-serif; }
    #tdoc-feedback-root .tdoc-fb-space:hover { background: var(--td-surface); }
    #tdoc-feedback-root .tdoc-fb-space span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tdoc-feedback-root .tdoc-fb-space svg { width: 14px; height: 14px; flex: none; color: var(--td-muted); }
    #tdoc-feedback-root .tdoc-fb-space-item { display: flex; align-items: center; gap: 8px; min-width: 200px; }
    #tdoc-feedback-root .tdoc-fb-space-item span { flex: 1; }
    #tdoc-feedback-root .tdoc-fb-space-item svg { width: 14px; height: 14px; color: var(--td-accent); }
    #tdoc-feedback-root .tdoc-feedback-notice .tdoc-fb-invite-err { color: #ffb4ab; }
    /* A small phone: the dock's buttons sit closer so the row stays on screen. */
    @media (max-width: 400px) {
      #tdoc-feedback-root .tdoc-feedback-dock { right: 8px; gap: 2px; }
      #tdoc-feedback-root .tdoc-feedback-dock button.primary { padding: 7px 9px; }
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
  const shield = document.createElement('div');
  shield.className = 'tdoc-fb-shield';
  shield.hidden = true;
  feedbackRoot.append(shield);
  const isOurs = (node) => node === host || host.contains(node);
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

  // The layer's presses and focus never reach the app. Following the modal
  // (above) only helps with modals that say they are one; a hand-written
  // overlay, a dropdown menu or a focus trap without aria-modal still runs
  // its capture-phase "press outside" check on document, sees our host as the
  // target, and closes (or swallows the click) before our bubble listeners
  // run. So in window capture, which runs before any document listener, the
  // app's copy of the event stops and a copy that cannot leave the shadow
  // tree (composed: false) is sent to the same target for our own React
  // handlers. Not copied: a link's click (the browser's own, trusted one
  // opens it) and a press on our own dialog's backdrop, which Base UI closes
  // from document. The capture sheet handles its own events below.
  (function isolateLayerEvents() {
    const KEYS = ['bubbles', 'cancelable', 'view', 'detail', 'screenX', 'screenY', 'clientX', 'clientY',
      'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'pointerId', 'width',
      'height', 'pressure', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'pointerType', 'isPrimary'];
    let lastFocus = null;
    shadow.addEventListener('focusin', (e) => { lastFocus = e.composedPath()[0] || null; }, true);
    const copy = (e) => {
      const init = { composed: false };
      for (const key of KEYS) if (key in e) init[key] = e[key];
      if (e.type === 'focusin' && init.relatedTarget === host) init.relatedTarget = lastFocus && lastFocus.isConnected ? lastFocus : null;
      if ('touches' in e) {
        init.touches = [...e.touches]; init.targetTouches = [...e.targetTouches]; init.changedTouches = [...e.changedTouches];
      }
      return new e.constructor(e.type, init);
    };
    const relay = (e) => {
      const path = e.composedPath();
      const inner = path[0];
      if (!(inner instanceof Node) || inner === host || inner === shield || !path.includes(host)) return;
      if (inner instanceof Element && inner.matches('.ui-dialog-backdrop, .ui-dialog-viewport')) return;
      if (e.type === 'click' && path.some((n) => n instanceof Element && n.localName === 'a' && n.hasAttribute('href'))) return;
      // Our own code clicking one of our inputs (a Base UI checkbox forwards
      // its press to its hidden <input>): cancelling that click and sending a
      // copy toggled the box, and the original's cancelled activation then
      // undid it when its dispatch ended, so Ask only never ticked. Such a
      // click is stopped here like any other (the app's capture listeners
      // never see it) and cancelled, and its copy goes out once the original
      // has finished: one toggle, which React hears.
      if (e.type === 'click' && !e.isTrusted && inner instanceof Element && inner.localName === 'input') {
        let later;
        try { later = copy(e); } catch (_) { return; }
        e.stopImmediatePropagation();
        e.preventDefault();
        queueMicrotask(() => { if (inner.isConnected) inner.dispatchEvent(later); });
        return;
      }
      let event;
      try { event = copy(e); } catch (_) { return; }
      e.stopImmediatePropagation();
      // The copy carries the click's activation (a checkbox, a submit), so
      // the original must not do it a second time.
      if (e.type === 'click') e.preventDefault();
      inner.dispatchEvent(event);
      if (event.defaultPrevented && e.cancelable && e.type !== 'click') e.preventDefault();
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin']) window.addEventListener(type, relay, true);
    for (const type of ['touchstart', 'touchend']) window.addEventListener(type, relay, { capture: true, passive: true });
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
  // Faces, the tdoc mark and profile links come from that same tdoc origin
  // (production, a PR preview or a local server), never from GitHub, Clerk
  // or a logo CDN: the app's CSP then needs to allow only tdoc.
  setTdocOrigin(base);
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

  // The click that follows a pick (see onPointerUp in FeedbackApp).
  let swallowClickUntil = 0;
  // A touch pick's late mouse events and click (see the picking effect).
  let touchPickUntil = 0;
  window.addEventListener('click', (event) => {
    if (Date.now() > swallowClickUntil || isOurs(event.composedPath()[0])) return;
    swallowClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // Feature flags (shell/src/feature-flags.js), read for the tdoc origin
  // that served this script, not the page. Dev mode is the signed-in
  // viewer's: there is no shell boot on another site, so the session answer
  // (/api/feedback/session, connect) names the dev flags on for the person
  // behind this token (worker feedbackDevFlags). Nobody connected: none.
  const flagOn = (name, session) => {
    const pinned = window.__TDOC_FLAGS__ && window.__TDOC_FLAGS__[name];
    if (typeof pinned === 'boolean') return pinned;
    const flag = FLAGS[name];
    if (!flag) return false;
    if (flag.default === true) return true;
    if (session && session.token && Array.isArray(session.dev_flags) && session.dev_flags.includes(name)) return true;
    try { return flag.preview === true && isPreviewHostname(new URL(base).hostname); } catch (_) { return false; }
  };
  // Share and invites inside the widget (feature-flags.js feedbackInvites).
  const invitesOn = flagOn('feedbackInvites');

  // An invite link opens the site with ?tdoc_invite=<id>. The id is taken
  // off the address at once (it is a one-time key; a reload or a copied URL
  // must not carry it on) and kept for this tab until it is answered: Join,
  // or Keep my own. Answers are remembered per invite.
  const INVITE_ID_RE = /^[a-f0-9]{32}\.[A-Za-z0-9_-]{22}$/;
  const inviteKey = `${storageKey}:invite`;
  if (invitesOn) {
    try {
      const url = new URL(location.href);
      const id = url.searchParams.get('tdoc_invite');
      if (id !== null) {
        url.searchParams.delete('tdoc_invite');
        history.replaceState(history.state, '', url.href);
        if (INVITE_ID_RE.test(id)) sessionStorage.setItem(inviteKey, id);
      }
    } catch (_) {}
  }
  const readInvite = () => { try { const id = sessionStorage.getItem(inviteKey); return id && INVITE_ID_RE.test(id) ? id : null; } catch (_) { return null; } };
  const dropInvite = () => { try { sessionStorage.removeItem(inviteKey); } catch (_) {} };
  const choiceKey = (which) => `${storageKey}:invite-choice:${which}`;
  const rememberChoice = (which, choice) => { try { localStorage.setItem(choiceKey(which), choice); } catch (_) {} };
  const rememberedChoice = (which) => { try { return localStorage.getItem(choiceKey(which)); } catch (_) { return null; } };

  // The connect popup mints a token that stands in for our missing cookie
  // (see getSession in the worker). It lives with the app's origin: one per
  // app, not one per page.
  const readSession = () => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) { return null; }
  };
  const writeSession = (session) => {
    // Signed out or another session: no agent list cached for the last one.
    if (!session || session.token !== (readSession() || {}).token) clearNotifyTargetsCache();
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
  //
  // Signing in visits pages that send Cross-Origin-Opener-Policy: same-origin
  // (the sign-in page and the check in front of it). From then on the popup
  // has no window.opener, its message never arrives, and popup.closed reads
  // true here while the person is still signing in. So the popup's first page
  // tells us a claim id (posted only to this origin), and once the window
  // reads closed we collect the connection from tdoc under that claim
  // instead of giving up. See "Connecting when the popup loses its opener"
  // in the worker.
  const CLAIM_RE = /^[a-f0-9]{64}$/;
  const CLAIM_WAIT_MS = 180_000;
  const CLAIM_POLL_MS = 1500;
  // The overlay's "Finish signing in in the tdoc window…" line; set by the app.
  let connectWaiting = () => {};
  let connecting = null;
  function connect({ invite = null } = {}) {
    if (connecting) return connecting;
    const attempt = new Promise((resolve, reject) => {
      // With an invite, the window asks Join and connecting takes it.
      const url = `${base}/feedback/connect?origin=${encodeURIComponent(location.origin)}${space ? `&space=${encodeURIComponent(space)}` : ''}${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`;
      let popup = null;
      let watch = null;
      let poll = null;
      let deadline = 0;
      let settled = false;
      const claims = new Set();
      const done = (fn) => (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearInterval(watch);
        clearTimeout(poll);
        connectWaiting(null);
        fn(value);
      };
      const finish = done((session) => { writeSession(session); resolve(session); });
      const fail = done(reject);
      const failWith = (message, extra = {}) => { const error = new Error(message); error.status = 0; Object.assign(error, extra); fail(error); };
      const onMessage = (event) => {
        if (event.origin !== base || !event.data || event.data.origin !== location.origin) return;
        if (event.data.type === 'tdoc-feedback-claim') {
          if (CLAIM_RE.test(String(event.data.claim || ''))) claims.add(event.data.claim);
          return;
        }
        if (event.data.type !== 'tdoc-feedback-connected') return;
        const session = event.data.session;
        if (!session || !session.token) return;
        finish(session);
      };
      const collect = async () => {
        for (const claim of [...claims]) {
          if (settled) return;
          try {
            const response = await fetch(`${base}/api/feedback/connect/claim`, {
              method: 'POST', credentials: 'omit',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ claim }),
            });
            const body = await response.json().catch(() => null);
            if (response.ok && body && body.status === 'connected' && body.session && body.session.token) { finish(body.session); return; }
            if (response.status === 400 || response.status === 404) claims.delete(claim);
          } catch (_) {}
        }
        if (settled) return;
        if (!claims.size) { failWith('The tdoc window was closed before connecting.'); return; }
        if (Date.now() > deadline) { failWith('Signing in took too long.', { timedOut: true }); return; }
        poll = setTimeout(collect, CLAIM_POLL_MS);
      };
      const openPopup = () => window.open(url, 'tdoc-feedback-connect', 'popup,width=520,height=640');
      const controls = {
        // A new window makes a new claim; the old ones are still collected.
        reopen: () => {
          const next = openPopup();
          if (next) { popup = next; deadline = Date.now() + CLAIM_WAIT_MS; }
          return Boolean(next);
        },
        cancel: () => failWith('Not connected.', { cancelled: true }),
      };
      const watchPopup = () => {
        watch = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(watch);
          // Closed before its first page could name a claim: really closed.
          if (!claims.size) { failWith('The tdoc window was closed before connecting.'); return; }
          // Maybe closed, maybe only cut off by signing in: keep collecting.
          deadline = Date.now() + CLAIM_WAIT_MS;
          connectWaiting(controls);
          collect();
        }, 500);
      };
      // Listen before opening. A signed-in popup can answer immediately, and
      // registering afterwards leaves the app waiting for a message it missed.
      window.addEventListener('message', onMessage);
      popup = openPopup();
      if (!popup) {
        settled = true;
        window.removeEventListener('message', onMessage);
        const error = new Error('Your browser blocked the tdoc window. Allow pop-ups for this site and try again.');
        error.status = 0;
        error.blocked = true;
        reject(error);
        return;
      }
      watchPopup();
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

  // A comment written before the connection exists is kept until it posts:
  // connecting can be blocked, cancelled or fail, and the person retries
  // (the tab can even reload). It is posted by the first call that has a
  // session, then dropped.
  const draftKey = `${storageKey}:draft`;
  const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch (_) { return null; } };
  const writeDraft = (draft) => {
    try { if (draft) sessionStorage.setItem(draftKey, JSON.stringify(draft)); else sessionStorage.removeItem(draftKey); } catch (_) {}
  };

  // A stored token that the worker no longer honours is dropped, not retried.
  // `interactive: false` (the quiet warm-up on page load) never opens the
  // connect window: a window no click opened is blocked by the browser. A
  // space that moved says so instead, and Reconnect (a click) connects.
  async function ensureSession({ interactive = true } = {}) {
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
        if (!interactive) {
          const quiet = new Error(error.message);
          quiet.status = error.status;
          quiet.reconnect = error.status === 409;
          throw quiet;
        }
      }
    }
    if (!interactive) return null;
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

  // Describing and finding elements, boxes and quotes: the shared selection
  // modules (shell/src/comments/selection/), the same ones the doc frame runs.
  const selectorFor = (element) => sharedSelectorFor(element);

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

  // A comment on the page as a whole (S6): its address and state, no element.
  function pageContext() {
    return {
      kind: 'product', page: true, url: canonical(), state: stateFor(document.body),
      label: 'This page', text: '', tag: '',
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
    };
  }

  // Finding a comment's element again (selection/anchors/element.js): the
  // selector's element still showing its text, else that text wherever it
  // moved, else the selector's element if it is still the same kind.
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  // Cached per page state: `domEpoch` moves when the app's DOM changes (the
  // mutation observer below), so a miss is not searched for again on every
  // render, and a found element is kept while it is on the page.
  let domEpoch = 0;
  const found = new Map();
  function elementFor(comment) {
    const anchor = comment && comment.anchor;
    if (!anchor || anchor.page) return null;
    // Inside the doc frame: the frame stands for it here; where in it, the
    // frame says (framePlaces). Without the flag (or off tdoc's doc page)
    // it has no element here: the card says it is not anchored.
    if (anchor.frame) return docFrame() || null;
    const cached = found.get(comment.id);
    if (cached && cached.el && cached.el.isConnected) return cached.el;
    if (cached && !cached.el && cached.epoch === domEpoch) return null;
    const el = findElement(anchor, { exclude: (node) => isOurs(node) });
    found.set(comment.id, { el, epoch: domEpoch });
    return el;
  }
  const QUOTE_RULE = '::highlight(tdoc-fb-quote){background-color:rgba(255,200,0,.32);}';
  let quoteSheet = null;
  function adoptQuoteStyle() {
    try {
      if (!quoteSheet && typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
        quoteSheet = new CSSStyleSheet();
        quoteSheet.replaceSync(QUOTE_RULE);
      }
      if (quoteSheet) {
        if (!document.adoptedStyleSheets.includes(quoteSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, quoteSheet];
        return;
      }
    } catch (_) { quoteSheet = null; }
    if (document.getElementById('tdoc-fb-quote-style')) return;
    const style = document.createElement('style');
    style.id = 'tdoc-fb-quote-style';
    style.textContent = QUOTE_RULE;
    document.head.appendChild(style);
  }
  // The text view of an element (the matcher's normalized text), per page state.
  const views = new WeakMap();
  function textViewOf(element) {
    const cached = views.get(element);
    if (cached && cached.epoch === domEpoch) return cached.view;
    const view = collectTextNodes(element, (node) => isOurs(node));
    views.set(element, { view, epoch: domEpoch });
    return view;
  }

  // A quote (selection/anchors/text-range.js): the words, found again inside
  // the element they were in, through the doc's own matcher.
  function quoteRangeFor(comment, element) {
    const quote = comment && comment.anchor && comment.anchor.quote;
    if (!quote || !element) return null;
    try { return findTextRange(quote, textViewOf(element)); } catch (_) { return null; }
  }

  // ---- Areas ---------------------------------------------------------------
  // What is on the page at a point, under the capture sheet: the sheet and the
  // rest of the layer are skipped. Iframes, canvases and disabled controls
  // come back as themselves (they never get a click of their own).
  function underPoint(x, y) {
    let list = [];
    try { list = document.elementsFromPoint(x, y); } catch (_) { list = []; }
    return list.find((el) => !isOurs(el) && el !== document.documentElement) || null;
  }

  // A press that starts on text: the caret position at the point lies in a
  // text node whose glyphs cover the point. Blank space, images, canvases and
  // charts are not text.
  function startsOnText(x, y) {
    const before = shield.style.pointerEvents;
    shield.style.pointerEvents = 'none';
    try {
      let node = null;
      if (document.caretPositionFromPoint) node = document.caretPositionFromPoint(x, y)?.offsetNode || null;
      else if (document.caretRangeFromPoint) node = document.caretRangeFromPoint(x, y)?.startContainer || null;
      if (!node || node.nodeType !== 3 || !node.textContent.trim() || isOurs(node.parentNode)) return false;
      // Text a person cannot select is not text here: a chart's SVG labels,
      // anything under user-select: none (buttons, canvases' overlays).
      const parent = node.parentElement;
      if (!parent || parent.closest('svg')) return false;
      const css = getComputedStyle(parent);
      if ((css.userSelect || css.webkitUserSelect) === 'none') return false;
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
    } catch (_) {
      return false;
    } finally {
      shield.style.pointerEvents = before;
    }
  }

  const canScroll = (el, dx, dy) => {
    if (!(el instanceof Element)) return false;
    const css = getComputedStyle(el);
    const y = /(auto|scroll|overlay)/.test(css.overflowY) && el.scrollHeight > el.clientHeight
      && (dy < 0 ? el.scrollTop > 0 : dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : true);
    const x = /(auto|scroll|overlay)/.test(css.overflowX) && el.scrollWidth > el.clientWidth
      && (dx < 0 ? el.scrollLeft > 0 : dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : true);
    return (dy && y) || (dx && x);
  };
  // The scrolling box under a point that is not the page itself (a modal's
  // body, a list). The sheet would otherwise only ever scroll the page.
  function innerScroller(x, y, dx, dy) {
    for (let el = underPoint(x, y); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (canScroll(el, dx, dy)) return el;
    }
    return null;
  }

  const toRect = sharedToRect;
  function enclosingFor(box) { return sharedEnclosingFor(box, underPoint); }
  // A comment on an area (selection/anchors/region.js): the container's own
  // anchor, the box in pixels and as fractions of the container, what is
  // under it; plus where the page was (state, scroll).
  function regionContext(box, container = enclosingFor(box)) {
    const anchor = regionOf(box, container, { exclude: (node) => isOurs(node), describe: (el) => contextFor(el) });
    anchor.rect = { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), width: anchor.region.rel.width, height: anchor.region.rel.height };
    anchor.region.scroll = { x: Math.round(scrollX), y: Math.round(scrollY) };
    return anchor;
  }

  // ---- tdoc's own doc page: inside the doc frame (feedbackDocFramePick) ----
  // On a tdoc doc page the document is a sandboxed frame (opaque origin):
  // from here it is one element, the whole page. With the flag on, a press,
  // a drag or the pointer over it is asked of the frame instead, which
  // answers with what is under it through the same selection code the doc's
  // own picking uses (server/frame-probe.js, tdoc:fb*). Only on tdoc's own
  // pages (this script came from this origin), only the doc frame, and only
  // its answers: event.source must be that frame's window. What it says is
  // the author's document talking (its scripts share that window): data
  // only, every field checked and cut to size here, and where the comment
  // belongs (the page, the space) never comes from it.
  let framePickOn = false;
  const onTdocPage = (() => { try { return new URL(base).origin === location.origin; } catch (_) { return false; } })();
  function docFrame() {
    if (!onTdocPage || !framePickOn) return null;
    const frame = document.querySelector('iframe.tdoc-doc-frame');
    return frame && frame.contentWindow ? frame : null;
  }
  function overFrame(x, y) {
    const frame = docFrame();
    if (!frame) return null;
    const r = frame.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? frame : null;
  }
  // A rect in the frame's viewport, in ours, clipped to the frame: the
  // frame never places anything (a pin, an outline, a composer) outside
  // itself. Nothing left of it: null.
  function fromFrame(rect, frame = docFrame()) {
    if (!rect || !frame) return null;
    const f = frame.getBoundingClientRect();
    const left = Math.max(f.left, f.left + rect.left), top = Math.max(f.top, f.top + rect.top);
    const right = Math.min(f.right, f.left + rect.left + rect.width), bottom = Math.min(f.bottom, f.top + rect.top + rect.height);
    if (right < left || bottom < top) return null;
    return toRect({ left, top, width: right - left, height: bottom - top });
  }
  let frameSeq = 0;
  const frameWaits = new Map();
  // Comments are known to the frame by tokens of this page load, never by
  // their ids (the doc's author must not be able to tell whose they are).
  let framePlaces = new Map();
  const frameListeners = new Set();
  const frameTokens = new Map(); // comment id → token
  const frameTokenIds = new Map(); // token → comment id
  function frameToken(id) {
    if (!frameTokens.has(id)) {
      const bytes = new Uint8Array(9);
      crypto.getRandomValues(bytes);
      const token = `t${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      frameTokens.set(id, token); frameTokenIds.set(token, id);
    }
    return frameTokens.get(id);
  }
  // The frame's position reports: one update per animation frame, none for
  // a report that changes nothing.
  let placesPending = null, placesFrame = 0, placesLast = '';
  function takePlaces(list) {
    placesPending = list;
    if (placesFrame) return;
    placesFrame = requestAnimationFrame(() => {
      placesFrame = 0;
      const key = JSON.stringify(placesPending);
      if (key === placesLast) return;
      placesLast = key;
      const next = new Map();
      for (const place of placesPending) {
        const id = place && typeof place.id === 'string' ? frameTokenIds.get(place.id) : null;
        if (id) next.set(id, cleanRect(place.rect));
      }
      framePlaces = next;
      frameListeners.forEach((fn) => fn('places'));
    });
  }
  // The doc frame (re)loaded: the shell page's own load event for it, not
  // anything the frame says; at most once a second.
  // A load inside that second is not dropped: one resend follows at its end.
  let lastFrameLoad = 0, trailingLoad = 0;
  function frameLoaded() {
    lastFrameLoad = Date.now();
    placesLast = '';
    frameListeners.forEach((fn) => fn('ready'));
  }
  document.addEventListener('load', (event) => {
    const frame = docFrame();
    if (!frame || event.target !== frame) return;
    const wait = lastFrameLoad + 1000 - Date.now();
    if (wait <= 0) { frameLoaded(); return; }
    if (!trailingLoad) trailingLoad = setTimeout(() => { trailingLoad = 0; frameLoaded(); }, wait);
  }, true);
  // Whether the frame has been told of any anchors (so hiding has something
  // to clear).
  let frameAnchorsSent = false;
  function toFrame(message, frame = docFrame()) {
    if (!frame) return false;
    try { frame.contentWindow.postMessage({ ...message, source: 'tdoc-feedback' }, '*'); return true; } catch (_) { return false; }
  }
  function askFrame(type, data, timeout = 1500) {
    const id = `fb${++frameSeq}`;
    return new Promise((resolve) => {
      if (!toFrame({ type, id, ...data })) { resolve(null); return; }
      const timer = setTimeout(() => { frameWaits.delete(id); resolve(null); }, timeout);
      frameWaits.set(id, (reply) => { clearTimeout(timer); frameWaits.delete(id); resolve(reply); });
    });
  }
  window.addEventListener('message', (event) => {
    const frame = docFrame();
    if (!frame || event.source !== frame.contentWindow) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.source !== 'tdoc-frame' || typeof d.type !== 'string') return;
    if ((d.type === 'tdoc:fbHover' || d.type === 'tdoc:fbPicked') && frameWaits.has(d.id)) {
      frameWaits.get(d.id)(d.type === 'tdoc:fbHover'
        ? { rect: cleanRect(d.rect), onText: d.onText === true }
        : { anchor: cleanFrameAnchor(d.anchor), rect: cleanRect(d.rect) });
    } else if (d.type === 'tdoc:fbPlaces') {
      takePlaces((Array.isArray(d.places) ? d.places : []).slice(0, 500));
    }
  });
  // The anchor of a comment on something inside the doc frame: the frame
  // element's own context (the page, its state) plus `frame`, what was
  // picked inside it. The words and label are the inner thing's.
  function frameContext(inner) {
    const frame = docFrame() || document.querySelector('iframe.tdoc-doc-frame');
    const outer = frame ? contextFor(frame) : pageContext();
    return {
      ...outer,
      tag: inner.tag || outer.tag,
      text: inner.quote ? inner.quote.text.slice(0, 500) : inner.text,
      accessible_name: inner.accessible_name || '',
      label: frameLabel(inner),
      frame: inner,
    };
  }

  async function loadSurface(session) {
    // The two reads are independent: one round trip, not two.
    const [comments, mentionsRead] = await Promise.all([
      listComments(session.slug, session.version),
      listMentionableUsers(session.slug).then((value) => ({ value }), (error) => ({ error })),
    ]);
    let mentionable = [];
    let mentions = null;
    let signedIn = true;
    if (mentionsRead.error) {
      const error = mentionsRead.error;
      if (error.status === 401 || error.status === 403) signedIn = false;
      else throw error;
    } else {
      mentions = mentionsRead.value;
      mentionable = Array.isArray(mentions && mentions.users) ? mentions.users : [];
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
      // A member of the team that owns the space: the doc page offers them
      // Send to agent once the team has an agent to send to.
      teamMember: Boolean(mentions && mentions.team_member),
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
    if (message.type === 'tdoc-feedback-submit') {
      writeDraft({ text: message.text, anchor: message.anchor, sendToAgent: Boolean(message.sendToAgent), recipient: message.recipient || null, askAgent: message.askAgent || null });
    }
    // Connect again: drop the token first, then the one connect below.
    if (message.type === 'tdoc-feedback-signin') writeSession(null);
    try {
      const session = await ensureSession();
      const { slug, version } = session;
      const body = (fields) => ({ slug, version, ...fields });
      let postedDraft = false;
      // What this call posted, and the agent hand-off that follows it. The
      // UI is answered as soon as the POST is (see `followUp` below).
      let posted = null;
      let handOff = null;
      const draft = readDraft();
      if (draft && draft.text && draft.anchor) {
        // Taken before posting, so two calls at once cannot post it twice.
        writeDraft(null);
        let made;
        try {
          made = await createComment(body({ text: draft.text, anchor: draft.anchor }));
        } catch (error) {
          // Kept for the next try, unless refused for a reason connecting
          // again will not fix (an open composer still has the words).
          if ((!error.status || error.status === 401) && !readDraft()) writeDraft(draft);
          throw error;
        }
        postedDraft = message.type !== 'tdoc-feedback-submit';
        posted = { made, parentId: null };
        emit('comment', { id: made && made.id, text: draft.text });
        if (draft.sendToAgent && made && made.id) handOff = () => sendToAgent(slug, made.id, draft.recipient);
        // One of the commenter's own agents: it answers in the thread.
        else if (draft.askAgent && made && made.id) handOff = () => askOwnAgent(slug, made.id, draft.askAgent);
      }
      switch (message.type) {
        case 'tdoc-feedback-load':
        case 'tdoc-feedback-signin':
        case 'tdoc-feedback-submit':
          // Posted above, as the draft it was saved as.
          break;
        case 'tdoc-feedback-reply': {
          const made = await createComment(body({ text: message.text, parent_id: message.parentId }));
          posted = { made, parentId: message.parentId };
          emit('comment', { id: made && made.id, text: message.text, parentId: message.parentId });
          const target = message.handoffCommentId || (made && made.id);
          if (message.sendToAgent && target) handOff = () => sendToAgent(slug, target, message.recipient);
          else if (message.askAgent && made && made.id) handOff = () => askOwnAgent(slug, made.id, message.askAgent);
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
        default:
          return { ok: false, error: 'Unknown feedback action' };
      }
      if (posted) {
        // The comment is saved: answer now, so the composer closes and the
        // comment shows from the POST's answer. The hand-off to an agent
        // (three requests to Raft on the server) and the re-read of the
        // comments and the @ list run behind it and arrive as `followUp`.
        // A follow-up that fails leaves the posted comment shown; the feed's
        // own refresh catches up.
        const followUp = (async () => {
          const sent = handOff ? await handOff() : null;
          try {
            const surface = await loadSurface(session);
            return { ...surface, ...(sent ? { handoff: sent } : {}) };
          } catch (error) {
            // Signed out or moved space meanwhile: the same notice (and
            // Connect / Reconnect) a failed action gets. Anything else
            // leaves the posted comment shown; the feed's refresh catches up.
            const refused = [401, 403, 409].includes(error && error.status);
            if (!refused) return sent ? { ok: false, handoffOnly: sent } : null;
            return {
              ok: false, status: error.status, reconnect: error.status === 409,
              error: String(error && error.message || error), ...(sent ? { handoffOnly: sent } : {}),
            };
          }
        })();
        return { ok: true, posted, followUp, handingOff: Boolean(handOff), ...(postedDraft ? { postedDraft: true } : {}) };
      }
      return await loadSurface(session);
    } catch (error) {
      const kept = Boolean(readDraft());
      const why = String(error && error.message || error);
      return {
        ok: false, status: error.status || 0, blocked: Boolean(error.blocked), draftKept: kept,
        error: kept && !error.status ? `${why} Your comment is kept: connect to post it.` : why,
      };
    }
  }

  // The panel's width, dragged by its edge (ui/side-resize.jsx). A phone gets
  // the whole screen and no handle.
  const SITE_SEEN = { load: getThreadSeen, save: null };
  const PANEL_WIDTH = { storageKey: 'tdoc-feedback-panel-width', initial: 340, min: 280, max: 640 };
  const pathOf = (href) => { try { const u = new URL(href); return `${u.pathname}${u.search}` || '/'; } catch (_) { return href; } };
  const labelOf = (anchor) => {
    const a = anchor || {};
    if (a.page) return 'This page';
    if (a.frame) return a.label || 'Document content';
    if (a.quote) return a.label || `“${String(a.quote.text || '').slice(0, 48)}”`;
    if (a.region) return a.label || 'Area';
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

  function Dock({ session, openCount, waitingCount = 0, unreadCount = 0, panelOpen, panelWidth, picking, onList, onPick, onHide, activity, onSend, onShare }) {
    // Share: in the widget, the owner's invites (SharePanel). Who else has
    // access, and moving the space into a team, stay in the space's Share on
    // tdoc: this page's token can add an invite, never change the rest.
    // (feedbackInvites off: Share opens that page, as it used to.)
    const shareUrl = session && session.share_url;
    return (
      <div className={`tdoc-feedback-dock${panelOpen ? ' panel-open' : ''}`} role="toolbar" aria-label="tdoc feedback" style={panelOpen && !isNarrowViewport() ? { right: panelWidth + 18 } : null}>
        <button type="button" className={panelOpen ? 'on' : ''} onClick={onList} title={unreadCount ? `${unreadCount} new agent ${unreadCount === 1 ? 'reply' : 'replies'}` : waitingCount ? `${waitingCount} waiting on you` : 'All comments on this app'}>
          <MessagesSquare aria-hidden="true" /> <strong>{openCount}</strong> open
          {unreadCount ? <span className="tdoc-fb-inline-unread-dot" aria-label="New agent reply" /> : null}
        </button>
        <button type="button" className={`primary${picking ? ' on' : ''}`} onClick={onPick} title="Click anything on the page to comment on it">
          <Plus aria-hidden="true" /> Comment
        </button>
        {onSend ? (
          // The doc page's agent activity button, its badge rules and all
          // (comments/panel/agent-activity.jsx); here it says Send to agent.
          <AgentActivityButton className="tdoc-fb-send" labelClassName="tdoc-fb-send-label" icon={<Send aria-hidden="true" />}
            label="Send to agent" summary={activity} onClick={onSend} />
        ) : null}
        {invitesOn ? (onShare ? (
          // Share opens here, in the widget (Julie, 2026-11-03): the owner
          // invites people without leaving the site. Owner (team admin) only.
          <button type="button" className="tdoc-fb-share" onClick={onShare} title="Invite people to comment here" aria-label="Share">
            <Share2 aria-hidden="true" /><span className="tdoc-fb-share-label">Share</span>
          </button>
        ) : null) : shareUrl ? (
          // On a phone the dock is icons with counts (as Send to agent):
          // the word does not fit beside them at 390px.
          <a className="tdoc-fb-share" href={shareUrl} target="_blank" rel="noopener noreferrer" title="Invite people, or move this space into a team" aria-label="Share">
            <Share2 aria-hidden="true" /><span className="tdoc-fb-share-label">Share</span>
          </a>
        ) : null}
        {session && session.doc_url ? (
          <a href={session.doc_url} target="_blank" rel="noopener noreferrer" title="Open this thread on tdoc"><ExternalLink aria-hidden="true" /></a>
        ) : null}
        <button type="button" className="icon" onClick={onHide} title="Hide tdoc (click the bookmark to bring it back)" aria-label="Hide tdoc"><X aria-hidden="true" /></button>
      </div>
    );
  }

  // Where this list's comments go, and the others to switch to (the
  // bookmarklet: My space and the spaces this person was invited to here).
  function SpaceSwitcher({ spaces, onSwitch }) {
    const nameOf = (sp) => (sp.mine ? 'My space' : sp.owner ? `${sp.owner}’s space` : (sp.title || 'Shared space'));
    const current = spaces.find((sp) => sp.current) || spaces[0];
    return (
      <AppMenu
        align="start"
        trigger={<button type="button" className="tdoc-fb-space" aria-label={`Feedback space: ${nameOf(current)}`}><span>{nameOf(current)}</span><ChevronDown aria-hidden="true" /></button>}
      >
        {spaces.map((sp) => (
          <AppMenuItem key={sp.slug || 'mine'} onClick={() => onSwitch(sp)}>
            <span className="tdoc-fb-space-item"><span>{nameOf(sp)}</span>{sp.current ? <Check aria-label="Current" /> : null}</span>
          </AppMenuItem>
        ))}
      </AppMenu>
    );
  }

  // Where a thread is on this page, for the list's position order: top to
  // bottom, then left to right. Threads not on screen follow, oldest first.
  const positionOnPage = (comment) => {
    const el = elementFor(comment);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.top + scrollY, r.left + scrollX];
  };

  // The list: the shared CommentPanel (comments/panel/), in a side panel on
  // a wide screen and the shared bottom sheet on a phone, where a
  // full-width aside used to cover the app being commented on.
  function ListPanel({ side, area, prefs, pageUrl, cardProps, onPick, onOpen, onClose, onRefresh, refreshing, spaces = [], onSwitch = null }) {
    const { filter } = prefs;
    // This page first, then one section per other page (comment-query.js
    // groupBy), each in the order the query gave.
    const groups = groupBy(area.shown, (c) => c.anchor.url, { first: pageUrl }).map(({ key, items }) => (key === pageUrl
      ? { key, label: 'This page', items, empty: <p className="tdoc-cpanel-empty">Nothing {filter === 'all' ? '' : filter} here yet. <button type="button" className="link" onClick={onPick}>Add a comment</button></p> }
      : { key, label: pathOf(key), title: key, items }));
    const wide = !isNarrowViewport();
    const panel = (
      <CommentPanel
        area={area}
        prefs={prefs}
        groups={groups}
        className="tdoc-fb-list"
        ariaLabel="Feedback on this app"
        titleSlot={spaces.length > 1 && onSwitch ? <strong className="tdoc-cpanel-title"><SpaceSwitcher spaces={spaces} onSwitch={onSwitch} /></strong> : <strong className="tdoc-cpanel-title">Feedback</strong>}
        onAdd={onPick}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onClose={onClose}
        closeLabel="Close list"
        cardProps={cardProps}
        selectedId={area.selected?.id}
        isAnchored={(c) => c.anchor.url !== pageUrl || Boolean(c.anchor.page) || Boolean(elementFor(c)) || Boolean(stateLabel(c.anchor))}
        onNavigate={(id) => { const c = area.byId.get(id); if (c) onOpen(c, c.anchor.url === pageUrl); }}
        contextLine={(c) => <button type="button" className="tdoc-cpanel-context" onClick={() => onOpen(c, c.anchor.url === pageUrl)}>
          {c.anchor.url === pageUrl && !c.anchor.page && !elementFor(c) ? 'Not on screen now · ' : ''}
          {stateLabel(c.anchor) ? `${stateLabel(c.anchor)} · ` : ''}{labelOf(c.anchor)}
        </button>}
      />
    );
    if (!wide) {
      return (
        <CommentSheet open onOpenChange={(next) => { if (!next) onClose(); }} title="Feedback" className="tdoc-fb-sheet">
          <SheetContent className="tdoc-sheet-content">{panel}</SheetContent>
        </CommentSheet>
      );
    }
    return (
      <aside className="tdoc-fb-panel" style={{ width: side.width }}>
        <SideResizeHandle side={side} label="Resize the feedback panel" />
        {panel}
      </aside>
    );
  }

  // "<Name> invited you to comment on <site>": the invite link's question,
  // or the server's (an invite for this person on this site they have not
  // answered). Join, or for the bookmarklet Keep my own (its comments stay
  // in the person's own space). The SDK's space is the site's: only Join.
  function InvitePrompt({ invite, rightInset, onJoin, onKeep, onClose }) {
    return (
      <section className="tdoc-popup tdoc-feedback-notice tdoc-fb-invite-prompt" role="dialog" aria-label="Invitation" style={{ top: 64, right: 18 + rightInset, left: 'auto' }}>
        <div className="head"><span className="h">Invitation</span><button className="x" type="button" aria-label="Close" onClick={onClose}><X size={14} aria-hidden="true" /></button></div>
        <p><strong>{invite.inviter}</strong> invited you to comment on <strong>{invite.host}</strong>.</p>
        {invite.site ? null : <p>Join to leave your comments here in their space. Keep my own to keep them in yours.</p>}
        {invite.error ? <p className="tdoc-fb-invite-err" role="alert">{invite.error}</p> : null}
        <div className="foot">
          {invite.site ? <span /> : <button className="ui-btn ui-btn-secondary ui-btn-m" type="button" disabled={invite.busy} onClick={onKeep}>Keep my own</button>}
          <button className="submit ui-btn ui-btn-primary ui-btn-m" type="button" disabled={invite.busy} onClick={onJoin}>Join</button>
        </div>
      </section>
    );
  }

  function FeedbackApp() {
    const [shown, setShown] = useState(false);
    const [picking, setPicking] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const panelSide = useSideWidth(PANEL_WIDTH);
    const [surface, setSurface] = useState(null);
    const [session, setSession] = useState(() => readSession());
    // Filter (Open by default), order and search: the same query as the doc
    // page, the choice remembered per space (this origin's storage).
    const listPrefs = useCommentListPrefs(session && session.slug);
    // Comment on an area (feedbackAreaSelect): a preview host, or this
    // viewer's own dev mode, from the session answer.
    const areaSelectOn = flagOn('feedbackAreaSelect', session);
    // Picking inside the doc frame on tdoc's own doc page (docFrame above).
    framePickOn = flagOn('feedbackDocFramePick', session);
    const [hovered, setHovered] = useState(null);
    const [selected, setSelected] = useState(null);
    // A box being commented on: fractions of `selected` (its container).
    const [areaSel, setAreaSel] = useState(null);
    // The box while it is being drawn, in viewport pixels.
    const [drag, setDrag] = useState(null);
    // The press in progress (selection/pick-gesture.js), for Esc.
    const gestureRef = useRef(null);
    // A quote being commented on: { quote, rect } (selection/anchors/text-range.js).
    const [quoteSel, setQuoteSel] = useState(null);
    // A comment on the whole page (no element).
    const [pageSel, setPageSel] = useState(false);
    // Something inside the doc frame being commented on: { anchor, rect }
    // (cleanFrameAnchor; rect in our viewport). `selected` is the frame.
    const [frameSel, setFrameSel] = useState(null);
    // The element under the pointer inside the doc frame, in our viewport.
    const [frameHover, setFrameHover] = useState(null);
    // Moves when the frame reports where our comments are now.
    const [, setFrameTick] = useState(0);
    const [openId, setOpenId] = useState(null);
    const [notice, setNotice] = useState(null);
    // Connecting, with the tdoc window cut off from us by signing in.
    const [waiting, setWaiting] = useState(null);
    useEffect(() => { connectWaiting = setWaiting; return () => { connectWaiting = () => {}; }; }, []);
    const [toast, setToast] = useState(null);
    const [reanchorId, setReanchorId] = useState(null);
    const [notifyIds, setNotifyIds] = useState(null);
    const [notifyAvoid, setNotifyAvoid] = useState(null);
    const [shareOpen, setShareOpen] = useState(false);
    // An invite to answer: { id } from the link, or { slug } from the server.
    const [invite, setInvite] = useState(null);
    const [, setViewportTick] = useState(0);
    // Moves only when the app's DOM changes (not on scroll): what the quote
    // highlights are recomputed by.
    const [domTick, setDomTick] = useState(0);

    const say = useCallback((text, bad = false) => {
      setToast({ text, bad });
      setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3200);
    }, []);

    const apply = useCallback((result) => {
      // Posted: the comment shows from the POST's answer now; the re-read
      // (and an agent hand-off's word) lands when `followUp` does.
      if (result?.ok && result.posted) {
        const { made, parentId } = result.posted;
        setSurface((prev) => (prev ? { ...prev, allComments: withPostedComment(prev.allComments, made, parentId) } : prev));
        if (result.postedDraft) { setSelected(null); setAreaSel(null); setPicking(false); if (!result.handingOff) say('Comment posted'); }
        result.followUp.then((next) => {
          if (!next) return;
          if (next.ok) { apply(next); return; }
          if (next.handoffOnly) say(next.handoffOnly.message, !next.handoffOnly.ok);
          if (next.status) setNotice({ status: next.status, reconnect: Boolean(next.reconnect), error: next.error });
        });
        return true;
      }
      if (result?.ok) {
        setSurface(result);
        if (result.config) setSession((prev) => ({ ...(prev || {}), ...result.config, token: (prev && prev.token) || result.config.token }));
        setNotice(result.signedIn === false ? { status: 401, error: 'Connect your tdoc account to comment here.' } : null);
        if (result.handoff) say(result.handoff.message, !result.handoff.ok);
        // The comment held while connecting has posted: its composer is done.
        if (result.postedDraft) { setSelected(null); setAreaSel(null); setPicking(false); if (!result.handoff) say('Comment posted'); }
        return true;
      }
      setNotice(result || { error: 'Could not load tdoc comments' });
      return false;
    }, [say]);

    const load = useCallback(async () => apply(await call({ type: 'tdoc-feedback-load' })), [apply]);

    // Showing the overlay loads the thread. The first time on an app with no
    // comments yet goes straight to picking — that is what someone who just
    // clicked the bookmark came to do; otherwise the list opens so they can
    // see what is already there.
    const hiddenKey = `${storageKey}:hidden`;
    const show = useCallback(async ({ intent } = {}) => {
      try { localStorage.removeItem(hiddenKey); } catch (_) {}
      setShown(true);
      // Opened by an invite link, not connected yet: its Join connects (and
      // takes the invite); Keep my own connects on the first comment.
      if (invitesOn && readInvite() && !readSession()) return;
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
      setSelected(null); setAreaSel(null); setOpenId(null); setHovered(null); setReanchorId(null);
    }, [hiddenKey]);

    const toggle = useCallback(() => { if (shown) hide(); else show({ intent: 'bookmark' }); }, [shown, hide, show]);

    // Warm the counts and the session quietly; connecting needs a click.
    // A space that moved (409) is said with a Reconnect button: a window
    // opened here, with no click, is one the browser blocks.
    useEffect(() => {
      let cancelled = false;
      (async () => {
        if (!readSession()) return;
        let hidden = false;
        try { hidden = localStorage.getItem(`${storageKey}:hidden`) === '1'; } catch (_) {}
        try {
          const next = await ensureSession({ interactive: false });
          if (cancelled || !next) return;
          setSession(next);
          const first = await call({ type: 'tdoc-feedback-load' });
          // A held comment that posted on the way answers early: wait for the read.
          const result = first?.posted ? await first.followUp : first;
          if (!cancelled && result?.ok) { setSurface(result); if (!hidden) setShown(true); }
        } catch (error) {
          if (cancelled || !(error && error.reconnect)) return;
          setSession(null);
          if (!hidden) setShown(true);
          setNotice({ status: 409, reconnect: true, error: 'Your comments on this site go to another feedback space now. Reconnect to keep commenting.' });
        }
      })();
      return () => { cancelled = true; };
    }, []);

    // An invite link (?tdoc_invite): who invited them, to which site.
    useEffect(() => {
      if (!invitesOn) return undefined;
      const id = readInvite();
      if (!id) return undefined;
      if (rememberedChoice(id)) { dropInvite(); return undefined; }
      let cancelled = false;
      (async () => {
        try {
          const info = await request(`/api/feedback/invite?id=${encodeURIComponent(id)}`);
          if (cancelled) return;
          if (info.status !== 'pending' && info.status !== 'accepted') {
            dropInvite();
            setShown(true);
            say(info.status === 'expired' ? 'This invite has expired. Ask for a new one.' : 'This invite is no longer valid.', true);
            return;
          }
          setInvite({ id, inviter: (info.inviter && info.inviter.name) || 'Someone', host: info.host || location.host, site: Boolean(space) });
          setShown(true);
        } catch (error) {
          if (cancelled) return;
          dropInvite();
          setShown(true);
          say('This invite link is not valid.', true);
        }
      })();
      return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Without a link: an invite for this person on this site that they have
    // not answered (the bookmarklet only), asked once.
    const serverPrompt = invitesOn && !space ? session?.invite_prompt : null;
    useEffect(() => {
      if (!serverPrompt || !serverPrompt.slug || invite || readInvite()) return;
      if (rememberedChoice(`slug:${serverPrompt.slug}`)) return;
      setInvite({ slug: serverPrompt.slug, invite: serverPrompt.invite || null, inviter: serverPrompt.inviter || 'Someone', host: serverPrompt.host || location.host, site: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverPrompt && serverPrompt.slug]);

    const adopt = useCallback((next) => {
      const stored = readSession();
      const merged = { ...(stored || {}), ...next, token: next.token || (stored && stored.token) };
      writeSession(merged);
      setSession(merged);
      return merged;
    }, []);
    const joinInvite = useCallback(async () => {
      const current = invite;
      if (!current) return;
      setInvite({ ...current, busy: true, error: '' });
      try {
        // Taking an invite is a click on tdoc: the connect window asks Join
        // and answers with a token for the space joined.
        const id = current.id || current.invite;
        if (!id) throw new Error('This invite is no longer valid.');
        setSession(await connect({ invite: id }));
        if (current.id) { rememberChoice(current.id, 'joined'); dropInvite(); }
        else rememberChoice(`slug:${current.slug}`, 'joined');
        setInvite(null);
        setOpenId(null);
        await load();
        say(current.site ? 'Joined. Your comments here go to this site’s space.' : `Joined ${current.inviter}’s space`);
      } catch (error) {
        setInvite({ ...current, busy: false, error: error.message || 'Could not join' });
      }
    }, [invite, adopt, load, say]);
    const keepOwn = useCallback(async () => {
      const current = invite;
      if (!current) return;
      setInvite(null);
      if (current.id) { rememberChoice(current.id, 'kept'); dropInvite(); }
      else rememberChoice(`slug:${current.slug}`, 'kept');
      if (!(readSession() || {}).token) return;
      try {
        adopt(await request('/api/feedback/invite/keep', { method: 'POST', body: JSON.stringify(current.id ? { id: current.id } : { slug: current.slug }) }));
      } catch (_) {}
    }, [invite, adopt]);
    const switchSpace = useCallback(async (target) => {
      if (target.current) return;
      try {
        // Not joined yet: Join in the connect window, with their invite.
        if (target.invite) setSession(await connect({ invite: target.invite }));
        else adopt(await request('/api/feedback/switch', { method: 'POST', body: JSON.stringify(target.mine ? { own: true } : { slug: target.slug }) }));
        setOpenId(null);
        await load();
        say(target.mine ? 'Now in your own space' : `Now in ${target.owner ? `${target.owner}’s` : 'the shared'} space`);
      } catch (error) { say(error.message || 'Could not switch', true); }
    }, [adopt, load, say]);

    // @agent is the owner's: ask once who it would reach.
    const owner = Boolean(surface?.isOwner);
    const slug = session && session.slug;
    const handoffViewer = useMemo(() => surface?.handoffViewer || [surface?.currentUser || 'anon'], [surface?.handoffViewer, surface?.currentUser]);
    const area = useCommentArea({
      comments: surface?.allComments || [], slug, selectedId: openId,
      filter: listPrefs.filter, sort: listPrefs.sort, search: listPrefs.search, positionOf: positionOnPage,
      handoffViewer, isOwner: owner,
      pageUrl: canonical(),
      // This widget's flags (a preview host, the viewer's dev mode), not the
      // host page's: autoReadComments decides read-when-seen here as on tdoc.
      flagOn: (name) => flagOn(name, session),
      // Read state on the server, so the space's tdoc page agrees.
      syncSeen: Boolean(slug && session?.token && surface?.ok && surface.signedIn !== false),
      // A site's (SDK) token lives in a page tdoc does not control: it reads
      // the person's read state but never writes it (the server refuses).
      seenTransport: space ? SITE_SEEN : undefined,
    });
    const unreadComments = area.unread;
    const teamMember = Boolean(surface?.teamMember);
    // Who may send to an agent: the server's rule, shared with the doc page
    // and the space page (agent-choices.js maySendToAgent).
    const sendMay = maySendToAgent({ owner, teamMember });
    // The token is this person's session here: a new one (reconnect, another
    // account) is another viewer to the agent-list cache.
    const notifyViewer = session?.token || '';
    const agent = useNotifyTargets(slug, Boolean(sendMay && slug && session?.notify), notifyViewer);
    const canSendToAgent = Boolean(agent.ready && agent.available && agent.reason !== 'no_agent_bound'
      && (agent.default || agent.candidates.length || agent.fallback));
    // Send to agent in the dock, as on the doc page. The owner always has it:
    // with no agent connected (or a host that cannot notify) it opens the
    // same panel, which says so and shows how to connect one, instead of the
    // button silently not being there. A team member gets it once the team
    // has an agent to send to; anyone else never does.
    const showSend = Boolean(slug && (owner || (teamMember && session?.notify && canSendToAgent)));
    // Own and team agents, answer only (my-agent.js): only where the server
    // allows this token to reach them, the bookmarklet on tdoc's own pages
    // (own_agent). A token living in another site's page never makes an
    // agent run that way.
    const myAgent = useMyAgent(slug, Boolean(slug && surface?.ok && session?.own_agent));
    const agentChoices = useMemo(() => composerAgents({
      canSendToAgent,
      notifyTargets: agent,
      // The doc page's @ list through the same door: the holder's own agents
      // and, on a team's space, the team's agents (answer only, in the
      // thread). Never tdoc AI: it answers from a stored doc, and an app's
      // page has none on tdoc.
      mine: session?.own_agent && myAgent.state ? { agents: myAgent.state.agents || [], team_agents: myAgent.state.team_agents || [], tdoc_ai: false } : null,
    }), [canSendToAgent, agent, session?.own_agent, myAgent.state]);
    // The same Send to agent judgment as the doc page (agent-choices.js): the
    // widget used to hide the control when nobody was linked or the viewer
    // could not send; now it always shows, connects, or says why.
    const { setupHref: sendToAgentSetupHref, disabledReason: sendToAgentDisabledReason } = sendToAgentSetup({
      canSendToAgent, may: sendMay, notifyOn: Boolean(session?.notify), targets: agent, href: `${base}/me/agents?tab=send`,
    });
    const sendToAgentConnectPrompt = sendToAgentSetupHref ? CONNECT_AGENT_PROMPT : null;
    const sendToAgent = useMemo(() => sendToAgentState({
      canSendToAgent,
      choices: agentChoices,
      disabledReason: sendToAgentDisabledReason,
      connectPrompt: sendToAgentConnectPrompt,
      setupHref: sendToAgentSetupHref,
    }), [canSendToAgent, agentChoices, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref]);
    // The default is an agent that may edit (the owner's, the team's); an
    // own agent is picked from the @ list, as on a doc page.
    const agentMentions = useMemo(() => ({
      choices: agentChoices, preselected: composerDefault(agentChoices, { orTop: true }),
      // Own and team agents are asked through my-agent, which this token
      // reaches only on tdoc's own pages (own_agent).
      ai: null, privateAskSupported: false, teamAskSupported: Boolean(session?.own_agent),
      ownAskSupported: Boolean(session?.own_agent),
      fixesTheApp: true,
      canSendToAgent,
      sendToAgentDisabledReason,
      connectAgentPrompt: sendToAgentConnectPrompt,
      agentSetupHref: sendToAgentSetupHref,
      sendToAgent,
    }), [agentChoices, session?.own_agent, canSendToAgent, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref, sendToAgent]);

    useEffect(() => {
      const api = {
        toggle,
        open: () => { if (!shown) show({ intent: 'bookmark' }); },
        close: hide,
        hide,
        comment: () => { setShown(true); setOpenId(null); setPanelOpen(false); setPicking(true); },
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

    // Picking: the only mode that takes over the page. A transparent sheet
    // covers it, so the app sees no press at all (no button fires, no modal
    // closes on an outside press, no slider or drag-and-drop starts). One
    // gesture, decided where it starts:
    //   - a click (moved < 8px) picks the element under it;
    //   - a drag that starts on selectable text picks the element holding
    //     the text (product anchors have no text ranges yet), no box;
    //   - a drag that starts where text can't be selected (blank, image,
    //     canvas, chart, iframe) draws a box. No key or tool changes this
    //     (no C shortcut: it would take a host site's own C);
    //   - on a touch screen a tap picks, a long press then drag draws a box,
    //     and a plain swipe still scrolls.
    useEffect(() => {
      if (!picking && !reanchorId) { shield.hidden = true; return undefined; }
      if (selected) {
        // The tap that picked still sends its mouse events and click a
        // moment later. With the sheet already gone they would land on what
        // is under it: in a frame (tdoc's doc, someone's embed), where our
        // click guard cannot reach, they start the frame's own thing (the
        // doc's composer under ours). The sheet stays, inert, until then.
        // Touch only: a mouse or pen sends nothing late, and a click into
        // the composer right after a pick must never be taken.
        const linger = touchPickUntil - Date.now();
        if (linger <= 0) { shield.hidden = true; return undefined; }
        shield.hidden = false;
        const stop = (event) => {
          if (event.composedPath()[0] !== shield) return;
          event.stopImmediatePropagation();
          if (event.cancelable) event.preventDefault();
        };
        const kinds = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'];
        kinds.forEach((type) => window.addEventListener(type, stop, { capture: true, passive: false }));
        const done = () => { shield.hidden = true; kinds.forEach((type) => window.removeEventListener(type, stop, { capture: true, passive: false })); };
        const timer = setTimeout(done, linger);
        return () => { clearTimeout(timer); done(); };
      }
      shield.hidden = false;
      const priorCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
      // The doc frame scrolls itself (its document is not ours to scroll).
      const frameScroller = (x, y) => (overFrame(x, y)
        ? { scrollBy: (dx, dy) => { setFrameHover(null); toFrame({ type: 'tdoc:fbScroll', dx, dy }); } }
        : null);
      const fromShield = (event) => event.composedPath()[0] === shield;
      const pickable = (el) => el && el !== document.body && el !== document.documentElement && !isOurs(el);
      // Inside the doc frame: the frame answers what is at the point(s), in
      // its own viewport; nothing it knows of → the frame as before.
      const pickInFrame = async (req) => {
        const docFrameEl = docFrame();
        if (!docFrameEl) return;
        const f = docFrameEl.getBoundingClientRect();
        const ask = { kind: req.kind, x: req.x - f.left, y: req.y - f.top };
        if (req.kind === 'text') { ask.x2 = req.x2 - f.left; ask.y2 = req.y2 - f.top; }
        if (req.kind === 'box') { ask.width = req.width; ask.height = req.height; }
        const reply = await askFrame('tdoc:fbPick', ask);
        if (!reply || !reply.anchor) { pickPlain(docFrameEl); return; }
        if (reanchorId) {
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: frameContext(reply.anchor) });
          if (apply(result)) setReanchorId(null);
          setHovered(null); setFrameHover(null);
          return;
        }
        setOpenId(null);
        setAreaSel(null);
        setQuoteSel(null);
        setFrameSel({ anchor: reply.anchor, rect: fromFrame(reply.rect, docFrameEl) || toRect(f) });
        setSelected(docFrameEl);
        setHovered(null); setFrameHover(null);
      };
      const pickElement = async (element, point) => {
        if (!pickable(element)) return;
        if (point && docFrame() && element === docFrame()) { pickInFrame({ kind: 'element', x: point.x, y: point.y }); return; }
        pickPlain(element);
      };
      const pickPlain = async (element) => {
        if (!pickable(element)) return;
        if (reanchorId) {
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: contextFor(element) });
          if (apply(result)) setReanchorId(null);
          setHovered(null);
          return;
        }
        setOpenId(null);
        setAreaSel(null);
        setQuoteSel(null);
        setFrameSel(null);
        setSelected(element);
        setHovered(null); setFrameHover(null);
      };
      const pickArea = async (box) => {
        const container = enclosingFor(box);
        if (docFrame() && container === docFrame()) { pickInFrame({ kind: 'box', x: box.left, y: box.top, width: box.width, height: box.height }); return; }
        if (reanchorId) {
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: regionContext(box, container) });
          if (apply(result)) setReanchorId(null);
          setHovered(null);
          return;
        }
        const c = container.getBoundingClientRect();
        setOpenId(null);
        setQuoteSel(null);
        setFrameSel(null);
        setAreaSel(c.width && c.height
          ? { x: (box.left - c.left) / c.width, y: (box.top - c.top) / c.height, width: box.width / c.width, height: box.height / c.height, label: regionContext(box, container).label }
          : null);
        setSelected(container);
        setHovered(null);
      };
      // A drag over words: a quote of them (selection/anchors/text-range.js),
      // anchored in the element that holds them all.
      const pickText = async (start, end) => {
        if (overFrame(start.x, start.y)) { pickInFrame({ kind: 'text', x: start.x, y: start.y, x2: end.x, y2: end.y }); return; }
        const before = shield.style.pointerEvents;
        shield.style.pointerEvents = 'none';
        let range = null;
        try { range = rangeBetweenPoints(start, end); } finally { shield.style.pointerEvents = before; }
        let holder = range ? range.commonAncestorContainer : null;
        if (holder && holder.nodeType === 3) holder = holder.parentElement;
        if (!range || !pickable(holder)) { pickElement(underPoint(start.x, start.y)); return; }
        const quote = captureTextAnchor(range, collectTextNodes(holder, (node) => isOurs(node)));
        if (!quote) { pickElement(holder); return; }
        if (reanchorId) {
          const result = await call({ type: 'tdoc-feedback-reanchor', id: reanchorId, anchor: { ...contextFor(holder), quote } });
          if (apply(result)) setReanchorId(null);
          setHovered(null);
          return;
        }
        setOpenId(null);
        setAreaSel(null);
        setFrameSel(null);
        setQuoteSel({ quote, rect: range.getBoundingClientRect() });
        setSelected(holder);
        setHovered(null);
      };
      // One rule (Julie, 2026-11-08), now the shared pick gesture
      // (selection/pick-gesture.js): a click picks the element, a drag that
      // starts on text a person could select quotes it, a drag anywhere else
      // (blank, an image, a canvas, a chart, an iframe) draws a box; on a
      // touch screen a tap picks, a hold then drag draws a box, a swipe scrolls.
      let frame = 0;
      // Where the pointer is and where the press started (the frame is
      // asked about points, not elements); whether the point in the doc
      // frame is on text, from its last hover answer.
      let pointer = null, pressPoint = null, frameOnText = false, frameOnTextAt = null, hoverSeq = 0, pendingDown = null;
      const gesture = createPickGesture({
        areaSelect: areaSelectOn,
        textSelect: true,
        elementAt: underPoint,
        startsOnText: (x, y) => (overFrame(x, y) ? frameOnText : startsOnText(x, y)),
        onHover: (el) => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            const inFrame = el && docFrame() === el ? el : null;
            if (inFrame && pointer) {
              const f = inFrame.getBoundingClientRect();
              const seq = ++hoverSeq;
              const at = { ...pointer };
              askFrame('tdoc:fbHover', { x: at.x - f.left, y: at.y - f.top }, 800).then((reply) => {
                if (seq !== hoverSeq) return;
                frameOnText = Boolean(reply && reply.onText); frameOnTextAt = at;
                setFrameHover(reply && reply.rect ? fromFrame(reply.rect, inFrame) : null);
              });
            } else { hoverSeq += 1; setFrameHover(null); }
            setHovered(pickable(el) ? el : null);
          });
        },
        onDrag: (box) => setDrag(box),
        onHold: () => { try { navigator.vibrate && navigator.vibrate(8); } catch (_) {} },
        onElement: (el) => pickElement(el, pressPoint),
        onText: pickText,
        onBox: pickArea,
      });
      gestureRef.current = gesture;
      const reset = () => { gesture.cancel(); setDrag(null); };
      // A finger's scroll of a modal's body, while the press is undecided.
      let touchScroll = null;
      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        pointer = pressPoint = { x: event.clientX, y: event.clientY };
        touchScroll = { x: event.clientX, y: event.clientY, lastX: null, lastY: null, scroller: undefined };
        if (event.pointerType === 'mouse') event.preventDefault();
        if (event.pointerType === 'mouse') { try { shield.setPointerCapture(event.pointerId); } catch (_) {} }
        // A mouse press in the doc frame: whether it starts on text (a drag
        // quotes) or not (a drag draws a box) is the frame's to say. Unless
        // its last hover answer was for this very point, ask first; the
        // moves and the release wait for the answer, in order.
        const docFrameEl = event.pointerType === 'mouse' ? overFrame(event.clientX, event.clientY) : null;
        if (docFrameEl && !(frameOnTextAt && frameOnTextAt.x === event.clientX && frameOnTextAt.y === event.clientY)) {
          const f = docFrameEl.getBoundingClientRect();
          const at = { x: event.clientX, y: event.clientY };
          pendingDown = askFrame('tdoc:fbHover', { x: at.x - f.left, y: at.y - f.top }, 800).then((reply) => {
            frameOnText = Boolean(reply && reply.onText); frameOnTextAt = at;
            gesture.down(event);
          });
          const mine = pendingDown;
          mine.then(() => { if (pendingDown === mine) pendingDown = null; });
          return;
        }
        gesture.down(event);
      };
      const afterDown = (fn) => { if (pendingDown) pendingDown = pendingDown.then(fn); else fn(); };
      const onPointerMove = (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        afterDown(() => gesture.move(event));
      };
      const onPointerUp = (event) => afterDown(() => {
        if (!gesture.pressing()) return;
        // The sheet goes away under the composer before this press's click
        // is sent: that click must not land on the app.
        swallowClickUntil = Date.now() + 400;
        touchPickUntil = event.pointerType === 'touch' ? swallowClickUntil : 0;
        gesture.up(event);
      });
      // A finger that scrolls a modal's body: the sheet is not inside it,
      // so move that box ourselves. Once a long press made a box, the finger
      // draws instead of scrolling.
      const onTouchMove = (event) => {
        const p = touchScroll;
        if (!p || !gesture.pressing()) return;
        const t = event.touches[0];
        if (!t) return;
        if (gesture.mode() === 'area') { if (event.cancelable) event.preventDefault(); return; }
        const dx = p.lastX == null ? 0 : p.lastX - t.clientX;
        const dy = p.lastY == null ? 0 : p.lastY - t.clientY;
        p.lastX = t.clientX; p.lastY = t.clientY;
        if (p.scroller === undefined && (dx || dy)) p.scroller = innerScroller(p.x, p.y, dx, dy) || frameScroller(p.x, p.y);
        if (p.scroller && event.cancelable) { event.preventDefault(); p.scroller.scrollBy(dx, dy); }
      };
      const onWheel = (event) => {
        const scroller = innerScroller(event.clientX, event.clientY, event.deltaX, event.deltaY) || frameScroller(event.clientX, event.clientY);
        if (!scroller) return;
        event.preventDefault();
        scroller.scrollBy(event.deltaX, event.deltaY);
      };
      const handlers = {
        pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp,
        pointercancel: () => { if (gesture.cancel(true)) setDrag(null); },
        touchmove: onTouchMove, wheel: onWheel,
        // The browser's own reactions to a press on the sheet: a touch's
        // follow-up mouse events and click, a long press's menu.
        touchend: (event) => { if (event.cancelable) event.preventDefault(); },
        contextmenu: (event) => event.preventDefault(),
      };
      const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
        'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'];
      // Window capture runs before every listener of the app.
      const listener = (event) => {
        if (!fromShield(event)) return;
        event.stopImmediatePropagation();
        if (handlers[event.type]) handlers[event.type](event);
      };
      const options = { capture: true, passive: false };
      for (const type of types) window.addEventListener(type, listener, options);
      // A press on the pins, the dock or the banner is not a pick, and a
      // pointer that leaves the window ends a drag.
      const away = () => { if (gesture.pressing() && !gesture.touching()) reset(); };
      window.addEventListener('blur', away);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        reset();
        gestureRef.current = null;
        shield.hidden = true;
        document.documentElement.style.cursor = priorCursor;
        for (const type of types) window.removeEventListener(type, listener, options);
        window.removeEventListener('blur', away);
      };
    }, [picking, reanchorId, selected, apply, areaSelectOn]);

    // A thing picked in the doc frame keeps its highlight until the
    // composer closes.
    const frameSelOpen = Boolean(frameSel);
    useEffect(() => { if (!selected) setFrameSel(null); }, [selected]);
    useEffect(() => (frameSelOpen ? () => { toFrame({ type: 'tdoc:fbClear' }); } : undefined), [frameSelOpen]);

    // Esc steps back one level (comments/panel/keyboard.js): a press in
    // progress → composer → picking → card → list. Window capture: a host
    // modal underneath must not close on the same press.
    useEscapeLadder([
      { active: () => Boolean(gestureRef.current && gestureRef.current.pressing()), close: () => {
        gestureRef.current.cancel();
        setDrag(null); setHovered(null);
      } },
      { active: Boolean(selected), close: () => { setSelected(null); setAreaSel(null); setQuoteSel(null); } },
      { active: Boolean(picking || reanchorId), close: () => { setPicking(false); setReanchorId(null); setHovered(null); } },
      { active: Boolean(openId), close: () => setOpenId(null) },
      { active: panelOpen, close: () => setPanelOpen(false) },
    ], { enabled: shown, capture: true });

    // Double-tap Option: start a comment from anywhere (the doc page takes
    // the same keys: comments/panel/keyboard.js).
    useDoubleTapOption(() => { setShown(true); setOpenId(null); setPanelOpen(false); setPicking((p) => !p); if (!surface) load(); });

    // Hash-route navigation is a new page: reload which comments are here.
    useEffect(() => {
      if (!shown) return undefined;
      let last = canonical();
      const onNav = () => { const now = canonical(); if (now !== last) { last = now; load(); } };
      window.addEventListener('hashchange', onNav);
      window.addEventListener('popstate', onNav);
      return () => { window.removeEventListener('hashchange', onNav); window.removeEventListener('popstate', onNav); };
    }, [shown, load]);

    // Refresh lightly while the overlay is visible: every 15 s, at once on
    // returning to the tab, never while somebody is typing or the composer is
    // open; the list also has a Refresh button. One rule with the doc page.
    // The doc page's feed (use-comment-feed.js) over this widget's call().
    const feed = useCommentFeed({
      load,
      enabled: Boolean(shown && surface && session && session.token),
      paused: Boolean(selected),
    });

    // Comments inside the doc frame: the frame finds them (and marks their
    // quotes) and says where they are, again on every scroll; we draw the
    // pins. Only their anchors go to the frame, never what was said.
    const frameAnchors = useMemo(() => area.pageComments
      .filter((c) => !c.deleted && c.anchor && c.anchor.frame)
      .map((c) => ({ ...c.anchor.frame, id: frameToken(c.id) })), [area.pageComments]);
    useEffect(() => {
      if (!shown || !docFrame()) return undefined;
      const send = () => { if (toFrame({ type: 'tdoc:fbAnchors', anchors: frameAnchors })) frameAnchorsSent = true; };
      send();
      const listen = (what) => { if (what === 'ready') send(); else setFrameTick((t) => t + 1); };
      frameListeners.add(listen);
      return () => { frameListeners.delete(listen); };
    }, [shown, frameAnchors, session]);
    // Shown → hidden, after the frame was told of anchors: it forgets them
    // (no pins, no marks, no reports). Never sent otherwise.
    useEffect(() => {
      if (shown || !frameAnchorsSent) return;
      if (toFrame({ type: 'tdoc:fbAnchors', anchors: [] })) frameAnchorsSent = false;
    }, [shown]);

    // Quotes on this page are marked in the app's own text, through the CSS
    // Highlight API: one constructed stylesheet adopted by the page (an
    // inline <style> where that is not supported), no change to its DOM.
    // Recomputed when the comments, the quote being written or the page's
    // DOM change, not on every render.
    useEffect(() => {
      if (!shown || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return undefined;
      adoptQuoteStyle();
      const ranges = [];
      for (const comment of area.pageComments) {
        if (!comment.anchor || !comment.anchor.quote || comment.deleted) continue;
        const range = quoteRangeFor(comment, elementFor(comment));
        if (range) ranges.push(range);
      }
      if (quoteSel && selected) {
        const live = findTextRange(quoteSel.quote, textViewOf(selected));
        if (live) ranges.push(live);
      }
      CSS.highlights.set('tdoc-fb-quote', new Highlight(...ranges));
      return () => { CSS.highlights.delete('tdoc-fb-quote'); };
    }, [shown, area.pageComments, quoteSel, selected, domTick]);

    // Modals, tabs and client-side routing change the page without a scroll
    // or resize. Watch the DOM (not our own overlay) and re-place the pins.
    useEffect(() => {
      if (!shown) return undefined;
      let frame = 0;
      const observer = new MutationObserver((records) => {
        if (records.every((r) => host.contains(r.target))) return;
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; domEpoch += 1; setDomTick(domEpoch); setViewportTick((tick) => tick + 1); });
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
      agentSetupHref: sendToAgentSetupHref,
      sendToAgentDisabledReason,
      connectAgentPrompt: sendToAgentConnectPrompt,
      onReply: (parentId, text, opts = {}) => mutate({ type: 'tdoc-feedback-reply', text, parentId, sendToAgent: Boolean(opts.sendToAgent), recipient: opts.recipient, askAgent: threadAskPick(opts), handoffCommentId: opts.handoffCommentId }),
      onReact: (id, emoji) => mutate({ type: 'tdoc-feedback-react', id, emoji }),
      onDelete: (id) => mutate({ type: 'tdoc-feedback-delete', id }, false),
      onResolve: (id, resolved) => mutate({ type: 'tdoc-feedback-resolve', id, resolved }),
      onEdit: (id, text) => mutate({ type: 'tdoc-feedback-edit', id, text }),
      onReanchor: (id) => { setOpenId(null); setPanelOpen(false); setReanchorId(id); },
      onMarkRead: area.markRead,
      onResendHandoff: canSendToAgent ? async (c) => {
        try {
          const body = await resendNotifyHandoff({ slug, handoff_id: c.handoff_id });
          say(resendResultText(body), body?.delivery?.status === 'failed');
          await load();
        } catch (err) { say(err.message || 'Could not resend', true); }
      } : null,
      onSendHandoffElsewhere: canSendToAgent
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
          {area.waitingCount ? <span className="tdoc-fb-badge" title={`${area.waitingCount} waiting on you`}>{area.waitingCount}</span> : null}
        </button>
      );
    }

    const hoverRect = (picking || reanchorId) && !drag
      ? (hovered && hovered === docFrame() ? (frameHover || null) : hovered?.getBoundingClientRect())
      : null;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const bannerText = !areaSelectOn
      ? (reanchorId ? 'Click the element this comment should point at' : 'Click anything on the page to comment on it')
      : reanchorId
        ? (coarse ? 'Tap the element this comment should point at, or hold and drag a box' : 'Click the element this comment should point at, or drag a box from an empty spot')
        : (coarse ? 'Tap an element, or hold and drag a box' : 'Click an element, or drag a box from an empty spot');
    // A box on screen: one being drawn, one being commented on, the open
    // comment's area.
    const marquee = (box, tag) => box ? (
      <div className="tdoc-drag-marquee" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        {tag ? <span className={`tdoc-fb-area-tag${box.top < 30 ? ' below' : ''}`}>{tag}</span> : null}
      </div>
    ) : null;
    const rightInset = panelOpen ? (!isNarrowViewport() ? panelSide.width : innerWidth) : 0;
    // The box being commented on, where it is now (it follows a scroll).
    const areaBox = (() => {
      if (!selected || !areaSel) return null;
      const c = selected.getBoundingClientRect();
      return toRect({ left: c.left + areaSel.x * c.width, top: c.top + areaSel.y * c.height, width: areaSel.width * c.width, height: areaSel.height * c.height });
    })();
    // A whole-page comment has no element: its composer sits at the top.
    const pageRect = { top: 72, bottom: 72, left: Math.max(8, (innerWidth - rightInset - COMPOSER_WIDTH) / 2), right: 0, width: 0, height: 0 };
    const composerRect = pageSel ? pageRect : frameSel ? frameSel.rect : quoteSel ? quoteSel.rect : (areaBox || selected?.getBoundingClientRect());
    const quoteLabel = (quote) => `“${quote.text.slice(0, 48)}${quote.text.length > 48 ? '…' : ''}”`;
    // Where a comment points on screen: its area, or its element.
    // Inside the doc frame: where the frame last said, while it is in view.
    const frameSpot = (comment) => {
      const docFrameEl = docFrame();
      const place = docFrameEl && framePlaces.get(comment.id);
      const rect = place ? fromFrame(place, docFrameEl) : null;
      const f = docFrameEl && docFrameEl.getBoundingClientRect();
      return rect && f && rect.bottom > f.top && rect.top < f.bottom ? rect : null;
    };
    const spotOf = (comment, element) => (comment.anchor && comment.anchor.frame ? frameSpot(comment)
      : (comment.anchor && comment.anchor.quote ? quoteRangeFor(comment, element)?.getBoundingClientRect() : null)
        || (comment.anchor && comment.anchor.region ? regionRect(comment.anchor, element) : null)
        || element?.getBoundingClientRect());
    const openSpot = openComment && openComment.anchor && openComment.anchor.region ? regionRect(openComment.anchor, elementFor(openComment)) : null;
    const placeCard = (element, comment) => {
      const rect = element ? spotOf(comment || {}, element) : null;
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
      if (el && c.anchor && c.anchor.frame) toFrame({ type: 'tdoc:fbReveal', id: frameToken(c.id) });
      else if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (stateLabel(c.anchor)) say(`Left ${stateLabel(c.anchor)} — open it to see the comment in place.`);
      setPicking(false);
      setSelected(null);
      setPanelOpen(false);
      setOpenId(c.id);
    };

    return (
      <AgentMentionContext.Provider value={agentMentions}>
        {(picking || reanchorId) && !selected ? (
          <div className="tdoc-fb-banner" role="status">
            {bannerText}
            {/* S6: a comment on the page as a whole, nothing picked. */}
            {!reanchorId ? <button type="button" className="tdoc-fb-page-comment" onClick={() => { setHovered(null); setAreaSel(null); setQuoteSel(null); setFrameSel(null); setPageSel(true); setSelected(document.body); }}>Comment on this page</button> : null}
            <button type="button" onClick={() => { setPicking(false); setReanchorId(null); setHovered(null); }}>Cancel · Esc</button>
          </div>
        ) : null}
        {hoverRect ? <div className="tdoc-hover-outline" style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }} /> : null}
        {marquee(drag, 'Comment on this area')}
        {marquee(areaBox)}
        {!selected ? marquee(openSpot) : null}
        {pins.map(({ comment, element }) => {
          if (!element) return null;
          const rect = spotOf(comment, element);
          if (!rect || rect.bottom < 0 || rect.top > innerHeight) return null;
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
            selection={{ kind: 'element', label: pageSel ? 'This page' : frameSel ? frameLabel(frameSel.anchor) : quoteSel ? quoteLabel(quoteSel.quote) : areaBox ? (areaSel.label || 'Area') : labelOf(contextFor(selected)), rect: {
              top: composerRect.top - TOP_BAR_HEIGHT,
              bottom: composerRect.bottom - TOP_BAR_HEIGHT,
              left: Math.min(composerRect.left, Math.max(8, innerWidth - rightInset - COMPOSER_WIDTH - 8)),
            } }}
            mentionable={mentionable}
            canSendToAgent={canSendToAgent}
            connectAgentPrompt={sendToAgentConnectPrompt}
            agentSetupHref={sendToAgentSetupHref}
            sendToAgentDisabledReason={sendToAgentDisabledReason}
            onClose={() => { writeDraft(null); setSelected(null); setAreaSel(null); setQuoteSel(null); setPageSel(false); }}
            onSubmit={async (text, opts = {}) => {
              const anchor = pageSel ? pageContext()
                : frameSel ? frameContext(frameSel.anchor)
                : quoteSel ? { ...contextFor(selected), quote: quoteSel.quote, label: quoteLabel(quoteSel.quote) }
                : areaBox ? regionContext(areaBox, selected) : contextFor(selected);
              const result = await call({ type: 'tdoc-feedback-submit', text, anchor, sendToAgent: Boolean(opts.sendToAgent), recipient: opts.recipient, askAgent: threadAskPick(opts) });
              if (apply(result)) { setSelected(null); setAreaSel(null); setQuoteSel(null); setPageSel(false); setPicking(false); }
            }}
          />
        ) : null}

        {openComment ? (
          <CommentCard
            {...cardProps}
            comment={openComment}
            unanchored={!elementFor(openComment) && !stateLabel(openComment.anchor)}
            floating
            position={placeCard(elementFor(openComment), openComment)}
          />
        ) : null}

        {panelOpen ? (
          <ListPanel
            side={panelSide}
            area={area}
            prefs={listPrefs}
            pageUrl={canonical()}
            cardProps={cardProps}
            onPick={() => { setOpenId(null); setPanelOpen(false); setPicking(true); }}
            onOpen={openFromList}
            onClose={() => setPanelOpen(false)}
            onRefresh={feed.refresh}
            refreshing={feed.refreshing}
            spaces={invitesOn && !space ? (session?.spaces || []) : []}
            onSwitch={switchSpace}
          />
        ) : null}

        {notice ? (
          <section className="tdoc-popup tdoc-feedback-notice" style={{ top: 64, right: 18 + rightInset, left: 'auto' }}>
            <div className="head"><span className="h">{notice.reconnect ? 'Reconnect tdoc' : notice.status === 401 ? 'Connect to comment' : 'tdoc Feedback'}</span><button className="x" type="button" aria-label="Close" onClick={() => setNotice(null)}><X size={14} aria-hidden="true" /></button></div>
            <p>{notice.error}</p>
            <div className="foot"><span /><button className="submit ui-btn ui-btn-primary ui-btn-m" type="button" onClick={async () => {
              setNotice(null);
              const result = await call({ type: 'tdoc-feedback-signin' });
              // This button is the continuation of "leave a comment", not a
              // standalone account setting. After a successful first connect,
              // put the person back where they were headed: picking an element.
              if (apply(result) && !result.postedDraft) setPicking(true);
            }}>{notice.reconnect ? 'Reconnect' : 'Connect tdoc'}</button></div>
          </section>
        ) : null}

        {waiting && !notice ? (
          <section className="tdoc-popup tdoc-feedback-notice tdoc-feedback-waiting" role="status" style={{ top: 64, right: 18 + rightInset, left: 'auto' }}>
            <div className="head"><span className="h">Connecting to tdoc</span></div>
            <p>Finish signing in in the tdoc window… {readDraft() ? 'Your comment posts as soon as you are connected.' : ''}</p>
            <div className="foot">
              <button className="ui-btn ui-btn-secondary ui-btn-m" type="button" onClick={() => waiting.cancel()}>Cancel</button>
              <button className="submit ui-btn ui-btn-primary ui-btn-m" type="button" onClick={() => { if (!waiting.reopen()) say('Your browser blocked the tdoc window. Allow pop-ups for this site and try again.', true); }}>Open the tdoc window again</button>
            </div>
          </section>
        ) : null}

        {invite && !notice ? (
          <InvitePrompt
            invite={invite}
            rightInset={rightInset}
            onJoin={joinInvite}
            onKeep={keepOwn}
            onClose={() => { if (invite.id) dropInvite(); else rememberChoice(`slug:${invite.slug}`, 'later'); setInvite(null); }}
          />
        ) : null}

        {shareOpen && slug ? <FeedbackSharePanel slug={slug} open onClose={() => setShareOpen(false)} request={request} /> : null}

        {toast ? <div className={`tdoc-fb-toast${toast.bad ? ' bad' : ''}`} role="status" style={{ right: innerWidth - rightInset >= 240 ? 18 + rightInset : 18 }}>{toast.text}</div> : null}

        <Dock
          session={session || surface?.config}
          openCount={openCount}
          waitingCount={area.waitingCount}
          unreadCount={unreadComments.length}
          panelOpen={panelOpen}
          panelWidth={panelSide.width}
          picking={picking}
          onList={() => setPanelOpen((v) => !v)}
          onPick={() => { setOpenId(null); setSelected(null); setAreaSel(null); setPanelOpen(false); setPicking((v) => !v); }}
          onHide={hide}
          activity={agentActivitySummary(Object.fromEntries(Object.entries(area.handoffBuckets).map(([state, list]) => [state, list.length])), area.unreadCount)}
          onSend={showSend ? () => { setPicking(false); setNotifyAvoid(null); setNotifyIds(ready.map((c) => c.id)); } : null}
          onShare={session?.can_share && slug ? () => {
            setPicking(false);
            // On the owner's own site (the SDK) or tdoc: here. On anyone
            // else's, where a page can read this token: tdoc's Share window.
            if (session.share_here) setShareOpen(true);
            else if (!window.open(`${base}/feedback/share/${encodeURIComponent(slug)}`, 'tdoc-feedback-share', 'popup,width=560,height=720')) say('Your browser blocked the tdoc window. Allow pop-ups for this site and try again.', true);
          } : null}
        />
        {notifyIds ? (
          <NotifyHandoffPanel
            slug={slug}
            open
            commentIds={notifyIds}
            avoid={notifyAvoid}
            onClose={() => setNotifyIds(null)}
            onSent={() => load()}
            onTargetsChanged={agent.refresh}
            hostNotify={Boolean(session?.notify)}
            viewer={notifyViewer}
          />
        ) : null}
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
