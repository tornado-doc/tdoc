import React, { useContext, useEffect, useRef, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import { AgentButtonsContext, AgentMentionContext, MentionField, MentionText } from './mention-field.jsx';
import { AGENT_TAG_JOINER, agentDisplayName, agentMentionName, taggedAgent, targetKey } from './agent-choices.js';
import { ProviderMark } from './notify-handoff.jsx';
import { AppMenu, AppMenuItem, AppMenuLinkItem } from '../ui/menu.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { freeLeftText, joinAiTags, mentionsAi, onlyMeDefault } from './ai-answerer.js';
import { AppCheckbox } from '../ui/checkbox.jsx';
import { TOP_BAR_HEIGHT } from './model.js';
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
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState(null);
  const [onlyMe, setOnlyMe] = useState(null);
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
  const preview = selection.kind === 'document'
    ? 'On this document'
    : selection.kind === 'element'
    ? selection.label || 'Selected element'
    : `"${quoted.slice(0, 80)}${quoted.length > 80 ? '…' : ''}"`;

  // One submit at a time. ⌘+Enter and the buttons both land here, and a second
  // press while the first post is still in flight used to post a twin.
  const [busy, setBusy] = useState(false);
  const agents = useContext(AgentMentionContext);
  const choices = agents.choices || [];
  // The agent this comment names after @ (the @agent button puts the
  // default one in; a bare @AI means it too). With one, "Ask" or "Ask +
  // request change": the second only when that agent may edit this doc
  // (authorship, decided by the server), and the default when it may.
  // "Only me" (private question and answer) is for Ask, to one's own agent
  // or tdoc AI -- never a team agent, which answers for the team.
  const target = taggedAgent(text, choices) || (mentionsAi(text) ? choices[0] || null : null);
  const canChange = Boolean(target && target.can_edit);
  const askMode = canChange ? (mode || 'change') : 'ask';
  const asking = Boolean(target) && askMode === 'ask';
  const ownOrCloud = Boolean(target) && (target.tdoc_ai || !target.team_agent);
  const private_ = asking && ownOrCloud && (onlyMe === null ? onlyMeDefault(target) : onlyMe);
  const tagOf = (t) => `@${AGENT_TAG_JOINER}${agentMentionName(t, choices)}`;
  // The @agent button and its menu: put the default agent in (once), or
  // swap the one already there.
  const field = useRef(null);
  const putAgent = (t) => {
    const tag = tagOf(t);
    setText((cur) => {
      const now = taggedAgent(cur, choices);
      if (now) return cur.split(tagOf(now)).join(tag);
      return `${cur.replace(/\s+$/, '')}${cur.trim() ? ' ' : ''}${tag} `;
    });
    setMode(null);
    setOnlyMe(null);
  };
  const whose = (t) => (t.tdoc_ai ? 'tdoc AI' : t.team_agent ? 'Team' : 'Mine');
  const submit = async (sendToAgent = false) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      // An agent picked after @ that may edit gets this comment, as if
      // chosen in Send to agent -- unless Ask only is ticked.
      const recipient = canSendToAgent && target && canChange && !asking ? target : null;
      await onSubmit(target || mentionsAi(text) ? joinAiTags(text) : text, {
        sendToAgent: canSendToAgent && !asking && (sendToAgent || Boolean(recipient)),
        recipient,
        target,
        askOnly: asking,
        onlyMe: private_,
      });
    } finally {
      setBusy(false);
    }
  };

  if (privateAsk) {
    return (
      <div
        className="tdoc-popup tdoc-private-ask"
        style={{ top, left }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="head">
          <span className="h">{preview}</span>
          <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="tdoc-private-q">{privateAsk.question}</p>
        <div className="tdoc-private-a" aria-live="polite">
          <span className="tdoc-private-who">{privateAsk.label}</span>
          {privateAsk.answer
            ? <MentionText text={privateAsk.answer} mentions={[]} />
            : <span className="tdoc-private-status">{privateAsk.error || privateAsk.status}</span>}
        </div>
        <div className="foot">
          <span className="hint"><Lock size={11} aria-hidden="true" /> Only you can see this</span>
          <div className="tdoc-composer-foot-actions">
            <button className="submit" type="button" disabled={!privateAsk.answer || privateAsk.publishing} onClick={onMakePublic}>
              {privateAsk.publishing ? 'Posting…' : 'Make public'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="tdoc-popup"
      style={{ top, left }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="head">
        {demo ? <span className="tdoc-demo-chip">Demo</span> : null}
        <span className="h">{preview}</span>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div ref={field}><MentionField
        autoFocus
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
      {target ? (
        <div className="tdoc-ask-row">
          <SegmentedControl
            className="tdoc-ask-mode"
            ariaLabel="What the agent does"
            value={askMode}
            onChange={setMode}
            options={[
              { value: 'ask', label: 'Ask' },
              {
                value: 'change',
                label: 'Ask + request change',
                disabled: !canChange,
                reason: target.tdoc_ai ? 'tdoc AI only answers' : 'this agent can’t edit this doc',
              },
            ]}
          />
          {asking && ownOrCloud ? (
            <AppCheckbox className="tdoc-only-me" checked={private_} onCheckedChange={setOnlyMe} label="Only me" />
          ) : null}
        </div>
      ) : null}
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
        {target ? (
          <span className="hint">{asking
            ? `${agentDisplayName(target)} answers${private_ ? ' you alone' : ' in the thread'}${canChange ? '' : target.tdoc_ai ? ' · it only answers' : ' · it can’t edit this doc'}`
            : `${agentDisplayName(target)} answers and may change the doc`}</span>
        ) : (
          <span className="hint">
            {demo
              ? 'Demo — refresh clears it'
              : (canSendToAgent && agentButtons ? '⌘+Enter · ⌘⇧+Enter @agent' : '⌘+Enter to submit')}
          </span>
        )}
        <div className="tdoc-composer-foot-actions">
          {choices.length && !agentButtons ? (
            <AppMenu
              align="end"
              trigger={(
                <button className="tdoc-composer-agent" type="button" disabled={busy} onClick={() => { if (!target) putAgent(choices[0]); }}>
                  @agent
                </button>
              )}
            >
              {['Mine', 'Team', 'tdoc AI'].map((group) => {
                const rows = choices.filter((t) => whose(t) === group);
                if (!rows.length) return null;
                return (
                  <React.Fragment key={group}>
                    <div className="tdoc-agent-menu-group">{group}</div>
                    {rows.map((t) => (
                      <AppMenuItem key={targetKey(t)} className="tdoc-action-menu-item tdoc-agent-menu-item" onClick={() => putAgent(t)}>
                        <ProviderMark target={t} size={14} />
                        <span className="tdoc-agent-menu-name">{agentDisplayName(t, choices)}</span>
                        {t.tdoc_ai && freeLeftText(agents.ai?.remaining)
                          ? <span className="tdoc-agent-menu-hint">{freeLeftText(agents.ai.remaining)}</span>
                          : t.last_writer ? <span className="tdoc-agent-menu-hint">edited last</span> : null}
                        {target && targetKey(target) === targetKey(t) ? <Check size={14} className="tdoc-space-check" aria-label="Picked" /> : null}
                      </AppMenuItem>
                    ))}
                    {group === 'tdoc AI' ? (
                      <AppMenuLinkItem className="tdoc-action-menu-item tdoc-agent-menu-connect" href="/start">Connect my agent →</AppMenuLinkItem>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </AppMenu>
          ) : null}
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
