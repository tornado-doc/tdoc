import { isFeatureOn } from '../feature-flags.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveDocumentVersion } from '../document/api.js';
import { embedFrameSrc } from '../document/sheet-embed.js';
import {
  clearDraft,
  clearDraftBody,
  draftBodyExpired,
  draftKey,
  hasLocalDraftBody,
  htmlHash,
  legacyDraftKey,
  loadDraft,
  saveDraft,
} from '../document/draft-store.js';

function urlWantsEdit() {
  return new URLSearchParams(location.search).get('edit') === '1';
}

// ?edit=1 is a one-shot instruction for the page that was just created or
// saved. Left in the address bar it turned every reload and every copied link
// into Edit, so it is read once and then dropped (other params and the hash
// stay).
function dropEditParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('edit')) return;
    url.searchParams.delete('edit');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function modeStorageKey(config) {
  return `tdoc-mode:${config.slug}:${config.identity?.login || 'anon'}`;
}

function getStoredMode(config) {
  try {
    return localStorage.getItem(modeStorageKey(config));
  } catch {
    return null;
  }
}

function storeMode(config, mode) {
  try {
    localStorage.setItem(modeStorageKey(config), mode);
  } catch {}
}

// Modeless editing (flag modelessEdit): how long the page waits after the
// last keystroke before the draft becomes a version. Tests shorten it.
const MODELESS_IDLE_MS = () => Number((typeof window !== 'undefined' && window.__TDOC_MODELESS_IDLE_MS) || 0) || 2 * 60 * 1000;
// "Saving…" until the draft has settled in this browser.
const MODELESS_SETTLE_MS = 1200;

