import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveDocumentVersion } from '../document/api.js';
import {
  clearDraft,
  clearDraftBody,
  draftBodyExpired,
  draftKey,
  htmlHash,
  legacyDraftKey,
  loadDraft,
  saveDraft,
  saveDraftMode,
} from '../document/draft-store.js';

function urlWantsEdit() {
  return new URLSearchParams(location.search).get('edit') === '1';
}

function allowedMode(mode, config) {
  if (mode === 'edit') return config.canEdit ? 'edit' : null;
  if (mode === 'comment') return config.canComment ? 'comment' : null;
  if (mode === 'read') return 'read';
  return null;
}

export function useDocumentEditor({
  boot,
  config,
  frameRef,
  send,
  showToast,
  onDisableCommentSelection,
}) {
  const requests = useRef(new Map());
  // Set for the save's own navigation, so the unload warning below can tell a
  // deliberate hop to the new version from a tab closing mid-edit.
  const leavingForSave = useRef(false);
  const storeKey = useMemo(() => draftKey(config), [config]);
  const legacyKey = useMemo(() => legacyDraftKey(config), [config]);
  const publishedHtml = useRef(null);
  const consideringDraft = useRef(false);
  const [sessionReady, setSessionReady] = useState(false);
  // A doc created from scratch arrives at ?edit=1: it is blank, so dropping the
  // author in read mode would show an empty page and hide the one control they
  // need. `tdoc:ready` re-sends whatever mode is current, so the frame picks
  // this up even though it is set before the iframe has loaded.
  const [mode, setMode] = useState(() => {
    if (urlWantsEdit() && config.canEdit) return 'edit';
    return config.canComment ? 'comment' : 'read';
  });
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [staleDraft, setStaleDraft] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadDraft(storeKey, legacyKey).then((record) => {
      if (cancelled) return;
      if (!urlWantsEdit()) {
        const next = allowedMode(record?.mode, config);
        if (next) setMode(next);
      }
      setSessionReady(true);
    }).catch(() => {
      if (!cancelled) setSessionReady(true);
    });
    return () => { cancelled = true; };
    // Load once per document. Mode is omitted so this cannot fight the author
    // switching Read/Comment/Edit after the restore.
  }, [storeKey, legacyKey]);

  useEffect(() => {
    send({ type: 'tdoc:mode', mode });
  }, [mode, send]);

  useEffect(() => {
    if (!sessionReady) return undefined;
    saveDraftMode(storeKey, mode).catch(() => {});
    return undefined;
  }, [mode, sessionReady, storeKey]);

  useEffect(() => {
    if (!dirty) return undefined;
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
    if (nextMode === 'edit' && !config.canEdit) return;
    if (nextMode === 'comment' && !config.canComment) return;
    if (nextMode === 'comment' && dirty) {
      showToast('Save or discard the draft before commenting', true);
      return;
    }
    if (nextMode !== 'comment') onDisableCommentSelection();
    setMode(nextMode);
  }, [config.canComment, config.canEdit, dirty, onDisableCommentSelection, showToast]);

  const requestDocument = useCallback(() => new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = window.setTimeout(() => {
      requests.current.delete(requestId);
      reject(new Error('The editor did not respond'));
    }, 5_000);
    requests.current.set(requestId, {
      resolve: (html) => { window.clearTimeout(timer); resolve(html); },
    });
    send({ type: 'tdoc:editSerialize', requestId });
  }), [send]);

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
      } else {
        showToast(error.message || 'Could not save', true);
      }
    } finally {
      setSaving(false);
    }
  }, [checking, config.slug, config.version, dirty, requestDocument, saving, showToast, storeKey]);

  const discard = useCallback(async () => {
    await clearDraftBody(storeKey);
    setDirty(false);
    setChecking(false);
    setStaleDraft(null);
    if (frameRef.current) frameRef.current.src = boot.frameSrc;
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

  const frameHandlers = {
    editState(message) {
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
      if (nextDirty) {
        saveDraft(storeKey, message.bodyHtml, {
          baseHash: htmlHash(publishedHtml.current || ''),
          baseVersion: config.version,
        }).catch(() => {});
      } else {
        clearDraftBody(storeKey).catch(() => {});
      }
    },
    editDocument(message) {
      const pending = requests.current.get(message.requestId);
      if (!pending) return;
      requests.current.delete(message.requestId);
      pending.resolve(message.html);
    },
  };

  return {
    mode,
    dirty,
    checking,
    saving,
    conflict,
    staleDraft,
    changeMode,
    discard,
    save,
    restoreDraft: () => staleDraft && restoreDraft(staleDraft.bodyHtml),
    keepPublished,
    closeConflict: () => setConflict(null),
    format: (command, value) => send({ type: 'tdoc:editFormat', command, value }),
    frameHandlers,
  };
}
