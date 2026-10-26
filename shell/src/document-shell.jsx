import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deliveryErrorText, resendResultText } from './document/notify-handoff.jsx';
import { TopBar } from './top-bar.jsx';
import { SegmentedControl } from './ui/segmented-control.jsx';
import {
  duplicateDocument,
  getAgentStatus,
  getOnboarding,
  listTeams,
  moveDocsToTeam,
  postOnboardingEvent,
  renameDocument,
  resendNotifyHandoff,
  getAskAllowance,
  handOff,
  publishAsk,
  setDocumentStar,
  acceptTeamInvite,
  requestTeamJoin,
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
  QuotaBumpDialog,
  ShareDialog,
} from './document/document-dialogs.jsx';
import {
  DocumentBreadcrumbs,
  DocumentEdited,
  DocumentOverflowActions,
  DocumentPrimaryAction,
  DocumentSendAgentAction,
  LandingActions,
} from './document/document-toolbar.jsx';
import {
  EditorToolbar,

  DocumentModeControl,
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
import { copyText, isDocumentComment, layoutPins, TOP_BAR_HEIGHT } from './document/model.js';
import { readStored } from './safe-storage.js';
import { isFeatureOn } from './feature-flags.js';
import { useComments } from './hooks/use-comments.js';
import { useMentionable } from './hooks/use-mentionable.js';
import { useFrameBridge } from './hooks/use-frame-bridge.js';
import { useDocumentEditor } from './hooks/use-document-editor.js';
import { SignInDialog } from './sign-in-dialog.jsx';
import { handoffLine, selectContents } from './onboarding-copy.js';
import { DocStepHint, docStep, STEP_HINT_HEIGHT } from './document/step-hint.jsx';
import { parseDiagramScene } from './document/excalidraw-scene.mjs';
import { DiagramDialog } from './document/diagram-dialog.jsx';
import { CONNECT_AGENT_PROMPT, NotifyHandoffPanel, readableHandle, useNotifyTargets } from './document/notify-handoff.jsx';
import { AGENT_TAG_JOINER, agentDisplayName, agentMentionName, orderedAskAiChoices, sameTarget, taggedAgentSpan, targetKey } from './document/agent-choices.js';
import { AgentMentionContext } from './document/mention-field.jsx';
import { HandoffDetailsPanel } from './document/handoff-details.jsx';
import { AskAiPanel } from './document/ask-ai-panel.jsx';
import { useCommentArea } from './document/comment-area.js';
import { VersionDiffView } from './document/version-diff.jsx';
import { MoveToTeamDialog } from './docs-hub/teams.jsx';
import { useMyAgent } from './document/my-agent.js';
import { TDOC_AI, composerAgents, withoutAskTags } from './document/ai-answerer.js';

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
        {value.fresh ? (
          // Published while this page was open: say so, and let the reader
          // move when they are ready instead of reloading under them.
          <span role="status">
            v{value.latest} was just published.{' '}
            <a href={value.latestUrl}>Open v{value.latest}</a>
          </span>
        ) : (
          <span>
            You're viewing v{value.current} - the latest is{' '}
            <a href={value.latestUrl}>v{value.latest}</a>
          </span>
        )}
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
// Live sync while a doc is open (see the effect in DocumentShell).
const LIVE_SYNC_MIN_MS = (typeof window !== "undefined" && window.__TDOC_LIVE_SYNC_MS) || 20000;
const LIVE_SYNC_MAX_MS = 60000;
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
  const [comparing, setComparing] = useState(() => new URLSearchParams(location.search).get('compare') === '1');
  const changeComparison = (next) => {
    if (next === comparing) return;
    const url = new URL(location.href);
    if (next) url.searchParams.set('compare', '1'); else url.searchParams.delete('compare');
    history.pushState(null, '', url);
    setComparing(next);
  };
  useEffect(() => {
    const restore = () => setComparing(new URLSearchParams(location.search).get('compare') === '1');
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const narrow = useNarrowViewport();
  const reanchorRef = useRef(null);
  const bridgeRef = useRef(null);
  const editorRef = useRef(null);
  const diagramApplyRef = useRef(null);
  const [diagram, setDiagram] = useState(null);
  const [visualOpen, setVisualOpen] = useState(false);
  // Slides presenting: full screen like a visual, but commenting stays on.
  const [presenting, setPresenting] = useState(false);
  const [composer, setComposer] = useState(null);
  const [openCommentId, setOpenCommentId] = useState(null);
  const [openClusterKey, setOpenClusterKey] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reanchorId, setReanchorId] = useState(null);
  const [saveNoticeOpen, setSaveNoticeOpen] = useState(false);
  // The bar's copy of the name, so a rename shows immediately instead of
  // waiting for a reload. The boot config stays the source it starts from.
  const [title, setTitle] = useState(config.title || '');
  // ?share=1 arrives with Share open (a feedback space's Share button links
  // here); read once and taken off the URL.
  const [dialog, setDialog] = useState(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('share') !== '1' || config.isLanding) return null;
    params.delete('share');
    const rest = params.toString();
    try { history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); } catch {}
    return { type: 'share' };
  });
  const [moveState, setMoveState] = useState({ teams: [], loading: false, error: '', busy: false });
  // Connected-App notify panel (doc-level send). Separate from onboarding
  // copy-paste handoff below.
  const [notifyOpen, setNotifyOpen] = useState(false);
  // What is left of this account's free tdoc AI answers, once known: the
  // muted line under a tdoc AI reply says it to the person who asked.
  const [aiRemaining, setAiRemaining] = useState(null);
  // The comment tdoc AI is answering right now, for "answering…" in its card.
  const [aiThinking, setAiThinking] = useState(null);
  // An "Only me" question from the composer: { kind, askId, question,
  // selection, answer, error, publishing }. Nothing is posted until Make public.
  const [privateAsk, setPrivateAsk] = useState(null);
  const [handoffDetailsOpen, setHandoffDetailsOpen] = useState(false);
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const [askAiDraft, setAskAiDraft] = useState('');
  const [askAiTargetKey, setAskAiTargetKey] = useState('');
  const [askAiTurns, setAskAiTurns] = useState([]);
  const [askAiBusy, setAskAiBusy] = useState(false);
  const [notifyCommentIds, setNotifyCommentIds] = useState(null);
  // "Send to another agent" from a card: the agent it is stuck on, so the
  // picker opens on someone else.
  const [notifyAvoid, setNotifyAvoid] = useState(null);
  const [hoveredAnchorId, setHoveredAnchorId] = useState(null);
  const [sendToAgentBusy, setSendToAgentBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // setToast('done') for confirmations; setToast('...', true) for failures,
  // which are painted in the danger tone and stay long enough to read.
  const showToast = useCallback((text, error = false) => setToast({ text, error }), []);
  const [supportsTheme, setSupportsTheme] = useState(false);
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
  // Show all comments on first open, including resolved threads. Remember an
  // explicit choice per browser; unavailable storage keeps the default ON.
  // The comments filter: All (the default), Open, or Resolved. It lives in
  // the comments area now, not the bar. Stored per browser; the old
  // '0' (resolved hidden) reads as Open.
  const [commentFilter, setCommentFilterState] = useState(() => {
    if (new URLSearchParams(location.search).get('revised')) return 'all';
    try {
      const v = localStorage.getItem(RESOLVED_KEY);
      return v === '0' ? 'open' : v === 'resolved' ? 'resolved' : 'all';
    } catch { return 'all'; }
  });


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
  const handoffViewer = useMemo(() => [config.identity?.login, ...(config.identity?.linked_actor_keys || [])], [config.identity]);
  const commentArea = useCommentArea({
    comments: comments.comments, slug: config.slug, selectedId: openCommentId,
    filter: commentFilter, filterMode: 'resolution', handoffViewer,
    isOwner: Boolean(config.isOwner),
  });

  const [invited, setInvited] = useState(null);
  const [teamGuestsEnabled] = useState(() => isFeatureOn('teamGuests'));
  const [guestInviteStatus, setGuestInviteStatus] = useState('');

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
    if (!config.canComment) {
      bridgeRef.current?.({ type: 'tdoc:clearPending' });
      if (config.signInToComment) signIn();
      return;
    }
    setComposer(selection);
  }, [comments.moveAnchor, config.canComment, config.signInToComment, signIn]);

  const bridge = useFrameBridge({
    'tdoc:visualState': (message) => setVisualOpen(message.open === true),
    'tdoc:presentState': (message) => setPresenting(message.open === true),
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
      setVisualOpen(false);
      setSupportsTheme(message.supportsTheme === true);
      const storedTheme = readStored('tdoc-theme');
      const nextTheme = storedTheme || (message.defaultTheme === 'dark' ? 'dark' : 'light');
      setTheme(nextTheme);
      if (message.supportsTheme === true) bridge.send({ type: 'tdoc:theme', theme: nextTheme });
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
      if (!visibleCommentsById.has(message.id)) return;
      setOpenCommentId(message.id);
      setOpenClusterKey(null);
      if (narrow) setDrawerOpen(true);
    },
    'tdoc:anchorHover': (message) => {
      setHoveredAnchorId(message.id && visibleCommentsById.has(message.id) ? message.id : null);
    },
    'tdoc:navigate': (message) => {
      const href = String(message.href || '');
      if (!/^https?:\/\//i.test(href) && !/^\/(?!\/)/.test(href)) return;
      if (config.onboarding && href === '/start' && !message.blank && config.identity) {
        // Connected already — an agent on this account has a token — means the
        // gate has nothing to ask, so it is not shown. Signed in and not yet
        // connected starts at the gate. Signed out falls through to /start
        // itself: sending a first-time visitor to /setup put a sign-in wall
        // ("Welcome back!") in front of somebody who had not yet seen what to
        // paste, or where. /start shows the line first; the account is asked
        // for only when the agent's sign-in link is opened.
        const done = Boolean(onboardingRecord?.agent_connected || onboardingRecord?.published_first);
        location.href = done ? '/me' : '/setup';
        return;
      }
      if (message.blank) window.open(href, '_blank', 'noopener');
      else location.href = href;
    },
  });

  const disableCommentSelection = useCallback(() => {
    setComposer(null);
    setOpenCommentId(null);
    setOpenClusterKey(null);
    setDrawerOpen(false);
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
    //
    // On a phone the open card lives in the drawer: once the drawer is shut,
    // nothing is open on screen, so the next tap on a highlight must open its
    // comment rather than be spent "closing" a card nobody can see. That was
    // every other tap failing (Julie, 2026-10-13).
    const cardOpen = narrow ? (drawerOpen && openCommentId) : (openCommentId || openClusterKey);
    const open = Boolean((cardOpen || composer) && !reanchorId);
    bridge.send({ type: 'tdoc:uiOpen', open });
  }, [bridge.send, composer, openClusterKey, openCommentId, reanchorId, narrow, drawerOpen]);

  const focusComment = useCallback((id, { scroll = false, closeDrawer = false } = {}) => {
    setOpenCommentId(id);
    setOpenClusterKey(null);
    if (closeDrawer) setDrawerOpen(false);
    bridge.send({ type: 'tdoc:focusAnchor', id, scroll });
  }, [bridge.send]);

  // Everything, always: an id has to resolve to its comment even when that
  // comment is hidden, or a deep link would open nothing.
  const commentsById = commentArea.byId;
  const resolvedCount = commentArea.resolvedCount;
  // One visible set drives the margin and the frame. Selection must never
  // override the filter; explicit links enable it before opening a thread.
  const shownComments = commentArea.shown;
  const drawerComments = useMemo(() => [
    ...shownComments.filter(isDocumentComment),
    ...shownComments.filter((comment) => !isDocumentComment(comment)),
  ], [shownComments]);
  const visibleCommentsById = commentArea.shownById;
  const seenMap = commentArea.seenMap;
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

  const setCommentFilter = useCallback((next) => {
    setCommentFilterState(next);
    try { localStorage.setItem(RESOLVED_KEY, next === 'open' ? '0' : next === 'resolved' ? 'resolved' : '1'); } catch {}
    if (next === 'all') return;
    // Whatever the filter now hides: cancel a pending reveal, and close the
    // card, cluster or re-anchor that showed it.
    const hidden = (id) => {
      const c = commentsById.get(id);
      return Boolean(c) && (next === 'open' ? c.status === 'applied' : c.status !== 'applied');
    };
    setDeepTarget(null);
    if (hidden(openCommentId)) {
      setOpenCommentId(null);
      bridge.send({ type: 'tdoc:focusAnchor', id: null });
    }
    const openCluster = clusters.find((cluster) => cluster.key === openClusterKey);
    if (openCluster?.items.some(({ comment }) => hidden(comment.id))) setOpenClusterKey(null);
    if (hidden(reanchorId)) setReanchorId(null);
  }, [bridge.send, clusters, commentsById, openClusterKey, openCommentId, reanchorId]);

  useEffect(() => {
    bridge.send({ type: 'tdoc:anchors', comments: shownComments });
    if (!comments.loading) document.body.dataset.tdocReady = '1';
  }, [bridge.send, shownComments, comments.loading]);

  useEffect(() => {
    bridgeRef.current = bridge.send;
  }, [bridge.send]);

  useEffect(() => {
    reanchorRef.current = reanchorId;
    document.body.classList.toggle('tdoc-reanchoring', Boolean(reanchorId));
    bridge.send({ type: 'tdoc:reanchorMode', active: Boolean(reanchorId) });
  }, [reanchorId, bridge.send]);

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
    if ((root.status === 'applied' && commentFilter === 'open') || (root.status !== 'applied' && commentFilter === 'resolved')) {
      // A direct link is an explicit request to reveal this thread. Reflect
      // that in the filter instead of bypassing its visibility contract.
      setCommentFilterState('all');
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
  }, [bridge.layout.scrollY, bridge.layout.documentComments, bridge.send, clusters, comments.comments, deepTarget, narrow, commentFilter]);

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
    setPrivateAsk(null);
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
    const selection = composer;
    const target = opts.target || null;
    // Ask only + Only me: nothing is posted; the answer is the asker's alone.
    if (target && opts.askOnly && opts.onlyMe) { await askPrivately(text, selection, target); return; }
    const { ok, value } = await attempt(() => comments.addComment(composer, text));
    if (!ok) return;
    markCommented();
    closeComposer();
    reportMentions(value);
    // The new card opens: it is where the next instruction lives.
    if (value?.id) setOpenCommentId(value.id);
    if (value?.id && selection?.kind === 'document') {
      setCommentFilterState('open');
      setDrawerOpen(true);
      bridge.send({ type: 'tdoc:scrollTo', docY: Math.max(0, (bridge.layout.documentComments?.docY || 0) - 60) });
    }
    if (!value?.id) return;
    if (target && opts.askOnly) { await askOn(value.id, text, selection, target); return; }
    // To edit: the agent named after @, or (⌘⇧Enter) the default one.
    const editor = target || (opts.sendToAgent && canSendToAgent ? opts.recipient || notifyTargets.default : null);
    if (editor && canSendToAgent) await editOn(value.id, editor);
  };

  // tdoc AI: the server's free answers, where it has a model, on a
  // published doc, for a signed-in person.
  const askEnabled = Boolean(config.ask?.available) && config.mode === 'published' && !config.isLanding && Boolean(config.identity);
  // Signed-out readers still see Ask AI; sending asks them to sign in, which
  // is the point: a question is the reason to make an account.
  const signedOutAsk = Boolean(config.ask?.available) && config.mode === 'published' && !config.isLanding && !config.identity && !config.demoComments;
  const recipientFor = (target) => (target.tdoc_ai ? { tdoc_ai: true } : target);
  // Hand a posted comment to an agent to EDIT the doc (Ask only off). The
  // server decides whether this agent may (agentEditPolicy).
  const editOn = async (commentId, target) => {
    setSendToAgentBusy(true);
    try {
      const body = await handOff(config.slug, { ask_only: false, comment_id: commentId, recipient: target });
      const failed = body?.delivery?.status === 'failed';
      showToast(failed
        ? `Sent — not delivered${body.delivery?.error ? `: ${deliveryErrorText(body.delivery.error)}` : ''}`
        : `Sent to ${agentDisplayName(target) || readableHandle(target) || 'agent'}`, failed);
      await comments.refresh();
    } catch (err) {
      showToast(err.body?.message || err.message || 'Comment posted — could not send to agent', true);
    } finally {
      setSendToAgentBusy(false);
    }
  };
  // The agent's tag as the text holds it (a draft may hold an older, longer
  // form), else as the picker would put it in.
  const askTagIn = (text, target) => {
    const span = taggedAgentSpan(text, agentChoices);
    return span && sameTarget(span.target, target) ? String(text).slice(span.start, span.end)
      : `@${AGENT_TAG_JOINER}${agentMentionName(target, agentChoices)}`;
  };
  // Ask only, in the thread: the answer is the reply under this comment.
  const askOn = async (commentId, text, selection, target) => {
    const question = withoutAskTags(text, askTagIn(text, target));
    const passage = selection && selection.text ? selection : null;
    const label = agentDisplayName(target);
    setAiThinking({ id: commentId, label, agent: !target.tdoc_ai });
    try {
      const body = await handOff(config.slug, { ask_only: true, comment_id: commentId, question, passage, version: config.version, recipient: recipientFor(target) });
      if (target.tdoc_ai) {
        if (typeof body?.remaining === 'number') setAiRemaining(body.remaining);
        await comments.refresh();
        setAiThinking(null);
      } else if (body?.ask) {
        // Its agent answers on its own time; the thread is read again then.
        myAgent.addAsk(body.ask);
      }
    } catch (error) {
      setAiThinking(null);
      if (error.status === 429 && target.tdoc_ai) setAiRemaining(0);
      showToast(error.status === 429 && target.tdoc_ai ? 'No free tdoc AI answers left — connect your agent at tdoc.dev/start'
        : error.status === 409 ? `${label} cannot be reached right now` : (error.message || `Could not ask ${label}`), true);
    }
  };

  // "Only me": the question goes to the agent and nothing is posted; the
  // composer shows the answer to its asker alone, with Make public.
  // From a reply box, `parentId` is the reply's parent: the answer shows in
  // that box, and Make public posts the question as a reply there.
  const askPrivately = async (text, selection, target, parentId = null) => {
    const question = withoutAskTags(text, askTagIn(text, target));
    const passage = selection && selection.text ? selection : null;
    const kind = target.tdoc_ai ? 'tdoc-ai' : 'agent';
    setPrivateAsk({ kind, label: agentDisplayName(target), question, selection, parentId, answer: '', error: '' });
    try {
      const body = await handOff(config.slug, { ask_only: true, only_me: true, question, passage, version: config.version, recipient: recipientFor(target) });
      if (body?.ask) {
        myAgent.addAsk(body.ask);
        setPrivateAsk((cur) => (cur ? { ...cur, askId: body.ask.ask_id } : cur));
        return;
      }
      if (typeof body?.remaining === 'number') setAiRemaining(body.remaining);
      setPrivateAsk((cur) => (cur ? { ...cur, askId: body.ask_id, answer: body.answer } : cur));
    } catch (error) {
      if (error.status === 429 && target.tdoc_ai) setAiRemaining(0);
      setPrivateAsk((cur) => (cur ? {
        ...cur,
        error: error.status === 429 && target.tdoc_ai ? 'No free tdoc AI answers left. Connect your agent at tdoc.dev/start for unlimited ones.'
          : error.status === 409 ? `${cur.label} cannot be reached right now.` : 'Could not get an answer. Try again.',
      } : cur));
    }
  };
  // Make public: the question becomes the asker's comment on the passage, and
  // the answer they were given (as the server kept it) its reply.
  const makePublic = async () => {
    const ask = privateAskView;
    if (!ask?.askId || !ask.answer) return;
    setPrivateAsk((cur) => ({ ...cur, publishing: true }));
    const { ok, value } = await attempt(() => (ask.parentId
      ? comments.addReply(ask.parentId, ask.question)
      : comments.addComment(ask.selection, ask.question)));
    if (!ok || !value?.id) { setPrivateAsk((cur) => ({ ...cur, publishing: false })); return; }
    try {
      await publishAsk(config.slug, ask.kind === 'tdoc-ai' ? 'ask' : 'my-agent', { askId: ask.askId, commentId: value.id });
    } catch (error) {
      showToast(error.message || 'Posted the question; could not post the answer', true);
    }
    markCommented();
    if (ask.parentId) {
      setPrivateAsk(null);
      await comments.refresh();
      return;
    }
    closeComposer();
    await comments.refresh();
    setOpenCommentId(value.id);
    if ((!ask.selection || ask.selection.kind === 'document') && bridge.layout.documentComments) {
      bridge.send({ type: 'tdoc:scrollTo', docY: bridge.layout.documentComments.docY });
    }
  };

  const replyTo = async (parentId, text, opts = {}) => {
    // Signed out, replying is the prompt to sign in (the reply box still shows).
    if (!config.identity && config.signInToComment) { signIn(); return false; }
    // Only me from a reply box: nothing is posted; the question goes with the
    // passage the thread hangs on, and the answer shows in that box.
    if (opts.target && opts.askOnly && opts.onlyMe) {
      const root = comments.comments.find((c) => c.id === parentId || (c.replies || []).some((r) => r.id === parentId));
      const anchorText = root?.anchor?.text || root?.anchor?.fallback?.text || '';
      await askPrivately(text, anchorText ? { text: anchorText } : null, opts.target, parentId);
      return false;
    }
    const { ok, value } = await attempt(() => comments.addReply(parentId, text));
    if (!ok) return false;
    markCommented();
    reportMentions(value);
    // An agent named in a reply that may only answer: under this reply.
    if (opts.target && opts.askOnly && value?.id) {
      await askOn(value.id, text, null, opts.target);
      return true;
    }
    // @agent on a reply re-hands the thread root (or the new reply if no root).
    if (opts.sendToAgent && canSendToAgent) {
      const handoffId = opts.handoffCommentId || value?.id;
      if (handoffId) await editOn(handoffId, opts.recipient || notifyTargets.default);
    }
    return true;
  };

  // An edit does not re-resolve @mentions: the notified set is stamped on the
  // event that first carried the text, and nobody is notified twice for a
  // rewrite of words they were already told about.
  const editComment = async (id, text) => (await attempt(() => comments.edit(id, text))).ok;

  const reactTo = (commentId, emoji) => (!config.identity && config.signInToComment
    ? signIn() : attempt(() => comments.react(commentId, emoji)));
  // Resolving takes the thread out of the margin, so the card that owns the
  // button goes with it — close it rather than leaving a card pinned to
  // nothing.
  const resolveComment = async (commentId, resolved) => {
    if (!await attempt(() => comments.setResolved(commentId, resolved))) return;
    if ((resolved && commentFilter === 'open') || (!resolved && commentFilter === 'resolved')) setOpenCommentId(null);
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

  // Team docs: every member may send to the team's agents (and an admin to
  // their own connections); the server lists only those. Send to agent shows
  // on a team doc once there is someone to send to.
  const notifyQuery = Boolean((config.isOwner || config.teamManage) && !config.isLanding && config.mode !== 'local');
  const notifyTargets = useNotifyTargets(config.slug, notifyQuery);
  const hasNotifyTargets = Boolean(
    notifyTargets.ready
    && notifyTargets.available
    && notifyTargets.reason !== 'no_agent_bound'
    && (notifyTargets.default || (notifyTargets.candidates || []).length || notifyTargets.fallback),
  );
  const notifyEnabled = notifyQuery && (!config.teamManage || hasNotifyTargets);
  const canSendToAgent = Boolean(notifyEnabled && hasNotifyTargets);
  // The commenter's OWN agent (my-agent.js), for Ask AI / @AI where the paper
  // plane does not reach one: anyone but the owner on their own doc, where
  // Send to agent and @agent already hand comments to the doc's agent. A
  // demo has no account to send from.
  const myAgentEnabled = Boolean(config.mode === 'published' && !config.isLanding && !config.demoComments);
  const askAiPanelEnabled = notifyEnabled || (myAgentEnabled && Boolean(config.identity));
  // Phones get one entry: the comment button's drawer carries an Ask AI tab,
  // and the top bar keeps only Share and ⋯ (flag: unifiedEntry).
  const [unifiedEntryFlag] = useState(() => isFeatureOn('unifiedEntry'));
  const unifiedEntry = narrow && (askAiPanelEnabled || signedOutAsk) && unifiedEntryFlag;
  const [drawerTab, setDrawerTab] = useState('comments');
  const myAgent = useMyAgent(config.slug, myAgentEnabled && Boolean(config.identity));
  // The composer's @ list: agents that may edit this doc, then those that
  // may only answer (own, the team's), else tdoc AI (ai-answerer.js).
  const agentChoices = useMemo(() => (config.identity && !config.demoComments ? composerAgents({
    canSendToAgent,
    notifyTargets,
    mine: myAgent.state ? { ...myAgent.state, tdoc_ai: Boolean(myAgent.state.tdoc_ai) && askEnabled } : null,
  }) : []), [config.identity, canSendToAgent, notifyTargets.default, notifyTargets.candidates, notifyTargets.fallback, myAgent.state, askEnabled]);
  const askAiTargets = useMemo(() => {
    const recent = [notifyTargets.default, ...(notifyTargets.candidates || [])].find((agent) => agent?.last_writer);
    const agents = orderedAskAiChoices([...(myAgent.state?.agents || []), ...(myAgent.state?.team_agents || [])], recent);
    return [
      ...agents.map((agent) => ({ key: targetKey(agent), label: agentDisplayName(agent, agents), target: agent, tdocAi: false })),
      ...(askEnabled || signedOutAsk ? [{ key: 'tdoc-ai', label: 'tdoc AI', target: TDOC_AI, tdocAi: true }] : []),
    ];
  }, [askEnabled, signedOutAsk, myAgent.state?.agents, myAgent.state?.team_agents, notifyTargets.default, notifyTargets.candidates]);
  // Relevance controls menu order, not who receives a private question by
  // default. A team agent (or another person's agent) cannot answer privately
  // for this viewer, even when it wrote the latest document version.
  const defaultAskAiTargetKey = useMemo(() => {
    const recent = [notifyTargets.default, ...(notifyTargets.candidates || [])].find((agent) => agent?.last_writer);
    const ownRecent = recent && !recent.team_agent
      ? (myAgent.state?.agents || []).find((agent) => agent.status !== 'stopped' && sameTarget(agent, recent))
      : null;
    return (ownRecent && askAiTargets.find((item) => item.key === targetKey(ownRecent))?.key)
      || askAiTargets.find((item) => item.tdocAi)?.key
      || askAiTargets.find((item) => !item.target.team_agent)?.key
      || askAiTargets[0]?.key || '';
  }, [askAiTargets, myAgent.state?.agents, notifyTargets.default, notifyTargets.candidates]);
  const selectedAskAiTargetKey = askAiTargets.some((item) => item.key === askAiTargetKey)
    ? askAiTargetKey : defaultAskAiTargetKey;
  const askAiSend = async (retryText = null, retryTarget = null) => {
    const question = String(retryText || askAiDraft).trim();
    if (signedOutAsk) {
      if (!question) return;
      // Keep the question across the sign-in round trip; it opens again here.
      try { sessionStorage.setItem(`tdoc-ask-draft:${config.slug}`, question); } catch {}
      signIn();
      return;
    }
    const choice = retryTarget
      ? askAiTargets.find((item) => sameTarget(item.target, retryTarget))
      : askAiTargets.find((item) => item.key === selectedAskAiTargetKey);
    if (!question || !choice || askAiBusy) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setAskAiBusy(true);
    if (!retryText) setAskAiDraft('');
    setAskAiTurns((turns) => [...turns, { id, question, target: choice.target, label: choice.label,
      kind: choice.tdocAi ? 'tdoc-ai' : 'agent', status: 'thinking', answer: '', askId: null }]);
    try {
      const body = await handOff(config.slug, { ask_only: true, only_me: true, question,
        version: config.version, recipient: recipientFor(choice.target) });
      if (body?.ask) myAgent.addAsk(body.ask);
      if (typeof body?.remaining === 'number') setAiRemaining(body.remaining);
      setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? {
        ...turn, askId: body?.ask?.ask_id || body?.ask_id || null,
        answer: body?.answer || body?.ask?.answer?.text || '',
        status: body?.ask && !body.ask.answer ? 'waiting' : 'answered',
      } : turn));
    } catch (error) {
      if (error.status === 429 && choice.tdocAi) setAiRemaining(0);
      setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? {
        ...turn, status: 'failed', error: error.status === 429 ? 'No free tdoc AI answers left.'
          : error.status === 409 ? 'Your agent could not be reached.' : (error.message || 'Could not get an answer.'),
      } : turn));
    } finally {
      setAskAiBusy(false);
    }
  };
  useEffect(() => {
    const asks = myAgent.state?.asks || [];
    if (!asks.length) return;
    setAskAiTurns((turns) => {
      let changed = false;
      const next = turns.map((turn) => {
        if (turn.kind !== 'agent' || turn.status !== 'waiting' || !turn.askId) return turn;
        const ask = asks.find((item) => item.ask_id === turn.askId);
        if (ask?.answer?.text) { changed = true; return { ...turn, status: 'answered', answer: ask.answer.text }; }
        if (ask?.delivery?.status === 'failed') { changed = true; return { ...turn, status: 'failed', error: 'Not delivered to your agent.' }; }
        return turn;
      });
      return changed ? next : turns;
    });
  }, [myAgent.state?.asks]);
  const keepAskAiAnswer = (id) => setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, kept: true } : turn));
  const postAskAiAnswer = async (id) => {
    const turn = askAiTurns.find((item) => item.id === id);
    if (!turn?.askId || !turn.answer || turn.public || turn.publishing) return;
    setAskAiTurns((turns) => turns.map((item) => item.id === id ? { ...item, publishing: true } : item));
    try {
      let commentId = turn.publicCommentId;
      if (!commentId) {
        const comment = await comments.addComment({ kind: 'document' }, turn.question);
        if (!comment?.id) throw new Error('Could not post the question');
        commentId = comment.id;
        setAskAiTurns((turns) => turns.map((item) => item.id === id ? { ...item, publicCommentId: commentId } : item));
      }
      await publishAsk(config.slug, turn.kind === 'tdoc-ai' ? 'ask' : 'my-agent', { askId: turn.askId, commentId });
      await comments.refresh();
      setAskAiTurns((turns) => turns.map((item) => item.id === id ? { ...item, public: true, publishing: false } : item));
      setOpenCommentId(commentId);
    } catch (error) {
      setAskAiTurns((turns) => turns.map((item) => item.id === id ? { ...item, publishing: false } : item));
      showToast(error.message || 'Could not post the answer', true);
    }
  };
  // An agent answers in the thread on its own time: once it has, the thread
  // is read again so the reply shows.
  const askedInThread = (myAgent.state?.asks || []).filter((a) => a.comment_id);
  const answeredInThread = askedInThread.filter((a) => a.reply_id).length;
  const settledInThread = askedInThread.filter((a) => a.reply_id || a.delivery?.status === 'failed').length;
  useEffect(() => {
    if (answeredInThread) comments.refresh();
  }, [answeredInThread]);
  useEffect(() => {
    setAiThinking((cur) => (cur && cur.agent ? null : cur));
  }, [settledInThread]);
  const offersTdocAi = agentChoices.some((t) => t.tdoc_ai);
  // The free answers left, for the @ list and the line under a tdoc AI reply.
  useEffect(() => {
    if (!askEnabled || aiRemaining !== null) return undefined;
    let live = true;
    getAskAllowance(config.slug)
      .then((body) => { if (live && typeof body?.remaining === 'number') setAiRemaining(body.remaining); })
      .catch(() => {});
    return () => { live = false; };
  }, [askEnabled, config.slug]);

  // The "Only me" question as the composer shows it: an agent answers on its
  // own time, so its answer is read from the asks list.
  const privateAgentAsk = privateAsk?.kind === 'agent' && privateAsk.askId
    ? (myAgent.state?.asks || []).find((a) => a.ask_id === privateAsk.askId) : null;
  const privateAskView = privateAsk ? {
    ...privateAsk,
    answer: privateAsk.answer || privateAgentAsk?.answer?.text || '',
    error: privateAsk.error || (privateAgentAsk?.delivery?.status === 'failed' ? `${privateAsk.label} did not answer.` : ''),
    status: privateAsk.kind === 'agent' ? (privateAgentAsk?.acked_at ? 'Working on it…' : 'Sent · waiting for the answer…') : 'Thinking…',
  } : null;

  const makePublicRef = useRef(null);
  makePublicRef.current = makePublic;
  const guestAction = teamGuestsEnabled && config.teamManage?.guest ? {
    label: config.teamManage.invitePending ? 'Accept team invitation' : `Request to join ${config.teamManage.team.name}`,
    onClick: async () => {
      setGuestInviteStatus('Sending…');
      try {
        if (config.teamManage.invitePending) await acceptTeamInvite(config.teamManage.team.id);
        else await requestTeamJoin(config.slug);
        if (config.teamManage.invitePending) location.reload();
        else setGuestInviteStatus('Request sent to team admins.');
      } catch (error) { setGuestInviteStatus(error.message || 'Could not send request.'); }
    },
  } : null;
  // What @ offers (agentChoices) and what tdoc AI has left / who is
  // answering where, for the composers and the cards.
  const agentMentions = useMemo(() => ({
    choices: agentChoices,
    disabledChoices: teamGuestsEnabled && config.teamManage?.guest ? (myAgent.state?.disabled_team_agents || []) : [],
    guestAction,
    preselected: agentChoices.find((agent) => notifyTargets.default && sameTarget(agent, notifyTargets.default)) || null,
    ai: { remaining: aiRemaining, thinking: aiThinking, offered: offersTdocAi },
    // An Only me question asked from a reply box, which shows its answer.
    privateReply: privateAskView && privateAskView.parentId ? privateAskView : null,
    onMakePublic: () => makePublicRef.current(),
    onClosePrivate: () => setPrivateAsk(null),
  }), [agentChoices, notifyTargets.default, aiRemaining, aiThinking, offersTdocAi, privateAsk, privateAgentAsk, myAgent.state?.disabled_team_agents, teamGuestsEnabled, config.teamManage?.guest, guestAction]);
  const openNotifyPanel = (ids, avoid = null) => {
    setNotifyCommentIds(ids);
    setNotifyAvoid(avoid);
    setNotifyOpen(true);
  };
  // A card whose handoff nobody picked up: resend it (same event id, so Raft
  // drops it if the first did land), or hand it to someone else.
  const resendHandoff = async (comment) => {
    if (!comment?.handoff_id) return;
    try {
      const body = await resendNotifyHandoff({ slug: config.slug, handoff_id: comment.handoff_id });
      showToast(resendResultText(body), body?.delivery?.status === 'failed');
      await comments.refresh();
    } catch (err) {
      showToast(err.message || 'Could not resend', true);
    }
  };
  const sendHandoffElsewhere = (comment) => {
    if (comment?.id) openNotifyPanel([comment.id], comment.handoff_to || null);
  };
  // Badge + send panel = comments ready to hand off (never sent, or human
  // wrote again after the last handoff). Not "open" and not "sent".
  const visibleHandoffComments = commentArea.visibleHandoffs;
  const handoffBuckets = commentArea.handoffBuckets;
  const unreadAgentReplies = commentArea.unreadCount;
  const markAgentReplyRead = commentArea.markRead;
  const markAllAgentRepliesRead = commentArea.markAllRead;
  const openDocNotify = (selectedIds = handoffBuckets.ready.map((c) => c.id)) => {
    setHandoffDetailsOpen(false);
    openNotifyPanel(selectedIds);
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

  const openMoveDocument = async () => {
    setDialog({ type: 'move-document' });
    setMoveState({ teams: [], loading: true, error: '', busy: false });
    try {
      const result = await listTeams();
      setMoveState({ teams: result.teams || [], loading: false, error: '', busy: false });
    } catch (error) {
      setMoveState({ teams: [], loading: false, error: error.message || 'Could not load workspaces.', busy: false });
    }
  };

  const moveDocument = async (target) => {
    setMoveState((current) => ({ ...current, busy: true, error: '' }));
    try {
      await moveDocsToTeam([config.slug], target.id);
      location.href = `/d/${encodeURIComponent(config.slug)}`;
    } catch (error) {
      setMoveState((current) => ({ ...current, busy: false, error: error.message || 'Could not move this document.' }));
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
      if (error.body?.error === 'quota_docs') {
        setDialog({
          type: 'quota-bump',
          used: error.body.used,
          limit: error.body.limit,
        });
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

  // What Share copies: the doc's own address, which always opens the newest
  // version (Julie, 2026-10-13). A link to exactly this version is offered
  // as the secondary choice in the dialog.
  const shareUrl = config.isLanding
    ? `${location.origin}/`
    : `${location.origin}/d/${encodeURIComponent(config.slug)}`;
  const versionUrl = config.isLanding ? null : `${location.origin}/d/${encodeURIComponent(config.slug)}/v/${config.version}`;

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
          // On the doc's own address the newest version is what it shows; a
          // reader who chose a version is taken to the new one explicitly.
          location.href = /\/v\/\d+\/?$/.test(location.pathname)
            ? `/d/${encodeURIComponent(config.slug)}/v/${latest}?revised=1`
            : `/d/${encodeURIComponent(config.slug)}?revised=1`;
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

  // Live sync for anyone reading: replies (an agent's included) arrive in
  // their threads, and a version published meanwhile is announced in the
  // strip above the doc rather than navigated to. Only a visible tab polls;
  // coming back to the tab checks at once; a quiet doc backs off to a minute.
  // Before this, polling ran only while a handoff was still `sent`, so a
  // reply that came after the agent picked the comment up needed a reload
  // (Julie, 2026-10-15).
  const [liveLatest, setLiveLatest] = useState(0);
  useEffect(() => {
    if (config.isLanding || config.mode === 'local' || !config.slug) return undefined;
    let cancelled = false;
    let timer = null;
    let delay = LIVE_SYNC_MIN_MS;
    let last = '';
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') { timer = window.setTimeout(tick, delay); return; }
      let seen = '';
      try {
        const status = await getAgentStatus(config.slug);
        const latest = Number(status?.latest_version) || 0;
        if (!cancelled && latest) setLiveLatest(latest);
        seen = String(latest);
      } catch { /* next tick */ }
      try { await commentsRefresh(); } catch { /* next tick */ }
      if (cancelled) return;
      const fingerprint = `${seen}|${(commentsRef.current || []).map((c) => `${c && c.id}:${(c && c.replies || []).length}:${c && c.status}`).join(',')}`;
      delay = fingerprint === last ? Math.min(delay * 2, LIVE_SYNC_MAX_MS) : LIVE_SYNC_MIN_MS;
      last = fingerprint;
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, LIVE_SYNC_MIN_MS);
    const onVis = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      delay = LIVE_SYNC_MIN_MS;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, 300);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [config.slug, config.isLanding, config.mode, commentsRefresh]);

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
      .map((c) => `${c.id}:${c.handoff_at || ''}:${c.handoff_acked_at || ''}:${c.handoff_delivery?.at || ''}:${(c.replies || []).length}`)
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
  const openComment = commentArea.selected;
  // Open / Resolved / All, in the comments area (it was a switch in the bar).
  // Only when there is something to filter.
  const openCount = commentArea.openCount;
  const mobileUnread = commentArea.unreadCount > 0;
  const startDocumentComment = (askAi = false) => {
    if (!config.canComment) { if (config.signInToComment) signIn(); return; }
    if (editor.mode === 'edit' && editor.dirty) {
      showToast('Save or discard the draft before commenting', true);
      return;
    }
    if (askAi && !agentChoices.length) {
      showToast('Connect an agent to ask AI', true);
      return;
    }
    editor.changeMode('comment');
    setDrawerOpen(false);
    const y = window.innerHeight - 80;
    setComposer({ kind: 'document', intent: askAi ? 'ask-ai' : 'comment', rect: { top: y, bottom: y, left: 16 } });
  };
  const closeAskAi = () => { setHandoffDetailsOpen(false); if (unifiedEntry) setDrawerOpen(false); };
  // A question typed before signing in comes back after it, in the open panel.
  useEffect(() => {
    if (!config.identity) return;
    let saved = null;
    try { saved = sessionStorage.getItem(`tdoc-ask-draft:${config.slug}`); sessionStorage.removeItem(`tdoc-ask-draft:${config.slug}`); } catch {}
    if (!saved) return;
    setAskAiDraft(saved);
    if (unifiedEntry) { setDrawerTab('ask'); setDrawerOpen(true); } else setHandoffDetailsOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.identity, config.slug]);
  const askAiPanel = (panelOpen) => (
    <AskAiPanel
      open={panelOpen}
      draft={askAiDraft}
      onDraft={setAskAiDraft}
      targetKey={selectedAskAiTargetKey}
      onTarget={setAskAiTargetKey}
      targets={askAiTargets}
      viewer={config.identity}
      turns={askAiTurns}
      busy={askAiBusy}
      remaining={aiRemaining}
      onAsk={askAiSend}
      onKeep={keepAskAiAnswer}
      onPost={postAskAiAnswer}
      readyCount={canSendToAgent ? handoffBuckets.ready.length : 0}
      onSendReady={canSendToAgent ? () => openDocNotify() : null}
      activityOpen={agentActivityOpen}
      onActivityOpen={setAgentActivityOpen}
      unreadCount={unreadAgentReplies}
      disabledChoices={teamGuestsEnabled && config.teamManage?.guest ? (myAgent.state?.disabled_team_agents || []) : []}
      guestAction={guestAction}
      signInToAsk={signedOutAsk}
    >{signedOutAsk ? null : <HandoffDetailsPanel
      slug={config.slug}
      open={panelOpen}
      comments={visibleHandoffComments}
      handoffViewer={handoffViewer}
      seenMap={seenMap}
      showReady={canSendToAgent}
      onClose={closeAskAi}
      onSendReady={canSendToAgent ? openDocNotify : null}
      onSendElsewhere={canSendToAgent ? (comment) => {
        closeAskAi();
        sendHandoffElsewhere(comment);
      } : null}
      onJump={(id) => {
        setCommentFilterState('all');
        setDrawerTab('comments');
        if (narrow) setDrawerOpen(true);
        focusComment(id, { scroll: true });
      }}
      onRefresh={() => comments.refresh()}
      onToast={(text, error) => showToast(text, error)}
      onMarkRead={markAgentReplyRead}
      onMarkAllRead={markAllAgentRepliesRead}
      onViewChanges={() => { closeAskAi(); changeComparison(true); }}
      onReply={config.canComment ? async (comment, text) => replyTo(comment.id, text,
        canSendToAgent ? { sendToAgent: true, handoffCommentId: comment.id, recipient: comment.handoff_to }
          : { target: comment.handoff_to, askOnly: true }) : null}
    />}</AskAiPanel>
  );
  const commentFilterControl = comments.comments.length ? (
    <SegmentedControl
      className="tdoc-comment-filter"
      ariaLabel="Show comments"
      value={commentFilter}
      onChange={setCommentFilter}
      options={[
        { value: 'open', label: `Open (${openCount})` },
        { value: 'resolved', label: `Resolved (${resolvedCount})` },
        { value: 'all', label: 'All' },
      ]}
    />
  ) : null;
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
  const composerView = composer ? (
    <CommentComposer
      selection={composer}
      initialText={composer.kind === 'document' && composer.intent === 'ask-ai' && agentChoices[0]
        ? `@${AGENT_TAG_JOINER}${agentMentionName(agentChoices[0], agentChoices)} ` : ''}
      mentionable={mentionable}
      demo={!!config.demoComments}
      canSendToAgent={canSendToAgent}
      agentSetupHref={notifyEnabled && notifyTargets.ready && notifyTargets.reason === 'no_agent_bound' ? '/me?view=settings#agents' : null}
      sendToAgentDisabledReason={
        notifyTargets.reason === 'no_agent_bound'
          ? 'No agent is following this doc yet'
          : null
      }
      connectAgentPrompt={notifyEnabled && notifyTargets.ready && notifyTargets.reason === 'no_agent_bound' ? CONNECT_AGENT_PROMPT : null}
      privateAsk={privateAskView && !privateAskView.parentId ? privateAskView : null}
      onMakePublic={makePublic}
      onSubmit={postComment}
      onClose={closeComposer}
      onCopyToast={showToast}
    />
  ) : null;
  return (
    <div
      className="tdoc-document-app"
      data-visual-open={visualOpen || undefined}
      data-presenting={(visualOpen && presenting) || undefined}
      onPointerDown={() => {
        // Legacy behavior: a click anywhere outside a card, pin, or composer
        // closes the open card and cluster popover (they stop propagation).
        setOpenClusterKey(null);
        setOpenCommentId(null);
      }}
    >
      <AgentMentionContext.Provider value={agentMentions}>
      <TopBar
        identity={config.identity}
        onboardingTest={config.debug ? {
          record: onboardingRecord,
          surface: config.isLanding ? 'landing' : 'document',
          onState: async () => {
            const result = await getOnboarding().catch(() => null);
            setOnboardingRecord(result?.record || null);
          },
        } : null}
        space={config.teamManage?.team?.id || ''}
        currentTeam={config.teamManage?.team || null}
        theme={supportsTheme ? theme : 'light'}
        supportsTheme={supportsTheme}
        actions={config.isLanding ? <LandingActions stars={config.stars} /> : (
          !comparing && <>
            <DocumentEdited config={config} onCompare={() => changeComparison(true)} />
            {(askAiPanelEnabled || signedOutAsk) && !unifiedEntry ? (
              <DocumentSendAgentAction
                counts={Object.fromEntries(Object.entries(handoffBuckets).map(([state, list]) => [state, list.length]))}
                unread={unreadAgentReplies}
                open={handoffDetailsOpen}
                onOpenChange={(open) => { setHandoffDetailsOpen(open); if (open) { setAgentActivityOpen(false); setDrawerOpen(false); } }}
                narrow={narrow}
              >
                {askAiPanel(handoffDetailsOpen)}
              </DocumentSendAgentAction>
            ) : null}
            <DocumentModeControl
              mode={editor.mode}
              canComment={config.canComment}
              canEdit={config.canEdit}
              signInToComment={Boolean(config.signInToComment)}
              onSignIn={() => signIn()}
              onChange={(value) => editor.changeMode(value)}
            />
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
            onMoveDocument={config.mode === 'published' && config.isOwner ? openMoveDocument : null}
            onDelete={() => setDialog({ type: 'delete' })}
            onCompare={() => changeComparison(true)}
          />
        )}
        onThemeChange={(nextTheme) => {
          setTheme(nextTheme);
          bridge.send({ type: 'tdoc:theme', theme: nextTheme });
        }}
        onNotificationNavigate={(item, target) => {
          const sameDocument = item.kind !== 'team_join_request' && item.slug === config.slug
            && Number(item.version || 1) === Number(config.version);
          if (!sameDocument) {
            location.href = target;
            return;
          }
          setComparing(false);
          const commentId = item.comment_id || item.thread_id;
          history.replaceState(null, '', target);
          setDeepTarget(commentId);
        }}
        notificationPrompt={!config.isLanding}
        authConfigured={config.authConfigured !== false}
        // The top bar's Sign in on the landing returns into the onboarding:
        // a new account lands on the first screen; one that has finished or
        // skipped is let straight through (the wizard closes itself).
        // `via=signin` lets the server send a returning account to My docs
        // instead: Sign out lands here, so every re-login came back through
        // this button and was shown "Connect your agent" again.
        onSignIn={() => signIn(config.onboarding ? '/setup?via=signin' : undefined)}
      >
        <DocumentBreadcrumbs
          config={config}
          title={title}
          onRename={renameDoc}
        />
      </TopBar>
      {teamGuestsEnabled && config.teamManage?.guest ? <div className="tdoc-onboard-banner" role="status" onPointerDown={(event) => event.stopPropagation()}>
        <span>{config.teamManage.invitePending
          ? `You have been invited to join ${config.teamManage.team.name}.`
          : `You are a guest in ${config.teamManage.team.name}. Team agents are for members.`}</span>
        <button type="button" onClick={guestAction.onClick}>{guestAction.label}</button>
        {guestInviteStatus ? <span>{guestInviteStatus}</span> : null}
      </div> : null}
      {comparing ? <VersionDiffView config={config} theme={theme} narrow={narrow} onClose={() => changeComparison(false)} /> : null}

      <DiagramDialog diagram={diagram} canApply={Boolean(config.canEdit)} onClose={() => setDiagram(null)}
        onApply={async (json, svg) => {
          if (!config.canEdit) return;
          editor.changeMode('edit');
          await new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => { diagramApplyRef.current = null; reject(new Error('The document did not respond. Try again.')); }, 5000);
            diagramApplyRef.current = { id, timer, resolve, reject };
            bridge.send({ type: diagram.isNew ? 'tdoc:diagramInsert' : 'tdoc:diagramApply', requestId: id, id: diagram.id, json, svg });
          });
          setDiagram(null);
          showToast(`${diagram.isNew ? 'Diagram inserted' : 'Diagram applied'}. Save the document to publish a new version.`);
        }} />
      <div className="tdoc-reader-surface" hidden={comparing}>
      <OldVersionNotice value={boot.oldVersion || (liveLatest > Number(config.version) ? {
        current: Number(config.version),
        latest: liveLatest,
        latestUrl: `/d/${encodeURIComponent(config.slug)}/v/${liveLatest}`,
        fresh: true,
      } : null)} />

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
          onInsertDiagram={() => setDiagram({
            id: `diagram-${crypto.randomUUID()}`,
            title: 'Draw a diagram',
            isNew: true,
            scene: { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} },
          })}
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
        onMouseLeave={() => setHoveredAnchorId(null)}
        sandbox="allow-scripts"
        src={boot.frameSrc}
      />

      <DocumentFooter visible={bridge.layout.footerVisible} />

      {!narrow && commentFilterControl && !comparing ? (
        <div className="tdoc-comment-filter-dock" style={{ top: frameTop + 10, left: Math.min(pinLeft - 4, window.innerWidth - 250) }}>
          {commentFilterControl}
        </div>
      ) : null}
      {narrow ? (<>
        {editor.mode !== 'read' ? <DesktopCommentLayer
          clusters={clusters.filter((cluster) => cluster.items.every(({ comment }) => comment.document))}
          commentsById={commentsById}
          seenMap={seenMap}
          frameScrollY={bridge.layout.scrollY}
          frameTop={frameTop}
          pinLeft={pinLeft}
          openComment={null}
          openClusterKey={null}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          handoffViewer={handoffViewer}
          isOwner={Boolean(config.isOwner)}
          onOpenComment={(id) => { setOpenCommentId(id); setDrawerTab('comments'); setDrawerOpen(true); }}
          onOpenCluster={() => { setOpenCommentId(null); setDrawerTab('comments'); setDrawerOpen(true); }}
        /> : null}
        <MobileCommentDrawer
          filter={commentFilterControl}
          open={drawerOpen && !comparing}
          openCount={openCount}
          unread={mobileUnread}
          // shownComments, not the raw list: hiding resolved threads took the
          // pins out of the document but left every one of them in the drawer,
          // which on a phone IS the comment list. "Hide resolved" appeared to
          // do nothing at all.
          comments={drawerComments}
          pinIds={pinIds}
          seenMap={seenMap}
          currentUser={config.identity?.login || 'anon'}
          handoffViewer={handoffViewer}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          openCommentId={openCommentId}
          expandReplies={deepReply}
          canSendToAgent={canSendToAgent}
          agentSetupHref={notifyEnabled && notifyTargets.ready && notifyTargets.reason === 'no_agent_bound' ? '/me?view=settings#agents' : null}
          onOpenChange={(open) => { setDrawerOpen(open); if (open) setHandoffDetailsOpen(false); }}
          hideFab={handoffDetailsOpen || editor.mode === 'read'}
          askAi={unifiedEntry ? askAiPanel(drawerOpen && drawerTab === 'ask') : null}
          tab={drawerTab}
          onTab={setDrawerTab}
          onStartComment={config.canComment || config.signInToComment ? () => startDocumentComment(false) : null}
          onAskAi={config.canComment || config.signInToComment ? () => startDocumentComment(true) : null}
          onReply={replyTo}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={setReanchorId}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
          onResendHandoff={canSendToAgent ? resendHandoff : null}
          onSendHandoffElsewhere={canSendToAgent ? sendHandoffElsewhere : null}
          onNavigate={(id) => isDocumentComment(commentsById.get(id))
            ? setOpenCommentId(id)
            : focusComment(id, { scroll: true, closeDrawer: true })}
        />
      </>) : (
        <DesktopCommentLayer
          clusters={editor.mode === 'read' ? [] : clusters}
          commentsById={commentsById}
          seenMap={seenMap}
          hoveredAnchorId={hoveredAnchorId}
          frameScrollY={bridge.layout.scrollY}
          frameTop={frameTop}
          pinLeft={pinLeft}
          openComment={editor.mode === 'read' ? null : openComment}
          openClusterKey={openClusterKey}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          handoffViewer={handoffViewer}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          cardPosition={cardPosition}
          expandReplies={deepReply}
          canSendToAgent={canSendToAgent}
          agentSetupHref={notifyEnabled && notifyTargets.ready && notifyTargets.reason === 'no_agent_bound' ? '/me?view=settings#agents' : null}
          onOpenComment={(id) => {
            focusComment(id);
          }}
          onOpenCluster={(key) => {
            setOpenCommentId(null);
            setOpenClusterKey(openClusterKey === key ? null : key);
          }}
          onReply={replyTo}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={setReanchorId}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
          onResendHandoff={canSendToAgent ? resendHandoff : null}
          onSendHandoffElsewhere={canSendToAgent ? sendHandoffElsewhere : null}
        />
      )}

      {composerView}

      </div>

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
          avoid={notifyAvoid}
          onClose={() => setNotifyOpen(false)}
          onSent={async () => { await comments.refresh(); }}
          onTargetsChanged={notifyTargets.refresh}
        />
      ) : null}

      <PublishDialog
        open={dialog?.type === 'publish'}
        slug={config.slug}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      {config.ownerManage || config.teamManage?.canManage ? (
        <OwnerAccessDialog
          open={dialog?.type === 'share'}
          config={config}
          url={shareUrl}
          versionUrl={versionUrl}
          version={config.version}
          onOpenChange={(open) => !open && setDialog(null)}
          onCopied={() => showToast('Link copied')}
        />
      ) : (
        <ShareDialog
          open={dialog?.type === 'share'}
          url={shareUrl}
          versionUrl={versionUrl}
          version={config.version}
          team={config.teamManage}
          onOpenChange={(open) => !open && setDialog(null)}
          onCopied={() => showToast('Link copied')}
        />
      )}
      <DeleteDocumentDialog
        open={dialog?.type === 'delete'}
        config={config}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      {dialog?.type === 'move-document' ? (
        <MoveToTeamDialog
          title="Move this document"
          teams={moveState.teams}
          count={1}
          includePersonal={Boolean(config.workspaceId || config.teamManage?.team?.id)}
          currentTeam={config.workspaceId || config.teamManage?.team?.id || null}
          loading={moveState.loading}
          busy={moveState.busy}
          error={moveState.error}
          onClose={() => { if (!moveState.busy) setDialog(null); }}
          onMove={moveDocument}
        />
      ) : null}
      <MessageDialog
        message={dialog?.type === 'message' ? dialog : null}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <QuotaBumpDialog
        open={dialog?.type === 'quota-bump'}
        used={dialog?.used}
        limit={dialog?.limit}
        onClose={() => setDialog(null)}
        onBumped={() => showToast('Limit raised — try duplicate again')}
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
      </AgentMentionContext.Provider>
    </div>
  );
}