export function useDocumentEditor({
  boot,
  config,
  frameRef,
  send,
  showToast,
  onDisableCommentSelection,
  // Someone who may edit, on a prose doc, with modelessEdit on: no modes,
  // the page is always editable, drafts publish themselves (see below).
  modeless = false,
  // Called with the save's result after a modeless publish (the page stays
  // and becomes that version).
  onPublished = null,
}) {
  const requests = useRef(new Map());
  // Set for the save's own navigation, so the unload warning below can tell a
  // deliberate hop to the new version from a tab closing mid-edit.
  const leavingForSave = useRef(false);
  const storeKey = useMemo(() => draftKey(config), [config]);
  const legacyKey = useMemo(() => legacyDraftKey(config), [config]);
  const publishedHtml = useRef(null);
  const consideringDraft = useRef(false);
  // A doc created from scratch (or just saved) arrives at ?edit=1: it is
  // blank, so dropping the author in read mode would show an empty page and
  // hide the one control they need. `tdoc:ready` re-sends whatever mode is
  // current, so the frame picks this up even though it is set before the
  // iframe has loaded.
  //
  // Opening a doc otherwise never starts in Edit from memory: a remembered
  // Edit landed people who only wanted to read in the editor. The one
  // exception is an unsaved draft — the frame offers it back only once it is
  // editing, so a remembered Edit with a draft waiting still opens Edit.
  const [mode, setMode] = useState(() => {
    if (urlWantsEdit() && config.canEdit) return 'edit';
    const stored = getStoredMode(config);
    if (stored === 'edit' && config.canEdit && hasLocalDraftBody(storeKey, legacyKey)) return 'edit';
    if (stored === 'comment' && (config.canComment || config.signInToComment)) return 'comment';
    if (stored === 'read') return 'read';
    return (config.canComment || config.signInToComment) ? 'comment' : 'read';
  });
  useEffect(() => { dropEditParam(); }, []);
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [staleDraft, setStaleDraft] = useState(null);
  const effectiveMode = modeless ? 'edit' : mode;
  const modeMessage = useCallback(() => ({
    type: 'tdoc:mode',
    mode: effectiveMode,
    modeless,
    elementComment: !config.isLanding,
    areaSelect: !config.isLanding && isFeatureOn('feedbackAreaSelect'),
  }), [effectiveMode, modeless, config.isLanding]);

  useEffect(() => {
    send(modeMessage());
  }, [modeMessage, send]);

  useEffect(() => {
    // Modeless: every keystroke is already in this browser's draft store, and
    // leaving publishes it (below); a "leave site?" prompt would only nag.
    if (!dirty || modeless) return undefined;
    const warn = (event) => {
      // A save commits the draft server-side and then navigates to the version
      // it just created. Warning about unsaved work there is a lie, and it put
      // a browser confirm in front of the author every single time they saved.
      if (leavingForSave.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const changeMode = useCallback((nextMode) => {
    if (modeless) return;
    if (nextMode === 'edit' && !config.canEdit) return;
    if (nextMode === 'comment' && !config.canComment && !config.signInToComment) return;
    if (nextMode === 'comment' && dirty) {
      showToast('Save or discard the draft before commenting', true);
      return;
    }
    if (nextMode !== 'comment') onDisableCommentSelection();
    setMode(nextMode);
    storeMode(config, nextMode);
  }, [config, dirty, modeless, onDisableCommentSelection, showToast, storeKey]);

  const requestDocumentMessage = useCallback(() => new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = window.setTimeout(() => {
      requests.current.delete(requestId);
      reject(new Error('The editor did not respond'));
    }, 5_000);
    requests.current.set(requestId, {
      resolve: (message) => { window.clearTimeout(timer); resolve(message); },
    });
    send({ type: 'tdoc:editSerialize', requestId });
  }), [send]);
  const requestDocument = useCallback(() => requestDocumentMessage().then((message) => message.html), [requestDocumentMessage]);

  const save = useCallback(async () => {
    if (!dirty || checking || saving) return;
    setSaving(true);
    try {
      const html = await requestDocument();
      const result = await saveDocumentVersion(config.slug, config.version, html);
      await clearDraftBody(storeKey);
      leavingForSave.current = true;
      // Stay in the editor on the version that was just written. Saving is a
      // checkpoint in the middle of writing, not the end of it — dropping the
      // author into read mode made them find the mode switch again after every
      // save, which is worst on a doc they only just started. Built through URL
      // so a response that ever carries a query string still composes.
      const next = new URL(result.url, location.origin);
      next.searchParams.set('edit', '1');
      location.href = `${next.pathname}${next.search}`;
    } catch (error) {
      if (error.status === 409 && error.body?.error === 'version_conflict') {
        const latestVersion = Number(error.body.latestVersion);
        setConflict({
          latestVersion,
          latestUrl: `/d/${encodeURIComponent(config.slug)}/v/${latestVersion}`,
        });
      } else if (error.status === 409 && error.body?.error === 'save_in_progress') {
        // Nothing was written and the draft is still here.
        showToast('The doc was just updated. Your draft is kept. Try saving again in a moment.', true);
      } else {
        showToast(error.message || 'Could not save', true);
      }
    } finally {
      setSaving(false);
    }
  }, [checking, config.slug, config.version, dirty, requestDocument, saving, showToast, storeKey]);

  // A version saved without Edit mode (a sheet's column width set in Read
  // or Comment mode): the same document request and the same save as Save,
  // so the same checks and the same author, but the page stays where it is.
  // Never over an unsaved draft: that would publish it unasked. (Edit mode
  // with nothing typed yet is fine: widths dragged just before it opened.)
  const saveInPlace = useCallback(async (baseVersion) => {
    if (dirty || saving) {
      const error = new Error('Save or discard the draft first');
      error.code = 'draft_open';
      throw error;
    }
    const html = await requestDocument();
    return saveDocumentVersion(config.slug, baseVersion, html);
  }, [config.slug, dirty, requestDocument, saving]);

  const discard = useCallback(async () => {
    await clearDraftBody(storeKey);
    setDirty(false);
    setChecking(false);
    setStaleDraft(null);
    if (frameRef.current) frameRef.current.src = embedFrameSrc(boot.frameSrc, true);
  }, [boot.frameSrc, frameRef, storeKey]);

  const restoreDraft = useCallback((bodyHtml) => {
    consideringDraft.current = true;
    send({ type: 'tdoc:editRestore', bodyHtml });
    setStaleDraft(null);
  }, [send]);

  const keepPublished = useCallback(async () => {
    await clearDraftBody(storeKey);
    setStaleDraft(null);
  }, [storeKey]);

  const considerDraft = useCallback(async (published, current) => {
    if (consideringDraft.current) return;
    if (current !== published) return;
    let record;
    try {
      record = await loadDraft(storeKey, legacyKey);
    } catch {
      return;
    }
    if (!record?.bodyHtml) return;
    if (record.bodyHtml === published) {
      await clearDraftBody(storeKey);
      return;
    }
    if (draftBodyExpired(record)) {
      await clearDraftBody(storeKey);
      return;
    }
    if (record.baseHash && record.baseHash === htmlHash(published)) {
      restoreDraft(record.bodyHtml);
      return;
    }
    setStaleDraft({
      bodyHtml: record.bodyHtml,
      updatedAt: record.bodyUpdatedAt || record.updatedAt,
      baseVersion: record.baseVersion,
    });
  }, [legacyKey, restoreDraft, storeKey]);

  // --- modeless: autosave -> version -------------------------------------
  // Every keystroke lands in this browser's draft store at once (editDraft
  // below), as in Edit mode. Readers never see a draft: it becomes a version
  // after MODELESS_IDLE_MS without typing, when the tab is hidden, or when
  // the page goes away, through the same save as Save (baseVersion checked
  // server-side, so a version someone else published meanwhile is a 409 and
  // the conflict dialog, never an overwrite). The page stays put and becomes
  // the new version (onPublished); the frame rebases on what was sent.
  //   status: idle | typing | draft | publishing | published | conflict | error
  const [saveStatus, setSaveStatus] = useState('idle');
  const [activity, setActivity] = useState(0);
  const dirtyRef = useRef(false);
  const publishingRef = useRef(null);
  const pausedRef = useRef(false);
  const baseRef = useRef(Number(config.version) || 0);
  const lastTypedRef = useRef(0);
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;
  useEffect(() => { baseRef.current = Math.max(baseRef.current, Number(config.version) || 0); }, [config.version]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // `force` (the tab going away): the last keystrokes may not have reached
  // the dirty flag yet, so the frame's own body decides.
  const publish = useCallback(async ({ keepalive = false, force = false } = {}) => {
    if (!modeless) return false;
    if (publishingRef.current) return publishingRef.current;
    if (pausedRef.current || (!dirtyRef.current && !force)) return false;
    const run = (async () => {
      try {
        const doc = await requestDocumentMessage();
        if (typeof doc.bodyHtml === 'string' && publishedHtml.current != null && doc.bodyHtml === publishedHtml.current) return false;
        setSaveStatus('publishing');
        const result = await saveDocumentVersion(config.slug, baseRef.current, doc.html, { keepalive });
        const n = Number(result?.version) || 0;
        if (n) baseRef.current = n;
        // Drafts from here on are measured against what was just published.
        if (typeof doc.bodyHtml === 'string') publishedHtml.current = doc.bodyHtml;
        onPublishedRef.current?.(result);
        send({ type: 'tdoc:editCommitted', bodyHtml: doc.bodyHtml });
        setSaveStatus('published');
        return true;
      } catch (error) {
        if (error.status === 409 && error.body?.error === 'version_conflict') {
          // Someone (a person or an agent) published meanwhile. Stop
          // publishing; the draft stays in this browser for the next visit.
          pausedRef.current = true;
          const latestVersion = Number(error.body.latestVersion);
          setConflict({ latestVersion, latestUrl: `/d/${encodeURIComponent(config.slug)}/v/${latestVersion}`, modeless: true });
          setSaveStatus('conflict');
        } else if (error.status === 409 && error.body?.error === 'save_in_progress') {
          setSaveStatus('draft');
          window.setTimeout(() => setActivity((n) => n + 1), 5_000);
        } else {
          setSaveStatus('error');
          window.setTimeout(() => setActivity((n) => n + 1), 30_000);
        }
        return false;
      } finally {
        publishingRef.current = null;
      }
    })();
    publishingRef.current = run;
    return run;
  }, [config.slug, modeless, requestDocumentMessage, send]);
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // Typing: "Saving…" while the draft settles, "Saved" once it has; the
  // version follows after the idle wait.
  useEffect(() => {
    if (!modeless || !activity) return undefined;
    const settle = window.setTimeout(() => {
      setSaveStatus((current) => (current === 'typing' ? 'draft' : current));
    }, MODELESS_SETTLE_MS);
    const idle = window.setTimeout(() => { publishRef.current(); }, MODELESS_IDLE_MS());
    return () => { window.clearTimeout(settle); window.clearTimeout(idle); };
  }, [activity, modeless]);

  useEffect(() => {
    if (!modeless) return undefined;
    const away = () => { publishRef.current({ keepalive: true, force: true }); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') away(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', away);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', away);
    };
  }, [modeless]);

  const noteTyping = () => {
    if (!modeless) return;
    lastTypedRef.current = Date.now();
    setSaveStatus((current) => (current === 'conflict' ? current : 'typing'));
    setActivity((n) => n + 1);
  };

  const frameHandlers = {
    editState(message) {
      // Read at once by a publish as the tab hides, before React renders.
      dirtyRef.current = Boolean(message.dirty);
      setDirty(Boolean(message.dirty));
      setChecking(Boolean(message.checking));
    },
    editBaseline(message) {
      if (typeof message.publishedHtml !== 'string') return;
      publishedHtml.current = message.publishedHtml;
      const current = typeof message.bodyHtml === 'string' ? message.bodyHtml : message.publishedHtml;
      considerDraft(message.publishedHtml, current).catch(() => {});
    },
    editDraft(message) {
      if (typeof message.bodyHtml !== 'string') return;
      noteTyping();
      saveDraft(storeKey, message.bodyHtml, {
        baseHash: htmlHash(publishedHtml.current || ''),
        baseVersion: config.version,
      }).catch(() => {});
    },
    editSnapshot(message) {
      consideringDraft.current = false;
      if (typeof message.bodyHtml !== 'string') return;
      const nextDirty = Boolean(message.dirty);
      setChecking(false);
      if (nextDirty && modeless) {
        // A restored draft never typed in this visit still has to publish.
        setSaveStatus((current) => (current === 'idle' ? 'draft' : current));
        setActivity((n) => n + 1);
      }
      if (nextDirty) {
        saveDraft(storeKey, message.bodyHtml, {
          baseHash: htmlHash(publishedHtml.current || ''),
          baseVersion: config.version,
        }).catch(() => {});
      } else {
        clearDraftBody(storeKey, message.bodyHtml).catch(() => {});
      }
    },
    editDocument(message) {
      const pending = requests.current.get(message.requestId);
      if (!pending) return;
      requests.current.delete(message.requestId);
      pending.resolve(message);
    },
  };

  return {
    mode: effectiveMode,
    modeless,
    modeMessage,
    saveStatus,
    publish,
    // When the person last typed (modeless): a newer version waits for a pause.
    lastTypedAt: () => lastTypedRef.current,
    dirty,
    checking,
    saving,
    conflict,
    staleDraft,
    changeMode,
    discard,
    save,
    saveInPlace,
    restoreDraft: () => staleDraft && restoreDraft(staleDraft.bodyHtml),
    keepPublished,
    closeConflict: () => setConflict(null),
    format: (command, value) => send({ type: 'tdoc:editFormat', command, value }),
    frameHandlers,
  };
}
