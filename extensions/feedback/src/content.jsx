import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquarePlus } from 'lucide-react';
import { CommentCard } from '../../../shell/src/document/comment-card.jsx';
import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx';
import { avatarFor } from '../../../shell/src/document/model.js';
import chromeCss from '../../../server/chrome.css?inline';

if (window.top === window && !window.__TDOC_FEEDBACK__) {
  window.__TDOC_FEEDBACK__ = true;

  const style = document.createElement('style');
  style.id = 'tdoc-feedback-styles';
  style.textContent = `${chromeCss}
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

  const call = (message) => chrome.runtime.sendMessage(message);
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
        setNotice(result.signedIn === false ? { status: 401, error: 'Sign in to the connected tdoc to comment.' } : null);
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

    useEffect(() => {
      const listener = (message) => {
        if (message?.type === 'tdoc-feedback-toggle') toggle();
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    }, [toggle]);

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

    if (!active) return null;
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
            <div className="head"><span className="h">{notice.setup ? 'Connect tdoc' : notice.status === 401 ? 'Sign in to comment' : 'tdoc Feedback'}</span><button className="x" type="button" onClick={() => setNotice(null)}>×</button></div>
            <p>{notice.setup ? 'Choose the tdoc that should hold this app’s product feedback.' : notice.error}</p>
            <div className="foot"><span /><button className="submit" type="button" onClick={() => call({ type: notice.setup ? 'tdoc-feedback-open-options' : 'tdoc-feedback-signin' })}>{notice.setup ? 'Choose tdoc' : 'Sign in to tdoc'}</button></div>
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
