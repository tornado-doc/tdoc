import React, { useEffect, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';

const PRODUCTS = { chatgpt: 'ChatGPT Work', cowork: 'Claude Cowork', claude: 'Claude Code', codex: 'Codex', grok: 'Grok Bot', raft: 'Raft', cursor: 'Cursor', other: 'your AI' };
// Only the private practice document gets these prompts. Dismissal is scoped
// to one document and step, so the next real action can teach the next gesture.
export function TutorialCoach({ slug, step, product, automatic, agentState, onComment, onSendAll, onCopy, reopen = 0 }) {
  const key = `tdoc.tutorial.${slug}.${step}`;
  const [open, setOpen] = useState(false);
  const [single, setSingle] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(key) === '1'; } catch {}
    setOpen(Boolean(step && (!seen || reopen))); setSingle(false);
  }, [key, step, reopen]);
  const close = () => {
    try { localStorage.setItem(key, '1'); } catch {}
    setOpen(false);
  };
  if (!step || !open || (step === 'handoff' && agentState !== 'idle')) return null;
  const manual = step === 'handoff' && !automatic;
  return <AppDialog open={open} onOpenChange={value => { if (!value) close(); }} side className="ui-tutorial-coach"
    title={step === 'comment' ? 'Leave a comment' : single ? 'Send one comment' : manual ? `Send it to ${PRODUCTS[product] || 'your AI'}` : 'Send it to your AI'}
    description={step === 'comment' ? 'Select a sentence and say what you want to change.' : single ? 'Reply on your comment, then choose @AI.' : manual ? 'Paste the instruction into the chat you used to connect Tdoc.' : 'Send your comments together, or mention your AI on one comment.'}
    actions={<>
      <button type="button" onClick={close}>Skip</button>
      {step === 'comment' ? <button type="button" className="primary" onClick={close}>Try it</button>
        : manual ? <button type="button" className="primary" onClick={async () => { const ok = await onCopy(); if (ok !== false) close(); }}>Copy instruction</button>
          : single ? <button type="button" className="primary" onClick={() => { close(); onComment(); }}>Show comment</button>
            : <button type="button" className="primary" onClick={() => { close(); onSendAll(); }}>Send all comments</button>}
    </>}
  >
    {step === 'handoff' && automatic && !single ? <button type="button" className="ui-tutorial-single" onClick={() => setSingle(true)}>Send one comment</button> : null}
  </AppDialog>;
}
