import React, { useContext, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { AgentMentionContext, MentionText } from './mention-field.jsx';
import { AGENT_BUTTON_LABEL, AGENT_TAG_JOINER, agentDisplayName, agentMentionName, sendToAgentState, sendToAgentWords, taggedAgent, taggedAgentSpan, targetKey } from './agent-choices.js';
import { AppCheckbox } from '../ui/checkbox.jsx';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { AgentMenuItems } from './agent-menu.jsx';
import { mentionsAi, onlyMeDefault } from './ai-answerer.js';

// The @agent part of a comment box, shared by the new-comment composer and
// the reply box under a thread (Julie, 2026-10-24):
//   - the @agent button puts the default agent (preselected: composerDefault,
//     the @ list's top row that may edit) into the text at the caret, as a
//     pill; the pill's dropdown swaps it (MentionField). Typing @ and
//     picking an agent makes the same pill.
//   - the agent reads the comment and answers or edits. The server's
//     authorship rules decide whether it may edit; where it may not (can_edit
//     false, tdoc AI), the hand-off is answer only.
//   - "Ask only" beside Comment / Reply, shown once an agent is named, off by
//     default (Julie, 2026-11-08): ticked, the hand-off is answer only, and
//     the server holds the agent to it (worker answer lock). Where the agent
//     could only answer anyway (or Only me is on) it shows ticked and locked.
//   - "Only me" for one's own agent or tdoc AI (never a team agent, which
//     answers for the team): a private question, answer only.
// The choices come from AgentMentionContext (document-shell.jsx).

export function useAgentAsk(text, setText, fieldRef = null) {
  const agents = useContext(AgentMentionContext);
  const choices = agents.choices || [];
  const [onlyMe, setOnlyMe] = useState(null);
  const [askOnlyPicked, setAskOnly] = useState(false);
  // A bare @AI follows this composer's default, if there is one.
  const target = taggedAgent(text, choices) || (mentionsAi(text) ? agents.preselected || null : null);
  const key = target ? targetKey(target) : '';
  useEffect(() => { setOnlyMe(null); setAskOnly(false); }, [key]);
  const canChange = Boolean(target && target.can_edit);
  // Embedded feedback can hand a comment to an editor, but has no private
  // answer flow. Hide Only me there so a tagged comment is never silently
  // posted without reaching the agent.
  const ownOrCloud = Boolean(target) && Boolean(target.tdoc_ai || !target.team_agent)
    && agents.privateAskSupported !== false;
  const private_ = ownOrCloud && (onlyMe === null ? onlyMeDefault(target) : onlyMe);
  // Answer only whatever the box says: it may not edit, or Only me.
  const askOnlyForced = Boolean(target) && (!canChange || private_);
  const askOnly = Boolean(target) && (askOnlyForced || askOnlyPicked);
  // Where a question cannot reach this agent, Ask only is not offered and
  // the comment is handed over as before: the widget on another site's page
  // asks nobody, own or team agent (worker feedbackTokenOwnAgent: tdoc's own
  // pages only).
  const askOnlyOffered = Boolean(target) && agents.ownAskSupported !== false
    && !(target.team_agent && agents.teamAskSupported === false);
  const tagOf = (t) => `@${AGENT_TAG_JOINER}${agentMentionName(t, choices)}`;
  // The text with the default agent in it, at `at` (the caret) or the end.
  const withAgent = (cur, t = agents.preselected, at = null) => {
    if (!t || taggedAgent(cur, choices)) return { text: cur, caret: null };
    const pos = at == null ? cur.length : Math.max(0, Math.min(at, cur.length));
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const tag = `${lead}${tagOf(t)} `;
    return { text: `${before}${tag}${after.replace(/^ /, '')}`, caret: pos + tag.length };
  };
  // The @agent button: `t`'s pill (the default agent's) at the caret, or a
  // bare @ to pick from when there is none. With a pill there already, the
  // caret goes back to the text.
  const putTag = (t) => {
    const box = fieldRef && fieldRef.current;
    const next = t
      ? withAgent(text, t, box ? box.selectionStart : null)
      : { text: `${text}${text && !/\s$/.test(text) ? ' ' : ''}@`, caret: null };
    if (next.text !== text) setText(next.text);
    requestAnimationFrame(() => {
      const el = fieldRef && fieldRef.current;
      if (!el) return;
      el.focus();
      if (next.caret != null) el.setSelectionRange(next.caret, next.caret);
    });
  };
  const putDefault = () => putTag(agents.preselected);
  // Start the box with this agent's tag, caret after it. Returns the text.
  const putAgent = (t) => {
    const next = withAgent(text, t, 0);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = fieldRef && fieldRef.current;
      if (el && next.caret != null && document.activeElement === el) el.setSelectionRange(next.caret, next.caret);
    });
    return next.text;
  };
  const caretAfter = (pos) => requestAnimationFrame(() => {
    const el = fieldRef && fieldRef.current;
    if (el && document.activeElement === el) el.setSelectionRange(pos, pos);
  });
  // The Send to agent control swaps the tag the picker inserted; typing @
  // makes the same tag, so both paths hand the comment to the same agent.
  const replaceAgent = (t) => {
    const span = taggedAgentSpan(text, choices);
    if (!span) { putAgent(t); return; }
    const tag = `${tagOf(t)} `;
    const next = `${text.slice(0, span.start)}${tag}${text.slice(span.end).replace(/^ /, '')}`;
    setText(next);
    caretAfter(span.start + tag.length);
  };
  const clearAgent = () => {
    const span = taggedAgentSpan(text, choices);
    if (!span) return;
    setText(`${text.slice(0, span.start)}${text.slice(span.end).replace(/^ /, '')}`);
    caretAfter(span.start);
  };
  // What a submit sends. `withDefault` (⌘⇧Enter): put the default agent in
  // first when none is named.
  const outgoing = (withDefault = false) => {
    const named = target;
    const filled = withDefault && !named ? withAgent(text) : { text };
    const t = named || (withDefault ? agents.preselected || null : null);
    const ownCloud = Boolean(t) && Boolean(t.tdoc_ai || !t.team_agent);
    const only = Boolean(t) && ownCloud && (t === named ? private_ : onlyMeDefault(t));
    const mayEdit = Boolean(t && t.can_edit) && !only && !(t === named && askOnlyPicked);
    return { text: filled.text, target: t, onlyMe: only, askOnly: Boolean(t) && !mayEdit };
  };
  return {
    agents, choices, target, canChange, ownOrCloud, onlyMe: private_,
    askOnly, askOnlyForced, askOnlyOffered, setAskOnly,
    setOnlyMe, putDefault, putTag, putAgent, replaceAgent, clearAgent, outgoing,
  };
}

