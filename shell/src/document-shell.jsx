import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deliveryErrorText, resendResultText } from './document/notify-handoff.jsx';
import { handoffSurfaceState } from './comments/core/handoff-state.js';
import { TopBar } from './top-bar.jsx';
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
  postNotifyHandoff,
  publishAsk,
  setDocumentStar,
  acceptTeamInvite,
  requestTeamJoin,
} from './document/api.js';
import { CommentComposer, composerDraftKey, rememberClosedDraft } from './document/comment-composer.jsx';
import {
  CommentFilterMenu,
  DesktopCommentLayer,
  MobileCommentDrawer,
} from './document/comment-layer.jsx';
import {
  MentionReachDialog,
  MessageDialog,
  ConvertToSheetDialog,
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
  LandingFeedbackMenuItem,
  editedAgo,
} from './document/document-toolbar.jsx';
import {
  EditorToolbar,
  availableModes,
  DocumentModeControl,
  LinkDialog,
  SaveConflictDialog,
  SaveNoticeDialog,
  StaleDraftDialog,
  saveNoticeDismissed,
  EditorSaveStatus,
} from './document/editor-toolbar.jsx';
import { flashEdited, useModelessEdit } from './document/modeless-edit.jsx';
import { MarkdownSwitch, markdownEligible, useMarkdownEdit } from './document/markdown-edit.jsx';
import {
  DeleteDocumentDialog,
  OwnerAccessDialog,
} from './document/owner-access-dialog.jsx';
import { copyText, isDocumentComment, layoutPins, TOP_BAR_HEIGHT } from './document/model.js';
import { readStored, writeStored } from './safe-storage.js';
import { SideResizeHandle, useSideWidth } from './ui/side-resize.jsx';
import { COMMENT_SIDE_WIDTH, CommentPanel } from './comments/panel/comment-panel.jsx';
import { useDoubleTapOption, useEscapeLadder } from './comments/panel/keyboard.js';
import { CopyForAgentContext, useCopyForAgent } from './comments/panel/copy-for-agent.jsx';
import { CommentIcon } from './ui/comment-icon.jsx';
import { AppButton } from './ui/button.jsx';
import { isFeatureOn } from './feature-flags.js';
import { readDevMode } from './dev-mode.js';
import { VersionHistory } from './document/version-history.jsx';
import { CommentDocVersionContext, CommentEditedPassageContext, CommentSeeChangesContext } from './document/comment-card.jsx';
import { useComments } from './hooks/use-comments.js';
import { useMentionable } from './hooks/use-mentionable.js';
import { useFrameBridge } from './hooks/use-frame-bridge.js';
import { createSheetEmbedHandler, embedFrameSrc } from './document/sheet-embed.js';
import { AllowSheetEmbedsDialog } from './document/sheet-embed-dialog.jsx';
import { useDocumentEditor } from './hooks/use-document-editor.js';
import { SignInDialog } from './sign-in-dialog.jsx';
import { signedInIdentity, signInHref, startSignInPopup } from './sign-in-popup.js';
import { handoffLine, selectContents } from './onboarding-copy.js';
import { DocStepHint, docStep, STEP_HINT_HEIGHT } from './document/step-hint.jsx';
import { ConnectAiAppsStrip } from './connect-ai-apps.jsx';
import { openAppLink, sendToAppLink } from './document/send-to-app.js';
import { parseDiagramScene } from './document/excalidraw-scene.mjs';
import { DiagramDialog } from './document/diagram-dialog.jsx';
import { CONNECT_AGENT_PROMPT, HandoffSendTransport, NotifyHandoffPanel, agentLabel as notifyAgentLabel, readableHandle, useNotifyTargets } from './document/notify-handoff.jsx';
import { AGENT_TAG_JOINER, agentDisplayName, agentMentionName, byRelevance, composerDefault, maySendToAgent, orderedAgentChoices, orderedAskAiChoices, sameTarget, sendToAgentSetup, sendToAgentState, taggedAgentSpan, targetKey } from './document/agent-choices.js';
import { AgentMentionContext } from './document/mention-field.jsx';
import { HandoffDetailsPanel } from './document/handoff-details.jsx';
import { AskAiPanel, DemoRewriteBar, DemoRewriteCta } from './document/ask-ai-panel.jsx';
import { SuggestContext, useSuggestions } from './document/suggestions.js';
import { SuggestInlineChip, SuggestReviewBar } from './document/suggest-review-bar.jsx';
import { useCommentArea, useCommentListPrefs } from './comments/core/comment-area.js';
import { DEFAULT_FILTER, filterName, groupBy, matchesFilter, sortThreads } from './comments/core/comment-query.js';
import { useCommentFeed } from './comments/core/use-comment-feed.js';
import { useNarrowViewport } from './comments/core/narrow.js';
import { useSheetView } from './document/sheet-view.js';
import { createExportHtmlRequest } from './document/export-html.js';
// The download converters load on the first Download (doc-download.js).
const loadDownloads = () => import('./document/doc-download.js');
import { VersionDiffView } from './document/version-diff.jsx';
import { MoveToTeamDialog } from './docs-hub/teams.jsx';
import { useMyAgent } from './document/my-agent.js';
import { TDOC_AI, composerAgents, withoutAskTags } from './document/ai-answerer.js';
import { DEMO_AGENT, DEMO_AGENT_CHOICES, DEMO_REWRITES, createDemoBackend } from './document/demo-agent.js';


const COMMENT_SIGNIN_DRAFT_MAX_AGE_MS = 60 * 60 * 1000;
const commentSignInDraftKey = (config) => `tdoc-comment-signin-draft:${config.slug}:v${config.version}`;

