import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LinkDialog, SelectionToolbar, SlashMenu } from './editor-toolbar.jsx';

// Modeless editing (flag modelessEdit), the doc page's half. The frame
// (server/frame-probe.js) says where a selection or a "/" is; this puts the
// editor bar's own tools there (SelectionToolbar, SlashMenu, LinkDialog from
// editor-toolbar.jsx) and sends the choice back. Publishing lives in
// use-document-editor.js. Also here: a version published while the page is
// open (by a person's autosave or an agent) replaces the content in place,
// once nobody is typing, instead of a reload.

// A pause this long after the last keystroke counts as "stopped typing".
const TYPING_PAUSE_MS = 4000;

// The latest version's content, read the way the page reads its own: the
// version's /frame in a hidden frame (the route only answers frames), asked
// for its body through the same serialize message the editor uses.
export function loadVersionBody(slug, n, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.className = 'tdoc-live-swap-frame';
    const requestId = `swap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
      frame.remove();
      if (error) reject(error); else resolve(value);
    };
    const receive = (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || message.source !== 'tdoc-frame') return;
      if (message.type === 'tdoc:ready') {
        frame.contentWindow.postMessage({ source: 'tdoc-shell', type: 'tdoc:editSerialize', requestId }, '*');
      } else if (message.type === 'tdoc:editDocument' && message.requestId === requestId) {
        if (typeof message.bodyHtml !== 'string' || !message.shape) finish(new Error('no body'));
        else finish(null, { bodyHtml: message.bodyHtml, shape: message.shape });
      }
    };
    const timer = window.setTimeout(() => finish(new Error('timeout')), timeoutMs);
    window.addEventListener('message', receive);
    frame.src = `/d/${encodeURIComponent(slug)}/v/${n}/frame`;
    document.body.appendChild(frame);
  });
}

export function useModelessEdit({
  enabled, // modeless editing for this person on this doc
  liveSwap, // the flag is on: newer versions replace the page in place
  config,
  editor,
  send,
  frameRef,
  narrow,
  busy, // a composer, dialog or panel the person is using
  latest, // the newest version the page has heard of
  onAdoptVersion, // (n) => the page is version n now
  onLink, // open the link dialog for the selection
}) {
  const [bubble, setBubble] = useState(null);
  const [slash, setSlash] = useState(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [frameBox, setFrameBox] = useState(null);
  const measure = useCallback(() => {
    const box = frameRef.current?.getBoundingClientRect();
    setFrameBox(box ? { top: box.top, left: box.left } : null);
  }, [frameRef]);

  useEffect(() => {
    if (!enabled) { setBubble(null); setSlash(null); }
  }, [enabled]);

  const handlers = {
    'tdoc:bubble': (message) => {
      if (!enabled) return;
      measure();
      setBubble(message.rect ? { rect: message.rect, marks: message.marks || {} } : null);
    },
    'tdoc:slash': (message) => {
      if (!enabled || !message.rect) return;
      measure();
      setBubble(null);
      setSlash({ rect: message.rect });
    },
    'tdoc:swapped': (message) => swapWait.current?.(message),
  };

  const format = (command, value) => {
    if (command === 'createLink') { onLink(); return; }
    editor.format(command, value);
  };

  // Comment on the selection: what it quotes has to be in a published
  // version for everybody else to see it anchored, so a draft publishes first.
  const comment = async () => {
    setBubble(null);
    if (editor.dirty) await editor.publish();
    send({ type: 'tdoc:bubbleComment' });
  };

  // The doc is another (sandboxed) origin: it cannot take focus back by
  // itself, so the page hands it over before the frame places the caret.
  const focusDoc = () => {
    try { frameRef.current?.focus(); frameRef.current?.contentWindow?.focus(); } catch {}
  };
  const toFrame = (message) => {
    // After the menu or dialog has put focus back where it was.
    window.setTimeout(() => { focusDoc(); send(message); }, 0);
  };
  const pick = (command) => {
    if (command === 'image') { setImageOpen(true); setSlash(null); return; }
    setSlash(null);
    toFrame({ type: 'tdoc:slashApply', command });
  };

  // --- a newer version, in place -----------------------------------------
  const swapWait = useRef(null);
  const swapping = useRef(0);
  const failed = useRef(new Set());
  const [tick, setTick] = useState(0);
  const current = Number(config.version) || 0;
  const handsOn = () => editor.dirty || busy || Boolean(bubble || slash || imageOpen)
    || editor.saveStatus === 'publishing' || Date.now() - (editor.lastTypedAt() || 0) < TYPING_PAUSE_MS;
  const handsOnRef = useRef(handsOn);
  handsOnRef.current = handsOn;
  useEffect(() => {
    if (!liveSwap || !config.slug || config.isLanding) return undefined;
    if (!(latest > current) || swapping.current === latest || failed.current.has(latest)) return undefined;
    // Never under someone's hands: their draft would be replaced (their
    // publish meets the conflict dialog instead), and a composer or a menu
    // is in use. Try again once they pause.
    const sinceTyping = Date.now() - (editor.lastTypedAt() || 0);
    if (editor.dirty || busy || bubble || slash || imageOpen || editor.saveStatus === 'publishing' || sinceTyping < TYPING_PAUSE_MS) {
      const again = window.setTimeout(() => setTick((n) => n + 1), sinceTyping < TYPING_PAUSE_MS ? TYPING_PAUSE_MS - sinceTyping + 50 : 1500);
      return () => window.clearTimeout(again);
    }
    const n = latest;
    swapping.current = n;
    (async () => {
      let retry = false;
      try {
        const next = await loadVersionBody(config.slug, n);
        // Typing started while it loaded: wait for the next pause.
        if (handsOnRef.current()) { retry = true; return; }
        const result = await new Promise((resolve) => {
          const requestId = `swap-${n}`;
          const timer = window.setTimeout(() => resolve({ ok: false }), 5000);
          swapWait.current = (message) => {
            if (message.requestId !== requestId) return;
            window.clearTimeout(timer);
            swapWait.current = null;
            resolve(message);
          };
          send({ type: 'tdoc:swapBody', requestId, bodyHtml: next.bodyHtml, shape: next.shape });
        });
        if (result.ok) {
          onAdoptVersion(n);
          // "Edited just now" lights up for as long as the changes stay marked.
          window.setTimeout(() => {
            const edited = document.getElementById('tdoc-version-toggle');
            if (!edited) return;
            edited.setAttribute('data-just-updated', '');
            window.setTimeout(() => edited.removeAttribute('data-just-updated'), 3000);
          }, 0);
        }
        else failed.current.add(n);
      } catch {
        failed.current.add(n);
      } finally {
        if (swapping.current === n) swapping.current = 0;
        if (retry) setTick((t) => t + 1);
      }
    })();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSwap, latest, current, editor.dirty, busy, bubble, slash, imageOpen, editor.saveStatus, tick]);

  const overlay = enabled ? (
    <>
      {!busy ? (
        <SelectionToolbar
          rect={bubble?.rect}
          marks={bubble?.marks}
          frameBox={frameBox}
          narrow={narrow}
          onFormat={format}
          onComment={comment}
        />
      ) : null}
      <SlashMenu
        rect={slash?.rect}
        frameBox={frameBox}
        onPick={pick}
        onCancel={() => { setSlash(null); toFrame({ type: 'tdoc:slashCancel' }); }}
      />
      <LinkDialog
        open={imageOpen}
        title="Add image"
        submitLabel="Add image"
        onOpenChange={(open) => {
          if (open) return;
          setImageOpen(false);
          toFrame({ type: 'tdoc:slashCancel' });
        }}
        onSubmit={(url) => { setImageOpen(false); toFrame({ type: 'tdoc:slashApply', command: 'image', value: url }); }}
      />
    </>
  ) : null;

  return { handlers, overlay, bubbleOpen: Boolean(bubble), slashOpen: Boolean(slash) };
}