// The @agent button: puts the default agent's pill in. Nothing when there is
// no agent to offer.
export function AgentButton({ ask, busy = false, className = 'tdoc-composer-agent ui-btn ui-btn-secondary ui-btn-m' }) {
  // Once the text names an agent the button has nothing left to do; the tag
  // itself changes or removes it, and Comment sends to it.
  if (!ask.choices.length || ask.target) return null;
  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      // Keep the caret where it is in the text: that is where the pill goes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={ask.putDefault}
      title={ask.agents.preselected ? `Add ${agentDisplayName(ask.agents.preselected, ask.choices)} to this comment` : 'Choose an agent for this comment'}
    >
      @agent
    </button>
  );
}

// The one Send to agent control every comment box shows (Kat feedback): the
// same judgment the @ picker uses, so the doc page and the widget cannot
// drift. Ready: it names the default/last agent and its menu swaps the tag
// the comment will carry (or turns it off). Connect: the viewer could send
// but nobody is linked, so it opens the connect prompt instead of failing.
// Disabled: it stays visible and says why on hover.
export function SendToAgentToggle({ ask, busy = false, className = 'tdoc-send-agent-toggle ui-btn ui-btn-secondary ui-btn-m', onConnect = null }) {
  const { agents, choices, target } = ask;
  const state = agents.sendToAgent || sendToAgentState({
    canSendToAgent: Boolean(agents.canSendToAgent),
    choices,
    disabledReason: agents.sendToAgentDisabledReason,
    connectPrompt: agents.connectAgentPrompt,
    setupHref: agents.agentSetupHref,
  });
  const editable = state.kind === 'ready' ? state.choices : [];
  // The control is also the @agent button: an agent that may only answer is
  // still somebody the comment can go to (Ask only / Only me), so the button
  // stays live on those rows even though they are not send targets.
  const offer = choices;
  const askable = state.kind !== 'ready' && state.kind !== 'connect' && offer.length > 0;
  const menuChoices = editable.length ? editable : offer;
  const current = target && offer.some((t) => targetKey(t) === targetKey(target)) ? target : null;
  const pre = (list) => list.find((t) => agents.preselected && targetKey(t) === targetKey(agents.preselected));
  // The agent the button names is the one its click puts in: this box's
  // default only. With none (composerDefault never hands a member or reader
  // somebody else's agent) it names nobody and its click is a bare @ to
  // pick from -- never a label for one agent and a click for another.
  const fallback = (state.kind === 'ready' ? pre(editable) : askable ? pre(offer) : null) || null;
  const shown = current || fallback;
  if (state.kind === 'connect') {
    const title = state.prompt || state.reason || 'Connect an agent to send comments to it';
    if (onConnect) {
      return <button className={className} type="button" disabled={busy} onClick={onConnect} title={title}>{AGENT_BUTTON_LABEL}</button>;
    }
    if (state.href) {
      return <a className={className} href={state.href} title={title}>{AGENT_BUTTON_LABEL}</a>;
    }
    return <button className={className} type="button" disabled title={title}>{AGENT_BUTTON_LABEL}</button>;
  }
  if (state.kind !== 'ready' && !askable) {
    return <button className={className} type="button" disabled title={state.reason}>{AGENT_BUTTON_LABEL}</button>;
  }
  const words = sendToAgentWords(shown, { editable, offer, asking: state.kind !== 'ready' });
  // Nothing named yet: the control is the @agent button, as before #1034
  // (Julie, 2026-11-14: "@agent", not "Send to agent · Name"). Its click
  // puts this box's default agent in (putDefault: composerDefault, which
  // never hands a member or reader somebody else's agent), else a bare @ to
  // pick from; the pill's own menu swaps it. Once a pill is in the text the
  // control becomes the switch: pick another agent or turn it off.
  if (!current) {
    return (
      <button
        className={className}
        type="button"
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={ask.putDefault}
        title={words.title}
      >
        {words.label}
      </button>
    );
  }
  return (
    <AppMenu
      align="end"
      popupClassName="tdoc-agent-menu"
      trigger={(
        <button
          className={className}
          type="button"
          disabled={busy}
          aria-pressed
          title={words.switchTitle}
        >
          {words.label}
        </button>
      )}
    >
      <AppMenuItem className="tdoc-agent-menu-item" onClick={ask.clearAgent}><span className="tdoc-agent-menu-name">{words.off}</span></AppMenuItem>
      <AgentMenuItems choices={menuChoices} current={current} onPick={ask.replaceAgent} showConnect={false} preserveOrder />
    </AppMenu>
  );
}