function DocumentFooter({ visible, footerRef }) {
  return (
    <footer ref={footerRef} className={`tdoc-footer${visible ? ' tdoc-footer-show' : ''}`}>
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
        {value.editing ? (
          // Modeless editing: someone published while this person has a
          // draft (theirs was not published over it).
          <span role="status">
            Someone else just edited this doc. Your changes are kept.{' '}
            <a href={value.latestUrl}>Show latest</a>
          </span>
        ) : value.fresh ? (
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


// Bridge 2. The only instruction in the journey: the line the owner pastes
// into their agent after leaving a comment. What follows is read off the
// server — the agent pulling the comments, then publishing — so the card can
// say "your agent is reading this" because it is, not because a timer ran.
const HANDOFF_POLL_MS = 3000;
// Live sync while a doc is open (see the effect in DocumentShell).
const LIVE_SYNC_MIN_MS = (typeof window !== "undefined" && window.__TDOC_LIVE_SYNC_MS) || 20000;
const LIVE_SYNC_MAX_MS = 60000;
// The doc page's side comment list (comments/panel/): resizable, open or
// closed as the reader last left it; with no choice yet, open on a doc with
// this many threads to read through, where pins alone are a crowd.
const SIDE_PANEL = { storageKey: 'tdoc-comment-panel-width', ...COMMENT_SIDE_WIDTH };
const SIDE_PANEL_OPEN_KEY = 'tdoc-comment-panel';
const SIDE_PANEL_AUTO_OPEN = 8;
// The comment feed's longest wait on a quiet doc (use-comment-feed.js).
const COMMENT_FEED_IDLE_MAX_MS = 60000;
const commentsFingerprint = (list) => (Array.isArray(list) ? list : [])
  .map((c) => `${c && c.id}:${(c && c.replies || []).length}:${c && c.status}:${c && c.handoff_status}:${c && c.handoff_acked_at || ''}:${c && c.handoff_delivery?.at || ''}`)
  .join(',');
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

export function DocumentShell({ boot: servedBoot, config: servedConfig }) {
  // A version this page saved without leaving it (a sheet's column width set
  // in Read or Comment mode): the page is that version now, so everything
  // that names the version (the next save's base, comments, history, the
  // newer-version notice) names it. The frame already shows it: its address
  // only changes for a later reload (Discard). The page's own address is
  // left as it is: no /v/N in it.
  const [ownVersion, setOwnVersion] = useState(null);
  const ownVersionRef = useRef(0);
  const config = useMemo(() => (ownVersion ? {
    ...servedConfig,
    version: ownVersion.n,
    versions: [...(servedConfig.versions || []).filter((v) => Number(v.n) !== ownVersion.n), ownVersion],
  } : servedConfig), [servedConfig, ownVersion]);
  const boot = useMemo(() => (ownVersion ? {
    ...servedBoot,
    oldVersion: null,
    frameSrc: String(servedBoot.frameSrc).replace(/\/v\/\d+\/frame/, `/v/${ownVersion.n}/frame`),
  } : servedBoot), [servedBoot, ownVersion]);
  const [comparing, setComparing] = useState(() => new URLSearchParams(location.search).get('compare') === '1');
  // The compare's range, from the address (?compare=1&from=K&to=N): none is
  // the version on screen against the one before it (VersionDiffView).
  const compareRangeFromUrl = () => {
    const query = new URLSearchParams(location.search);
    // Kept as typed: VersionDiffView checks them (whole numbers in range).
    return { from: query.get('from'), to: query.get('to') };
  };
  const [compareRange, setCompareRange] = useState(compareRangeFromUrl);
  const changeComparison = (next, range = null) => {
    if (next === comparing && !range) return;
    const url = new URL(location.href);
    url.searchParams.delete('from');
    url.searchParams.delete('to');
    if (next) {
      url.searchParams.set('compare', '1');
      if (range?.from) url.searchParams.set('from', String(range.from));
      if (range?.to) url.searchParams.set('to', String(range.to));
    } else url.searchParams.delete('compare');
    history.pushState(null, '', url);
    setCompareRange(next && range ? { from: range.from || null, to: range.to || null } : { from: null, to: null });
    setComparing(next);
  };
  // Version history: "Edited …" opens the history panel for whoever may
  // list the doc's history (cfg.historyVisible); for anyone else it is plain
  // text. ?history=1 is the panel open, so Back closes it.
  const historyEnabled = config.mode === 'published' && !config.isLanding && Boolean(config.historyVisible);
  const [historyOpen, setHistoryOpen] = useState(() => historyEnabled && new URLSearchParams(location.search).get('history') === '1');
  const changeHistory = (next) => {
    if (next === historyOpen) return;
    const url = new URL(location.href);
    if (next) url.searchParams.set('history', '1'); else url.searchParams.delete('history');
    history.pushState(null, '', url);
    setHistoryOpen(next);
  };
  useEffect(() => {
    const restore = () => {
      const query = new URLSearchParams(location.search);
      setComparing(query.get('compare') === '1');
      setCompareRange(compareRangeFromUrl());
      setHistoryOpen(historyEnabled && query.get('history') === '1');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [historyEnabled]);
  const [historyDevMode] = useState(() => Boolean(readDevMode()?.on));
  // See what changed: a reader who may not list the history
  // (config.changesVisible, the server's canSeeVersionChanges) still sees
  // how this version differs from the one they last saw here, or from the
  // one before it. "Last saw" is this browser's: the version on screen when
  // they last left the page (seenKey), read once as the page opens.
  const changesEnabled = config.mode === 'published' && !config.isLanding && !historyEnabled
    && Boolean(config.changesVisible) && Number(config.version) > 1;
  const seenKey = `tdoc-seen-version:${config.slug}`;
  const [seenAtOpen] = useState(() => Number(readStored(seenKey)) || 0);
  const shownVersion = Number(config.version) || 0;
  const changesFrom = seenAtOpen > 0 && seenAtOpen < shownVersion ? seenAtOpen : shownVersion - 1;
  const changesFresh = changesEnabled && seenAtOpen > 0 && seenAtOpen < shownVersion;
  const [changesSeen, setChangesSeen] = useState(false);
  useEffect(() => {
    if (config.mode !== 'published' || config.isLanding || !shownVersion) return undefined;
    const remember = () => {
      if (shownVersion > (Number(readStored(seenKey)) || 0)) writeStored(seenKey, String(shownVersion));
    };
    window.addEventListener('pagehide', remember);
    return () => window.removeEventListener('pagehide', remember);
  }, [config.mode, config.isLanding, seenKey, shownVersion]);
  const openWhatChanged = changesEnabled ? () => {
    setChangesSeen(true);
    changeComparison(true, changesFrom !== shownVersion - 1 ? { from: changesFrom } : null);
  } : null;
  // See changes on an agent's applied reply: that version against the one
  // before it, for anyone who may see what changed (or list the history).
  const seeReplyChanges = config.mode === 'published' && !config.isLanding && (historyEnabled || config.changesVisible)
    ? (n) => { if (Number(n) > 0) changeComparison(true, { to: Number(n) }); }
    : null;
  const narrow = useNarrowViewport({ bodyClass: 'tdoc-narrow' });
  // The frame's address carries this page's embed key (sheet-embed.js).
  const [frameSrc] = useState(() => embedFrameSrc(boot.frameSrc));
  const reanchorRef = useRef(null);
  const bridgeRef = useRef(null);
  const editorRef = useRef(null);
  const diagramApplyRef = useRef(null);
  const demoRewriteWait = useRef(null);
  const suggestRef = useRef(null);
  const openAskRef = useRef(null);
  const [diagram, setDiagram] = useState(null);
  const [visualOpen, setVisualOpen] = useState(false);
  // Slides presenting: full screen like a visual, but commenting stays on.
  const [presenting, setPresenting] = useState(false);
  // + Comment and double-tap Option start a pick in the doc frame
  // (selection/pick-gesture.js); the frame answers with a selection, a
  // whole-document request, or a cancel.
  const [docPicking, setDocPickingState] = useState(false);
  const docPickingRef = useRef(false);
  const setDocPicking = useCallback((on) => { docPickingRef.current = on; setDocPickingState(on); }, []);
  const startDocumentCommentRef = useRef(null);
  const [composer, setComposer] = useState(null);
  // A visitor writes before signing in. Bring that draft and its quote back
  // after the auth redirect (the sign-in window was blocked), so sending
  // never discards the work they just did: signed in, the foot says it is
  // saved and one Post sends it; back without signing in (the browser's
  // Back), it says Post signs in. Never posted by itself.
  useEffect(() => {
    if (!(config.identity ? config.canComment : config.signInToComment)) return;
    let saved;
    try {
      const key = commentSignInDraftKey(config);
      saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      sessionStorage.removeItem(key);
    } catch { return; }
    if (!saved || !Number.isFinite(saved.at) || Date.now() - saved.at > COMMENT_SIGNIN_DRAFT_MAX_AGE_MS
      || !saved.selection || (saved.selection.kind && !['text', 'element', 'document'].includes(saved.selection.kind))
      || typeof saved.text !== 'string') return;
    setComposer({ ...saved.selection, draftText: saved.text, restored: true });
  }, [config.identity, config.canComment, config.signInToComment, config.slug, config.version]);
  // A sign-in running in its own window for the comment in the composer
  // (sign-in-popup.js): { reopen, cancel, held }, `held` being the composer
  // it was started from.
  const signInWaitRef = useRef(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  // The composer replaced or gone by any road (a click in the doc, a new
  // selection, + Comment, a mode change, × / Esc): the held post is
  // abandoned. Its sign-in is called off and nothing posts after it; the
  // words stay for their passage, as any closed draft.
  useEffect(() => {
    const wait = signInWaitRef.current;
    if (!wait || wait.held === composer) return;
    abandonHeldSignIn(wait);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer]);
  const abandonHeldSignIn = (wait) => {
    let stored = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(commentSignInDraftKey(config)) || 'null');
      sessionStorage.removeItem(commentSignInDraftKey(config));
    } catch {}
    if (stored && typeof stored.text === 'string' && wait.held) rememberClosedDraft(composerDraftKey(wait.held), stored.text);
    if (signInWaitRef.current === wait) signInWaitRef.current = null;
    wait.cancel();
  };
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
  // Ask AI's one draft, Ask's question and Edit's instruction alike: it
  // outlives switching mode and closing the panel.
  const [askAiDraft, setAskAiDraft] = useState('');
  // Edit's unchecked pending comments, kept here for the same reason.
  const [askAiUnchecked, setAskAiUnchecked] = useState([]);
  // Ask/Edit v2 remembers the agent picked last (the chip), per browser:
  // only where the server turned it on for this person (canSuggest), so a
  // pinned flag changes nothing for anybody else.
  const rememberAskAgent = isFeatureOn('askEditV2') && Boolean(config.canSuggest);
  const [askAiTargetKey, setAskAiTargetKeyState] = useState(() => (rememberAskAgent ? readStored('tdoc-ask-agent') || '' : ''));
  const setAskAiTargetKey = (key) => { setAskAiTargetKeyState(key); if (rememberAskAgent) writeStored('tdoc-ask-agent', key); };
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
  const [arrival, setArrival] = useState(() => {
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
  // The comments filter: Open (the default), Replied, Resolved, All — the
  // same control and rule as the feedback widget (comment-query.js), the
  // choice remembered per doc. A doc an agent just revised shows All for
  // that visit, without making it the choice.
  const listPrefs = useCommentListPrefs(config.slug, {
    initialFilter: new URLSearchParams(location.search).get('revised') ? 'all' : null,
  });
  const commentFilter = listPrefs.filter;
  // Shown, not remembered: a link revealing a thread, a resolve.
  const setCommentFilterState = useCallback((next) => listPrefs.setFilter(next, { remember: false }), [listPrefs.setFilter]);


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

  // A page that published itself in place (modeless autosave, a sheet's
  // column width) comments on the version it is now.
  const commentVersionNow = useCallback(() => Math.max(Number(config.version) || 0, ownVersionRef.current), [config.version]);
  const comments = useComments({
    slug: config.slug,
    version: config.version,
    versionNow: commentVersionNow,
    onUnauthorized: signIn,
    demo: !!config.demoComments,
    identity: config.identity,
  });
  // The homepage demo: the real @agent, handoff line and Ask AI, against a
  // simulated agent (demo-agent.js) that writes only into the demo comments.
  const demoAgents = Boolean(config.demoComments);
  // The homepage's scripted Edit (demo-agent.js DEMO_REWRITES): the frame
  // plays it (demoPlayRef, set once the bridge exists); the panel shows its
  // prompt, fixed, and the sign-up call to action once done. On a phone the
  // drawer gives way to a slim bar while it plays (demoBar).
  const [demoRewrite] = useState(() => (demoAgents && isFeatureOn('demoEditRewrite')
    ? DEMO_REWRITES[config.slug] || null : null));
  const [demoRewriteState, setDemoRewriteState] = useState('idle');
  const [demoRewriteResets, setDemoRewriteResets] = useState(0);
  const [demoBar, setDemoBar] = useState(false);
  const demoPlayRef = useRef(null);
  const demoBackend = useMemo(() => (demoAgents && comments.demoUpdate
    ? createDemoBackend({ update: comments.demoUpdate, rewrite: demoRewrite ? {
      ...demoRewrite,
      play: () => (demoPlayRef.current ? demoPlayRef.current() : Promise.resolve(false)),
      onDone: (ok) => {
        setDemoRewriteState(ok ? 'done' : 'idle');
        if (!ok) setDemoBar(false);
      },
    } : null }) : null), [demoAgents, comments.demoUpdate, demoRewrite]);
  useEffect(() => () => demoBackend?.dispose(), [demoBackend]);
  // The three write endpoints the agent flows use, or the demo's stand-ins.
  const agentApi = demoBackend || { handOff, publishAsk };
  // A signed-out demo comment is "you"'s (use-comments.js demoAuthor).
  const handoffViewer = useMemo(() => [config.identity?.login || (demoAgents ? 'you' : undefined), ...(config.identity?.linked_actor_keys || [])], [config.identity, demoAgents]);
  const commentArea = useCommentArea({
    comments: comments.comments, slug: config.slug, selectedId: openCommentId,
    filter: commentFilter, sort: listPrefs.sort, search: listPrefs.search,
    handoffViewer, isOwner: Boolean(config.isOwner),
    // Read state is kept on the server per person; the demo has nobody.
    syncSeen: Boolean(config.identity) && !config.demoComments,
  });
  const autoReadEnabled = commentArea.autoRead;

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
    if (!config.canComment && !config.signInToComment) {
      bridgeRef.current?.({ type: 'tdoc:clearPending' });
      return;
    }
    // Modeless editing: a comment on an element (a sheet's cell, row or
    // column; the cell pill, ⌘⌥M, a cell or column menu) anchors to what is
    // on screen, which may be a draft: a cell just typed, a row just
    // inserted. The draft publishes first, as the selection bubble's Comment
    // does for text (modeless-edit.jsx), so the comment is filed on a
    // version that has it. If it cannot publish (someone else published),
    // no composer: the conflict notice says what to do.
    const current = editorRef.current;
    if (selection?.kind === 'element' && current?.modeless) {
      current.publishFirst().then(({ published, conflict }) => {
        if (published) { setComposer(selection); return; }
        bridgeRef.current?.({ type: 'tdoc:clearPending' });
        showToast(conflict
          ? 'Someone else just edited this doc, so your changes are not published yet. Open the latest version (Show latest, at the top) to resolve that, then comment.'
          : 'Your changes are not published yet, so this comment could not be anchored. Try again in a moment.', true);
      }).catch(() => {
        bridgeRef.current?.({ type: 'tdoc:clearPending' });
        showToast('Could not publish your changes before commenting', true);
      });
      return;
    }
    setComposer(selection);
  }, [comments.moveAnchor, config.canComment, config.signInToComment, showToast]);

  const sendToFrame = useCallback((message) => bridgeRef.current?.(message), []);
  // Download: Word, CSV and Excel are built from the document's HTML, which
  // the frame sends; what the doc is (a sheet, or prose) comes with the
  // frame's ready message.
  const exportHtml = useMemo(() => createExportHtmlRequest(sendToFrame), [sendToFrame]);
  const [docShape, setDocShape] = useState({ sheets: 0, sheetDoc: false });
  // Each page the frame loads (first load, Discard, a save): the Markdown
  // view reopens on it.
  const [frameEpoch, setFrameEpoch] = useState(0);
  // The signed-out homepage remembers nothing about a visitor's view.
  const sheetHandlers = useSheetView({ slug: config.slug, send: sendToFrame, persist: !(config.isLanding && !config.identity), canEdit: Boolean(config.canEdit) });
  const [embedsHeld, setEmbedsHeld] = useState(false);
  const pageRef = useRef(null);
  pageRef.current = { slug: config.slug, version: Number(config.version) || 0, latest: Math.max(...(config.versions || []).map((v) => Number(v.n) || 0), Number(config.version) || 0) };
  // Sheets embedded in the page (flag sheetEmbeds): the frame asks, this
  // fetches as the reader and answers on the request's own port.
  const sheetEmbed = useMemo(() => createSheetEmbedHandler({
    enabled: () => isFeatureOn('sheetEmbeds'),
    page: () => pageRef.current,
    onPageUnattributed: () => { if (config.isOwner) setEmbedsHeld(true); },
  }), []);
  const embedsAllowed = useCallback(() => {
    setDialog(null);
    setEmbedsHeld(false);
    showToast('Sheet embeds allowed on this page');
    if (bridge.frameRef.current) bridge.frameRef.current.src = embedFrameSrc(boot.frameSrc, true);
  }, [boot.frameSrc, showToast]);
  const modelessRef = useRef(null);
  const bridge = useFrameBridge({
    // Modeless editing (flag modelessEdit; document/modeless-edit.jsx).
    'tdoc:bubble': (message) => modelessRef.current?.handlers['tdoc:bubble'](message),
    'tdoc:slash': (message) => modelessRef.current?.handlers['tdoc:slash'](message),
    'tdoc:swapped': (message) => modelessRef.current?.handlers['tdoc:swapped'](message),
    ...sheetHandlers,
    'tdoc:sheetEmbed': sheetEmbed,
    'tdoc:demoRewriteDone': (message) => {
      const pending = demoRewriteWait.current;
      if (pending && pending.id === message.id) pending.resolve(message.ok === true);
    },
    'tdoc:visualState': (message) => setVisualOpen(message.open === true),
    'tdoc:presentState': (message) => setPresenting(message.open === true),
    'tdoc:selection': (message) => { setDocPicking(false); selectFromFrame(message); },
    // A pick (+ Comment, double-tap Option) that landed on nothing in
    // particular: a comment on the whole document. Nothing else is taken
    // from the message (the doc's own scripts can post as the frame).
    // Only while a pick this shell started is under way.
    'tdoc:pickNothing': () => {
      if (!docPickingRef.current) return;
      setDocPicking(false);
      startDocumentCommentRef.current?.(false);
    },
    'tdoc:pickCancelled': () => setDocPicking(false),
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
      // Ask AI's popover closes on a press outside it, but a press in the
      // document lands in the frame, where its outside-press listener never
      // hears it: the frame's dismissal closes it, as it closes a card. The
      // typed question is the page's (askAiDraft), so it is there on reopen.
      setHandoffDetailsOpen(false);
    },
    'tdoc:exportHtml': (message) => exportHtml.handle(message),
    'tdoc:ready': (message) => {
      setVisualOpen(false);
      setDocShape({ sheets: Number(message.sheets) || 0, sheetDoc: message.sheetDoc === true, slides: Number(message.slides) || 0 });
      setFrameEpoch((n) => n + 1);
      setSupportsTheme(message.supportsTheme === true);
      const storedTheme = readStored('tdoc-theme');
      const nextTheme = storedTheme || (message.defaultTheme === 'dark' ? 'dark' : 'light');
      setTheme(nextTheme);
      if (message.supportsTheme === true) bridge.send({ type: 'tdoc:theme', theme: nextTheme });
      bridge.send(editorRef.current?.modeMessage?.() || { type: 'tdoc:mode', mode: editorRef.current?.mode || 'read', elementComment: !config.isLanding, areaSelect: !config.isLanding && isFeatureOn('feedbackAreaSelect') });
      sendFooterInsetRef.current();
      if (marksHiddenRef.current) bridge.send({ type: 'tdoc:marksHidden', hidden: true });
      comments.refresh();
      suggestRef.current?.frameHandlers['tdoc:ready']();
    },
    // AI suggestions in the doc (flag askEditV2; suggestions.js).
    'tdoc:suggestShown': (message) => suggestRef.current?.frameHandlers['tdoc:suggestShown'](message),
    'tdoc:suggestRect': (message) => suggestRef.current?.frameHandlers['tdoc:suggestRect'](message),
    // A click on a suggestion in the doc picks it; Accept / Reject stay in
    // the shell (the doc's own scripts can post as the frame), and focus
    // stays where it is.
    'tdoc:suggestAction': (message) => {
      const s = suggestRef.current;
      if (!s?.enabled || message.action !== 'focus') return;
      s.pick(String(message.id));
    },
    'tdoc:suggestKey': () => openAskRef.current?.(),
    // Option, Esc, C and H pressed in the doc: the shell's own keys (keyboard.js).
    'tdoc:key': (message) => {
      if (!['Alt', 'Escape', 'c', 'h'].includes(message.key)) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: message.key, bubbles: true, cancelable: true }));
    },
    // A change only an editor keeps for everyone (a sheet's column width or
    // wrap, made in Read or Comment mode): the doc goes into Edit mode, the
    // change lands there, and Save / Discard are the editor's own. Nothing
    // is written without that Save, so a doc's own script asking is harmless.
    'tdoc:requestMode': (message) => {
      const current = editorRef.current;
      if (message.mode !== 'edit' || !config.canEdit || !current || current.mode === 'edit') return;
      current.changeMode('edit');
      showToast('Edit mode: Save to keep this for everyone, or Discard');
    },
    // A sheet's column width set in Read or Comment mode by someone who may
    // edit the doc: saved as a new version at once, through the editor's own
    // document request and save (same checks, same author), without a mode
    // change or a reload. The frame batches a burst of resizes into one
    // request, waits for the answer before it asks again, and takes the
    // widths back when the save fails.
    'tdoc:sheetLayoutSave': async () => {
      const current = editorRef.current;
      const reply = (ok) => bridgeRef.current?.({ type: 'tdoc:sheetLayoutSaved', ok });
      if (!config.canEdit || config.isLanding || !current) { reply(false); return; }
      const base = Math.max(Number(config.version) || 0, ownVersionRef.current);
      try {
        const result = await current.saveInPlace(base);
        const n = Number(result?.version) || 0;
        if (!n) throw new Error('Could not save');
        ownVersionRef.current = n;
        setOwnVersion({ n, created: new Date().toISOString(), source: 'browser', ...(config.identity?.login ? { author: config.identity.login } : {}) });
        bridgeRef.current?.({ type: 'tdoc:editRebase' });
        reply(true);
        showToast('Column width saved');
      } catch (error) {
        reply(false);
        if (error.status === 409 && error.body?.error === 'version_conflict') showToast('This doc has a newer version. Open it to change column widths.', true);
        else if (error.status === 409 && error.body?.error === 'save_in_progress') showToast('The doc was just updated. Try again in a moment.', true);
        else showToast(error.message || 'Could not save the column width', true);
      }
    },
    'tdoc:editState': (message) => editorRef.current?.frameHandlers.editState(message),
    'tdoc:editBaseline': (message) => editorRef.current?.frameHandlers.editBaseline(message),
    'tdoc:editDraft': (message) => editorRef.current?.frameHandlers.editDraft(message),
    'tdoc:editSnapshot': (message) => editorRef.current?.frameHandlers.editSnapshot(message),
    'tdoc:editDocument': (message) => editorRef.current?.frameHandlers.editDocument(message),
    'tdoc:copyText': (message) => copyText(message.text || ''),
    'tdoc:sendToApp': (message) => {
      if (!config.isLanding) return;
      const link = sendToAppLink(message.app, message.text);
      if (!link) return;
      copyText(message.text);
      showToast(`Prompt copied. Opening ${link.name}…`);
      openAppLink(link.href);
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

  // The footer is fixed over the frame's bottom edge and reveals at full
  // scroll. Ask the frame to leave that much blank space after the document
  // (frame-probe.js tdoc:footerInset), so the footer never covers the last
  // lines of a doc that sets its own padding. Constant while reading, so the
  // footer showing cannot change the doc height; none in full-bleed mode,
  // where the footer stays hidden.
  const footerRef = useRef(null);
  const fullBleed = bridge.layout.fullBleed;
  const sendFooterInset = () => {
    const el = footerRef.current;
    bridge.send({ type: 'tdoc:footerInset', px: !el || fullBleed ? 0 : Math.ceil(el.offsetHeight) });
  };
  const sendFooterInsetRef = useRef(sendFooterInset);
  sendFooterInsetRef.current = sendFooterInset;
  useEffect(() => { sendFooterInsetRef.current(); }, [fullBleed]);
  useEffect(() => {
    const el = footerRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => sendFooterInsetRef.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The scripted Edit's run in the frame (frame-probe.js tdoc:demoRewrite):
  // resolves once the paragraph is rewritten, false if it isn't on the page.
  // Agent activity opens so its row walks delivered → on it → replied as the
  // doc changes. On a phone the drawer would cover the paragraph: it closes
  // and a slim bar ("Editing…", then the call to action) takes its place,
  // and the paragraph is brought above that bar.
  const demoBand = () => {
    // The part of the frame the visitor can see: below the bar and, on a
    // phone, above the slim bar; on a desktop, below the Ask AI popover (with
    // room for the call to action it grows by), which would otherwise cover
    // the paragraph's right end. The frame brings the paragraph into it.
    const frame = bridge.frameRef.current?.getBoundingClientRect();
    const bar = document.querySelector('.tdoc-bar')?.getBoundingClientRect();
    const slim = narrow ? document.querySelector('.tdoc-demo-rewrite-bar')?.getBoundingClientRect() : null;
    const drawer = narrow && !slim ? document.getElementById('tdoc-comment-layer')?.getBoundingClientRect() : null;
    const below = slim && slim.top > 0 ? slim.top - 8 : drawer && drawer.top > 0 ? drawer.top : window.innerHeight;
    const popover = narrow ? null : document.querySelector('.tdoc-ask-panel')?.getBoundingClientRect();
    const above = Math.max(bar ? bar.bottom : 0, popover && popover.height ? popover.bottom + 130 : 0);
    const top = frame ? Math.max(0, above - frame.top) : 0;
    const bottom = frame ? Math.min(frame.height, below - frame.top) : 0;
    return { top, bottom };
  };
  demoPlayRef.current = demoRewrite ? () => new Promise((resolve) => {
    demoRewriteWait.current?.resolve(false);
    const id = `rewrite_${Date.now().toString(36)}`;
    const timer = setTimeout(() => finish(false), 15000);
    function finish(ok) {
      clearTimeout(timer);
      if (demoRewriteWait.current?.id === id) demoRewriteWait.current = null;
      resolve(ok);
    }
    demoRewriteWait.current = { id, resolve: finish };
    setDemoRewriteState('running');
    setAgentActivityOpen(true);
    const play = () => bridge.send({ type: 'tdoc:demoRewrite', id, before: demoRewrite.before, after: demoRewrite.after, view: demoBand() });
    if (narrow) {
      // The drawer (the comment drawer's Ask AI tab, or the bar's Ask AI
      // drawer on the site pages, which have no comment button) slides away
      // (.2s) and the slim bar is in place before the paragraph is measured
      // against it.
      setDrawerOpen(false);
      setHandoffDetailsOpen(false);
      setDemoBar(true);
      setTimeout(play, 260);
    } else play();
  }) : null;
  // Done: the slim bar now holds the call to action (it may have changed
  // height), so the paragraph is brought above it again.
  useEffect(() => {
    if (!demoBar || demoRewriteState !== 'done') return undefined;
    const id = requestAnimationFrame(() => bridge.send({ type: 'tdoc:demoRewriteShow', view: demoBand() }));
    return () => cancelAnimationFrame(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoBar, demoRewriteState]);
  // While the rewritten paragraph is on show, the phone drawer's backdrop
  // stops dimming the page above it.
  useEffect(() => {
    if (!demoRewrite) return undefined;
    if (demoRewriteState === 'idle') delete document.body.dataset.tdocDemoRewrite;
    else document.body.dataset.tdocDemoRewrite = demoRewriteState;
    return undefined;
  }, [demoRewrite, demoRewriteState]);
  // Undo: the paragraph back, and Edit as it was before Send (a fresh form;
  // on a phone, the drawer's Ask AI tab again).
  const undoDemoRewrite = () => {
    bridge.send({ type: 'tdoc:demoRewriteUndo' });
    setDemoRewriteState('idle');
    setDemoRewriteResets((n) => n + 1);
    if (demoBar) {
      setDemoBar(false);
      if (unifiedEntry) { setDrawerTab('ask'); setDrawerOpen(true); } else setHandoffDetailsOpen(true);
    }
  };

  const disableCommentSelection = useCallback(() => {
    setComposer(null);
    setOpenCommentId(null);
    setOpenClusterKey(null);
    setDrawerOpen(false);
    bridge.send({ type: 'tdoc:clearPending' });
  }, [bridge.send]);

  // Ask/Edit v2 (flag askEditV2): one Ask AI input that answers or edits;
  // tdoc AI's edits show in the doc to accept (publish) or reject. The owner and
  // editors only, on the latest version.
  const [askEditFlag] = useState(() => isFeatureOn('askEditV2'));
  const suggestOn = askEditFlag && Boolean(config.canSuggest) && config.mode === 'published' && !demoAgents;
  const suggestions = useSuggestions({
    slug: config.slug,
    version: config.version,
    enabled: suggestOn,
    send: bridge.send,
    onToast: showToast,
    onPublished: (v) => { location.href = `/d/${encodeURIComponent(config.slug)}/v/${v}`; },
    onAccepted: () => comments.refresh(),
  });
  suggestRef.current = suggestions;

  // The page is a version it published itself (modeless autosave) or was
  // swapped to in place: as after a sheet's column width (ownVersion above).
  const revisedPending = useRef(0);
  const modelessFlagRef = useRef(false);
  const adoptVersion = useCallback((n) => {
    // The agent's version the owner was waiting for, swapped in: the same
    // arrival as ?revised=1 (its answered thread opens, the toast says so).
    if (revisedPending.current && n >= revisedPending.current) {
      revisedPending.current = 0;
      arrivedRef.current = false;
      setArrival('revised');
    }
    if (!n || n <= ownVersionRef.current) return;
    ownVersionRef.current = n;
    setOwnVersion({ n, created: new Date().toISOString(), source: 'browser' });
    // An address naming the old version would reopen it on reload.
    if (/\/v\/\d+\/?$/.test(location.pathname)) {
      history.replaceState(history.state, '', `/d/${encodeURIComponent(config.slug)}${location.search}${location.hash}`);
    }
  }, [config.slug]);
  // Modeless editing (flag modelessEdit): someone who may edit a prose doc
  // or a sheet types into it (a sheet's cells are always editable for them:
  // click selects, typing or a double-click edits, and the same autosave
  // publishes it); slides keep Read / Comment / Edit.
  const modelessFlag = isFeatureOn('modelessEdit');
  const convertToSheetFlag = isFeatureOn('convertToSheet');
  modelessFlagRef.current = modelessFlag;
  const modeless = modelessFlag && Boolean(config.canEdit) && !config.isLanding && !boot.oldVersion
    && !docShape.slides;
  const editor = useDocumentEditor({
    boot,
    config,
    frameRef: bridge.frameRef,
    send: bridge.send,
    showToast,
    onDisableCommentSelection: disableCommentSelection,
    modeless,
    onPublished: (result) => { adoptVersion(Number(result?.version) || 0); flashEdited(); },
  });
  editorRef.current = editor;
  // Edit as Markdown (flag markdownEditMode): a prose doc being edited.
  const markdown = useMarkdownEdit({
    available: isFeatureOn('markdownEditMode') && Boolean(config.canEdit) && !config.isLanding && !boot.oldVersion
      && editor.mode === 'edit' && frameEpoch > 0 && markdownEligible(docShape),
    editor,
    send: bridge.send,
    login: config.identity?.login,
    frameEpoch,
    showToast,
    version: Math.max(Number(config.version) || 0, Number(ownVersion?.n) || 0),
  });

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
    const open = Boolean((cardOpen || composer || handoffDetailsOpen) && !reanchorId);
    bridge.send({ type: 'tdoc:uiOpen', open });
  }, [bridge.send, composer, openClusterKey, openCommentId, reanchorId, narrow, drawerOpen, handoffDetailsOpen]);

  // Whatever opened a comment (its pin, a link to it, an arrival, the list),
  // the frame learns which one is open: it marks what the comment is on (a
  // text highlight, a sheet's cell) and unmarks it once none is. An id the
  // frame already has active changes nothing there, so focusComment's own
  // message and this one do not repeat a scroll.
  const openAnchorRef = useRef(null);
  useEffect(() => {
    if (openAnchorRef.current === openCommentId) return;
    openAnchorRef.current = openCommentId;
    bridge.send({ type: 'tdoc:focusAnchor', id: openCommentId || null });
  }, [bridge.send, openCommentId]);

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
  // The phone drawer is the list: whole-document comments first, then the
  // rest in document order (by where their pins sit), or newest / oldest.
  const drawerComments = useMemo(() => {
    const docY = new Map(bridge.layout.pins.map((pin) => [pin.id, pin.docY]));
    const ordered = sortThreads(shownComments, listPrefs.sort, { positionOf: (comment) => docY.get(comment.id) ?? null });
    return groupBy(ordered, (comment) => (isDocumentComment(comment) ? 'document' : 'body'), { first: 'document' })
      .flatMap((group) => group.items);
  }, [shownComments, listPrefs.sort, bridge.layout.pins]);
  // The same order as the shared panel's groups (comments/panel/): the whole
  // document first, then the body in document order.
  const panelGroups = useMemo(() => {
    const whole = drawerComments.filter(isDocumentComment);
    const body = drawerComments.filter((comment) => !isDocumentComment(comment));
    const both = whole.length && body.length;
    return [
      { key: 'document', label: both ? 'On this document' : null, items: whole },
      { key: 'body', label: both ? 'In the text' : null, items: body },
    ];
  }, [drawerComments]);
  const visibleCommentsById = commentArea.shownById;
  const seenMap = commentArea.seenMap;
  // Lost pins are seats, not anchors: they give the card somewhere to be drawn
  // while it still reads — and styles — as unanchored, with the way back.
  const pinIds = useMemo(
    () => new Set(bridge.layout.pins.filter((pin) => !pin.lost).map((pin) => pin.id)),
    [bridge.layout.pins],
  );
  // Flag stableBlockIds: anchored to the block they were made on, whose
  // words have since changed (the frame's `edited` pins).
  const editedPassageIds = useMemo(
    () => new Set(bridge.layout.pins.filter((pin) => pin.edited && !pin.lost).map((pin) => pin.id)),
    [bridge.layout.pins],
  );
  const clusters = useMemo(
    () => layoutPins(bridge.layout.pins, bridge.layout.docHeight),
    [bridge.layout.docHeight, bridge.layout.pins],
  );

  const setCommentFilter = useCallback((next) => {
    listPrefs.setFilter(next);
    if (next === 'all') return;
    // Whatever the filter now hides: cancel a pending reveal, and close the
    // card, cluster or re-anchor that showed it.
    const hidden = (id) => {
      const c = commentsById.get(id);
      return Boolean(c) && !matchesFilter(c, next);
    };
    setDeepTarget(null);
    if (hidden(openCommentId)) {
      setOpenCommentId(null);
      bridge.send({ type: 'tdoc:focusAnchor', id: null });
    }
    const openCluster = clusters.find((cluster) => cluster.key === openClusterKey);
    if (openCluster?.items.some(({ comment }) => hidden(comment.id))) setOpenClusterKey(null);
    if (hidden(reanchorId)) setReanchorId(null);
  }, [bridge.send, clusters, commentsById, openClusterKey, openCommentId, reanchorId, listPrefs.setFilter]);

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
    if (!reanchorId) bridge.send({ type: 'tdoc:reanchorMode', active: false });
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
    if (!matchesFilter(root, commentFilter)) {
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
    // Closed without posting (× or Esc): the held signed-out post is
    // dropped and its sign-in window called off, so signing in later never
    // posts words the person walked away from. (Any other way the composer
    // goes or is replaced is caught by the effect on `composer` above.)
    if (signInWaitRef.current) abandonHeldSignIn(signInWaitRef.current);
    else { try { sessionStorage.removeItem(commentSignInDraftKey(config)); } catch {} }
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
    // A signed-out reader can select, copy, and write first. Asking to sign
    // in happens on the action that would actually send their words.
    if (!config.identity && config.signInToComment) {
      const held = composer;
      // One held post at a time: an earlier wait (another passage) ends.
      if (signInWaitRef.current) abandonHeldSignIn(signInWaitRef.current);
      // Kept for the page's own sign-in (a redirect, when the window is
      // blocked) and for a post that fails after signing in.
      try { sessionStorage.setItem(commentSignInDraftKey(config), JSON.stringify({ text, selection: held, at: Date.now() })); } catch {}
      // Signed in already (another tab, since this page loaded)? Asked
      // alongside opening the window, so the window still comes from this
      // click. Then nothing posts by itself as whichever account that is:
      // the page reloads as them and the words wait in the composer.
      const already = signedInIdentity().catch(() => null);
      // Sign in in a window of its own, the composer staying as it is
      // (the widget does the same with its tdoc window). Blocked, or no
      // provider door here: the page's own sign-in, as before.
      const href = signInHref(config);
      const wait = href ? startSignInPopup(href) : null;
      if (!wait) { if (await already) { location.reload(); return; } signIn(); return; }
      wait.held = held;
      signInWaitRef.current = wait;
      if (await already) { signInWaitRef.current = null; wait.cancel(); location.reload(); return; }
      try {
        await wait.done;
      } catch {
        // Called off (× / Esc, the composer replaced) or timed out.
        return;
      } finally {
        if (signInWaitRef.current === wait) signInWaitRef.current = null;
      }
      // Still the comment the person is waiting on: the same composer, and
      // the same words held. Anything else was abandoned on the way.
      let stored = null;
      try { stored = JSON.parse(sessionStorage.getItem(commentSignInDraftKey(config)) || 'null'); } catch {}
      if (composerRef.current !== held || !stored || stored.text !== text) return;
      // Signed in: tdoc says so for this browser's cookie (never the
      // window's word). Post the held words as that person, then show the
      // page as them, with the new comment open.
      try {
        const value = await comments.addComment(held, text);
        if (!value?.id) return;
        try { sessionStorage.removeItem(commentSignInDraftKey(config)); } catch {}
        markCommented();
        const outcome = value.mention_outcome;
        if (outcome && (outcome.newcomers?.length || outcome.blocked?.length)) {
          // What became of an @mention has to be said here (a reload would
          // drop it): the comment shows from the POST's answer, open.
          closeComposer();
          reportMentions(value);
          setOpenCommentId(value.id);
          return;
        }
        const next = new URL(location.href);
        next.searchParams.set('comment', value.id);
        location.replace(next.href);
      } catch (error) {
        showToast(error?.message || 'Could not post the comment', true);
        if (error?.status === 403) {
          // Refused for this account: nothing to post later. The words stay
          // in the open composer, not held.
          try { sessionStorage.removeItem(commentSignInDraftKey(config)); } catch {}
          return;
        }
        // A passing failure: the words stay saved and come back in the
        // composer after the page reloads as the signed-in person.
        window.setTimeout(() => location.reload(), 2000);
      }
      return;
    }
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
    const editor = target || (opts.sendToAgent && canSendToAgent ? opts.recipient || composerPick : null);
    if (editor && canSendToAgent) await editOn(value.id, editor, selection?.text || null);
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
  const editOn = async (commentId, target, passage = null) => {
    setSendToAgentBusy(true);
    try {
      // Ask/Edit v2: its edits come back as suggestions in the doc, not as a
      // new version. Everyone else keeps the handoff below, unchanged.
      if (handsBackSuggestions(target)) {
        // The stock note: the payload keeps out the comment's words
        // (handoffEvent's rule); the agent reads the thread.
        const sent = await postNotifyHandoff({ slug: config.slug, comment_ids: [commentId], instruction: 'address this comment', recipient: target, reply_as: 'suggestions' });
        const name = agentDisplayName(target) || readableHandle(target) || 'agent';
        if (sent?.delivery?.status === 'failed') {
          showToast(`Sent — not delivered${sent.delivery.error ? `: ${deliveryErrorText(sent.delivery.error)}` : ''}`, true);
        } else if (sent?.reason === 'agent_has_last_word') {
          showToast('Nothing sent: an agent already replied to this comment.');
        } else if (sent?.reply_as !== 'suggestions') {
          // The server dropped it (dev mode went off in another tab): a plain handoff.
          showToast(`Sent to ${name}`);
        } else {
          suggestions.awaitAgent({
            commentId,
            passage,
            label: target.provider === 'local' ? `${name} is working on your computer…` : `${name} is working on it…`,
            settled: () => ['replied', 'failed'].includes(handoffSurfaceState(comments.latest.current.find((c) => c.id === commentId))),
          });
          showToast(`Sent to ${name}. Its edits will show here as suggestions.`);
        }
        // Not awaited: it has been sent, and a failed read must not say otherwise.
        comments.refresh().catch(() => {});
        return;
      }
      const body = await agentApi.handOff(config.slug, { ask_only: false, comment_id: commentId, recipient: target });
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
      const body = await agentApi.handOff(config.slug, { ask_only: true, comment_id: commentId, question, passage, version: config.version, recipient: recipientFor(target) });
      if (target.tdoc_ai || demoAgents) {
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
      const body = await agentApi.handOff(config.slug, { ask_only: true, only_me: true, question, passage, version: config.version, recipient: recipientFor(target) });
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
      await agentApi.publishAsk(config.slug, ask.kind === 'tdoc-ai' ? 'ask' : 'my-agent', { askId: ask.askId, commentId: value.id });
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
    // The reply is posted, so its box is done: the sends below report on their
    // own (a toast, the thread). Waiting for them held the box on "Posting…"
    // through the whole delivery, three requests to Raft.
    // An agent named in a reply that may only answer: under this reply.
    if (opts.target && opts.askOnly && value?.id) {
      askOn(value.id, text, null, opts.target);
      return true;
    }
    // @agent on a reply re-hands the thread root (or the new reply if no root).
    if (opts.sendToAgent && canSendToAgent) {
      const handoffId = opts.handoffCommentId || value?.id;
      if (handoffId) editOn(handoffId, opts.recipient || composerPick);
    }
    return true;
  };

  // An edit does not re-resolve @mentions: the notified set is stamped on the
  // event that first carried the text, and nobody is notified twice for a
  // rewrite of words they were already told about.
  const editComment = async (id, text, base) => (await attempt(() => comments.edit(id, text, base))).ok;

  const reactTo = (commentId, emoji) => (!config.identity && config.signInToComment
    ? signIn() : attempt(() => comments.react(commentId, emoji)));
  // Resolving takes the thread out of the margin, so the card that owns the
  // button goes with it — close it rather than leaving a card pinned to
  // nothing.
  const resolveComment = async (commentId, resolved) => {
    if (!await attempt(() => comments.setResolved(commentId, resolved))) return;
    if (commentFilter !== 'all' && (resolved ? commentFilter !== 'resolved' : commentFilter === 'resolved')) setOpenCommentId(null);
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
  // Who may send is maySendToAgent (the server's rule): the owner or a team
  // member, not a guest of the team.
  const sendToAgentMay = maySendToAgent({ owner: config.isOwner, teamMember: Boolean(config.teamManage && !config.teamManage.guest) });
  const notifyQuery = Boolean(sendToAgentMay && !config.isLanding && config.mode !== 'local');
  const notifyViewer = (config.identity && (config.identity.account_id || config.identity.login)) || '';
  const notifyTargets = useNotifyTargets(config.slug, notifyQuery, notifyViewer);
  const hasNotifyTargets = Boolean(
    notifyTargets.ready
    && notifyTargets.available
    && notifyTargets.reason !== 'no_agent_bound'
    && (notifyTargets.default || (notifyTargets.candidates || []).length || notifyTargets.fallback),
  );
  const notifyEnabled = notifyQuery && (!config.teamManage || hasNotifyTargets);
  // The demo's Claude may "edit": its handoff runs the real status line.
  const canSendToAgent = Boolean(notifyEnabled && hasNotifyTargets) || demoAgents;
  // Who a comment's @agent can ask for suggestions (Ask/Edit v2). Not a team
  // agent: propose_edits refuses it (askEditV2Decide), so it keeps the plain
  // handoff. Not a local CLI other than claude: the daemon refuses to run a
  // suggestions handoff on one, since only claude can be kept from publishing.
  const handsBackSuggestions = (target) => Boolean(suggestOn && canSendToAgent && target && !target.tdoc_ai && !target.team_agent
    && !(target.provider === 'local' && target.cli !== 'claude'));
  // Resend / send elsewhere / the Send to agent dialog are real-only.
  const canNotify = Boolean(notifyEnabled && hasNotifyTargets) && !demoAgents;
  const defaultEditor = demoAgents ? DEMO_AGENT_CHOICES[0] : notifyTargets.default;
  // The commenter's OWN agent (my-agent.js), for Ask AI / @AI where the paper
  // plane does not reach one: anyone but the owner on their own doc, where
  // Send to agent and @agent already hand comments to the doc's agent. A
  // demo has no account to send from.
  const myAgentEnabled = Boolean(config.mode === 'published' && !config.isLanding && !config.demoComments);
  const askAiPanelEnabled = notifyEnabled || (myAgentEnabled && Boolean(config.identity)) || demoAgents;
  // Phones get one entry: the comment button's drawer carries an Ask AI tab,
  // and the top bar keeps only Share and ⋯ (flag: unifiedEntry).
  const [unifiedEntryFlag] = useState(() => isFeatureOn('unifiedEntry'));
  // Doc bar layout B (flag docTopbarB): the title opens the document's menu,
  // the right side is Ask AI · Comments · Share · avatar. Not the landing.
  const [topbarBFlag] = useState(() => isFeatureOn('docTopbarB'));
  const barB = topbarBFlag && !config.isLanding;
  // Not the landing (and the other site pages: /pricing, /start, ...): a
  // marketing page has no comments for a visitor, so a phone gets no comment
  // button there; Ask AI stays in the bar, as on desktop (Julie, 2026-11-22).
  const unifiedEntry = narrow && !config.isLanding && (askAiPanelEnabled || signedOutAsk) && unifiedEntryFlag;
  const [drawerTab, setDrawerTab] = useState('comments');
  const myAgent = useMyAgent(config.slug, myAgentEnabled && Boolean(config.identity));
  // The composer's @ list: agents that may edit this doc, then those that
  // may only answer (own, the team's), else tdoc AI (ai-answerer.js).
  const agentChoices = useMemo(() => (demoAgents ? DEMO_AGENT_CHOICES : config.identity ? composerAgents({
    canSendToAgent,
    notifyTargets,
    mine: myAgent.state ? { ...myAgent.state, tdoc_ai: Boolean(myAgent.state.tdoc_ai) && askEnabled } : null,
  }) : []), [demoAgents, config.identity, canSendToAgent, notifyTargets.default, notifyTargets.candidates, notifyTargets.fallback, myAgent.state, askEnabled]);
  // Who a composer means by default: the row the @ list shows on top. The
  // Send to agent dialog keeps the server's default.
  const composerPick = demoAgents
    ? agentChoices.find((agent) => defaultEditor && sameTarget(agent, defaultEditor)) || null
    : composerDefault(agentChoices, { evidence: defaultEditor });
  const askAiTargets = useMemo(() => {
    if (demoAgents) {
      return DEMO_AGENT_CHOICES.map((agent) => (agent.tdoc_ai
        ? { key: 'tdoc-ai', label: 'tdoc AI', target: TDOC_AI, tdocAi: true }
        : { key: targetKey(agent), label: agentDisplayName(agent), target: agent, tdocAi: false }));
    }
    const recent = [notifyTargets.default, ...(notifyTargets.candidates || [])].find((agent) => agent?.last_writer);
    const agents = orderedAskAiChoices([...(myAgent.state?.agents || []), ...(myAgent.state?.team_agents || [])], recent);
    return [
      ...agents.map((agent) => ({ key: targetKey(agent), label: agentDisplayName(agent, agents), target: agent, tdocAi: false })),
      ...(askEnabled || signedOutAsk ? [{ key: 'tdoc-ai', label: 'tdoc AI', target: TDOC_AI, tdocAi: true }] : []),
    ];
  }, [demoAgents, askEnabled, signedOutAsk, myAgent.state?.agents, myAgent.state?.team_agents, notifyTargets.default, notifyTargets.candidates]);
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
    // Ask/Edit v2: tdoc AI decides. A question gets the private answer as
    // before; a change comes back as suggestions in the doc.
    if (suggestOn && choice.tdocAi) {
      setAskAiBusy(true);
      if (!retryText) setAskAiDraft('');
      setAskAiTurns((turns) => [...turns, { id, question, target: choice.target, label: choice.label,
        kind: 'tdoc-ai', status: 'thinking', answer: '', askId: null, public: false }]);
      try {
        const body = await suggestions.request({ instruction: question, scope: { kind: 'doc' } });
        if (typeof body?.remaining === 'number') setAiRemaining(body.remaining);
        if (body?.kind === 'answer') {
          setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, askId: body.ask_id || null, answer: body.answer || '', status: 'answered' } : turn));
        } else {
          const n = body?.suggestion?.edits?.length || 0;
          setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, status: 'answered', suggested: true,
            answer: n ? `Suggested ${n} ${n === 1 ? 'change' : 'changes'} in the document${body.suggestion.summary ? `: ${body.suggestion.summary}` : '.'} Review them in the doc; Accept publishes a new version.`
              : 'I could not place an edit for that in the text. Say which part to change, quoting a few of its words.' } : turn));
          if (n) { setHandoffDetailsOpen(false); if (unifiedEntry) setDrawerOpen(false); }
        }
      } catch (error) {
        if (error.status === 429) setAiRemaining(0);
        setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, status: 'failed',
          error: error.status === 429 ? 'No free tdoc AI answers left.' : (error.message || 'Could not get an answer.') } : turn));
      } finally {
        setAskAiBusy(false);
      }
      return;
    }
    // Ask/Edit v2 with an agent that may edit this doc: the request is posted
    // as the viewer's whole-document comment and handed to that agent (the
    // existing handoff), asking for its edits as suggestions in the doc.
    if (suggestOn && !choice.tdocAi && canSendToAgent && !demoAgents
      && orderedAgentChoices(notifyTargets).some((t) => sameTarget(t, choice.target))) {
      setAskAiBusy(true);
      if (!retryText) setAskAiDraft('');
      setAskAiTurns((turns) => [...turns, { id, question, target: choice.target, label: choice.label,
        kind: 'agent', status: 'thinking', answer: '', askId: null, public: true, suggested: true }]);
      try {
        const comment = await comments.addComment({ kind: 'document' }, question);
        if (!comment?.id) throw new Error('Could not post the request');
        markCommented();
        const body = await postNotifyHandoff({ slug: config.slug, comment_ids: [comment.id], instruction: question, recipient: choice.target, reply_as: 'suggestions' });
        const failed = body?.delivery?.status === 'failed';
        // reply_as back: the server took it (dev mode can go off in another tab).
        const suggesting = body?.reply_as === 'suggestions';
        if (!failed && suggesting) suggestions.awaitAgent({ commentId: comment.id, label: choice.target.provider === 'local' ? `${choice.label} is working on your computer…` : `${choice.label} is working on it…` });
        setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, publicCommentId: comment.id,
          status: failed ? 'failed' : 'answered',
          error: failed ? `Not delivered to ${choice.label}.` : '',
          answer: suggesting ? `Sent to ${choice.label} ✓ Its edits will show in the doc as suggestions to accept or reject; any answer arrives as a reply to your comment.` : `Sent to ${choice.label} ✓` } : turn));
        comments.refresh();
      } catch (error) {
        setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, status: 'failed', error: error.message || 'Could not send it.' } : turn));
      } finally {
        setAskAiBusy(false);
      }
      return;
    }
    // A team agent answers for the team, never privately (worker
    // team_agent_not_private): the question is posted as the asker's comment
    // and the answer is its reply. The panel said so before Send.
    const inPublic = Boolean(!choice.tdocAi && choice.target.team_agent);
    setAskAiBusy(true);
    if (!retryText) setAskAiDraft('');
    setAskAiTurns((turns) => [...turns, { id, question, target: choice.target, label: choice.label,
      kind: choice.tdocAi ? 'tdoc-ai' : 'agent', status: 'thinking', answer: '', askId: null, public: inPublic }]);
    try {
      let commentId = null;
      if (inPublic) {
        const comment = await comments.addComment({ kind: 'document' }, question);
        if (!comment?.id) throw new Error('Could not post the question');
        commentId = comment.id;
        markCommented();
        setAiThinking({ id: commentId, label: choice.label, agent: true });
        setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? { ...turn, publicCommentId: commentId } : turn));
      }
      const body = await agentApi.handOff(config.slug, inPublic
        ? { ask_only: true, comment_id: commentId, question, version: config.version, recipient: recipientFor(choice.target) }
        : { ask_only: true, only_me: true, question, version: config.version, recipient: recipientFor(choice.target) });
      if (body?.ask) myAgent.addAsk(body.ask);
      if (typeof body?.remaining === 'number') setAiRemaining(body.remaining);
      setAskAiTurns((turns) => turns.map((turn) => turn.id === id ? {
        ...turn, askId: body?.ask?.ask_id || body?.ask_id || null,
        answer: body?.answer || body?.ask?.answer?.text || '',
        status: body?.ask && !body.ask.answer ? 'waiting' : 'answered',
      } : turn));
    } catch (error) {
      if (error.status === 429 && choice.tdocAi) setAiRemaining(0);
      if (inPublic) setAiThinking(null);
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
  const suggestContext = suggestOn ? {
    enabled: true,
    pendingFor: suggestions.commentPending,
    review: (id) => { if (narrow) setDrawerOpen(false); suggestions.review(id); },
  } : null;
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
      await agentApi.publishAsk(config.slug, turn.kind === 'tdoc-ai' ? 'ask' : 'my-agent', { askId: turn.askId, commentId });
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
  // The one Send to agent judgment both composers share (agent-choices.js):
  // ready with the agents that may edit, connect when this viewer could send
  // but nobody is linked, disabled with the reason when they cannot.
  const { setupHref: sendToAgentSetupHref, disabledReason: sendToAgentDisabledReason } = sendToAgentSetup({
    canSendToAgent, may: sendToAgentMay, notifyOn: notifyQuery, targets: notifyTargets, href: '/me?view=settings#agents',
  });
  const sendToAgentConnectPrompt = sendToAgentSetupHref ? CONNECT_AGENT_PROMPT : null;
  const sendToAgent = useMemo(() => sendToAgentState({
    canSendToAgent,
    choices: agentChoices,
    disabledReason: sendToAgentDisabledReason,
    connectPrompt: sendToAgentConnectPrompt,
    setupHref: sendToAgentSetupHref,
  }), [canSendToAgent, agentChoices, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref]);
  // What @ offers (agentChoices) and what tdoc AI has left / who is
  // answering where, for the composers and the cards.
  const agentMentions = useMemo(() => ({
    choices: agentChoices,
    disabledChoices: teamGuestsEnabled && config.teamManage?.guest ? (myAgent.state?.disabled_team_agents || []) : [],
    guestAction,
    preselected: composerPick,
    ai: { remaining: aiRemaining, thinking: aiThinking, offered: offersTdocAi },
    // An Only me question asked from a reply box, which shows its answer.
    privateReply: privateAskView && privateAskView.parentId ? privateAskView : null,
    onMakePublic: () => makePublicRef.current(),
    onClosePrivate: () => setPrivateAsk(null),
    // Ask/Edit v2: what the hint says about the named agent.
    suggestsFor: suggestOn ? handsBackSuggestions : null,
    // "Open as a document" on a feedback space: only the wording.
    fixesTheApp: Boolean(config.feedbackSpace),
    // The Send to agent control's one judgment (SendToAgentToggle).
    canSendToAgent,
    sendToAgentDisabledReason,
    connectAgentPrompt: sendToAgentConnectPrompt,
    agentSetupHref: sendToAgentSetupHref,
    sendToAgent,
  }), [suggestOn, canSendToAgent, agentChoices, composerPick, aiRemaining, aiThinking, offersTdocAi, privateAsk, privateAgentAsk, myAgent.state?.disabled_team_agents, teamGuestsEnabled, config.teamManage?.guest, guestAction, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref, sendToAgent]);
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
      // A resend that asks for suggestions: its edits arrive here, as from a first send.
      if (suggestOn && body?.reply_as === 'suggestions' && body?.delivery?.status !== 'failed') {
        const name = agentDisplayName(comment.handoff_to) || readableHandle(comment.handoff_to) || 'agent';
        suggestions.awaitAgent({
          commentId: comment.id,
          label: comment.handoff_to?.provider === 'local' ? `${name} is working on your computer…` : `${name} is working on it…`,
          settled: () => ['replied', 'failed'].includes(handoffSurfaceState(comments.latest.current.find((c) => c.id === comment.id))),
        });
      }
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

  // The bar's star: optimistic, put back if the server refuses. The same
  // POST /api/star as My docs, and the same 'tdoc-doc-state' message, so an
  // open My docs tab (and this doc in another tab) follows along.
  const toggleStar = async () => {
    const next = !starred;
    setStarred(next);
    try {
      await setDocumentStar(config.slug, next);
      showToast(next ? 'Starred - find it in My docs' : 'Star removed');
      try {
        new BroadcastChannel('tdoc-doc-state').postMessage({ type: 'star', slug: config.slug, starred: next });
      } catch {
        // Other tabs catch up on their next load.
      }
    } catch (error) {
      setStarred(!next);
      showToast(error?.message || (next ? 'Could not star this doc' : 'Could not remove the star'), true);
    }
  };
  useEffect(() => {
    if (!config.viewerStar || typeof BroadcastChannel !== 'function') return undefined;
    const channel = new BroadcastChannel('tdoc-doc-state');
    channel.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'star' && data.slug === config.slug) setStarred(Boolean(data.starred));
    };
    return () => channel.close();
  }, [config.viewerStar, config.slug]);

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

  // Convert to Sheet (flag convertToSheet): the doc as the editor would save
  // it, with its prose moved into a note under the title
  // (document/convert-to-sheet.js), published as the next version through
  // the same save as a column width, then opened. The current version stays
  // in the history; Restore there undoes it.
  const canConvertToSheet = convertToSheetFlag && Boolean(config.canEdit) && !config.isLanding && !boot.oldVersion
    && docShape.sheets > 0 && !docShape.sheetDoc && !docShape.slides;
  const convertToSheet = async () => {
    const current = editorRef.current;
    if (!current) throw new Error('The doc is still loading. Try again.');
    const { convertToSheetHtml } = await import('./document/convert-to-sheet.js');
    const base = Math.max(Number(config.version) || 0, ownVersionRef.current);
    let result;
    try {
      // Open comments on the prose that moves: its note is written open.
      const anchors = comments.comments.filter((c) => !c.deleted && c.status !== 'applied' && c.anchor).map((c) => c.anchor);
      result = await current.saveInPlace(base, (html) => convertToSheetHtml(html, { comments: anchors }).html);
    } catch (error) {
      if (error.code === 'draft_open') throw new Error('Save or discard your draft first.');
      if (error.status === 409 && error.body?.error === 'version_conflict') throw new Error('This doc has a newer version. Open it to convert.');
      if (error.status === 409 && error.body?.error === 'save_in_progress') throw new Error('The doc was just updated. Try again in a moment.');
      throw error;
    }
    const n = Number(result?.version) || 0;
    location.href = result?.url || `/d/${encodeURIComponent(config.slug)}${n ? `/v/${n}` : ''}`;
  };

  const download = () => {
    const anchor = document.createElement('a');
    anchor.href = `/d/${encodeURIComponent(config.slug)}/v/${config.version}/export?download=1`;
    anchor.download = `${config.slug}-v${config.version}.html`;
    anchor.click();
  };

  // The browser's print of the reading column, with the print rules
  // (doc-download.js).
  const printPdf = () => {
    const src = `/d/${encodeURIComponent(config.slug)}/v/${config.version}/export?download=0`;
    loadDownloads().then(({ printDocument }) => printDocument(src));
  };

  // Download as Word / Markdown / CSV / Excel.
  const versionBase = `${location.origin}/d/${encodeURIComponent(config.slug)}/v/${config.version}`;
  // Copy as Markdown: the same Markdown as Download Markdown (/export.md).
  // The fetch rides inside a ClipboardItem so Safari keeps the click's
  // permission to write; elsewhere the text is written when it arrives.
  const copyMarkdown = async () => {
    const text = fetch(`${versionBase}/export.md`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
    let copied = false;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
        copied = true;
      }
    } catch {}
    if (!copied) copied = await text.then(copyText, () => false);
    showToast(copied ? 'Copied as Markdown' : 'Copy failed', !copied);
  };

  const downloadAs = async (kind) => {
    const { buildSheetFile, buildWord, downloadBlob, downloadUrl } = await loadDownloads();
    if (kind === 'md') {
      downloadUrl(`${versionBase}/export.md`, `${config.slug}.md`);
      return;
    }
    showToast(kind === 'docx' ? 'Preparing the Word file…' : kind === 'xlsx' ? 'Preparing the Excel file…' : 'Preparing the CSV file…');
    try {
      const html = await exportHtml.request();
      if (kind === 'docx') {
        const blob = await buildWord(html, { title, slug: config.slug, docUrl: `${location.origin}/d/${encodeURIComponent(config.slug)}`, baseUrl: `${versionBase}/frame` });
        downloadBlob(blob, `${config.slug}.docx`);
      } else {
        const file = await buildSheetFile(html, kind, { slug: config.slug });
        downloadBlob(file.blob, file.filename);
      }
      setToast(null);
    } catch (error) {
      showToast(error?.message ? `Download failed: ${error.message}` : 'Download failed', true);
    }
  };

  // What Share copies: the doc's own address, which always opens the newest
  // version (Julie, 2026-10-13). A link to exactly this version is offered
  // as the secondary choice in the dialog.
  const shareUrl = config.isLanding
    ? `${location.origin}/`
    : `${location.origin}/d/${encodeURIComponent(config.slug)}`;
  // With version history the link to one version lives in the panel (Share
  // this version), not under Share.
  const versionUrl = config.isLanding || historyEnabled ? null : `${location.origin}/d/${encodeURIComponent(config.slug)}/v/${config.version}`;

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
          // modelessEdit: no navigation. The version is swapped into this
          // page (as for anyone) and the "revised" arrival is set here; only
          // a version that cannot be swapped in navigates (onSwapFailed).
          if (modelessFlagRef.current) {
            revisedPending.current = latest;
            setHandoff({ state: 'idle', copiedAt: null });
            setLiveLatest(latest);
            return;
          }
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

  // Threads stay current the way the feedback widget's do, through the same
  // hook (use-comment-feed.js): every 15 s while the tab is visible, at once
  // when it comes back, never while somebody is typing or the composer is
  // open, and on the Refresh button in the side list and drawer. An agent's reply appears
  // on an open doc without a reload.
  // A quiet doc backs off to a minute, as live sync used to; a handoff still
  // on its way (`sent`) keeps it at 15 s until the agent answers.
  const outstandingHandoffs = useMemo(
    () => comments.comments.some((c) => c && !c.deleted && c.handoff_status === 'sent'),
    [comments.comments],
  );
  const commentFeed = useCommentFeed({
    load: commentsRefresh,
    enabled: Boolean(config.slug) && !config.isLanding && !config.demoComments,
    paused: Boolean(composer),
    idleMax: COMMENT_FEED_IDLE_MAX_MS,
    active: outstandingHandoffs,
    fingerprint: commentsFingerprint,
  });

  // A version published meanwhile is announced in the strip above the doc
  // rather than navigated to. Only a visible tab polls; coming back to the
  // tab checks at once; a quiet doc backs off to a minute.
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
      suggestRef.current?.relist();
      if (cancelled) return;
      const fingerprint = seen;
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
  }, [config.slug, config.isLanding, config.mode]);

  // Connected-App handoffs still `sent` keep the comment feed at its base
  // pace (above); there is no second poll for them.

  const modelessEdit = useModelessEdit({
    enabled: editor.modeless,
    liveSwap: modelessFlag && !boot.oldVersion,
    canSwap: !docShape.sheets && !docShape.slides,
    config,
    editor,
    send: bridge.send,
    frameRef: bridge.frameRef,
    narrow,
    busy: Boolean(composer || dialog || comparing || historyOpen || (narrow && drawerOpen) || editor.conflict || editor.staleDraft || markdown.on),
    latest: liveLatest,
    onAdoptVersion: adoptVersion,
    // A version that cannot be swapped in: the owner waiting on their agent
    // is taken to it, as before the flag.
    onSwapFailed: (n) => {
      if (!revisedPending.current || n < revisedPending.current) return;
      location.href = /\/v\/\d+\/?$/.test(location.pathname)
        ? `/d/${encodeURIComponent(config.slug)}/v/${n}?revised=1`
        : `/d/${encodeURIComponent(config.slug)}?revised=1`;
    },
    onLink: () => setDialog({ type: 'link' }),
  });
  modelessRef.current = modelessEdit;

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
  const sidePanelSize = useSideWidth(SIDE_PANEL);
  const [sidePanelChoice, setSidePanelChoice] = useState(() => readStored(SIDE_PANEL_OPEN_KEY));
  const sidePanelAvailable = !narrow && !config.isLanding && !comparing && !historyOpen && !visualOpen && !presenting;
  const sidePanelOpen = sidePanelAvailable && (sidePanelChoice === '1'
    || (sidePanelChoice !== '0' && commentArea.counts.all >= SIDE_PANEL_AUTO_OPEN));
  const setSidePanel = useCallback((open) => {
    writeStored(SIDE_PANEL_OPEN_KEY, open ? '1' : '0');
    setSidePanelChoice(open ? '1' : '0');
  }, []);
  // Esc steps back one level, as in the widget (comments/panel/keyboard.js):
  // composer → open card or cluster → the side list. A key something else
  // took (an @ menu, a dialog, the phone sheet) is left alone.
  useEscapeLadder([
    { active: docPicking, close: () => { setDocPicking(false); bridge.send({ type: 'tdoc:cancelPick' }); } },
    // A sheet's keys go back to the doc: full screen there closes on the next Esc.
    { active: Boolean(composer), close: () => { closeComposer(); if (composer.sheet) bridge.frameRef.current?.focus(); } },
    { active: !narrow && Boolean(openCommentId || openClusterKey), close: () => {
      setOpenCommentId(null);
      setOpenClusterKey(null);
      bridge.send({ type: 'tdoc:focusAnchor', id: null });
    } },
    { active: sidePanelOpen, close: () => setSidePanel(false) },
  ], { enabled: !config.isLanding && !reanchorId });
  // Double-tap Option starts a comment, as in the widget: a pick in the
  // doc (the frame forwards the key from inside the doc).
  useDoubleTapOption(() => startPick(), {
    enabled: !config.isLanding && Boolean(config.canComment || config.signInToComment),
  });
  // Copy for agent, as on every comment surface: ⋯ on a
  // thread and on the list; C (the open thread, else all open) and H (hide
  // the pins and the words' highlight) while the list, the phone drawer or
  // a thread is open (comments/panel/copy-for-agent.jsx). Doc, slides and
  // sheets alike: they share this shell.
  const [markersHidden, setMarkersHidden] = useState(false);
  const copyForAgent = useCopyForAgent({
    enabled: !config.isLanding,
    area: commentArea,
    selectedId: openCommentId,
    title: title || config.title || config.slug,
    pageUrl: `${location.origin}/d/${encodeURIComponent(config.slug)}`,
    linkFor: (c) => `${location.origin}/d/${encodeURIComponent(config.slug)}?comment=${encodeURIComponent(c.id)}`,
    say: showToast,
    markers: { hidden: markersHidden, toggle: () => setMarkersHidden((h) => !h) },
    keysEnabled: Boolean(sidePanelOpen || openCommentId || openClusterKey || (narrow && drawerOpen)) && !composer && !reanchorId,
  });
  const marksHidden = Boolean(copyForAgent && markersHidden);
  const marksHiddenRef = useRef(marksHidden);
  marksHiddenRef.current = marksHidden;
  useEffect(() => { bridge.send({ type: 'tdoc:marksHidden', hidden: marksHidden }); }, [bridge.send, marksHidden]);
  // What the document and its pins have to themselves.
  const sideInset = sidePanelOpen ? sidePanelSize.width : 0;
  const viewRight = window.innerWidth - sideInset;
  const frameTop = TOP_BAR_HEIGHT + (boot.oldVersion ? 28 : 0) + (showExitBanner ? exitBannerHeight : 0)
    + (hintBar ? STEP_HINT_HEIGHT : 0) + (editor.mode === 'edit' && !editor.modeless ? 46 : 0);
  const pinLeft = Math.min(
    (bridge.layout.articleRight || viewRight - 44) + 14,
    viewRight - 34,
  );
  const openComment = commentArea.selected;
  const openCount = commentArea.openCount;
  // The count on the Comment button: open threads, or what the filter shows.
  const filterCount = commentFilter === DEFAULT_FILTER ? openCount : (commentArea.counts[commentFilter] || 0);
  // Read / Comment / Edit, at the top of ⋯ (document-toolbar.jsx).
  const modeOptions = availableModes({ canComment: config.canComment, canEdit: config.canEdit, signInToComment: Boolean(config.signInToComment) });
  const mobileUnread = commentArea.unreadCount > 0;
  const startDocumentComment = (askAi = false) => {
    if (!config.canComment && !config.signInToComment) return;
    if (editor.mode === 'edit' && editor.dirty && !editor.modeless) {
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
  startDocumentCommentRef.current = startDocumentComment;
  // + Comment: pick something in the doc (an artifact, a box on one, a run
  // of text), or click on nothing in particular for the whole document.
  const startPick = () => {
    if (!config.canComment && !config.signInToComment) return;
    if (editor.mode === 'edit') { startDocumentComment(false); return; }
    if (editor.mode === 'read') editor.changeMode('comment');
    setComposer(null);
    setOpenCommentId(null);
    setDrawerOpen(false);
    setDocPicking(true);
    bridge.send({ type: 'tdoc:startPick' });
    showToast('Click what to comment on, drag over text, or click anywhere for the whole doc. Esc cancels.');
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
      unified={suggestOn}
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
      send={canSendToAgent ? {
        slug: config.slug,
        choices: demoAgents ? [DEMO_AGENT] : agentChoices.filter((t) => t.can_edit),
        preselected: demoAgents ? DEMO_AGENT : composerPick,
        ready: handoffBuckets.ready,
        readyIds: handoffBuckets.ready.map((c) => c.id),
        // Edit with only an instruction: it becomes the viewer's
        // whole-document comment, then is handed off like any other.
        createDocumentComment: async (text) => {
          const comment = await comments.addComment({ kind: 'document' }, text);
          if (comment?.id) markCommented();
          if (comment?.id) demoBackend?.markScripted(comment.id, text);
          return comment;
        },
        onSent: () => comments.refresh(),
        // The homepage demo: Edit holds the scripted request, fixed; Send
        // is off while it plays and after, until Undo.
        fixed: demoRewrite ? demoRewrite.prompt : '',
        fixedBusy: demoRewriteState !== 'idle',
        resetKey: demoRewriteResets,
        unchecked: askAiUnchecked,
        onUnchecked: setAskAiUnchecked,
      } : null}
      cta={demoRewrite && demoRewriteState === 'done' ? <DemoRewriteCta onUndo={undoDemoRewrite} /> : null}
      activityOpen={agentActivityOpen}
      onActivityOpen={setAgentActivityOpen}
      unreadCount={unreadAgentReplies}
      disabledChoices={teamGuestsEnabled && config.teamManage?.guest ? (myAgent.state?.disabled_team_agents || []) : []}
      guestAction={guestAction}
      signInToAsk={signedOutAsk}
      setupHref={sendToAgentSetupHref}
      onConnect={signedOutAsk ? () => {
        if (askAiDraft.trim()) {
          try { sessionStorage.setItem(`tdoc-ask-draft:${config.slug}`, askAiDraft); } catch {}
        }
        signIn('/start');
      } : null}
    >{signedOutAsk ? null : <HandoffDetailsPanel
      slug={config.slug}
      open={panelOpen}
      comments={visibleHandoffComments}
      handoffViewer={handoffViewer}
      seenMap={seenMap}
      showReady={canNotify}
      onClose={closeAskAi}
      onSendReady={canNotify ? openDocNotify : null}
      onSendElsewhere={canNotify ? (comment) => {
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
      autoRead={autoReadEnabled}
      onViewChanges={(comment) => { closeAskAi(); changeComparison(true, comment?.applied_in ? { to: Number(comment.applied_in) } : null); }}
      onReply={config.canComment ? async (comment, text) => replyTo(comment.id, text,
        canSendToAgent ? { sendToAgent: true, handoffCommentId: comment.id, recipient: comment.handoff_to }
          : { target: comment.handoff_to, askOnly: true }) : null}
    />}</AskAiPanel>
  );
  // ⌘K opens Ask AI; with a suggestion in review, ⌘↵ accepts it and Esc
  // rejects it (the frame forwards the same keys: tdoc:suggestKey/Action).
  openAskRef.current = suggestOn ? () => {
    if (unifiedEntry) { setDrawerTab('ask'); setDrawerOpen(true); }
    else { setHandoffDetailsOpen(true); setAgentActivityOpen(false); }
  } : null;
  const suggestKeysBlocked = useRef(false);
  suggestKeysBlocked.current = Boolean(composer || handoffDetailsOpen || (narrow && drawerOpen));
  useEffect(() => {
    if (!suggestOn) return undefined;
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        openAskRef.current?.();
        return;
      }
      const t = event.target;
      if (suggestKeysBlocked.current || (t && t.closest && t.closest('input, textarea, [contenteditable="true"]'))) return;
      const s = suggestRef.current;
      if (!s?.activeKey) return;
      if (mod && event.key === 'Enter') { event.preventDefault(); s.accept(); }
      else if (event.key === 'Escape') s.reject();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [suggestOn]);
  // Send every ready comment at once, from Ask AI (DocumentSendAgentAction):
  // the space page's "Send to agent (N)" rule -- the owner, with an agent to
  // send to -- and its send (the Send to agent dialog, POST
  // /api/notify/handoff). A member may send only their own threads
  // (comment_not_owned), so a member never gets "send all".
  // Named as the dialog's Send button names it: the server's default.
  const bulkTarget = notifyTargets.default || null;
  const bulkSend = config.isOwner && !demoAgents && canSendToAgent && handoffBuckets.ready.length ? {
    count: handoffBuckets.ready.length,
    agentName: bulkTarget ? notifyAgentLabel(bulkTarget) : null,
    onSend: () => openDocNotify(handoffBuckets.ready.map((c) => c.id)),
  } : null;
  // The document's actions: ⋯ in the current bar, the title's menu in layout
  // B (with B's extra rows, see DocumentOverflowActions).
  const documentActions = (extra = {}) => (
    <DocumentOverflowActions
      config={config}
      onPublish={() => setDialog({ type: 'publish' })}
      onShare={() => setDialog({ type: 'share' })}
      onCopyMarkdown={copyMarkdown}
      onDuplicate={duplicate}
      onDownload={download}
      onPrint={printPdf}
      onDownloadAs={downloadAs}
      docShape={docShape}
      onMoveDocument={config.mode === 'published' && config.isOwner ? openMoveDocument : null}
      onDelete={() => setDialog({ type: 'delete' })}
      onHistory={historyEnabled ? () => changeHistory(true) : null}
      onWhatChanged={openWhatChanged}
      mode={editor.modeless ? null : { modes: modeOptions, value: editor.mode, onChange: (value) => editor.changeMode(value) }}
      onAllowEmbeds={embedsHeld ? () => setDialog({ type: 'allow-embeds' }) : null}
      onConvertToSheet={canConvertToSheet ? () => setDialog({ type: 'convert-sheet' }) : null}
      {...extra}
    />
  );
  // "Edited …" (· See what changed): on the right in the current bar, after
  // the title and star in layout B.
  const editedChip = (
    <DocumentEdited
      config={config}
      onHistory={historyEnabled ? () => changeHistory(!historyOpen) : null}
      historyOpen={historyOpen}
      onWhatChanged={openWhatChanged}
      fresh={changesFresh && !changesSeen}
      disabled={editor.mode === 'edit' && editor.dirty && !editor.modeless}
    />
  );
  // Light / dark for a signed-out reader in layout B: the title menu holds
  // it (TopBar keeps it in ⋯, which B does not have).
  const toggleThemeHere = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    writeStored('tdoc-theme', next);
    setTheme(next);
    bridge.send({ type: 'tdoc:theme', theme: next });
  };
  const askAiAction = (askAiPanelEnabled || signedOutAsk) && !unifiedEntry ? (
    <DocumentSendAgentAction
      counts={Object.fromEntries(Object.entries(handoffBuckets).map(([state, list]) => [state, list.length]))}
      unread={unreadAgentReplies}
      open={handoffDetailsOpen}
      onOpenChange={(open) => { setHandoffDetailsOpen(open); if (open) { setAgentActivityOpen(false); setDrawerOpen(false); } }}
      narrow={narrow}
      bulkSend={bulkSend}
    >
      {askAiPanel(handoffDetailsOpen)}
    </DocumentSendAgentAction>
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
    left: Math.max(8, Math.min(pinLeft + 34, viewRight - 306 - 8)),
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
      initialText={composer.draftText || (composer.kind === 'document' && composer.intent === 'ask-ai' && agentChoices.length
        ? `@${AGENT_TAG_JOINER}${agentMentionName(byRelevance(agentChoices)[0], agentChoices)} ` : '')}
      mentionable={mentionable}
      demo={!!config.demoComments}
      canSendToAgent={canSendToAgent}
      agentSetupHref={sendToAgentSetupHref}
      sendToAgentDisabledReason={sendToAgentDisabledReason}
      connectAgentPrompt={sendToAgentConnectPrompt}
      privateAsk={privateAskView && !privateAskView.parentId ? privateAskView : null}
      onMakePublic={makePublic}
      onSubmit={postComment}
      onClose={closeComposer}
      onCopyToast={showToast}
      signInToPost={!config.identity && Boolean(config.signInToComment)}
      onReopenSignIn={() => { if (signInWaitRef.current && !signInWaitRef.current.reopen()) showToast('Your browser blocked the sign-in window. Allow pop-ups for tdoc and try again.', true); }}
      restored={Boolean(composer.restored)}
    />
  ) : null;
  return (
    <CopyForAgentContext.Provider value={copyForAgent}>
    <div
      className="tdoc-document-app"
      data-mode={editor.mode}
      data-markers-hidden={marksHidden || undefined}
      data-visual-open={visualOpen || undefined}
      data-presenting={(visualOpen && presenting) || undefined}
      onPointerDown={() => {
        // Legacy behavior: a click anywhere outside a card, pin, or composer
        // closes the open card and cluster popover (they stop propagation).
        setOpenClusterKey(null);
        setOpenCommentId(null);
      }}
    >
      <HandoffSendTransport.Provider value={demoBackend ? demoBackend.postNotifyHandoff : null}>
      <AgentMentionContext.Provider value={agentMentions}>
      <SuggestContext.Provider value={suggestContext}>
      <CommentDocVersionContext.Provider value={config.mode === 'published' ? Number(config.version) : null}>
      <CommentSeeChangesContext.Provider value={seeReplyChanges}>
      <CommentEditedPassageContext.Provider value={editedPassageIds}>
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
        actions={config.isLanding ? <>
          {askAiAction}
          <LandingActions stars={config.stars} />
        </> : (
          !comparing && <>
            {barB ? null : editedChip}
            {editor.modeless && !barB ? <EditorSaveStatus status={editor.saveStatus} /> : null}
            {editor.modeless && !barB ? <MarkdownSwitch markdown={markdown} /> : null}
            {askAiAction}
            {!narrow && sidePanelAvailable ? (
              // One Comment button, its open count on it: it opens and closes
              // the comment list beside the doc. A new comment starts there
              // (+ New comment), from a selection, or with double-tap Option.
              // The Read / Comment / Edit switch that sat beside it read as a
              // second comment button (Julie, 2026-11-10); it heads ⋯ now.
              // The filter is the chevron beside it (CommentFilterMenu). The
              // button is only the mark and the count (Julie, 2026-11-16: the
              // word and "· Resolved" made it too large); a filter other than
              // Open is a check in the menu and a small dot on the button.
              <span className="tdoc-comments-split">
                <AppButton variant="quiet" className="tdoc-comments-toggle" aria-pressed={sidePanelOpen ? 'true' : 'false'}
                  aria-label={`Comments${commentFilter !== DEFAULT_FILTER ? `, showing ${filterName(commentFilter)} (${filterCount})` : (openCount ? ` (${openCount} open)` : '')}`}
                  title="Comments" data-filter={commentFilter}
                  onClick={() => {
                    if (!sidePanelOpen && editor.mode === 'read') editor.changeMode('comment');
                    setSidePanel(!sidePanelOpen);
                  }}>
                  <CommentIcon size={16} outline />
                  {filterCount ? <span className="tdoc-comments-toggle-count">{filterCount}</span> : null}
                  {commentFilter !== DEFAULT_FILTER ? <span className="tdoc-comments-toggle-dot" aria-hidden="true" /> : null}
                </AppButton>
                {/* Layout B: no chevron. The filter (and Mark all as read)
                    is the comment list's own filter row. */}
                {barB ? null : comments.comments.length ? (
                  <CommentFilterMenu area={commentArea} prefs={listPrefs} onChange={setCommentFilter}
                    unreadCount={sidePanelOpen ? 0 : unreadAgentReplies} onMarkAllRead={markAllAgentRepliesRead} />
                ) : null}
              </span>
            ) : null}
            {/* Only the "Read only" note is left in the bar: a doc that takes
                no comments and no edits has no mode to switch to. */}
            {modeOptions.length < 2 && !barB ? (
              <DocumentModeControl
                mode={editor.mode}
                canComment={config.canComment}
                canEdit={config.canEdit}
                signInToComment={Boolean(config.signInToComment)}
                onChange={(value) => editor.changeMode(value)}
              />
            ) : null}
            <DocumentPrimaryAction
              config={config}
              onPublish={() => setDialog({ type: 'publish' })}
              onShare={() => setDialog({ type: 'share' })}
            />
          </>
        )}
        mobileOverflowActions={config.isLanding ? <LandingFeedbackMenuItem /> : null}
        barLayout={barB ? 'b' : null}
        overflowActions={config.isLanding || barB ? null : documentActions()}
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
          starred={starred}
          onToggleStar={toggleStar}
          titleMenu={barB ? ({ rename }) => documentActions({
            onRename: rename,
            edited: config.mode === 'local' ? '' : editedAgo((config.versions || []).find((v) => Number(v.n) === Number(config.version))?.created),
            readOnly: modeOptions.length < 2 && !config.canComment && !config.signInToComment,
            markdown: editor.modeless ? markdown : null,
            theme: supportsTheme && !config.identity ? { dark: theme === 'dark', onToggle: toggleThemeHere } : null,
            shareRow: false,
          }) : null}
          after={barB && !comparing ? <>
            {editedChip}
            {editor.modeless ? <EditorSaveStatus status={editor.saveStatus} /> : null}
          </> : null}
        />
      </TopBar>
      {teamGuestsEnabled && config.teamManage?.guest ? <div className="tdoc-onboard-banner" role="status" onPointerDown={(event) => event.stopPropagation()}>
        <span>{config.teamManage.invitePending
          ? `You have been invited to join ${config.teamManage.team.name}.`
          : `You are a guest in ${config.teamManage.team.name}. Team agents are for members.`}</span>
        <button type="button" onClick={guestAction.onClick}>{guestAction.label}</button>
        {guestInviteStatus ? <span>{guestInviteStatus}</span> : null}
      </div> : null}
      {comparing ? <VersionDiffView config={config} theme={theme} narrow={narrow} from={compareRange.from} to={compareRange.to} onClose={() => changeComparison(false)} /> : null}
      {historyOpen && !comparing ? (
        <VersionHistory
          config={config}
          narrow={narrow}
          theme={theme}
          devMode={historyDevMode}
          suggestions={suggestOn ? suggestions : null}
          onClose={() => changeHistory(false)}
          onToast={showToast}
        />
      ) : null}

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
      <div className="tdoc-reader-surface" hidden={comparing || historyOpen} data-markdown={markdown.on ? '' : undefined} style={sideInset ? { marginRight: sideInset } : undefined}>
      <OldVersionNotice value={boot.oldVersion || (modelessEdit.strip !== 'hidden' && modelessEdit.newest > Number(config.version) ? {
        current: Number(config.version),
        latest: modelessEdit.newest,
        latestUrl: `/d/${encodeURIComponent(config.slug)}`,
        fresh: true,
        editing: modelessEdit.strip === 'editing',
      } : null)} />

      {/* /start: the no-terminal way in (remote MCP), behind remoteMcp. */}
      {config.onboarding && config.slug === 'tdoc-start' && (editor.mode !== 'edit' || editor.modeless) ? <ConnectAiAppsStrip /> : null}

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
      {editor.mode === 'edit' && !editor.modeless ? null : (
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

      {editor.mode === 'edit' && !editor.modeless ? (
        <EditorToolbar
          proseTools={!docShape.sheetDoc}
          markdown={markdown}
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
          onDiscard={() => { markdown.cancel(); return editor.discard(); }}
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
        src={frameSrc}
      />
      {markdown.pane}
      {markdown.dialog}

      <DocumentFooter footerRef={footerRef} visible={bridge.layout.footerVisible && !bridge.layout.fullBleed} />

      {narrow ? (<>
        {editor.mode !== 'read' && !markdown.on ? <DesktopCommentLayer
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
        {demoBar && !drawerOpen && !handoffDetailsOpen ? <DemoRewriteBar state={demoRewriteState} agent={DEMO_AGENT.handle} onUndo={undoDemoRewrite} /> : null}
        <MobileCommentDrawer
          area={commentArea}
          prefs={listPrefs}
          // shownComments, not the raw list: hiding resolved threads took the
          // pins out of the document but left every one of them in the drawer,
          // which on a phone IS the comment list.
          groups={panelGroups}
          open={drawerOpen && !comparing && !historyOpen}
          openCount={openCount}
          unread={mobileUnread}
          onRefresh={commentFeed.refresh}
          refreshing={commentFeed.refreshing}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          handoffViewer={handoffViewer}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          openCommentId={openCommentId}
          expandReplies={deepReply}
          canSendToAgent={canSendToAgent}
          agentSetupHref={sendToAgentSetupHref}
          onOpenChange={(open) => { setDrawerOpen(open); if (open) setHandoffDetailsOpen(false); }}
          // The site pages (landing, /pricing, ...) have no comment button on a
          // phone, as on desktop: no comments for a visitor there. A tapped
          // demo highlight still opens the drawer.
          fab={!config.isLanding}
          hideFab={handoffDetailsOpen || editor.mode === 'read' || demoBar}
          askAi={unifiedEntry ? askAiPanel(drawerOpen && drawerTab === 'ask') : null}
          tab={drawerTab}
          onTab={setDrawerTab}
          onStartComment={config.canComment || config.signInToComment ? () => startDocumentComment(false) : null}
          onAskAi={config.canComment || config.signInToComment ? () => startDocumentComment(true) : null}
          onReply={replyTo}
          onMarkRead={commentArea.onSeen}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={(id) => { bridge.send({ type: 'tdoc:reanchorMode', active: true }); setReanchorId(id); }}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
          onResendHandoff={canNotify ? resendHandoff : null}
          onSendHandoffElsewhere={canNotify ? sendHandoffElsewhere : null}
          // A tap on a card selects it in the drawer (its words are marked
          // behind it, nothing scrolls); Go to comment closes the drawer and
          // scrolls to them.
          onSelect={(id) => (isDocumentComment(commentsById.get(id)) ? setOpenCommentId(id) : focusComment(id))}
          onGoTo={(id) => focusComment(id, { scroll: true, closeDrawer: true })}
          canGoTo={(comment) => !isDocumentComment(comment) && pinIds.has(comment.id)}
        />
      </>) : (
        <DesktopCommentLayer
          clusters={editor.mode === 'read' || markdown.on ? [] : clusters}
          commentsById={commentsById}
          seenMap={seenMap}
          hoveredAnchorId={hoveredAnchorId}
          frameScrollY={bridge.layout.scrollY}
          frameTop={frameTop}
          pinLeft={pinLeft}
          openComment={editor.mode === 'read' || sidePanelOpen ? null : openComment}
          openClusterKey={sidePanelOpen ? null : openClusterKey}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          handoffViewer={handoffViewer}
          isOwner={Boolean(config.isOwner)}
          mentionable={mentionable}
          demo={!!config.demoComments}
          cardPosition={cardPosition}
          expandReplies={deepReply}
          canSendToAgent={canSendToAgent}
          agentSetupHref={sendToAgentSetupHref}
          onOpenComment={(id) => {
            focusComment(id);
          }}
          onOpenCluster={(key) => {
            // With the side list open, a cluster's first thread is selected
            // there; without it, the cluster opens beside its pin.
            const cluster = sidePanelOpen ? clusters.find((item) => item.key === key) : null;
            if (cluster && cluster.items.length) { focusComment(cluster.items[0].comment.id); return; }
            setOpenCommentId(null);
            setOpenClusterKey(openClusterKey === key ? null : key);
          }}
          onReply={replyTo}
          onMarkRead={autoReadEnabled ? markAgentReplyRead : null}
          onEdit={editComment}
          onReact={reactTo}
          onDelete={removeComment}
          onResolve={resolveComment}
          onReanchor={(id) => { bridge.send({ type: 'tdoc:reanchorMode', active: true }); setReanchorId(id); }}
          handoff={handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null}
          onResendHandoff={canNotify ? resendHandoff : null}
          onSendHandoffElsewhere={canNotify ? sendHandoffElsewhere : null}
        />
      )}

      {composerView}

      {sidePanelOpen ? (
        // The desktop side list: the shared panel. Pins stay beside the text;
        // a thread picked here scrolls to its words and flashes them, and a
        // pin picked there is selected here.
        <aside className="tdoc-doc-side" style={{ top: frameTop, width: sidePanelSize.width }}>
          <SideResizeHandle side={sidePanelSize} label="Resize the comment list" />
          <CommentPanel
            area={commentArea}
            prefs={listPrefs}
            groups={panelGroups}
            title="Comments"
            onAdd={config.canComment || config.signInToComment ? () => startPick() : null}
            onRefresh={commentFeed.refresh}
            refreshing={commentFeed.refreshing}
            onClose={() => setSidePanel(false)}
            empty={<p className="tdoc-cpanel-empty">No comments here yet. Select any text to comment.</p>}
            selectedId={openCommentId}
            expandReplies
            isAnchored={(comment) => isDocumentComment(comment) || pinIds.has(comment.id)}
            // A press on a card selects it and marks its words where they
            // are, without scrolling the doc; Go to comment (⋯) scrolls to
            // them and flashes them.
            onSelect={(id) => (isDocumentComment(commentsById.get(id)) ? setOpenCommentId(id) : focusComment(id))}
            onGoTo={(id) => focusComment(id, { scroll: true })}
            canGoTo={(comment) => !isDocumentComment(comment) && pinIds.has(comment.id)}
            cardProps={{
              currentUser: config.identity?.login || 'anon',
              handoffViewer,
              isOwner: Boolean(config.isOwner),
              mentionable,
              demo: !!config.demoComments,
              canSendToAgent,
              agentSetupHref: notifyEnabled && notifyTargets.ready && notifyTargets.reason === 'no_agent_bound' ? '/me?view=settings#agents' : null,
              onReply: replyTo,
              onReact: reactTo,
              onDelete: removeComment,
              onResolve: resolveComment,
              onEdit: editComment,
              onMarkRead: commentArea.autoRead ? null : markAgentReplyRead,
              onReanchor: (id) => { bridge.send({ type: 'tdoc:reanchorMode', active: true }); setReanchorId(id); },
              handoff: handoffOnPage ? { threadId: myThread.id, line: handoffText, open: handoffOpen, onToggle: handoffToggle, state: handoff.state, copyFailed: Boolean(handoff.copyFailed), onCopy: handoffCopy } : null,
              onResendHandoff: canNotify ? resendHandoff : null,
              onSendHandoffElsewhere: canNotify ? sendHandoffElsewhere : null,
            }}
          />
        </aside>
      ) : null}

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
          viewer={notifyViewer}
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
      <AllowSheetEmbedsDialog
        open={dialog?.type === 'allow-embeds'}
        slug={config.slug}
        sheets={dialog?.type === 'allow-embeds' ? sheetEmbed.sheets() : []}
        onOpenChange={(open) => !open && setDialog(null)}
        onAllowed={embedsAllowed}
      />
      <ConvertToSheetDialog
        open={dialog?.type === 'convert-sheet'}
        onOpenChange={(open) => !open && setDialog(null)}
        onConvert={convertToSheet}
      />
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
      {modelessEdit.overlay}
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
      {suggestOn && !(narrow && (drawerOpen || composer)) && !comparing && !historyOpen ? <SuggestReviewBar suggestions={suggestions} narrow={narrow} /> : null}
      {suggestOn && suggestions.rect && !narrow && !comparing && !historyOpen && !composer ? (() => {
        const frameBox = bridge.frameRef.current?.getBoundingClientRect();
        const top = (frameBox?.top || frameTop) + suggestions.rect.docY - bridge.layout.scrollY + 6;
        if (top < (frameBox?.top || frameTop) || top > window.innerHeight - 120) return null;
        const left = Math.min(window.innerWidth - 120, (frameBox?.left || 0) + suggestions.rect.right - 40);
        return <SuggestInlineChip suggestions={suggestions} style={{ top, left }} />;
      })() : null}
      </CommentEditedPassageContext.Provider>
      </CommentSeeChangesContext.Provider>
      </CommentDocVersionContext.Provider>
      </SuggestContext.Provider>
      </AgentMentionContext.Provider>
      </HandoffSendTransport.Provider>
    </div>
    </CopyForAgentContext.Provider>
  );
}
