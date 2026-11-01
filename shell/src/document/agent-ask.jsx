import React, { useContext, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { AgentMentionContext, MentionText } from './mention-field.jsx';
import { AGENT_TAG_JOINER, agentDisplayName, agentMentionName, taggedAgent, targetKey } from './agent-choices.js';
import { AppCheckbox } from '../ui/checkbox.jsx';
import { mentionsAi, onlyMeDefault } from './ai-answerer.js';

// The @agent part of a comment box, shared by the new-comment composer and
// the reply box under a thread (Julie, 2026-10-24):
//   - the @agent button puts the default agent (choices[0]: the one that last
//     edited, if the commenter may drive it) into the text at the caret, as
//     a pill; the pill's dropdown swaps it (MentionField). Typing @ and
//     picking an agent makes the same pill.
//   - no mode to pick: the agent reads the comment and answers or edits. The
//     server's authorship rules decide whether it may edit; where it may not
//     (can_edit false, tdoc AI), the hand-off is answer only and the box says
//     so in one quiet line.
//   - "Only me" for one's own agent or tdoc AI (never a team agent, which
//     answers for the team): a private question, answer only.
// The choices come from AgentMentionContext (document-shell.jsx).

export function useAgentAsk(text, setText, fieldRef = null) {
  const agents = useContext(AgentMentionContext);
  const choices = agents.choices || [];
  const [onlyMe, setOnlyMe] = useState(null);
  // A bare @AI follows this document's evidenced default, if there is one.
  const target = taggedAgent(text, choices) || (mentionsAi(text) ? agents.preselected || null : null);
  const key = target ? targetKey(target) : '';
  useEffect(() => { setOnlyMe(null); }, [key]);
  const canChange = Boolean(target && target.can_edit);
  // Embedded feedback can hand a comment to an editor, but has no private
  // answer flow. Hide Only me there so a tagged comment is never silently
  // posted without reaching the agent.
  const ownOrCloud = Boolean(target) && Boolean(target.tdoc_ai || !target.team_agent)
    && agents.privateAskSupported !== false;
  const private_ = ownOrCloud && (onlyMe === null ? onlyMeDefault(target) : onlyMe);
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
  // The @agent button: the default agent's pill at the caret. With one there
  // already, the caret goes back to the text.
  const putDefault = () => {
    const box = fieldRef && fieldRef.current;
    const next = agents.preselected
      ? withAgent(text, agents.preselected, box ? box.selectionStart : null)
      : { text: `${text}${text && !/\s$/.test(text) ? ' ' : ''}@`, caret: null };
    if (next.text !== text) setText(next.text);
    requestAnimationFrame(() => {
      const el = fieldRef && fieldRef.current;
      if (!el) return;
      el.focus();
      if (next.caret != null) el.setSelectionRange(next.caret, next.caret);
    });
  };
  // What a submit sends. `withDefault` (⌘⇧Enter): put the default agent in
  // first when none is named.
  const outgoing = (withDefault = false) => {
    const named = target;
    const filled = withDefault && !named ? withAgent(text) : { text };
    const t = named || (withDefault ? agents.preselected || null : null);
    const ownCloud = Boolean(t) && Boolean(t.tdoc_ai || !t.team_agent);
    const only = Boolean(t) && ownCloud && (t === named ? private_ : onlyMeDefault(t));
    const mayEdit = Boolean(t && t.can_edit) && !only;
    return { text: filled.text, target: t, onlyMe: only, askOnly: Boolean(t) && !mayEdit };
  };
  return {
    agents, choices, target, canChange, ownOrCloud, onlyMe: private_,
    setOnlyMe, putDefault, outgoing,
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

// Under the text, once an agent is named: "Answers only" where it may not
// edit this doc, and "Only me" where it applies.
export function AgentAskRow({ ask, hint = null }) {
  const { target, canChange, ownOrCloud, onlyMe, setOnlyMe } = ask;
  if (!target) return null;
  const note = !canChange || onlyMe;
  if (!note && !ownOrCloud && !hint) return null;
  return (
    <div className="tdoc-ask-row">
      {note ? <span className="tdoc-ask-only-label">Answers only</span> : null}
      {ownOrCloud ? (
        <AppCheckbox className="tdoc-only-me" checked={onlyMe} onCheckedChange={setOnlyMe} label="Only me" />
      ) : null}
      {hint ? <span className="tdoc-ask-hint">{hint}</span> : null}
    </div>
  );
}

// The line under the box saying what the named agent will do.
export function agentAskHint(ask) {
  const { target, onlyMe, canChange, choices } = ask;
  if (!target) return null;
  // The pill's short name (Julie, 2026-10-25).
  const name = agentMentionName(target, choices);
  if (onlyMe) return `${name} answers you alone`;
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