// "Ask only", beside the send button, once an agent is named. Ticked and
// locked where the agent may only answer anyway (it may not edit this doc,
// tdoc AI, or Only me); otherwise off until ticked.
export function AskOnlyToggle({ ask, busy = false }) {
  const { target, askOnly, askOnlyForced, askOnlyOffered, setAskOnly, onlyMe } = ask;
  if (!target || !askOnlyOffered) return null;
  const why = !askOnlyForced ? 'Answer only: no edits, no suggestions'
    : onlyMe ? 'Only me: the answer is yours alone, no edits'
    : `${agentMentionName(target, ask.choices)} only answers on this doc`;
  return (
    <span className="tdoc-ask-only" title={why}>
      <AppCheckbox checked={askOnly} disabled={askOnlyForced || busy} onCheckedChange={setAskOnly} label="Ask only" />
    </span>
  );
}

// Under the text, once an agent is named: "Only me" where it applies.
export function AgentAskRow({ ask, hint = null }) {
  const { target, ownOrCloud, onlyMe, setOnlyMe } = ask;
  if (!target) return null;
  if (!ownOrCloud && !hint) return null;
  return (
    <div className="tdoc-ask-row">
      {ownOrCloud ? (
        <AppCheckbox className="tdoc-only-me" checked={onlyMe} onCheckedChange={setOnlyMe} label="Only me" />
      ) : null}
      {hint ? <span className="tdoc-ask-hint">{hint}</span> : null}
    </div>
  );
}

// The line under the box saying what the named agent will do.
export function agentAskHint(ask) {
  const { target, onlyMe, canChange, askOnly, choices, agents } = ask;
  if (!target) return null;
  // The pill's short name (Julie, 2026-10-25).
  const name = agentMentionName(target, choices);
  if (onlyMe) return `${name} answers you alone`;
  if (askOnly) return `${name} answers in the thread`;
  if (canChange && agents?.suggestsFor?.(target)) return `${name} answers or suggests edits`;
  if (canChange && agents?.fixesTheApp) return `${name} answers or fixes the app`;
  return canChange ? `${name} answers or changes the doc` : `${name} answers in the thread`;
}

// An "Only me" question and its answer, shown to the asker alone:
// { question, label, status, answer, error, publishing }.
export function PrivateAnswer({ privateAsk, onMakePublic, onClose = null, submitClassName = 'submit' }) {
  return (
    <>
      <p className="tdoc-private-q">{privateAsk.question}</p>
      <div className="tdoc-private-a" aria-live="polite">
        <span className="tdoc-private-who">{privateAsk.label}</span>
        {privateAsk.answer
          ? <MentionText text={privateAsk.answer} mentions={[]} />
          : <span className="tdoc-private-status">{privateAsk.error || privateAsk.status}</span>}
      </div>
      <div className="foot tdoc-private-foot">
        <span className="hint"><Lock size={11} aria-hidden="true" /> Only you can see this</span>
        <div className="tdoc-composer-foot-actions">
          {onClose ? <button className="tdoc-private-dismiss ui-btn ui-btn-secondary ui-btn-m" type="button" onClick={onClose}>Dismiss</button> : null}
          <button className={`${submitClassName} ui-btn ui-btn-primary ui-btn-m`} type="button" disabled={!privateAsk.answer || privateAsk.publishing} onClick={onMakePublic}>
            {privateAsk.publishing ? 'Posting…' : 'Make public'}
          </button>
        </div>
      </div>
    </>
  );
}
