import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { AppSwitch } from './ui/switch.jsx';
import {
  duplicateDocument,
  getAgentStatus,
  getOnboarding,
  postOnboardingEvent,
  renameDocument,
  setDocumentStar,
} from './document/api.js';
import { CommentComposer } from './document/comment-composer.jsx';
import {
  DesktopCommentLayer,
  MobileCommentDrawer,
} from './document/comment-layer.jsx';
import {
  MentionReachDialog,
  MessageDialog,
  PublishDialog,
  ShareDialog,
} from './document/document-dialogs.jsx';
import {
  DocumentBreadcrumbs,
  DocumentOverflowActions,
  DocumentPrimaryAction,
  DocumentSendAgentAction,
  LandingActions,
} from './document/document-toolbar.jsx';
import {
  DocumentModeControl,
  EditorToolbar,
  LinkDialog,
  SaveConflictDialog,
  SaveNoticeDialog,
  StaleDraftDialog,
  saveNoticeDismissed,
} from './document/editor-toolbar.jsx';
import {
  DeleteDocumentDialog,
  OwnerAccessDialog,
} from './document/owner-access-dialog.jsx';
import { copyText, layoutPins, TOP_BAR_HEIGHT } from './document/model.js';
import { readStored } from './safe-storage.js';
import { useComments } from './hooks/use-comments.js';
import { useMentionable } from './hooks/use-mentionable.js';
import { useFrameBridge } from './hooks/use-frame-bridge.js';
import { useDocumentEditor } from './hooks/use-document-editor.js';
import { SignInDialog } from './sign-in-dialog.jsx';
import { handoffLine, selectContents } from './onboarding-copy.js';
import { DocStepHint, docStep, STEP_HINT_HEIGHT } from './document/step-hint.jsx';
import { parseDiagramScene } from './document/excalidraw-scene.mjs';
import { DiagramDialog } from './document/diagram-dialog.jsx';
import { NotifyHandoffPanel, sendOneCommentToAgent, useNotifyTargets } from './document/notify-handoff.jsx';
import { HandoffBanner } from './document/handoff-banner.jsx';
import { DebugBar } from './debug-bar.jsx';

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 700);

  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < 700);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('tdoc-narrow', narrow);
  }, [narrow]);

  return narrow;
}

function DocumentFooter({ visible }) {
  return (
    <footer className={`tdoc-footer${visible ? ' tdoc-footer-show' : ''}`}>
      <div className="tdoc-footer-row">
        <a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noreferrer">
          github.com/tornado-doc/tdoc
        </a>
        <span className="sep">·</span>
        <span>
          built with{' '}
          <a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noreferrer">
            tdoc
          </a>
        </span>
      </div>
    </footer>
  );
}

