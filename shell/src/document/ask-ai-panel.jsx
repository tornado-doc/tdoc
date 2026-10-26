import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AppMenu } from '../ui/menu.jsx';
import { agentMentionName, sameTarget } from './agent-choices.js';
import { AgentMenuItems } from './agent-menu.jsx';
import { Author, CommentMessageText, ReplyMessage } from './comment-card.jsx';

// A document-level question starts private. Sending a saved comment to an
// editor stays a separate action, visible only when comments are ready.
export function AskAiPanel({ open, draft, onDraft, targetKey, onTarget, targets, viewer,
  turns, busy, remaining, onAsk, onKeep, onPost, readyCount, onSendReady,
  activityOpen, onActivityOpen, unreadCount, children }) {
  const input = useRef(null);
  const [expandedTurnId, setExpandedTurnId] = useState(null);
  useEffect(() => {
    // Focusing during a phone panel's opening animation raises the software
    // keyboard and changes the visual viewport before the panel settles.
    // Let the reader choose when to type; desktop keeps direct focus.
    if (open && !activityOpen && !window.matchMedia('(max-width: 700px)').matches) input.current?.focus();
  }, [open, activityOpen]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [draft, open]);
  const selected = targets.find((target) => target.key === targetKey) || targets[0];
  const choices = targets.map((item) => item.target);
  const noFreeAnswers = selected?.tdocAi && remaining === 0;
  const latest = turns.at(-1);
  useEffect(() => { setExpandedTurnId(null); }, [latest?.id]);
  const activeTurnId = expandedTurnId || latest?.id;
  return <div className="tdoc-ask-panel">
    <h2>Ask AI</h2>
    <form className="tdoc-ask-form" onSubmit={(event) => { event.preventDefault(); onAsk(); }}>
      <textarea ref={input} aria-label="Ask about this document" placeholder={latest ? 'Ask a follow-up…' : 'Ask about this document…'}
        rows={2} value={draft} onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); onAsk(); } }} />
      <div className="tdoc-ask-form-bottom">
        {selected ? <AppMenu align="start" popupClassName="tdoc-agent-menu" positionerClassName="tdoc-ask-target-menu-positioner" trigger={(
          <button type="button" className="tdoc-ask-target-pill tdoc-agent-pill" aria-label="Who should answer?">
            {agentMentionName(selected.target, choices)} <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}>
          <AgentMenuItems choices={choices} ai={{ remaining }} current={selected.target} preserveOrder maxVisible={4} showConnect={false} showRelevance pinTdocAi
            onPick={(target) => onTarget(targets.find((item) => sameTarget(item.target, target))?.key || selected.key)} />
        </AppMenu> : null}
        <button type="submit" aria-label="Send question" disabled={!draft.trim() || busy || !selected || noFreeAnswers}>↑</button>
      </div>
    </form>
    <div className="tdoc-ask-only-hint">Answers only · won’t edit this document</div>
    {noFreeAnswers ? <div className="tdoc-ask-notice">No free tdoc AI answers left. <a href="/start">Connect my agent</a> to keep asking.</div> : null}
    {!targets.length ? <div className="tdoc-ask-notice">Connect an agent to ask about this document. <a href="/start">Connect my agent</a></div> : null}
    {readyCount > 0 && onSendReady ? <div className="tdoc-ask-ready">
      <span>{readyCount} {readyCount === 1 ? 'comment' : 'comments'} not sent</span>
      <button type="button" onClick={onSendReady}>Send to agent →</button>
    </div> : null}
    {turns.length ? <div className="tdoc-ask-conversation" aria-live="polite">
      {turns.map((turn) => activeTurnId !== turn.id ? <button type="button" className="tdoc-ask-turn-summary" key={turn.id}
        aria-expanded="false" onClick={() => setExpandedTurnId(turn.id)}>
        <span>{turn.question}</span><span>{turn.status === 'answered' ? 'View answer ›' : 'View ›'}</span>
      </button> : <div className={`tdoc-ask-turn${turn.public ? ' is-public' : ''}`} key={turn.id}>
        {turn.id !== latest?.id ? <button type="button" className="tdoc-ask-turn-collapse" onClick={() => setExpandedTurnId(null)}>Latest answer ↑</button> : null}
        <div className="tdoc-margin-comment tdoc-ask-question">
          <Author author={viewer || { login: 'You' }} />
          <CommentMessageText text={turn.question} />
        </div>
        <div className={`tdoc-reply tdoc-ask-answer${turn.status === 'failed' ? ' is-error' : ''}`}>
          <div className="tdoc-ask-answer-body"><ReplyMessage
            author={{ ...turn.target, kind: 'agent', handle: turn.label, login: turn.label }}
            text={turn.status === 'thinking' ? 'Reading this document…'
              : turn.status === 'waiting' ? 'Sent · waiting for your agent…'
                : turn.status === 'failed' ? turn.error || 'Could not get an answer.' : turn.answer} />
          </div>
          <div className="tdoc-ask-visibility">{turn.public ? 'Posted as a comment · Visible to everyone' : 'Only you can see this'}</div>
          {turn.status === 'failed' ? <button type="button" onClick={() => onAsk(turn.question, turn.target)}>Retry</button>
            : turn.status === 'thinking' || turn.status === 'waiting' ? null
              : <>
                  {turn.public ? null
                    : turn.kept ? <span className="tdoc-ask-private-note">Kept private</span>
                      : <div className="tdoc-ask-answer-actions">
                        <button type="button" onClick={() => onKeep(turn.id)}>Keep to myself</button>
                        <button type="button" className="primary" disabled={turn.publishing} onClick={() => onPost(turn.id)}>{turn.publishing ? 'Posting…' : 'Post as comment'}</button>
                      </div>}
                </>}
        </div>
      </div>)}
    </div> : null}
    <button type="button" className="tdoc-ask-activity-toggle" aria-expanded={activityOpen} onClick={() => onActivityOpen(!activityOpen)}>
      <span>Agent activity</span><span>{unreadCount ? `${unreadCount} new · ` : ''}{activityOpen ? '⌃' : '›'}</span>
    </button>
    {activityOpen ? <div className="tdoc-ask-activity">{children}</div> : null}
  </div>;
}
