import React, { useEffect, useRef } from 'react';
import { AppSelect } from '../ui/select.jsx';

// A document-level question starts private. Sending a saved comment to an
// editor stays a separate action, visible only when comments are ready.
export function AskAiPanel({ open, draft, onDraft, targetKey, onTarget, targets,
  turns, busy, remaining, onAsk, onKeep, onPost, readyCount, onSendReady,
  activityOpen, onActivityOpen, unreadCount, children }) {
  const input = useRef(null);
  useEffect(() => {
    if (open && !activityOpen) input.current?.focus();
  }, [open, activityOpen]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [draft, open]);
  const selected = targets.find((target) => target.key === targetKey) || targets[0];
  const noFreeAnswers = selected?.tdocAi && remaining === 0;
  const latest = turns.at(-1);
  return <div className="tdoc-ask-panel">
    <h2>Ask AI</h2>
    <form className="tdoc-ask-form" onSubmit={(event) => { event.preventDefault(); onAsk(); }}>
      <textarea ref={input} aria-label="Ask about this document" placeholder={latest ? 'Ask a follow-up…' : 'Ask about this document…'}
        rows={2} value={draft} onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); onAsk(); } }} />
      <div className="tdoc-ask-form-bottom">
        <AppSelect plain className="tdoc-ask-target-select" ariaLabel="Who should answer?" value={selected?.key || ''}
          onChange={onTarget} options={targets.map((target) => ({ value: target.key, label: target.label }))} />
        <button type="submit" aria-label="Send question" disabled={!draft.trim() || busy || !selected || noFreeAnswers}>↑</button>
      </div>
    </form>
    {noFreeAnswers ? <div className="tdoc-ask-notice">No free tdoc AI answers left. <a href="/start">Connect my agent</a> to keep asking.</div> : null}
    {!targets.length ? <div className="tdoc-ask-notice">Connect an agent to ask about this document. <a href="/start">Connect my agent</a></div> : null}
    {readyCount > 0 && onSendReady ? <div className="tdoc-ask-ready">
      <span>{readyCount} {readyCount === 1 ? 'comment' : 'comments'} not sent</span>
      <button type="button" onClick={onSendReady}>Send to agent →</button>
    </div> : null}
    {turns.length ? <div className="tdoc-ask-conversation" aria-live="polite">
      {turns.map((turn) => <div className="tdoc-ask-turn" key={turn.id}>
        <div className="tdoc-ask-question">{turn.question}</div>
        <div className={`tdoc-ask-answer${turn.status === 'failed' ? ' is-error' : ''}`}>
          <div className="tdoc-ask-answer-heading">{turn.public ? 'Posted as a comment · Visible to everyone' : `${turn.label} · Only you can see this`}</div>
          {turn.status === 'thinking' ? <p>Reading this document…</p>
            : turn.status === 'waiting' ? <p>Sent · waiting for your agent…</p>
              : turn.status === 'failed' ? <><p>{turn.error || 'Could not get an answer.'}</p><button type="button" onClick={() => onAsk(turn.question, turn.target)}>Retry</button></>
                : <><p>{turn.answer}</p>
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
