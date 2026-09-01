import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveDocumentVersion } from '../document/api.js';
import {
  clearDraft,
  draftKey,
  loadDraft,
  saveDraft,
} from '../document/draft-store.js';

export function useDocumentEditor({
  boot,
  config,
  frameRef,
  send,
  showToast,
  onDisableCommentSelection,
}) {
  const requests = useRef(new Map());
  const storeKey = useMemo(() => draftKey(config), [config]);
  // A doc created from scratch arrives at ?edit=1: it is blank, so dropping the
  // author in read mode would show an empty page and hide the one control they
  // need. `tdoc:ready` re-sends whatever mode is current, so the frame picks
  // this up even though it is set before the iframe has loaded.
  const [mode, setMode] = useState(() => {
    const wantsEdit = new URLSearchParams(location.search).get('edit') === '1';
    if (wantsEdit && config.canEdit) return 'edit';
    return config.canComment ? 'comment' : 'read';
  });
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    send({ type: 'tdoc:mode', mode });
    if (mode !== 'edit') return undefined;
    let cancelled = false;
    loadDraft(storeKey).then((draft) => {
      if (!cancelled && draft?.bodyHtml) {
        send({ type: 'tdoc:editRestore', bodyHtml: draft.bodyHtml });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [mode, send, storeKey]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
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
      await clearDraft(storeKey);
      location.href = result.url;
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
    await clearDraft(storeKey);
    setDirty(false);
    setChecking(false);
    if (frameRef.current) frameRef.current.src = boot.frameSrc;
  }, [boot.frameSrc, frameRef, storeKey]);

  const frameHandlers = {
    editState(message) {
      setDirty(Boolean(message.dirty));
      setChecking(Boolean(message.checking));
    },
    editSnapshot(message) {
      if (typeof message.bodyHtml !== 'string') return;
      const nextDirty = Boolean(message.dirty);
      setChecking(false);
      if (nextDirty) saveDraft(storeKey, message.bodyHtml).catch(() => {});
      else clearDraft(storeKey).catch(() => {});
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
    changeMode,
    discard,
    save,
    closeConflict: () => setConflict(null),
    format: (command, value) => send({ type: 'tdoc:editFormat', command, value }),
    frameHandlers,
  };
}