function ReanchorBanner({ commentId, onRemove, onCancel }) {
  if (!commentId) return null;
  return (
    <div className="tdoc-reanchor-banner">
      <span className="label">Select text to move anchor</span>
      <button type="button" id="tdoc-reanchor-remove" onClick={onRemove}>Remove anchor</button>
      <button type="button" id="tdoc-reanchor-cancel" className="danger" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function OldVersionNotice({ value }) {
  if (!value) return null;
  return (
    <div className="tdoc-oldver-slot">
      <div className="tdoc-oldver-strip tdoc-oldver-visible">
        <span>
          You're viewing v{value.current} - the latest is{' '}
          <a href={value.latestUrl}>v{value.latest}</a>
        </span>
      </div>
    </div>
  );
}

// Whether resolved threads are shown, per browser. Not per document: a reader
// who wants the margin quiet wants it quiet everywhere.
const RESOLVED_KEY = 'tdoc-show-resolved';

// Bridge 2. The only instruction in the journey: the line the owner pastes
// into their agent after leaving a comment. What follows is read off the
// server — the agent pulling the comments, then publishing — so the card can
// say "your agent is reading this" because it is, not because a timer ran.
const HANDOFF_POLL_MS = 3000;
// Whether the block is open. The onboarding doc opens it; anywhere else the
// reader's last choice holds.
const HANDOFF_OPEN_KEY = 'tdoc-handoff-open';
// Past this the wait reads as stuck, and the line asks the one question that
// resolves it.
const HANDOFF_STUCK_MS = 5 * 60 * 1000;
// The exit. On a revised doc, until the person has copied the link. Says
// what just happened and what to do with it; nothing a stranger has to decode.
const exitLine = (answered, version) => (
  // An agent that published a version without resolving anything leaves this
  // at zero, and "answered 0 comments" reads as a report that the product
  // failed. The version is still real and still worth sending; say that.
  answered
    ? `Answered ${answered} ${answered === 1 ? 'comment' : 'comments'} in v${version}. Share it.`
    : `v${version} published. Share it.`
);

export function DocumentShell({ boot, config }) {
  const narrow = useNarrowViewport();
  const reanchorRef = useRef(null);
  const bridgeRef = useRef(null);
  const editorRef = useRef(null);
  const diagramApplyRef = useRef(null);
  const [diagram, setDiagram] = useState(null);
  const [composer, setComposer] = useState(null);
  const [openCommentId, setOpenCommentId] = useState(null);
  const [openClusterKey, setOpenClusterKey] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reanchorId, setReanchorId] = useState(null);
  const [saveNoticeOpen, setSaveNoticeOpen] = useState(false);
  // The bar's copy of the name, so a rename shows immediately instead of
  // waiting for a reload. The boot config stays the source it starts from.
  const [title, setTitle] = useState(config.title || '');
  const [dialog, setDialog] = useState(null);
  // Connected-App notify panel (doc-level send). Separate from onboarding
  // copy-paste handoff below.
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyCommentIds, setNotifyCommentIds] = useState(null);
  const [sendToAgentBusy, setSendToAgentBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // setToast('done') for confirmations; setToast('...', true) for failures,
  // which are painted in the danger tone and stay long enough to read.
  const showToast = useCallback((text, error = false) => setToast({ text, error }), []);
  const [theme, setTheme] = useState(() => (
    readStored('tdoc-theme') === 'dark' ? 'dark' : 'light'
  ));
  const [starred, setStarred] = useState(Boolean(config.viewerStar?.starred));
  const [signInOpen, setSignInOpen] = useState(false);
  const [deepTarget, setDeepTarget] = useState(() => (
    new URLSearchParams(location.search).get('comment')
  ));
  // Two arrivals the journey makes on its own: the first doc (`welcome`) and
  // a version the agent just published (`revised`). Read once and taken off
  // the URL, so a reload is an ordinary visit.
  const [arrival] = useState(() => {
    const params = new URLSearchParams(location.search);
    // `step` is the checklist arriving: a row on My docs sends people here, and
    // the page opens whatever that row is about instead of leaving them on a
    // wall of text to work it out. `revised` is the shell's own: it navigates
    // here when it sees the agent publish. (`welcome` went with the wizard --
    // nothing has produced it since the landing pop-up stopped opening.)
    const step = params.get('step');
    const kind = params.get('revised') ? 'revised'
      : step === 'comment' || step === 'fix' ? step : null;
    if (kind) {
      params.delete('revised');
      params.delete('step');
      const rest = params.toString();
      try { history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); } catch {}
    }
    return kind;
  });
  // Resolved threads leave the margin. The choice is the reader's and is
  // remembered per browser; storage that throws (private mode) simply means
  // the margin starts quiet again next visit.
  const [showResolved, setShowResolved] = useState(() => {
    if (new URLSearchParams(location.search).get('revised')) return true;
    try { return localStorage.getItem(RESOLVED_KEY) === '1'; } catch { return false; }
  });
  const toggleResolved = useCallback(() => {
    setShowResolved((on) => {
      const next = !on;
      try { localStorage.setItem(RESOLVED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // `returnTo` lets a caller land the person somewhere specific after the
  // sign-in — the onboarding door they chose — instead of back where they were.
  const signIn = useCallback((returnTo) => {
    const returnUrl = typeof returnTo === 'string' && returnTo.startsWith('/')
      ? returnTo
      : location.pathname + location.search + location.hash;
    // One door: the provider seat first (every method lives in its modal),
    // the first-party GitHub redirect only where the seat is absent, the
    // device-code dialog only where neither is configured.
    if (config.oidcAuth) {
      location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnUrl)}`;
      return undefined;
    }
    if (config.webAuth) {
      location.href = `/api/auth/web/login?return=${encodeURIComponent(returnUrl)}`;
      return undefined;
    }
    setSignInOpen(true);
    return undefined;
  }, [config.oidcAuth, config.webAuth]);

  const completeSignIn = useCallback(() => {
    location.reload();
  }, []);

  const comments = useComments({
    slug: config.slug,
    version: config.version,
    onUnauthorized: signIn,
    demo: !!config.demoComments,
    identity: config.identity,
  });

  const [invited, setInvited] = useState(null);

  // The journey record, for a signed-in reader on a doc of their own: it says
  // whether the exit line is still owed. Nothing is read for a visitor.
  const [onboardingRecord, setOnboardingRecord] = useState(null);
  useEffect(() => {
    if (!config.identity) return;
    getOnboarding()
      .then((result) => setOnboardingRecord(result?.record || null))
      .catch(() => {});
  }, [config.identity]);

  // The two arrivals the journey makes on its own. Both open the card the
  // person should be looking at, and say in one line what just happened.
  const arrivedRef = useRef(false);
  useEffect(() => {
    if (!arrival || arrivedRef.current || comments.loading) return;
    arrivedRef.current = true;
    const list = comments.comments;
    if (arrival === 'revised') {
      // Their own answered thread first — that is the reply they are waiting
      // for — then whatever else the agent resolved.
      const mine = config.identity?.login || '';
      const resolved = list.find((c) => c.status === 'applied' && mine && c.author?.login === mine)
        || list.find((c) => c.status === 'applied');
      if (resolved) setOpenCommentId(resolved.id);
      const n = list.filter((c) => c.status === 'applied').length;
      showToast(n
        ? `Your agent answered ${n} ${n === 1 ? 'comment' : 'comments'} and published v${config.version}.`
        : `Your agent published v${config.version}.`);
    }
  }, [arrival, comments.loading, comments.comments, config.identity, config.title, config.version, showToast]);

  // Bridge 2 state lives on the doc, not on a card: one paste covers every
  // comment, and the card that shows it can close and reopen.
  // The wait survives a reload. It used to be component state only, so
  // somebody who pasted the line and then refreshed was told to do it again --
  // the polling never re-armed and the card's own status line vanished. The
  // copy is a gesture this browser saw, so this browser is where it is
  // remembered; the poll below clears it when the version it is waiting for
  // arrives.
  const handoffKey = `tdoc.handoff.${config.slug}`;
  const [handoff, setHandoff] = useState(() => {
    try {
      const at = Number(localStorage.getItem(handoffKey));
      if (at > 0) return { state: 'waiting', copiedAt: at };
    } catch {}
    return { state: 'idle', copiedAt: null };
  });
  // Only on the latest version: a handoff on v1 while v2 exists asks for work
  // the agent already did.
  const latestVersion = Math.max(...(config.versions || []).map((v) => Number(v.n) || 0), Number(config.version) || 0);
  const handoffEnabled = Boolean(config.isOwner && !config.isLanding && Number(config.version) === latestVersion);
  // The line carries the doc's own address, so the agent knows which doc's
  // comments to read without being told; the bare instruction sent it
  // guessing between every doc on the machine.
  const handoffText = handoffLine(`${location.origin}/d/${encodeURIComponent(config.slug)}`);
  const [handoffPref, setHandoffPref] = useState(() => {
    try { return localStorage.getItem(HANDOFF_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [handoffTouched, setHandoffTouched] = useState(false);
  // The journey's own doc, until its exit: the block stays open there so the
  // first handoff is never behind a chevron.
  const onboardingDoc = Boolean(onboardingRecord?.first_doc && onboardingRecord.first_doc === config.slug && !onboardingRecord.shared);
  const handoffOpen = handoffTouched ? handoffPref : (onboardingDoc || handoffPref);
  const handoffToggle = useCallback(() => {
    const next = !handoffOpen;
    setHandoffTouched(true);
    setHandoffPref(next);
    try { localStorage.setItem(HANDOFF_OPEN_KEY, next ? '1' : '0'); } catch {}
  }, [handoffOpen]);
  const handoffCopy = useCallback(async () => {
    const ok = await copyText(handoffText);
    // A refused clipboard is not a dead end: the line is left selected for a
    // manual copy, the card says so, and the wait starts anyway — the person
    // may well paste it by hand.
    if (!ok) {
      // The line has to be visible to be selected: open the block first, then
      // select once it has rendered.
      setHandoffTouched(true);
      setHandoffPref(true);
      requestAnimationFrame(() => selectContents(document.querySelector('.tdoc-handoff-line code')));
    }
    const copiedAt = Date.now();
    try { localStorage.setItem(handoffKey, String(copiedAt)); } catch {}
    setHandoff({ state: 'waiting', copiedAt, copyFailed: !ok });
    postOnboardingEvent('fix_copy_clicked', config.slug).catch(() => {});
  }, [config.slug, handoffText]);

  const mentionable = useMentionable(
    config.slug,
    Boolean(config.identity?.login) && !config.demoComments,
    comments.comments.length,
    { demo: !!config.demoComments },
  );

  const selectFromFrame = useCallback((selection) => {
    const reanchoring = reanchorRef.current;
    if (reanchoring) {
      // Leave re-anchor mode before the request, as the pre-React shell did:
      // a second selection while the PATCH is in flight must not move the
      // anchor a second time.
      reanchorRef.current = null;
      setReanchorId(null);
      setOpenCommentId(null);
      comments.moveAnchor(reanchoring, selection)
        // `send` is stable, so reading it off the current bridge is safe here.
        // Clear the pending selection either way: on failure the anchor stays
        // put, and leaving the selection painted looks like a second anchor.
        .catch((error) => showToast(error.message || 'Could not move anchor', true))
        .finally(() => bridgeRef.current?.({ type: 'tdoc:clearPending' }));
      return;
    }
    setComposer(selection);
  }, [comments.moveAnchor]);

  const bridge = useFrameBridge({
    'tdoc:selection': selectFromFrame,
    'tdoc:diagramApplied': (message) => {
      const pending = diagramApplyRef.current;
      if (!pending || pending.id !== message.requestId) return;
      clearTimeout(pending.timer);
      diagramApplyRef.current = null;
      if (message.ok) pending.resolve();
      else pending.reject(new Error('The diagram could not be applied. Your edits are still in the editor.'));
    },
    'tdoc:diagramOpen': (message) => {
      try {
        if (typeof message.json !== 'string' || message.json.length > 2_000_000) throw new Error();
        const scene = parseDiagramScene(message.json);
        setDiagram({ id: message.id, title: message.title, scene });
      } catch (error) { showToast(error.message || 'This diagram has invalid source data', true); }
    },
    'tdoc:cleared': () => {
      if (!document.querySelector('.tdoc-popup textarea:focus')) setComposer(null);
      setOpenCommentId(null);
      setOpenClusterKey(null);
    },
    'tdoc:ready': (message) => {
      const storedTheme = readStored('tdoc-theme');
      const nextTheme = storedTheme || (message.defaultTheme === 'dark' ? 'dark' : 'light');
      setTheme(nextTheme);
      bridge.send({ type: 'tdoc:theme', theme: nextTheme });
      bridge.send({ type: 'tdoc:mode', mode: editorRef.current?.mode || 'read', elementComment: !config.isLanding });
      comments.refresh();
    },
    'tdoc:editState': (message) => editorRef.current?.frameHandlers.editState(message),
    'tdoc:editBaseline': (message) => editorRef.current?.frameHandlers.editBaseline(message),
    'tdoc:editDraft': (message) => editorRef.current?.frameHandlers.editDraft(message),
    'tdoc:editSnapshot': (message) => editorRef.current?.frameHandlers.editSnapshot(message),
    'tdoc:editDocument': (message) => editorRef.current?.frameHandlers.editDocument(message),
    'tdoc:copyText': (message) => copyText(message.text || ''),
    'tdoc:docMarkdown': (message) => {
      copyText(message.markdown || '').then((copied) => {
        showToast(copied ? 'Copied as Markdown' : 'Copy failed', !copied);
      });
    },
    'tdoc:anchorClick': (message) => {
      if (!message.id) return;
      setOpenCommentId(message.id);
      setOpenClusterKey(null);
      if (narrow) setDrawerOpen(true);
    },
    'tdoc:navigate': (message) => {
      const href = String(message.href || '');
      if (!/^https?:\/\//i.test(href) && !/^\/(?!\/)/.test(href)) return;
      if (config.onboarding && href === '/start' && !message.blank) {
        // Connected already — an agent on this account has a token — means the
        // gate has nothing to ask, so it is not shown. Everyone else starts
        // there, signed in or not; /setup handles the sign-in itself.
        const done = Boolean(onboardingRecord?.agent_connected || onboardingRecord?.published_first);
        location.href = config.identity && done ? '/me' : '/setup';
        return;
      }
      if (message.blank) window.open(href, '_blank', 'noopener');
      else location.href = href;
    },
  });

  const disableCommentSelection = useCallback(() => {
    setComposer(null);
    bridge.send({ type: 'tdoc:clearPending' });
  }, [bridge.send]);

  const editor = useDocumentEditor({
    boot,
    config,
    frameRef: bridge.frameRef,
    send: bridge.send,
    showToast,
    onDisableCommentSelection: disableCommentSelection,
  });
  editorRef.current = editor;

  // The frame decides whether a click dismisses or acts, so it has to know when
  // the shell has something open. While it does, the next click anywhere in the
  // document only closes it — no hit-testing, no opening the comment underneath.
  useEffect(() => {
    // Re-anchoring is the exception: the card stays open precisely so the author
    // can click the new spot, and treating that click as a dismissal ate it.
    const open = Boolean((openCommentId || openClusterKey || composer) && !reanchorId);
    bridge.send({ type: 'tdoc:uiOpen', open });
  }, [bridge.send, composer, openClusterKey, openCommentId, reanchorId]);

  const focusComment = useCallback((id, { scroll = false, closeDrawer = false } = {}) => {
    setOpenCommentId(id);
    setOpenClusterKey(null);
    if (closeDrawer) setDrawerOpen(false);
    bridge.send({ type: 'tdoc:focusAnchor', id, scroll });
  }, [bridge.send]);

  // Everything, always: an id has to resolve to its comment even when that
  // comment is hidden, or a deep link would open nothing.
  const commentsById = useMemo(
    () => new Map(comments.comments.map((comment) => [comment.id, comment])),
    [comments.comments],
  );
  const resolvedCount = useMemo(
    () => comments.comments.filter((comment) => comment.status === 'applied').length,
    [comments.comments],
  );
  // What the margin shows. A resolved thread is out of the way until asked for
  // — except the one being looked at. A deep link opens its card before
  // deepTarget is consumed, so without the openCommentId clause the card would
  // sit there with no pin under it the moment the target cleared.
  const shownComments = useMemo(() => (
    showResolved
      ? comments.comments
      : comments.comments.filter((comment) => (
        comment.status !== 'applied'
        || comment.id === openCommentId
        || comment.id === deepTarget
        || comment.replies?.some((reply) => reply.id === deepTarget)
      ))
  ), [comments.comments, deepTarget, openCommentId, showResolved]);
  // Lost pins are seats, not anchors: they give the card somewhere to be drawn
  // while it still reads — and styles — as unanchored, with the way back.
  const pinIds = useMemo(
    () => new Set(bridge.layout.pins.filter((pin) => !pin.lost).map((pin) => pin.id)),
    [bridge.layout.pins],
  );
  const clusters = useMemo(
    () => layoutPins(bridge.layout.pins, bridge.layout.docHeight),
    [bridge.layout.docHeight, bridge.layout.pins],
  );

  // Every thread goes to the frame. The ones the margin is not showing —
  // resolved, with the switch off — go flagged `hidden`: no pin, a lighter
  // mark on their sentence, and a click on it opens the thread (the open
  // card is always shown, whatever the switch says).
  const anchorsForFrame = useMemo(() => {
    const shown = new Set(shownComments.map((comment) => comment.id));
    return comments.comments.map((comment) => (shown.has(comment.id) ? comment : { ...comment, hidden: true }));
  }, [comments.comments, shownComments]);
  useEffect(() => {
    bridge.send({ type: 'tdoc:anchors', comments: anchorsForFrame });
    if (!comments.loading) document.body.dataset.tdocReady = '1';
  }, [bridge.send, anchorsForFrame, comments.loading]);

  useEffect(() => {
    bridgeRef.current = bridge.send;
  }, [bridge.send]);

  useEffect(() => {
    reanchorRef.current = reanchorId;
    document.body.classList.toggle('tdoc-reanchoring', Boolean(reanchorId));
  }, [reanchorId]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 5000 : 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!deepTarget || !comments.comments.length) return;
    const root = comments.comments.find((comment) => (
      comment.id === deepTarget
      || comment.replies?.some((reply) => reply.id === deepTarget)
    ));
    if (!root) {
      setDeepTarget(null);
      return;
    }
    if (narrow) {
      bridge.send({ type: 'tdoc:focusAnchor', id: root.id, scroll: true });
      setDrawerOpen(true);
      setOpenCommentId(root.id);
      setDeepTarget(null);
      return;
    }

    const cluster = clusters.find((item) => (
      item.items.some(({ comment }) => comment.id === root.id)
    ));
    if (!cluster) {
      // The comment exists but its anchor no longer resolves, so there is no
      // pin in the document to scroll to. Open it as a floating card anyway —
      // DesktopCommentLayer already renders an unanchored card, and it offers
      // re-anchoring from there. Returning instead leaves the link doing
      // nothing at all: no card, no scroll, and `?comment=` still in the URL.
      setOpenCommentId(root.id);
      setDeepTarget(null);
      return;
    }
    const top = TOP_BAR_HEIGHT + cluster.y - bridge.layout.scrollY;
    if (top < TOP_BAR_HEIGHT + 20 || top > window.innerHeight - 60) {
      bridge.send({
        type: 'tdoc:scrollTo',
        docY: Math.max(0, Math.round(cluster.y - window.innerHeight / 3)),
      });
      return;
    }
    setOpenCommentId(root.id);
    setDeepTarget(null);
  }, [bridge.layout.scrollY, bridge.send, clusters, comments.comments, deepTarget, narrow]);

  // Save explains itself the first time, then gets out of the way for good if
  // the author asked it to.
  const requestSave = () => {
    if (saveNoticeDismissed()) {
      editor.save();
      return;
    }
    setSaveNoticeOpen(true);
  };

  const closeComposer = () => {
    setComposer(null);
    bridge.send({ type: 'tdoc:clearPending' });
  };

  // Every comment mutation that reaches the UI goes through here: a 401 has
  // already been turned into the sign-in flow by useComments, anything else
  // becomes a toast instead of an unhandled rejection. Returns whether the
  // mutation succeeded so callers can keep the composer/reply text on failure.
  const attempt = async (operation) => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      showToast(error.message || 'Request failed', true);
      return { ok: false };
    }
  };

  // What the server did with each @mention. An invite is only half done — the
  // named person has no way of hearing about it until someone sends them the
  // link — so it opens a dialog rather than a toast that scrolls away. A
  // blocked name has to be said out loud too, or it fails silently as plain
  // text the author believes was delivered.
  const reportMentions = (value) => {
    const outcome = value?.mention_outcome;
    if (!outcome) return;
    // Anyone new to this doc — invited onto a private one, or simply named on
    // a public one — is someone the author may still have to reach by hand.
    if (outcome.newcomers?.length) {
      setInvited(outcome.newcomers);
      return;
    }
    if (outcome.blocked?.length) {
      const names = outcome.blocked.map((login) => `@${login}`).join(', ');
      showToast(`${names} can't open this doc — ask the owner to invite them`, true);
    }
  };

  // Their own first words on the journey's doc are a step, and the server
  // stamps it on the way through. Moving it here too is what keeps the row
  // above the document honest between now and the next page load, which is the
  // whole time somebody is looking at what they just wrote.
  const markCommented = () => {
    if (!config.isOwner) return;
    setOnboardingRecord((current) => (
      current && current.started && current.first_doc === config.slug && !current.commented
        ? { ...current, commented: new Date().toISOString() }
        : current
    ));
  };

  const postComment = async (text, opts = {}) => {
    const { ok, value } = await attempt(() => comments.addComment(composer, text));
    if (!ok) return;
    markCommented();
    closeComposer();
    reportMentions(value);
    // The new card opens: it is where the next instruction lives.
    if (value?.id) setOpenCommentId(value.id);
    if (opts.sendToAgent && value?.id && canSendToAgent) {
      setSendToAgentBusy(true);
      try {
        const body = await sendOneCommentToAgent(config.slug, value.id);
        const failed = body?.delivery?.status === 'failed';
        showToast(failed
          ? `Sent — not delivered${body.delivery?.error ? `: ${body.delivery.error}` : ''}`
          : 'Sent to agent');
        await comments.refresh();
      } catch (err) {
        showToast(err.message || 'Comment posted — could not send to agent');
      } finally {
        setSendToAgentBusy(false);
      }
    }
  };

  const replyTo = async (parentId, text) => {
    const { ok, value } = await attempt(() => comments.addReply(parentId, text));
    if (ok) { markCommented(); reportMentions(value); }
    return ok;
  };

  // An edit does not re-resolve @mentions: the notified set is stamped on the
  // event that first carried the text, and nobody is notified twice for a
  // rewrite of words they were already told about.
  const editComment = async (id, text) => (await attempt(() => comments.edit(id, text))).ok;

  const reactTo = (commentId, emoji) => attempt(() => comments.react(commentId, emoji));
  // Resolving takes the thread out of the margin, so the card that owns the
  // button goes with it — close it rather than leaving a card pinned to
  // nothing.
  const resolveComment = async (commentId, resolved) => {
    if (!await attempt(() => comments.setResolved(commentId, resolved))) return;
    if (resolved && !showResolved) setOpenCommentId(null);
  };

  // Closing the card was unconditional, which hid the two cases where there is
  // still something to look at: deleting a comment that holds replies leaves a
  // tombstone with the thread under it (#354), and deleting a reply never
  // touched the comment it hung from at all. Either way the card vanished and
  // took the surviving conversation off screen — a delete that looked like it
  // had removed far more than it did. It closes only when the comment the card
  // is showing is really gone.
  const removeComment = async (id) => {
    const { ok } = await attempt(() => comments.remove(id));
    if (!ok) return;
    // Not the mutation's own response — that is `{ ok: true }` either way.
    // The refreshed list is what says whether this card still has anything on
    // it. (comments.comments is the pre-refresh render's state here.)
    if (!comments.latest.current.some((c) => c.id === openCommentId)) setOpenCommentId(null);
  };

  const notifyEnabled = Boolean(config.isOwner && !config.isLanding && config.mode !== 'local');
  const notifyTargets = useNotifyTargets(config.slug, notifyEnabled);
  const canSendToAgent = Boolean(
    notifyEnabled
    && notifyTargets.ready
    && notifyTargets.available
    && notifyTargets.reason !== 'no_agent_bound'
    && (notifyTargets.default || (notifyTargets.candidates || []).length || notifyTargets.fallback),
  );
  const openNotifyPanel = (ids) => {
    setNotifyCommentIds(ids);
    setNotifyOpen(true);
  };
  const openDocNotify = () => {
    const openIds = shownComments
      .filter((c) => c.status !== 'applied' && !c.deleted)
      .map((c) => c.id);
    openNotifyPanel(openIds);
  };
  const removeAnchor = async () => {
    if (!(await attempt(() => comments.moveAnchor(reanchorId, { kind: 'none' }))).ok) return;
    setReanchorId(null);
    setOpenCommentId(null);
  };

  // Optimistic: the name in the bar changes as you commit it and rolls back if
  // the server refuses, because a rename that appears to work and silently did
  // not is worse than a slow one.
  const renameDoc = async (next) => {
    const previous = title;
    setTitle(next);
    document.title = next;
    try {
      await renameDocument(config.slug, next);
    } catch (error) {
      setTitle(previous);
      document.title = previous;
      showToast(error.message || 'Could not rename', true);
    }
  };

  const toggleStar = async () => {
    const next = !starred;
    setStarred(next);
    try {
      await setDocumentStar(config.slug, next);
      showToast(next ? 'Starred - find it in My docs' : 'Star removed');
    } catch {
      setStarred(!next);
    }
  };

  const duplicate = async () => {
    try {
      const result = await duplicateDocument(config.slug, config.version);
      if (result.url) location.href = result.url;
    } catch (error) {
      if (error.status === 401) {
        signIn();
        return;
      }
      setDialog({
        type: 'message',
        title: 'Could not duplicate',
        message: error.message,
      });
    }
  };

  const download = () => {
    const anchor = document.createElement('a');
    anchor.href = `/d/${encodeURIComponent(config.slug)}/v/${config.version}/export?download=1`;
    anchor.download = `${config.slug}-v${config.version}.html`;
    anchor.click();
  };

  const printPdf = () => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = `/d/${encodeURIComponent(config.slug)}/v/${config.version}/export?download=0`;
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      window.setTimeout(() => frame.remove(), 1_000);
    };
    document.body.appendChild(frame);
  };

  const shareUrl = config.isLanding
    ? `${location.origin}/`
    : `${location.origin}/d/${encodeURIComponent(config.slug)}/v/${config.version}`;

  // While the owner waits on their agent, ask the server every few seconds
  // what it has done: read the comments (the card flips to "reading"), then
  // published (the page moves to the new version). There is no "replied"
  // step between them: the agent answers thread by thread and publishes
  // seconds later, and a doc-level stamp lit "Replied ✓" on a thread it had
  // not answered yet. A reply without a new version (a question) shows up in
  // the thread itself on the next refresh. Stops on its own past
  // HANDOFF_STUCK_MS.
  const commentsRefresh = comments.refresh;
  useEffect(() => {
    if (!['waiting', 'reading'].includes(handoff.state)) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const status = await getAgentStatus(config.slug);
        if (cancelled) return;
        const latest = Number(status?.latest_version) || 0;
        if (latest > Number(config.version)) {
          // The thing it was waiting for arrived; the wait should not outlive
          // it into the next page.
          try { localStorage.removeItem(handoffKey); } catch {}
          location.href = `/d/${encodeURIComponent(config.slug)}/v/${latest}?revised=1`;
          return;
        }
        const readAt = status?.read_at ? new Date(status.read_at).getTime() : 0;
        if (readAt && readAt >= handoff.copiedAt - 5000) {
          setHandoff((current) => (current.state === 'waiting' ? { ...current, state: 'reading' } : current));
        }
        await commentsRefresh();
      } catch {}
      if (cancelled) return;
      if (Date.now() - handoff.copiedAt > HANDOFF_STUCK_MS) {
        setHandoff((current) => ({ ...current, state: 'stuck' }));
        postOnboardingEvent('timeout_shown', config.slug).catch(() => {});
        return;
      }
      timer = window.setTimeout(tick, HANDOFF_POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [handoff.state, handoff.copiedAt, config.slug, config.version, commentsRefresh]);

  // Connected-App handoffs: while any comment is still `sent`, refresh so the
  // waiting tags and banner catch agent replies / resolve without a manual reload.
  // No outstanding sent → no requests. Hidden tab → pause. Back off when quiet.
  const outstandingHandoffs = useMemo(
    () => comments.comments.some((c) => c && !c.deleted && c.handoff_status === 'sent'),
    [comments.comments],
  );
  const commentsRef = useRef(comments.comments);
  commentsRef.current = comments.comments;
  useEffect(() => {
    if (!outstandingHandoffs || !notifyEnabled) return undefined;
    let cancelled = false;
    let timer = null;
    let delay = 8000;
    let unchanged = 0;
    let lastFingerprint = '';
    const fingerprint = () => (commentsRef.current || [])
      .filter((c) => c && c.handoff_status === 'sent')
      .map((c) => `${c.id}:${c.handoff_at || ''}:${(c.replies || []).length}`)
      .sort()
      .join('|');
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = window.setTimeout(tick, delay);
        return;
      }
      try {
        await commentsRefresh();
      } catch { /* next tick */ }
      if (cancelled) return;
      const next = fingerprint();
      if (next === lastFingerprint) {
        unchanged += 1;
        delay = Math.min(8000 * (2 ** Math.min(unchanged, 3)), 60000);
      } else {
        unchanged = 0;
        delay = 8000;
        lastFingerprint = next;
      }
      timer = window.setTimeout(tick, delay);
    };
    lastFingerprint = fingerprint();
    timer = window.setTimeout(tick, delay);
    const onVis = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      unchanged = 0;
      delay = 8000;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, 500);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [outstandingHandoffs, notifyEnabled, commentsRefresh]);

  const answered = comments.comments.filter((c) => c.status === 'applied').length;
  // Copied in this session: the banner stays, as the confirmation, so the
  // frame does not jump and the pins and the open card stay where they are.
  const [sharedNow, setSharedNow] = useState(false);
  // Set by the hint itself -- only it knows whether it drew.
  const [hintBar, setHintBar] = useState(false);
  // On the journey's own doc, and nowhere else. This never checked the slug,
  // so the tutorial's closing banner appeared over ANY document the account
  // owned that had reached v2 -- announcing "your agent answered N comments in
  // v2" on a page that had nothing to do with onboarding, to an owner with no
  // idea what it was talking about. Same leak as the checklist row and the
  // handoff block: onboarding furniture standing on somebody's real work.
  const showExitBanner = Boolean(
    handoffEnabled && Number(config.version) >= 2
    && onboardingRecord && onboardingRecord.started
    && onboardingRecord.first_doc === config.slug
    && (!onboardingRecord.shared || sharedNow),
  );
  const exitBannerRef = useRef(null);
  const [exitBannerHeight, setExitBannerHeight] = useState(36);
  useLayoutEffect(() => {
    const banner = exitBannerRef.current;
    if (!showExitBanner || !banner) return undefined;
    // Wrapped tutorial copy needs breathing room; pins follow its actual height.
    const measure = () => setExitBannerHeight(banner.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => observer.disconnect();
  }, [showExitBanner]);
  // The owner's own first words are the gesture — a comment of their own, or
  // the reply the seeded card asks for. The handoff appears once they exist,
  // not on an untouched seeded card.
  const me = config.identity?.login || '';
  // The thread the owner has said something in -- their own comment, or the
  // reply the seeded card asks for. One lookup, because three things need the
  // same one: whether they have spoken at all, which card carries the line for
  // the agent, and which card the row above the document opens.
  const myThread = me
    ? comments.comments.find((c) => (
      c.author?.login === me || (c.replies || []).some((r) => r.author?.login === me)
    ))
    : null;
  const ownerCommented = Boolean(myThread);
  // Whether the line for the agent is on this page at all. Three conditions,
  // and it used to have one: the owner has to have spoken (it belongs under
  // their words, not under the seeded card that is still asking for them),
  // this has to be the latest version, and this has to be the onboarding doc
  // with the loop still open. Without that last one every comment the owner
  // ever wrote, on every doc they own, carried a copyable instruction for an
  // agent -- a teaching aid that never stopped teaching.
  // `!revised`, not just `onboardingDoc`. The loop closing is what ends the
  // tutorial -- it is what `docStep` reads to stop drawing the row, and what
  // empties the checklist. `onboardingDoc` ends on `shared` instead, which is
  // stamped by copying the exit link, and the exit banner that asks for that
  // only renders from v2: on a doc that never reached v2 nothing ever stamped
  // it, so the box sat on their comment for ever with no tutorial around it.
  const tutorialOpen = onboardingDoc && !onboardingRecord?.revised;
  const handoffOnPage = handoffEnabled && ownerCommented && tutorialOpen;
  // The one row of the checklist that belongs to this doc. It names something
  // already on the page, so going there is opening the card that carries it:
  // the seeded comment asks for the highlight, and their own card carries the
  // line for the agent. The record says which step; `handoffOnPage` says
  // whether the page can honour it, because a row naming a line that is not
  // here is the one thing this row promised never to do.
  const hintStep = docStep(onboardingRecord, config.slug, handoffOnPage);
  // What `goToStep` would open, if anything. The comment step opens tdoc's
  // seeded card, and a CLI-first publisher has none -- seeding is reserved for
  // somebody who came through /setup, on purpose.
  const stepHasSomewhereToGo = hintStep === 'comment'
    ? comments.comments.some((c) => c.author?.login === 'tdoc')
    : Boolean(myThread);

  const goToStep = useCallback((want) => {
    const list = comments.comments;
    const going = want || hintStep;
    if (going === 'comment') {
      const seed = list.find((c) => c.author?.login === 'tdoc');
      if (seed) setOpenCommentId(seed.id);
      return;
    }
    if (myThread) setOpenCommentId(myThread.id);
    // The line is the point of the trip, so it is open when they arrive.
    setHandoffTouched(true);
    setHandoffPref(true);
    try { localStorage.setItem(HANDOFF_OPEN_KEY, '1'); } catch {}
  }, [hintStep, comments.comments, myThread]);

  // A row on My docs lands here, so it lands the way the corner row's own click
  // does -- same function, so the two can never drift into two ideas of where
  // that row goes. It is silent: nothing just happened, they clicked a to-do.
  const checklistArrival = useRef(false);
  useEffect(() => {
    if (checklistArrival.current || comments.loading) return;
    if (arrival !== 'comment' && arrival !== 'fix') return;
    checklistArrival.current = true;
    goToStep(arrival === 'fix' ? 'handoff' : 'comment');
  }, [arrival, comments.loading, goToStep]);

  const copyExitLink = async () => {
    if (!await copyText(shareUrl)) { showToast('Could not copy', true); return; }
    setSharedNow(true);
    setOnboardingRecord((current) => ({ ...(current || {}), shared: new Date().toISOString() }));
    postOnboardingEvent('share_link_copied', config.slug).catch(() => {});
  };

  // Every comment card and pin is placed from the top of the document, so
  // anything docked above it moves all of them. STEP_HINT_HEIGHT is the bar's
  // own height in step-hint.css.
  const frameTop = TOP_BAR_HEIGHT + (boot.oldVersion ? 28 : 0) + (showExitBanner ? exitBannerHeight : 0)
    + (hintBar ? STEP_HINT_HEIGHT : 0) + (editor.mode === 'edit' ? 46 : 0);
  const pinLeft = Math.min(
    (bridge.layout.articleRight || window.innerWidth - 44) + 14,
    window.innerWidth - 34,
  );
  const openComment = commentsById.get(openCommentId);
  const openCluster = clusters.find((cluster) => (
    cluster.items.some(({ comment }) => comment.id === openCommentId)
  ));
  const cardPosition = {
    top: openCluster
      ? Math.max(
        frameTop + 4,
        Math.min(
          frameTop + openCluster.y - bridge.layout.scrollY,
          window.innerHeight - 220,
        ),
      )
      : frameTop + 4,
    // 280px card + 12px padding each side + 1px borders, kept 8px off the edge.
    left: Math.max(8, Math.min(pinLeft + 34, window.innerWidth - 306 - 8)),
  };
  // A deep link to a reply (?comment=<reply id>) opens its thread expanded;
  // any other open card starts with replies collapsed, as before.
  const deepReply = Boolean(
    openComment
    && new URLSearchParams(location.search).get('comment')
    && new URLSearchParams(location.search).get('comment') !== openComment.id
  ) || (arrival === 'revised' && Boolean(openComment));

  return (
    <div
      className="tdoc-document-app"
      onPointerDown={() => {
        // Legacy behavior: a click anywhere outside a card, pin, or composer
        // closes the open card and cluster popover (they stop propagation).
        setOpenClusterKey(null);
        setOpenCommentId(null);
      }}
    >
      <TopBar
        identity={config.identity}
        theme={theme}
        actions={config.isLanding ? <LandingActions stars={config.stars} /> : (
          <>
            {/* Resolved threads are out of the margin by default. The switch is
                the way back, in the bar where it can be seen — it folds into
                the ⋯ menu with everything else when the bar runs out of room.
                Absent entirely when nothing is resolved: a control that can
                only do nothing is worse than no control. */}
            {resolvedCount ? (
              <AppSwitch
                id="tdoc-show-resolved"
                checked={showResolved}
                onCheckedChange={toggleResolved}
                label={`Resolved (${resolvedCount})`}
              />
            ) : null}
            <DocumentModeControl
              mode={editor.mode}
              canComment={config.canComment}
              canEdit={config.canEdit}
              signInToComment={Boolean(config.signInToComment)}
              onSignIn={signIn}
              onChange={editor.changeMode}
            />
            {notifyEnabled ? (
              <DocumentSendAgentAction
                count={shownComments.filter((c) => c.status !== 'applied' && !c.deleted).length}
                onClick={openDocNotify}
              />
            ) : null}
            <DocumentPrimaryAction
              config={config}
              onPublish={() => setDialog({ type: 'publish' })}
              onShare={() => setDialog({ type: 'share' })}
            />
          </>
        )}
        overflowActions={config.isLanding ? null : (
          <DocumentOverflowActions
            config={config}
            starred={starred}
            onToggleStar={toggleStar}
            onPublish={() => setDialog({ type: 'publish' })}
            onShare={() => setDialog({ type: 'share' })}
            onCopyMarkdown={() => bridge.send({ type: 'tdoc:copyDoc', requestId: Date.now() })}
            onDuplicate={duplicate}
            onDownload={download}
            onPrint={printPdf}
            onDelete={() => setDialog({ type: 'delete' })}
            resolvedCount={resolvedCount}
            showResolved={showResolved}
            onToggleResolved={toggleResolved}
          />
        )}
        onThemeChange={(nextTheme) => {
          setTheme(nextTheme);
          bridge.send({ type: 'tdoc:theme', theme: nextTheme });
        }}
        onNotificationNavigate={(item, target) => {
          const sameDocument = item.slug === config.slug
            && Number(item.version || 1) === Number(config.version);
          if (!sameDocument) {
            location.href = target;
            return;
          }
          const commentId = item.comment_id || item.thread_id;
          history.replaceState(null, '', target);
          setDeepTarget(commentId);
        }}
        authConfigured={config.authConfigured !== false}
        // The top bar's Sign in on the landing returns into the onboarding:
        // a new account lands on the first screen; one that has finished or
        // skipped is let straight through (the wizard closes itself).
        onSignIn={() => signIn(config.onboarding ? '/setup' : undefined)}
        onSwitchAccount={config.oidcAuth ? () => {
          const returnUrl = location.pathname + location.search + location.hash;
          location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnUrl)}`;
        } : null}
      >
        <DocumentBreadcrumbs
          config={config}
          title={title}
          starred={starred}
          onRename={renameDoc}
          onToggleStar={toggleStar}
        />
      </TopBar>

      <DiagramDialog diagram={diagram} canApply={Boolean(config.canEdit)} onClose={() => setDiagram(null)}
        onApply={async (json, svg) => {
          if (!config.canEdit) return;
          editor.changeMode('edit');
          await new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => { diagramApplyRef.current = null; reject(new Error('The document did not respond. Try again.')); }, 5000);
            diagramApplyRef.current = { id, timer, resolve, reject };
            bridge.send({ type: 'tdoc:diagramApply', requestId: id, id: diagram.id, json, svg });
          });
          setDiagram(null);
          showToast('Diagram applied. Save the document to publish a new version.');
        }} />
      <OldVersionNotice value={boot.oldVersion} />

      {notifyEnabled ? (
        <HandoffBanner
          slug={config.slug}
          comments={comments.comments}
          onOpenPanel={openDocNotify}
          onRefresh={() => comments.refresh()}
          onToast={(text, error) => showToast(text, error)}
        />
      ) : null}

      {showExitBanner ? (
        <div ref={exitBannerRef} className="tdoc-onboard-banner" role="status" onPointerDown={(event) => event.stopPropagation()}>
          <span>{sharedNow ? 'Link copied.' : exitLine(answered, config.version)}</span>
          {sharedNow
            ? <a href="/me">My docs</a>
            : <button type="button" onClick={copyExitLink}>Copy link</button>}
        </div>
      ) : null}

      {/* Under the chrome, over the document, in flow: the step pushes the page
          down rather than floating in the corner the eye reaches last. */}
      {editor.mode === 'edit' ? null : (
        <DocStepHint
          step={hintStep}
          agentState={handoff.state}
          banner={showExitBanner}
          hidden={narrow && drawerOpen}
          justFinished={arrival === 'revised'}
          // Null when `goToStep` would find nothing to open, so the row does
          // not offer a button that goes nowhere.
          onGo={stepHasSomewhereToGo ? () => goToStep() : null}
          onVisible={setHintBar}
        />
      )}

      {editor.mode === 'edit' ? (
        <EditorToolbar
          dirty={editor.dirty}
          checking={editor.checking}
          saving={editor.saving}
          onFormat={(command, value) => {
            if (command === 'createLink') setDialog({ type: 'link' });
            else editor.format(command, value);
          }}
          onDiscard={editor.discard}
          onSave={requestSave}
        />
      ) : null}

      <ReanchorBanner
        commentId={reanchorId}
        onRemove={removeAnchor}
        onCancel={() => setReanchorId(null)}
      />

      {/* `aria-label`, not `title`: a title on an iframe is an accessible name
          AND a native tooltip, and the tooltip sat over the top bar whenever
          the pointer rested on the document. The name is what was wanted. */}
      <iframe
        ref={bridge.frameRef}
        className="tdoc-doc-frame"
        aria-label="Document content"
        sandbox="allow-scripts"
        src={boot.frameSrc}
      />

      {/* The internal bar, for an allow-listed account. It matters most here:
          a new reader starts at the landing page, and a replay pressed at the
          gate skips everything between the two -- the call to action, the
          sign-in, the first sight of the product. */}
      {config.debug ? (
        <DebugBar
          record={onboardingRecord}
          surface={config.isLanding ? 'landing' : 'document'}
          onState={async () => {
            const result = await getOnboarding().catch(() => null);
            setOnboardingRecord(result?.record || null);
          }}
        />
      ) : null}

      <DocumentFooter visible={bridge.layout.footerVisible} />

      {narrow ? (
        <MobileCommentDrawer
          open={drawerOpen}
          // shownComments, not the raw list: hiding resolved threads took the
          // pins out of the document but left every one of them in the drawer,
          // which on a phone IS the comment list. "Hide resolved" appeared to
          // do nothing at all.
          comments={shownComments}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          openCommentId={openCommentId}
          expandReplies={deepReply}
          onOpenChange={setDrawerOpen}
          onReply={replyTo}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={setReanchorId}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
          onNavigate={(id) => focusComment(id, { scroll: true, closeDrawer: true })}
        />
      ) : (
        <DesktopCommentLayer
          clusters={clusters}
          commentsById={commentsById}
          frameScrollY={bridge.layout.scrollY}
          frameTop={frameTop}
          pinLeft={pinLeft}
          openComment={openComment}
          openClusterKey={openClusterKey}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          cardPosition={cardPosition}
          expandReplies={deepReply}
          onOpenComment={(id) => {
            focusComment(id);
          }}
          onOpenCluster={(key) => setOpenClusterKey(
            openClusterKey === key ? null : key
          )}
          onReply={replyTo}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={setReanchorId}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
        />
      )}

      {composer ? (
        <CommentComposer
          selection={composer}
          mentionable={mentionable}
          demo={!!config.demoComments}
          canSendToAgent={canSendToAgent}
          sendToAgentDisabledReason={
            notifyTargets.reason === 'no_agent_bound'
              ? 'No agent is following this doc yet'
              : null
          }
          onSubmit={postComment}
          onClose={closeComposer}
        />
      ) : null}

      <MentionReachDialog
        open={Boolean(invited?.length)}
        newcomers={invited || []}
        url={shareUrl}
        onOpenChange={(open) => !open && setInvited(null)}
        onCopied={() => { setInvited(null); showToast('Link copied'); }}
      />


      {notifyEnabled ? (
        <NotifyHandoffPanel
          slug={config.slug}
          open={notifyOpen}
          commentIds={notifyCommentIds || []}
          onClose={() => setNotifyOpen(false)}
          onSent={async () => { await comments.refresh(); }}
        />
      ) : null}

      <PublishDialog
        open={dialog?.type === 'publish'}
        slug={config.slug}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      {config.ownerManage ? (
        <OwnerAccessDialog
          open={dialog?.type === 'share'}
          config={config}
          url={shareUrl}
          onOpenChange={(open) => !open && setDialog(null)}
          onCopied={() => showToast('Link copied')}
        />
      ) : (
        <ShareDialog
          open={dialog?.type === 'share'}
          url={shareUrl}
          onOpenChange={(open) => !open && setDialog(null)}
          onCopied={() => showToast('Link copied')}
        />
      )}
      <DeleteDocumentDialog
        open={dialog?.type === 'delete'}
        config={config}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <MessageDialog
        message={dialog?.type === 'message' ? dialog : null}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <SaveNoticeDialog
        open={saveNoticeOpen}
        onOpenChange={setSaveNoticeOpen}
        onConfirm={editor.save}
      />
      <SaveConflictDialog conflict={editor.conflict} onClose={editor.closeConflict} />
      <StaleDraftDialog
        draft={editor.staleDraft}
        currentVersion={config.version}
        onRestore={editor.restoreDraft}
        onKeep={editor.keepPublished}
      />
      <LinkDialog
        open={dialog?.type === 'link'}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={(url) => editor.format('createLink', url)}
      />
      <SignInDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onSuccess={completeSignIn}
      />
      {toast ? (
        <div className={`tdoc-shell-toast${toast.error ? ' error' : ''}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
