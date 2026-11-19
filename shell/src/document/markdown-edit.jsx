import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppSwitch } from '../ui/switch.jsx';
import { AppTextarea } from '../ui/textarea.jsx';
import { readStored, writeStored } from '../safe-storage.js';

// The Markdown switch (flag markdownEditMode): while a doc is being edited,
// one switch shows the same doc as Markdown source in place of the page, and
// back. The page stays mounted under it and follows what is typed (a pause
// of SYNC_MS, and always before anything reads it: Save, autosave, a
// download), so drafts, Save / Discard, autosave and conflicts are the
// editor's own, unchanged. The conversion and what it keeps as HTML:
// markdown-source.js (loaded only when the switch is used).
//
// The choice is remembered per person in this browser, like the mode
// (use-document-editor.js): someone who edits in Markdown opens the next
// doc they edit in Markdown.
const SYNC_MS = 300;
// A very long doc converts in tens of milliseconds: it follows less often.
const SYNC_LONG_MS = 1500;
const LONG_TEXT = 200_000;

export function markdownPrefKey(login) {
  return `tdoc-edit-view:${login || 'anon'}`;
}

// Prose docs only: a sheet doc and slides have their own editors.
export function markdownEligible(docShape) {
  return !(docShape && (docShape.sheetDoc || docShape.slides));
}

let converter = null;
function loadConverter() {
  if (!converter) converter = import('./markdown-source.js');
  return converter;
}

