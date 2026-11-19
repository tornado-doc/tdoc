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
  const timer = useRef(0);
  const dirtyText = useRef(false);
  const lastSent = useRef(null);
  const echoes = useRef(0);
  const textareaRef = useRef(null);

  // The page takes what is typed: the whole body, rebuilt from the
  // snapshot taken when the view opened, so repeated syncs never drift.
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const current = viewRef.current;
    if (!current || !dirtyText.current || !lib.current) return;
    dirtyText.current = false;
    const { bodyHtml } = lib.current.fromMarkdown(current.text, current.snapshot);
    const previous = lastSent.current == null ? current.snapshot.bodyHtml : lastSent.current;
    if (bodyHtml === previous) return;
    lastSent.current = bodyHtml;
    echoes.current += 1;
    send({ type: 'tdoc:editRestore', bodyHtml, keepFocus: true });
  }, [send]);

  // Open the view on the body the page has now (with any rich edits).
  const open = useCallback(async ({ quiet = false } = {}) => {
    setLoading(true);
    try {
      const [mod, bodyHtml] = await Promise.all([loadConverter(), editor.requestBody()]);
      lib.current = mod;
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
      echoes.current = 0;
      setView({ snapshot: result.snapshot, text: result.markdown });
      return true;
    } catch {
      if (!quiet) showToast('Could not open the Markdown view', true);
      return false;
    } finally {
      setLoading(false);
    }
  }, [editor, showToast]);

  const close = useCallback(() => {
    flush();
    const current = viewRef.current;
    if (current && lib.current && lastSent.current != null) {
      const { removedKept } = lib.current.fromMarkdown(current.text, current.snapshot);
      if (removedKept) showToast(removedKept === 1 ? 'A block kept as HTML was deleted in Markdown' : `${removedKept} blocks kept as HTML were deleted in Markdown`);
    }
    setView(null);
  }, [flush, showToast]);

  const toggle = useCallback(async (next) => {
    setWanted(next);
    writeStored(prefKey, next ? 'markdown' : 'rich');
    if (next) await open();
    else close();
  }, [close, open, prefKey]);

  // Edit mode on, or a fresh page (a save, a discard): open the view if it
  // was the person's choice, otherwise only learn whether it could open.
  useEffect(() => {
    if (!available) {
      if (viewRef.current) close();
      return undefined;
    }
    let cancelled = false;
    const id = window.setTimeout(async () => {
      if (cancelled) return;
      if (wanted) { await open({ quiet: true }); return; }
      try {
        const [mod, bodyHtml] = await Promise.all([loadConverter(), editor.requestBody()]);
        if (cancelled) return;
        lib.current = mod;
        const result = mod.toMarkdown(bodyHtml);
        setBlocked(result.ok ? '' : result.reason);
      } catch {}
    }, 250);
    return () => { cancelled = true; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, frameEpoch]);

  // The page's body replaced from elsewhere (a draft restored, a version
  // swapped in): the view reopens on it, unless typing is still on its way.
  useEffect(() => {
    editor.setMarkdownHooks({
      beforeSerialize: () => flush(),
      onSnapshot: () => {
        if (!viewRef.current) return;
        if (echoes.current > 0) { echoes.current -= 1; return; }
        if (dirtyText.current) return;
        open({ quiet: true });
      },
    });
    return () => editor.setMarkdownHooks(null);
  }, [editor, flush, open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onChange = (event) => {
    const text = event.target.value;
    setView((current) => (current ? { ...current, text } : current));
    viewRef.current = viewRef.current ? { ...viewRef.current, text } : null;
    dirtyText.current = true;
    editor.noteTyping?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SYNC_MS);
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
        onBlur={flush}
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
