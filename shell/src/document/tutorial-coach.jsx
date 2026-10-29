import React, { useEffect, useState } from 'react';
import { AppButton } from '../ui/button.jsx';
import { AppDialog } from '../ui/dialog.jsx';

const PRODUCTS = { chatgpt: 'ChatGPT Work', cowork: 'Claude Cowork', claude: 'Claude Code', codex: 'Codex', grok: 'Grok Bot', raft: 'Raft', cursor: 'Cursor', other: 'your AI', claude_web: 'Claude', chatgpt_web: 'ChatGPT', vscode: 'VS Code', gemini: 'Gemini' };
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
  const manual = step === 'handoff' && !automatic;
  // Copying the instruction keeps this panel where it is (as on the connect page);
  // it turns into the wait. An automatic handoff has the step bar for that.
  const waiting = manual && agentState !== 'idle';
  if (!step || !open || (step === 'handoff' && agentState !== 'idle' && !manual)) return null;
  return <AppDialog open={open} onOpenChange={value => { if (!value) close(); }} side className="ui-tutorial-coach"
    title={step === 'comment' ? 'Leave a comment' : single ? 'Send one comment' : waiting ? `Waiting for ${PRODUCTS[product] || 'your AI'}` : manual ? `Send it to ${PRODUCTS[product] || 'your AI'}` : 'Send it to your AI'}
    description={step === 'comment' ? 'Select a sentence and say what you want to change.' : single ? 'Reply on your comment, then choose @AI.' : waiting ? 'Paste it into the chat you used to connect Tdoc. The new version appears here on its own.' : manual ? 'Paste the instruction into the chat you used to connect Tdoc.' : 'Send your comments together, or mention your AI on one comment.'}
    actions={<>
      <AppButton type="button" onClick={close}>Skip</AppButton>
      {step === 'comment' ? <AppButton type="button" variant="primary" onClick={close}>Try it</AppButton>
        : manual ? <AppButton type="button" variant="primary" onClick={() => onCopy()}>{waiting ? 'Copy again' : 'Copy instruction'}</AppButton>
          : single ? <AppButton type="button" variant="primary" onClick={() => { close(); onComment(); }}>Show comment</AppButton>
            : <AppButton type="button" variant="primary" onClick={() => { close(); onSendAll(); }}>Send all comments</AppButton>}
    </>}
  >
    {step === 'handoff' && automatic && !single ? <AppButton type="button" className="ui-tutorial-single" onClick={() => setSingle(true)}>Send one comment</AppButton> : null}
  </AppDialog>;
}
