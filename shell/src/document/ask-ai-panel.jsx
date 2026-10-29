import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { AppButton } from '../ui/button.jsx';
import { AppCheckbox } from '../ui/checkbox.jsx';
import { readStored, writeStored } from '../safe-storage.js';
import { agentMentionName, sameTarget } from './agent-choices.js';
import { AgentMenuItems } from './agent-menu.jsx';
import { Author, CommentMessageText, ReplyMessage, authorLine } from './comment-card.jsx';
import { HandoffSendResult, defaultInstruction, useHandoffSend } from './notify-handoff.jsx';

// The last mode picked on this doc: Ask, or Send to agent.
const modeKey = (slug) => `tdoc-ask-mode:${slug}`;

// The agent pill and its menu, the composer's (agent-menu.jsx): who
// answers in Ask, who gets the comments in Send to agent.
function AgentPill({ label, ariaLabel, children }) {
  return <AppMenu align="start" popupClassName="tdoc-agent-menu" trigger={(
    <button type="button" className="tdoc-ask-target-pill tdoc-agent-pill" aria-label={ariaLabel}>
      {label} <ChevronDown size={12} aria-hidden="true" />
    </button>
  )}>{children}</AppMenu>;
}

const commentCount = (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`;

// Ask or Send to agent: a quiet setting in the input's bottom row, beside
// the agent pill and in its style and menu rows -- not a filled switch above
// the input. Only where the viewer may send (`send`).
function ModePicker({ mode, onPick, ready }) {
  const row = (value, name, desc, disabled = false) => <AppMenuItem className="tdoc-agent-menu-item tdoc-ask-mode-item"
    disabled={disabled} onClick={() => onPick(value)}>
    <span className="tdoc-ask-mode-item-text"><b>{name}</b> — {desc}</span>
    <span className="tdoc-agent-menu-check">{mode === value ? <Check size={13} aria-label="Picked" /> : null}</span>
  </AppMenuItem>;
  return <AppMenu align="start" popupClassName="tdoc-agent-menu tdoc-ask-mode-menu" trigger={(
    <button type="button" className="tdoc-ask-target-pill tdoc-ask-mode-pill" aria-label={`Mode: ${mode === 'send' ? 'Send to agent' : 'Ask'}`}>
      {mode === 'send' ? 'Send to agent' : 'Ask'} <ChevronDown size={12} aria-hidden="true" />
    </button>
  )}>
    {row('ask', 'Ask', 'the agent answers')}
    {row('send', 'Send to agent', ready ? `hand over ${commentCount(ready)} to fix` : 'No comments ready', !ready)}
  </AppMenu>;
}

// What Send to agent hands over, one quiet line above the input: "5
// comments will be sent · Choose". Choose opens every not-yet-sent comment
// (who + its first line) as a checkbox, all checked by default; closing it
// keeps the selection ("3 of 5 comments will be sent"). An unchecked
// comment stays pending.
function PendingComments({ comments, chosen, onToggle }) {
  const [open, setOpen] = useState(false);
  const total = comments.length;
  const k = comments.filter((c) => chosen.includes(c.id)).length;
  return <div className="tdoc-ask-send-payload">
    <div className="tdoc-ask-send-summary">
      <span>{k === total ? `${commentCount(total)} will be sent` : `${k} of ${commentCount(total)} will be sent`}</span>
      <span aria-hidden="true"> · </span>
      <AppButton variant="quiet" size="s" className="tdoc-ask-send-choose" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Done' : 'Choose'}</AppButton>
    </div>
    {open ? <div className="tdoc-ask-send-list" role="group" aria-label="Comments to send">
      {comments.map((c) => <AppCheckbox key={c.id} className="tdoc-ask-send-item" checked={chosen.includes(c.id)}
        onCheckedChange={(on) => onToggle(c.id, on)}
        label={<><b>{authorLine(c.author)}</b> <span>{String(c.text || '').split('\n').find((line) => line.trim()) || ''}</span></>} />)}
    </div> : null}
  </div>;
}

// Send to agent, inside Ask AI: the doc's comments ready to hand off, to
// the agent picked here, through the Send to agent dialog's own send
// (useHandoffSend) and its delivery line. The comments are the payload, so
// they are counted above the input (and can be chosen) and on the button;
// the note is optional, behind "+ Add a note".
function SendToAgentForm({ send, modePicker }) {
  const { slug, choices, preselected, readyIds, ready = [], onSent } = send;
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const sending = useHandoffSend(slug, onSent);
  const input = useRef(null);
  useEffect(() => { if (noteOpen) input.current?.focus(); }, [noteOpen]);
  // The doc's own agent, as the dialog preselects it; else the person picks.
  const recipient = (picked && choices.find((t) => sameTarget(t, picked)))
    || (preselected && choices.find((t) => sameTarget(t, preselected))) || null;
  // The Send to agent dialog's selection: comment ids, kept only while
  // still ready (as Agent activity's Ready to send). Tracked as unchecked
  // ids so every comment -- and one arriving later -- starts checked.
  const [unchecked, setUnchecked] = useState([]);
  const chosen = readyIds.filter((id) => !unchecked.includes(id));
  const toggle = (id, on) => setUnchecked((ids) => (on ? ids.filter((x) => x !== id) : [...ids, id]));
  const n = chosen.length;
  const canSend = n > 0 && Boolean(recipient) && !sending.busy;
  const submit = async (event) => {
    event?.preventDefault();
    if (!canSend) return;
    const body = await sending.send({ commentIds: chosen, recipient, instruction: note.trim() || defaultInstruction(chosen) });
    if (body) { setNote(''); setNoteOpen(false); setUnchecked([]); }
  };
  return <>
    {readyIds.length ? <>
      <PendingComments comments={ready.length ? ready : readyIds.map((id) => ({ id }))} chosen={chosen} onToggle={toggle} />
      <form className="tdoc-ask-form tdoc-ask-send-form" onSubmit={submit}>
        {noteOpen ? <textarea ref={input} aria-label="Note for the agent" placeholder="Note for the agent…"
          rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          : <div className="tdoc-ask-note-add"><AppButton variant="quiet" size="s" onClick={() => setNoteOpen(true)}>+ Add a note</AppButton></div>}
        <div className="tdoc-ask-form-bottom">
          <div className="tdoc-ask-form-pills">
            {modePicker}
            {choices.length ? <AgentPill ariaLabel="Who should get these?" label={recipient ? agentMentionName(recipient, choices) : 'Choose an agent'}>
              <AgentMenuItems choices={choices} current={recipient} preserveOrder maxVisible={4} showConnect={false} showRelevance
                onPick={(target) => { setPicked(target); sending.setResult(null); }} />
            </AgentPill> : null}
          </div>
          {/* type="button": the Ask form's round ↑ styles every submit button in this row. */}
          <AppButton variant="primary" size="s" className="tdoc-ask-send-btn" disabled={!canSend} onClick={submit}>
            {sending.busy ? 'Sending…' : sending.result && !sending.result.ok ? 'Retry' : `Send ${commentCount(n)}`}
          </AppButton>
        </div>
      </form>
    </> : <div className="tdoc-ask-send-empty">
      <p className="tdoc-ask-send-none">No comments to send to an agent right now.</p>
      <div className="tdoc-ask-form-bottom"><div className="tdoc-ask-form-pills">{modePicker}</div></div>
    </div>}
    <HandoffSendResult result={sending.result} />
  </>;
}

// A document-level question starts private; a team agent's answer is a
// comment everyone sees, and the panel says so before anything is sent.
// Where the viewer may hand off comments (`send`), the same panel switches
// to Send to agent: the doc's ready comments, to the agent picked here.
export function AskAiPanel({ open, draft, onDraft, targetKey, onTarget, targets, viewer,
  disabledChoices = [], guestAction = null,
  turns, busy, remaining, onAsk, onKeep, onPost, send = null,
  activityOpen, onActivityOpen, unreadCount, signInToAsk = false, onConnect = null, children }) {
  const input = useRef(null);
  const [expandedTurnId, setExpandedTurnId] = useState(null);
  const [storedMode, setStoredMode] = useState(() => (send && readStored(modeKey(send.slug)) === 'send' ? 'send' : 'ask'));
  const mode = send ? storedMode : 'ask';
  const pickMode = (next) => {
    setStoredMode(next);
    if (send) writeStored(modeKey(send.slug), next);
  };
  useEffect(() => {
    if (open && !activityOpen && mode === 'ask') input.current?.focus();
  }, [open, activityOpen, mode]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [draft, open, mode]);
  const selected = targets.find((target) => target.key === targetKey) || targets[0];
  const choices = targets.map((item) => item.target);
  const noFreeAnswers = selected?.tdocAi && remaining === 0;
  const teamAgent = selected && !selected.tdocAi && selected.target?.team_agent ? agentMentionName(selected.target, choices) : '';
  const latest = turns.at(-1);
  useEffect(() => { setExpandedTurnId(null); }, [latest?.id]);
  const activeTurnId = expandedTurnId || latest?.id;
  const modePicker = send ? <ModePicker mode={mode} onPick={pickMode} ready={send.readyIds.length} /> : null;
  return <div className="tdoc-ask-panel">
    <h2>Ask AI</h2>
    {mode === 'send' ? <SendToAgentForm send={send} modePicker={modePicker} /> : <>
    <form className="tdoc-ask-form" onSubmit={(event) => { event.preventDefault(); onAsk(); }}>
      <textarea ref={input} aria-label="Ask about this document" placeholder={latest ? 'Ask a follow-up…' : 'Ask about this document…'}
        rows={2} value={draft} onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); onAsk(); } }} />
      <div className="tdoc-ask-form-bottom">
        <div className="tdoc-ask-form-pills">
          {modePicker}
          {selected ? <AgentPill ariaLabel="Who should answer?" label={agentMentionName(selected.target, choices)}>
            <AgentMenuItems choices={choices} disabledChoices={disabledChoices} guestAction={guestAction} ai={{ remaining }} current={selected.target} preserveOrder maxVisible={4} showConnect={signInToAsk} onConnect={onConnect} showRelevance pinTdocAi
              onPick={(target) => onTarget(targets.find((item) => sameTarget(item.target, target))?.key || selected.key)} />
          </AgentPill> : null}
        </div>
        <button type="submit" aria-label="Send question" disabled={!draft.trim() || busy || !selected || noFreeAnswers}>↑</button>
      </div>
    </form>
    <div className="tdoc-ask-only-hint">{signInToAsk ? 'Free · sign in to get your answer' : 'Answers only · won’t edit this document'}</div>
    {teamAgent ? <div className="tdoc-ask-notice tdoc-ask-public-notice" role="note">{teamAgent} is a team agent: its answer is posted as a comment everyone can see</div> : null}
    {noFreeAnswers ? <div className="tdoc-ask-notice">No free tdoc AI answers left. <a href="/start">Connect my agent</a> to keep asking.</div> : null}
    {!targets.length && !signInToAsk ? <div className="tdoc-ask-notice">Connect an agent to ask about this document. <a href="/start">Connect my agent</a></div> : null}
    </>}
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
          {turn.status === 'failed' ? <button type="button" className="ui-btn ui-btn-primary ui-btn-m" onClick={() => onAsk(turn.question, turn.target)}>Retry</button>
            : turn.status === 'thinking' || turn.status === 'waiting' ? null
              : <>
                  {turn.public ? null
                    : turn.kept ? <span className="tdoc-ask-private-note">Kept private</span>
                      : <div className="tdoc-ask-answer-actions">
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-m" onClick={() => onKeep(turn.id)}>Keep to myself</button>
                        <button type="button" className="primary ui-btn ui-btn-primary ui-btn-m" disabled={turn.publishing} onClick={() => onPost(turn.id)}>{turn.publishing ? 'Posting…' : 'Post as comment'}</button>
                      </div>}
                </>}
        </div>
      </div>)}
    </div> : null}
    {children ? <button type="button" className="tdoc-ask-activity-toggle" aria-expanded={activityOpen} onClick={() => onActivityOpen(!activityOpen)}>
      <span>Agent activity</span><span>{unreadCount ? `${unreadCount} new · ` : ''}{activityOpen ? '⌃' : '›'}</span>
    </button> : null}
    {children && activityOpen ? <div className="tdoc-ask-activity">{children}</div> : null}
  </div>;
}
