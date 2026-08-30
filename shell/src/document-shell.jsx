import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { duplicateDocument, setDocumentStar } from './document/api.js';
import { CommentComposer } from './document/comment-composer.jsx';
import {
  DesktopCommentLayer,
  MobileCommentDrawer,
} from './document/comment-layer.jsx';
import {
  MessageDialog,
  PublishDialog,
  ShareDialog,
} from './document/document-dialogs.jsx';
import {
  DocumentActions,
  DocumentBreadcrumbs,
  LandingActions,
} from './document/document-toolbar.jsx';
import {
  DeleteDocumentDialog,
  OwnerAccessDialog,
} from './document/owner-access-dialog.jsx';
import { copyText, layoutPins, TOP_BAR_HEIGHT } from './document/model.js';
import { useComments } from './hooks/use-comments.js';
import { useFrameBridge } from './hooks/use-frame-bridge.js';
import { SignInDialog } from './sign-in-dialog.jsx';
import { OnboardingDialog } from './onboarding-dialog.jsx';

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

export function DocumentShell({ boot, config }) {
  const narrow = useNarrowViewport();
  const reanchorRef = useRef(null);
  const bridgeRef = useRef(null);
  const [composer, setComposer] = useState(null);
  const [openCommentId, setOpenCommentId] = useState(null);
  const [openClusterKey, setOpenClusterKey] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reanchorId, setReanchorId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);
  // setToast('done') for confirmations; setToast('...', true) for failures,
  // which are painted in the danger tone and stay long enough to read.
  const showToast = useCallback((text, error = false) => setToast({ text, error }), []);
  const [theme, setTheme] = useState(() => (
    localStorage.getItem('tdoc-theme') === 'dark' ? 'dark' : 'light'
  ));
  const [starred, setStarred] = useState(Boolean(config.viewerStar?.starred));
  const [signInOpen, setSignInOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [deepTarget, setDeepTarget] = useState(() => (
    new URLSearchParams(location.search).get('comment')
  ));

  const signIn = useCallback(() => {
    if (config.webAuth) {
      const returnUrl = location.pathname + location.search + location.hash;
      location.href = `/api/auth/web/login?return=${encodeURIComponent(returnUrl)}`;
      return undefined;
    }
    setSignInOpen(true);
    return undefined;
  }, [config.webAuth]);

  const completeSignIn = useCallback(() => {
    location.reload();
  }, []);

  const comments = useComments({
    slug: config.slug,
    version: config.version,
    onUnauthorized: signIn,
  });

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
    'tdoc:cleared': () => {
      if (!document.querySelector('.tdoc-popup textarea:focus')) setComposer(null);
      setOpenCommentId(null);
      setOpenClusterKey(null);
    },
    'tdoc:ready': (message) => {
      const storedTheme = localStorage.getItem('tdoc-theme');
      const nextTheme = storedTheme || (message.defaultTheme === 'dark' ? 'dark' : 'light');
      setTheme(nextTheme);
      bridge.send({ type: 'tdoc:theme', theme: nextTheme });
      comments.refresh();
    },
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
        setOnboardingOpen(true);
        return;
      }
      if (message.blank) window.open(href, '_blank', 'noopener');
      else location.href = href;
    },
  });

  const focusComment = useCallback((id, { scroll = false, closeDrawer = false } = {}) => {
    setOpenCommentId(id);
    setOpenClusterKey(null);
    if (closeDrawer) setDrawerOpen(false);
    bridge.send({ type: 'tdoc:focusAnchor', id, scroll });
  }, [bridge.send]);

  const commentsById = useMemo(
    () => new Map(comments.comments.map((comment) => [comment.id, comment])),
    [comments.comments],
  );
  const pinIds = useMemo(
    () => new Set(bridge.layout.pins.map((pin) => pin.id)),
    [bridge.layout.pins],
  );
  const clusters = useMemo(
    () => layoutPins(bridge.layout.pins, bridge.layout.docHeight),
    [bridge.layout.docHeight, bridge.layout.pins],
  );

  useEffect(() => {
    bridge.send({ type: 'tdoc:anchors', comments: comments.comments });
    if (!comments.loading) document.body.dataset.tdocReady = '1';
  }, [bridge.send, comments.comments, comments.loading]);

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
    if (!cluster) return;
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
      await operation();
      return true;
    } catch (error) {
      showToast(error.message || 'Request failed', true);
      return false;
    }
  };

  const postComment = async (text) => {
    if (await attempt(() => comments.addComment(composer, text))) closeComposer();
  };

  const replyTo = (parentId, text) => attempt(() => comments.addReply(parentId, text));
  const reactTo = (commentId, emoji) => attempt(() => comments.react(commentId, emoji));

  const removeComment = async (id) => {
    if (await attempt(() => comments.remove(id))) setOpenCommentId(null);
  };

  const removeAnchor = async () => {
    if (!await attempt(() => comments.moveAnchor(reanchorId, { kind: 'none' }))) return;
    setReanchorId(null);
    setOpenCommentId(null);
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
        TOP_BAR_HEIGHT + 4,
        Math.min(
          TOP_BAR_HEIGHT + openCluster.y - bridge.layout.scrollY,
          window.innerHeight - 220,
        ),
      )
      : TOP_BAR_HEIGHT + 4,
    // 280px card + 12px padding each side + 1px borders, kept 8px off the edge.
    left: Math.max(8, Math.min(pinLeft + 34, window.innerWidth - 306 - 8)),
  };
  // A deep link to a reply (?comment=<reply id>) opens its thread expanded;
  // any other open card starts with replies collapsed, as before.
  const deepReply = Boolean(
    openComment
    && new URLSearchParams(location.search).get('comment')
    && new URLSearchParams(location.search).get('comment') !== openComment.id
  );

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
          <DocumentActions
            config={config}
            onPublish={() => setDialog({ type: 'publish' })}
            onShare={() => setDialog({ type: 'share' })}
            onCopyMarkdown={() => bridge.send({ type: 'tdoc:copyDoc', requestId: Date.now() })}
            onDuplicate={duplicate}
            onDownload={download}
            onPrint={printPdf}
            onDelete={() => setDialog({ type: 'delete' })}
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
        onSignIn={signIn}
      >
        <DocumentBreadcrumbs config={config} starred={starred} onToggleStar={toggleStar} />
      </TopBar>

      <OldVersionNotice value={boot.oldVersion} />

      <ReanchorBanner
        commentId={reanchorId}
        onRemove={removeAnchor}
        onCancel={() => setReanchorId(null)}
      />

      <iframe
        ref={bridge.frameRef}
        className="tdoc-doc-frame"
        title="Document content"
        sandbox="allow-scripts"
        src={boot.frameSrc}
      />

      <DocumentFooter visible={bridge.layout.footerVisible} />

      {narrow ? (
        <MobileCommentDrawer
          open={drawerOpen}
          comments={comments.comments}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          isOwner={Boolean(config.isOwner)}
          openCommentId={openCommentId}
          expandReplies={deepReply}
          onOpenChange={setDrawerOpen}
          onReply={replyTo}
          onReact={reactTo}
          onDelete={removeComment}
          onReanchor={setReanchorId}
          onNavigate={(id) => focusComment(id, { scroll: true, closeDrawer: true })}
        />
      ) : (
        <DesktopCommentLayer
          clusters={clusters}
          commentsById={commentsById}
          frameScrollY={bridge.layout.scrollY}
          pinLeft={pinLeft}
          openComment={openComment}
          openClusterKey={openClusterKey}
          pinIds={pinIds}
          currentUser={config.identity?.login || 'anon'}
          isOwner={Boolean(config.isOwner)}
          cardPosition={cardPosition}
          expandReplies={deepReply}
          onOpenComment={(id) => {
            focusComment(id);
          }}
          onOpenCluster={(key) => setOpenClusterKey(
            openClusterKey === key ? null : key
          )}
          onReply={replyTo}
          onReact={reactTo}
          onDelete={removeComment}
          onReanchor={setReanchorId}
        />
      )}

      {composer ? (
        <CommentComposer selection={composer} onSubmit={postComment} onClose={closeComposer} />
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
      <SignInDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onSuccess={completeSignIn}
      />
      <OnboardingDialog open={onboardingOpen} onOpenChange={setOnboardingOpen} />

      {toast ? (
        <div className={`tdoc-shell-toast${toast.error ? ' error' : ''}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