// available: the flag is on and this person is editing a prose doc here.
export function useMarkdownEdit({ available, editor, send, login, frameEpoch, showToast }) {
  const prefKey = markdownPrefKey(login);
  const [wanted, setWanted] = useState(() => readStored(prefKey) === 'markdown');
  // { snapshot, text } while the Markdown view is showing.
  const [view, setView] = useState(null);
  const [blocked, setBlocked] = useState('');
  const [loading, setLoading] = useState(false);
  const viewRef = useRef(null);
  viewRef.current = view;
  const lib = useRef(null);
  const seenEpoch = useRef(frameEpoch);
  // Whether the view can show now (Edit on a prose doc). Text kept while it
  // can't (Read, Comment) stays out of the editor's reads until it can.
  const availableRef = useRef(available);
  availableRef.current = available;
  // Markdown kept from Edit because it could not be converted: tried once,
  // on leaving Edit, and not again until Edit is back.
  const kept = useRef(false);
  const timer = useRef(0);
  const dirtyText = useRef(false);
  const lastSent = useRef(null);
  // Bodies sent and not yet answered, by request id: the page's answer to
  // one of them is this view's own; anything else is from elsewhere.
  const inFlight = useRef(new Set());
  // Bodies the page holds because of this view (what it was opened on, and
  // the page's own copy of each body sent): a snapshot of one of them (an
  // autosave publishing it, editCommitted) is not a change from elsewhere.
  const ours = useRef(new Set());
  const typed = useRef(0);
  const warnedRemoved = useRef(0);
  const problem = useRef('');
  const textareaRef = useRef(null);

  // The page takes what is typed: the whole body, rebuilt from the
  // snapshot taken when the view opened, so repeated syncs never drift and
  // placeholder numbers never change while the view is open. Markdown that
  // can't be converted keeps the text unsynced and THROWS, so nothing saves
  // the page as it was without saying so (use-document-editor.js).
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const current = viewRef.current;
    if (!current || !dirtyText.current || !lib.current) return;
    let result;
    try {
      result = lib.current.fromMarkdown(current.text, current.snapshot);
    } catch (error) {
      const why = error instanceof lib.current.MarkdownTooComplex ? error.message : 'This Markdown can\'t be converted';
      const message = `${why}. Nothing is saved until it is fixed.`;
      if (problem.current !== message) { problem.current = message; showToast(message, true); }
      throw new Error(message);
    }
    problem.current = '';
    dirtyText.current = false;
    const { bodyHtml, removedKept } = result;
    // A placeholder deleted: said when it happens, before any save takes it.
    if (removedKept > warnedRemoved.current) {
      showToast(removedKept === 1
        ? 'A block kept as HTML was deleted in Markdown. Undo (⌘Z) to keep it.'
        : `${removedKept} blocks kept as HTML were deleted in Markdown. Undo (⌘Z) to keep them.`);
    }
    warnedRemoved.current = removedKept;
    const previous = lastSent.current == null ? current.snapshot.bodyHtml : lastSent.current;
    if (bodyHtml === previous) return;
    lastSent.current = bodyHtml;
    const requestId = `md-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    inFlight.current.add(requestId);
    send({ type: 'tdoc:editRestore', bodyHtml, keepFocus: true, requestId });
  }, [send, showToast]);
  const flushQuietly = useCallback(() => { try { flush(); return true; } catch { return false; } }, [flush]);

  // Typing that is on its way to the page is dropped (Discard, a new page).
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    dirtyText.current = false;
    lastSent.current = null;
    inFlight.current = new Set();
    problem.current = '';
  }, []);

  // Open the view on the body the page has now (with any rich edits).
  // Typing in the view while this runs wins: the view is left as it is.
  const open = useCallback(async ({ quiet = false } = {}) => {
    setLoading(true);
    const seq = typed.current;
    try {
      const [mod, bodyHtml] = await Promise.all([loadConverter(), editor.requestBody()]);
      lib.current = mod;
      if (viewRef.current && typed.current !== seq) return true;
      const result = mod.toMarkdown(bodyHtml);
      if (!result.ok) {
        setBlocked(result.reason);
        setView(null);
        if (!quiet) showToast(result.reason, true);
        return false;
      }
      setBlocked('');
      lastSent.current = null;
      dirtyText.current = false;
      inFlight.current = new Set();
      warnedRemoved.current = 0;
      problem.current = '';
      ours.current = new Set([bodyHtml]);
      const next = { snapshot: result.snapshot, text: result.markdown };
      viewRef.current = next;
      setView(next);
      return true;
    } catch {
      if (!quiet) showToast('Could not open the Markdown view', true);
      return false;
    } finally {
      setLoading(false);
    }
  }, [editor, showToast]);

  // Back to the page: only once the page has what was typed. Markdown that
  // can't be converted keeps the view open (flush said why).
  const close = useCallback(() => {
    if (!flushQuietly()) return false;
    viewRef.current = null;
    setView(null);
    return true;
  }, [flushQuietly]);

  const toggle = useCallback(async (next) => {
    if (!next && !close()) return;
    setWanted(next);
    writeStored(prefKey, next ? 'markdown' : 'rich');
    if (next) await open();
  }, [close, open, prefKey]);

  // Edit mode on, or a fresh page (a save, a discard): the view opens if it
  // was the person's choice. Nothing is converted otherwise: whether a doc
  // can be shown as Markdown is learnt when the switch is used.
  useEffect(() => {
    if (frameEpoch !== seenEpoch.current) {
      seenEpoch.current = frameEpoch;
      // A new page in the frame. Markdown kept from Edit that could not be
      // converted stays (it comes back with Edit); typing on its way to the
      // old page (Discard) is dropped with it.
      if (!(viewRef.current && dirtyText.current && kept.current)) {
        cancel();
        if (viewRef.current) { viewRef.current = null; setView(null); }
      }
    }
    if (!available) {
      // Leaving Edit: what was typed goes to the page first. Markdown that
      // can't be converted is kept (not shown) and comes back with Edit;
      // flush has said why, and leaving the page asks first (below).
      if (viewRef.current && !kept.current && !close()) kept.current = true;
      return undefined;
    }
    kept.current = false;
    let cancelled = false;
    const id = window.setTimeout(async () => {
      if (cancelled) return;
      // Back in Edit with Markdown still waiting to be fixed: that text.
      if (viewRef.current && dirtyText.current) { setView(viewRef.current); return; }
      if (wanted && !viewRef.current) await open({ quiet: true });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, frameEpoch]);

  // The page's body replaced from elsewhere (a draft restored, a version
  // swapped in): the view reopens on it, unless typing is still on its way.
  useEffect(() => {
    editor.setMarkdownHooks({
      beforeSerialize: () => { if (availableRef.current) flush(); },
      onSnapshot: (message) => {
        if (!viewRef.current || !availableRef.current) return;
        if (message.requestId && inFlight.current.has(message.requestId)) {
          inFlight.current.delete(message.requestId);
          ours.current.add(message.bodyHtml);
          if (ours.current.size > 8) ours.current = new Set([...ours.current].slice(-8));
          return;
        }
        // The page still holds what this view gave it (an autosave just
        // published it): nothing to reopen, the numbering stays.
        if (ours.current.has(message.bodyHtml) || message.bodyHtml === lastSent.current) return;
        if (dirtyText.current) return;
        open({ quiet: true });
      },
    });
    return () => editor.setMarkdownHooks(null);
  }, [editor, flush, open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Leaving the page with Markdown the page does not have yet (it could not
  // be converted, or the last keystrokes): try once more, then ask. Neither
  // a draft nor autosave can hold text the page never got.
  useEffect(() => {
    const warn = (event) => {
      if (!viewRef.current || !dirtyText.current) return;
      if (!kept.current && flushQuietly()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flushQuietly]);

  const onChange = (event) => {
    const text = event.target.value;
    setView((current) => (current ? { ...current, text } : current));
    viewRef.current = viewRef.current ? { ...viewRef.current, text } : null;
    dirtyText.current = true;
    typed.current += 1;
    editor.noteTyping?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flushQuietly, text.length > LONG_TEXT ? SYNC_LONG_MS : SYNC_MS);
  };

  useEffect(() => {
    if (view && textareaRef.current && document.activeElement !== textareaRef.current) {
      try { textareaRef.current.focus({ preventScroll: true }); textareaRef.current.setSelectionRange(0, 0); } catch {}
    }
    // Only when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(view)]);

  const on = Boolean(available && view);
  const pane = on ? (
    <div className="tdoc-md-source">
      <AppTextarea
        ref={textareaRef}
        autoGrow={false}
        className="tdoc-md-source-text"
        aria-label="Document as Markdown"
        spellCheck
        value={view.text}
        onChange={onChange}
        onBlur={flushQuietly}
      />
    </div>
  ) : null;

  return {
    available,
    on,
    loading,
    blocked: available && !on ? blocked : '',
    toggle,
    flush,
    cancel,
    pane,
  };
}

// The switch itself: in Edit mode's bar, or beside the autosave status
// (modeless). Disabled, with the reason as its tooltip, where the doc can't
// be shown as Markdown.
export function MarkdownSwitch({ markdown }) {
  if (!markdown?.available) return null;
  const reason = markdown.blocked;
  return (
    <span className="tdoc-md-switch" title={reason || (markdown.on ? 'Back to the formatted page' : 'Edit this doc as Markdown')} data-blocked={reason ? '' : undefined}>
      <AppSwitch
        id="tdoc-md-switch"
        label="Markdown"
        checked={markdown.on}
        disabled={Boolean(reason) || markdown.loading}
        onCheckedChange={(next) => markdown.toggle(next)}
      />
    </span>
  );
}
