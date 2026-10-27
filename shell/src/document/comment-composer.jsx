import React, { useContext, useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { AgentButtonsContext, MentionField } from './mention-field.jsx';
import { joinAiTags, mentionsAi } from './ai-answerer.js';
import { AgentAskRow, AgentButton, PrivateAnswer, agentAskHint, useAgentAsk } from './agent-ask.jsx';
import { TOP_BAR_HEIGHT, copyText } from './model.js';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';

// The shell's chrome does not scroll — the frame does — so the composer's
// coordinates are viewport coordinates.
//
// A phone keyboard does TWO things, and reading only the first is why the card
// still flew after the first attempt at this: it shrinks the visual viewport,
// and it SHIFTS it, so the visible band no longer starts at y=0. offsetTop is
// that shift. A card positioned without it sits at a coordinate that is still
// inside the layout viewport and no longer inside the part you can see.
//
// The card is position:fixed for the same reason: absolute positioning ties it
// to the document, and iOS scrolls the document to reveal the focused textarea.
// Fixed plus offsetTop keeps it against the band that is actually on screen.
function readViewport() {
  const visual = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!visual) {
    return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 };
  }
  return {
    width: Math.round(visual.width),
    height: Math.round(visual.height),
    offsetTop: Math.round(visual.offsetTop || 0),
    offsetLeft: Math.round(visual.offsetLeft || 0),
  };
}

export const COMPOSER_WIDTH = 320;
export const COMPOSER_HEIGHT = 190;

// Where the card goes, as arithmetic — no DOM, so the keyboard cases are unit
// tested rather than staged in a browser that has no keyboard.
//   viewport: { width, height, offsetTop, offsetLeft } from visualViewport
//   rect:     the selection, in the frame's own viewport coordinates
// The result is a fixed-position coordinate, clamped into the band that is
// actually on screen. Both directions matter: the keyboard can leave less room
// than the card needs, and then staying visible beats staying next to the quote.
export function composerPosition(rect, viewport) {
  const visibleTop = viewport.offsetTop || 0;
  const visibleBottom = visibleTop + viewport.height;
  const offsetLeft = viewport.offsetLeft || 0;

  const left = Math.max(
    offsetLeft + 8,
    Math.min((rect.left || 8) + offsetLeft, offsetLeft + viewport.width - COMPOSER_WIDTH - 8),
  );
  let top = visibleTop + TOP_BAR_HEIGHT + (rect.bottom || 0) + 8;
  if (top + COMPOSER_HEIGHT > visibleBottom - 8) {
    top = visibleTop + TOP_BAR_HEIGHT + (rect.top || 0) - COMPOSER_HEIGHT - 8;
  }
  top = Math.min(top, visibleBottom - COMPOSER_HEIGHT - 8);
  top = Math.max(top, visibleTop + 8);
  return { top, left };
}

