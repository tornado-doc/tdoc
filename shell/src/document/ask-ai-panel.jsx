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

// The last mode picked on this doc: Ask, or Edit ('send' before Edit had
// its name; read as Edit).
const modeKey = (slug) => `tdoc-ask-mode:${slug}`;
const storedMode = (slug) => (['edit', 'send'].includes(readStored(modeKey(slug))) ? 'edit' : 'ask');

// The agent pill and its menu, the composer's (agent-menu.jsx): who
// answers in Ask, who changes the doc in Edit. A long name ends in an
// ellipsis on a phone rather than pushing the row wider.
function AgentPill({ label, ariaLabel, children }) {
  return <AppMenu align="start" popupClassName="tdoc-agent-menu" trigger={(
    <button type="button" className="tdoc-ask-target-pill tdoc-agent-pill" aria-label={ariaLabel}>
      <span className="tdoc-ask-pill-label">{label}</span> <ChevronDown size={12} aria-hidden="true" />
    </button>
  )}>{children}</AppMenu>;
}

const commentCount = (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`;

// Ask or Edit: a quiet setting in the input's bottom row, beside the agent
// pill and in its style and menu rows -- not a filled switch above the
// input. Only where the viewer may send (`send`).
function ModePicker({ mode, onPick }) {
  const row = (value, name, desc) => <AppMenuItem className="tdoc-agent-menu-item tdoc-ask-mode-item" onClick={() => onPick(value)}>
    <span className="tdoc-ask-mode-item-text"><b>{name}</b> — {desc}</span>
    <span className="tdoc-agent-menu-check">{mode === value ? <Check size={13} aria-label="Picked" /> : null}</span>
  </AppMenuItem>;
  const name = mode === 'edit' ? 'Edit' : 'Ask';
  return <AppMenu align="start" popupClassName="tdoc-agent-menu tdoc-ask-mode-menu" trigger={(
    <button type="button" className="tdoc-ask-target-pill tdoc-ask-mode-pill" aria-label={`Mode: ${name}`}>
      {name} <ChevronDown size={12} aria-hidden="true" />
    </button>
  )}>
    {row('ask', 'Ask', 'the agent answers')}
    {row('edit', 'Edit', 'the agent changes this doc')}
  </AppMenu>;
}

// The pending comments Edit attaches, one quiet line above the input: "4
// comments included · Choose". Choose opens every not-yet-sent comment (who
// + its first line) as a checkbox, all checked by default; closing it keeps
// the selection ("2 of 4 comments included"). An unchecked comment stays
// pending.
function PendingComments({ comments, chosen, onToggle }) {
  const [open, setOpen] = useState(false);
  const total = comments.length;
  const k = comments.filter((c) => chosen.includes(c.id)).length;
  return <div className="tdoc-ask-send-payload">
    <div className="tdoc-ask-send-summary">
      <span>{k === total ? `${commentCount(total)} included` : k === 0 ? 'No comments included' : `${k} of ${commentCount(total)} included`}</span>
      <span aria-hidden="true"> · </span>
      <AppButton variant="quiet" size="s" className="tdoc-ask-send-choose" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Done' : 'Choose'}</AppButton>
    </div>
    {open ? <div className="tdoc-ask-send-list" role="group" aria-label="Comments to include">
      {comments.map((c) => <AppCheckbox key={c.id} className="tdoc-ask-send-item" checked={chosen.includes(c.id)}
        onCheckedChange={(on) => onToggle(c.id, on)}
        label={<><b>{authorLine(c.author)}</b> <span>{String(c.text || '').split('\n').find((line) => line.trim()) || ''}</span></>} />)}
    </div> : null}
  </div>;
}

// Edit, inside Ask AI: ask the agent picked here to change the document.
// The instruction is the input; the doc's pending comments are optional
// attachments. Everything goes through the Send to agent dialog's own send
// (useHandoffSend) and its delivery line:
//   instruction + comments  the checked comments, the instruction as the note
//   comments only           the checked comments, the default note
//   instruction only        posted as the viewer's whole-document comment,
//                           then that comment is handed off; the agent
//                           replies under it as usual
function EditForm({ send, modePicker }) {
  const { slug, choices, preselected, readyIds, ready = [], createDocumentComment, onSent, prefill = '' } = send;
  const [picked, setPicked] = useState(null);
  const [instruction, setInstruction] = useState(prefill);
  const [posting, setPosting] = useState(false);
  const sending = useHandoffSend(slug, onSent);
  const input = useRef(null);
  // The homepage demo's ready request (demo-agent.js DEMO_REWRITES): in the
  // input, caret at its end, so the visitor only presses Send. It comes back
  // after Undo.
  useEffect(() => { if (prefill) setInstruction(prefill); }, [prefill]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [instruction]);
  // The doc's own agent, as the dialog preselects it; else the person picks.
  const recipient = (picked && choices.find((t) => sameTarget(t, picked)))
    || (preselected && choices.find((t) => sameTarget(t, preselected))) || null;
  const to = recipient ? agentMentionName(recipient, choices) : '';
  // The Send to agent dialog's selection: comment ids, kept only while
  // still ready (as Agent activity's Ready to send). Tracked as unchecked
  // ids so every comment -- and one arriving later -- starts checked.
  const [unchecked, setUnchecked] = useState([]);
  const chosen = readyIds.filter((id) => !unchecked.includes(id));
  const toggle = (id, on) => setUnchecked((ids) => (on ? ids.filter((x) => x !== id) : [...ids, id]));
  const text = instruction.trim();
  const busy = sending.busy || posting;
  const canSend = (Boolean(text) || chosen.length > 0) && Boolean(recipient) && !busy;
  const submit = async (event) => {
    event?.preventDefault();
    if (!canSend) return;
    let commentIds = chosen;
    let sentText = '';
    if (!chosen.length) {
      // Only an instruction: it becomes a whole-document comment first. Once
      // posted it is a pending comment like any other, so the input clears
      // even if the handoff fails (Retry sends that comment, not a copy).
      setPosting(true);
      let comment = null;
      try { comment = await createDocumentComment?.(text); } catch (err) {
        sending.setResult({ ok: false, text: `Not sent to ${to}: ${err.message || 'something went wrong'}.` });
      } finally { setPosting(false); }
      if (!comment?.id) return;
      setInstruction('');
      commentIds = [comment.id];
      sentText = `Sent to ${to} ✓`;
    }
    const body = await sending.send({ commentIds, recipient, sentText,
      instruction: chosen.length && text ? text : defaultInstruction(commentIds) });
    if (body) { setInstruction(''); setUnchecked([]); }
  };
  const label = sending.busy || posting ? 'Sending…' : sending.result && !sending.result.ok ? 'Retry' : recipient ? `Send to ${to}` : 'Send';
  return <>
    {readyIds.length ? <PendingComments comments={ready.length ? ready : readyIds.map((id) => ({ id }))} chosen={chosen} onToggle={toggle} /> : null}
    <form className="tdoc-ask-form tdoc-ask-send-form" onSubmit={submit}>
      <textarea ref={input} aria-label="What should the agent change?" placeholder="What should the agent change?"
        rows={2} maxLength={2000} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      <div className="tdoc-ask-form-bottom">
        <div className="tdoc-ask-form-pills">
          {modePicker}
          {choices.length ? <AgentPill ariaLabel="Who should change it?" label={recipient ? to : 'Choose an agent'}>
            <AgentMenuItems choices={choices} current={recipient} preserveOrder maxVisible={4} showConnect={false} showRelevance
              onPick={(target) => { setPicked(target); sending.setResult(null); }} />
          </AgentPill> : null}
        </div>
        {/* type="button": the Ask form's round ↑ styles every submit button
            in this row -- which is the phone's send, the Ask form's own ↑. */}
        <AppButton variant="primary" size="s" className="tdoc-ask-send-btn" disabled={!canSend} onClick={submit}>{label}</AppButton>
        <button type="submit" className="tdoc-ask-send-icon" aria-label={recipient ? `Send to ${to}` : 'Send'} disabled={!canSend}>↑</button>
      </div>
    </form>
    <HandoffSendResult result={sending.result} />
  </>;
}

// After the homepage demo's scripted Edit has changed the doc: the landing's
// own call to action (its "Create a free doc", to /start), here in Ask AI
// because that is where the visitor is looking -- the popover on desktop,
// the drawer on a phone. Undo puts the paragraph back and the request in
// the input, so it can run again.
export function DemoRewriteCta({ onUndo }) {
  return <div className="tdoc-ask-notice tdoc-ask-demo-cta" role="status">
    <p>That’s tdoc: ask, and your agent edits the doc in place. Try it on your own docs.</p>
    <div className="tdoc-ask-demo-cta-actions">
      <a className="ui-btn ui-btn-primary ui-btn-m" href="/start">Create a free doc</a>
      <AppButton variant="quiet" size="m" onClick={onUndo}>Undo</AppButton>
    </div>
  </div>;
}

// A document-level question starts private; a team agent's answer is a
// comment everyone sees, and the panel says so before anything is sent.
// Where the viewer may hand off comments (`send`), the same panel switches
// to Edit: an instruction (and any pending comments) to the agent picked here.
export function AskAiPanel({ open, draft, onDraft, targetKey, onTarget, targets, viewer,
  disabledChoices = [], guestAction = null,
  turns, busy, remaining, onAsk, onKeep, onPost, send = null, cta = null,
  activityOpen, onActivityOpen, unreadCount, signInToAsk = false, onConnect = null, children }) {
  const input = useRef(null);
  const [expandedTurnId, setExpandedTurnId] = useState(null);
  const [pickedMode, setPickedMode] = useState(() => (send ? storedMode(send.slug) : 'ask'));
  const mode = send ? pickedMode : 'ask';
  const pickMode = (next) => {
    setPickedMode(next);
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
  const modePicker = send ? <ModePicker mode={mode} onPick={pickMode} /> : null;
  return <div className="tdoc-ask-panel">
    <h2>Ask AI</h2>
    {mode === 'edit' ? <EditForm send={send} modePicker={modePicker} /> : <>
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
    {cta}
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