export function CommentComposer({
  selection,
  inline = false,
  initialText = '',
  onSubmit,
  onClose,
  mentionable = [],
  demo = false,
  canSendToAgent = false,
  sendToAgentDisabledReason = null,
  // Set when @agent would work but nobody is linked yet: the button stays,
  // and pressing it explains how to connect instead of vanishing silently.
  // Only where the @agent buttons are (AgentButtonsContext).
  connectAgentPrompt = null,
  // Where "Set up an agent" goes. The feedback overlay runs on someone
  // else's app, so it passes an absolute tdoc URL.
  agentSetupHref = '/me?view=settings#agents',
  // An "Only me" question in flight or answered: { question, label, status,
  // answer, error }. The composer turns into its answer, with Make public.
  privateAsk = null,
  onMakePublic = null,
  onCopyToast = null,
}) {
  const [text, setText] = useState(initialText);
  const [connectOpen, setConnectOpen] = useState(false);
  const [viewport, setViewport] = useState(readViewport);
  const agentButtons = useContext(AgentButtonsContext);

  useEffect(() => {
    const onChange = () => setViewport(readViewport());
    const visual = window.visualViewport;
    // `scroll` too: iOS shifts the visual viewport as well as resizing it.
    visual?.addEventListener('resize', onChange);
    visual?.addEventListener('scroll', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      visual?.removeEventListener('resize', onChange);
      visual?.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, []);

  const { top, left } = composerPosition(selection.rect || {}, viewport);

  const quoted = String(selection.text || '');
  const copyQuote = async () => {
    let copied = false;
    try { copied = await copyText(quoted); } catch {}
    onCopyToast?.(copied ? 'Copied' : 'Copy failed', !copied);
  };
  const copyEmptyDraftQuote = (event) => {
    if (!quoted || text.length || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') return;
    const textarea = field.current;
    if (!textarea || document.activeElement !== textarea || textarea.selectionStart !== textarea.selectionEnd) return;
    event.preventDefault();
    void copyQuote();
  };
  const preview = selection.kind === 'document'
    ? 'On this document'
    : selection.kind === 'element'
    ? selection.label || 'Selected element'
    : `"${quoted.slice(0, 80)}${quoted.length > 80 ? '…' : ''}"`;

  // One submit at a time. ⌘+Enter and the buttons both land here, and a second
  // press while the first post is still in flight used to post a twin.
  const [busy, setBusy] = useState(false);
  // The @agent button and its pill, and Only me (agent-ask.jsx, shared with
  // the reply box). The feedback overlay keeps its own @agent buttons.
  const field = useRef(null);
  const ask = useAgentAsk(text, setText, field);
  const { agents, target } = ask;
  const submit = async (sendToAgent = false) => {
    if (busy || !text.trim()) return;
    if (sendToAgent && !agentButtons && !target && !agents.preselected) { ask.putDefault(); return; }
    setBusy(true);
    try {
      if (agentButtons) {
        // The feedback overlay: its @agent button hands the comment to the
        // following agent.
        await onSubmit(text, { sendToAgent: canSendToAgent && sendToAgent, recipient: null, target: null, askOnly: false, onlyMe: false });
        return;
      }
      // ⌘⇧Enter puts the default agent in, then sends. A named agent that
      // may edit this doc gets the comment to answer or change; one that may
      // not (or Only me) answers only.
      const out = ask.outgoing(sendToAgent);
      const recipient = canSendToAgent && out.target && !out.askOnly ? out.target : null;
      await onSubmit(out.target || mentionsAi(out.text) ? joinAiTags(out.text) : out.text, {
        sendToAgent: Boolean(recipient),
        recipient,
        target: out.target,
        askOnly: out.askOnly,
        onlyMe: out.onlyMe,
      });
    } finally {
      setBusy(false);
    }
  };

  if (privateAsk) {
    return (
      <div
        className={`tdoc-popup tdoc-private-ask${inline ? ' tdoc-inline-composer' : ''}`}
        style={inline ? undefined : { top, left }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="head">
          <span className="h">{preview}</span>
          <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <PrivateAnswer privateAsk={privateAsk} onMakePublic={onMakePublic} />
      </div>
    );
  }

  return (
    <div
      className={`tdoc-popup${inline ? ' tdoc-inline-composer' : ''}`}
      style={inline ? undefined : { top, left }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDownCapture={copyEmptyDraftQuote}
    >
      <div className="head">
        {demo ? <span className="tdoc-demo-chip">Demo</span> : null}
        <span className="h">{preview}</span>
        {quoted ? <button type="button" className="tdoc-copy-quote" aria-label="Copy selected text" title="Copy selected text" onMouseDown={(event) => event.preventDefault()} onClick={copyQuote}><Copy size={15} aria-hidden="true" /></button> : null}
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div><MentionField
        autoFocus={viewport.width > 700}
        fieldRef={field}
        placeholder={demo
          ? 'What should change? Type a GitHub @ — or @email'
          : (agents.choices || []).length && !agentButtons
            ? 'Comment, or type @ to ask an agent'
            : 'What should change? Type @ to notify someone'}
        value={text}
        people={mentionable}
        onChange={setText}
        onSubmit={({ sendToAgent } = {}) => submit(Boolean(sendToAgent))}
      /></div>
      {!agentButtons ? <AgentAskRow ask={ask} /> : null}
      {connectOpen && connectAgentPrompt ? (
        <div className="tdoc-connect-agent">
          <p><strong>No agent is connected yet.</strong> Connect one once (Raft or a webhook), then @agent works here.</p>
          <a className="tdoc-connect-agent-cta" href={agentSetupHref || '/me?view=settings#agents'}>Set up an agent</a>
          <details>
            <summary>Or paste this into your agent</summary>
            <code>{connectAgentPrompt}</code>
            <CopyPromptButton text={connectAgentPrompt} />
          </details>
        </div>
      ) : null}
      <div className="foot">
        {target && !agentButtons ? (
          <span className="hint">{agentAskHint(ask)}</span>
        ) : (
          <span className="hint">
            {demo
              ? 'Demo — refresh clears it'
              : (canSendToAgent && agentButtons ? '⌘+Enter · ⌘⇧+Enter @agent' : ask.choices.length ? '⌘+Enter · ⌘⇧+Enter with @agent' : '⌘+Enter to submit')}
          </span>
        )}
        <div className="tdoc-composer-foot-actions">
          {!agentButtons && connectAgentPrompt ? (
            <button className="tdoc-composer-agent" type="button" disabled={busy} aria-expanded={connectOpen}
              onClick={() => setConnectOpen((value) => !value)} title="Connect an agent to use @agent">@agent</button>
          ) : !agentButtons ? <AgentButton ask={ask} busy={busy} /> : null}
          {agentButtons && !canSendToAgent && connectAgentPrompt ? (
            <button
              className="submit agent tdoc-agent-unlinked"
              type="button"
              aria-expanded={connectOpen}
              onClick={() => setConnectOpen((v) => !v)}
              title="Connect an agent to hand comments to it"
            >
              @agent
            </button>
          ) : null}
          {agentButtons && canSendToAgent ? (
            <button
              className="submit agent"
              type="button"
              onClick={() => submit(true)}
              disabled={busy}
              title={sendToAgentDisabledReason || 'Comment and hand to the following agent'}
            >
              {busy ? 'Posting…' : '@agent'}
            </button>
          ) : null}
          <button className="submit" type="button" onClick={() => submit(false)} disabled={busy}>
            {busy ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
