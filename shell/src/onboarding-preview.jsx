import React, { useState } from 'react';
import { ActivatePage } from './activate-page.jsx';
import { SetupGate } from './setup-gate.jsx';
import { SignInDialog } from './sign-in-dialog.jsx';
import { StatusPage } from './status-page.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import { DocStepHint } from './document/step-hint.jsx';
import { CommentCard } from './document/comment-card.jsx';
import './docs-hub.css';
import './onboarding-preview.css';

const identity = { name: 'Alex Morgan', email: 'alex.morgan@example.com' };
const states = ['Approved', 'Confirm device', 'Enter code', 'Expired code', 'Approving', 'Long account', 'Sign in', 'Sign in with code', 'Sign-in complete', 'Sign-in error', 'GitHub dialog', 'Setup sign in', 'Connect agent', 'Connection help', 'Connected', 'First document', 'Document published', 'Checklist', 'Checklist after publishing', 'Checklist after commenting', 'Tutorial comment', 'Tutorial handoff', 'Tutorial waiting', 'Tutorial reading', 'Tutorial stuck', 'Tutorial complete', 'Tutorial shared'];

function TutorialPreview({ state }) {
  const [agentState, setAgentState] = useState(state.replace('Tutorial ', ''));
  const [open, setOpen] = useState(true);
  const [shared, setShared] = useState(state === 'Tutorial shared');
  const done = ['Tutorial complete', 'Tutorial shared'].includes(state);
  const comment = { id: 'preview-comment', text: 'Make this introduction more concise.', author: { login: 'alex', name: 'Alex Morgan' }, replies: [], status: done ? 'applied' : 'open', applied_version: 2 };
  const noop = () => {};
  return <div className="op-tutorial">
    {done ? <div className="tdoc-onboard-banner" role="status">
      <span>{shared ? 'Link copied.' : 'Answered 1 comment in v2. Share it.'}</span>
      {shared ? <a href="/me">My docs</a> : <button onClick={() => setShared(true)}>Copy link</button>}
    </div> : <DocStepHint step={state === 'Tutorial comment' ? 'comment' : 'handoff'} agentState={['waiting', 'reading', 'stuck'].includes(agentState) ? agentState : 'idle'} onGo={noop} />}
    <div className="op-tutorial-card"><CommentCard comment={comment} currentUser="alex" onReply={noop} onReact={noop} onDelete={noop} onResolve={noop} onEdit={noop}
      handoff={state === 'Tutorial comment' || done ? null : {threadId:comment.id, open, line:'Read https://tdoc.dev/d/my-first-tdoc and fix the comments.', state:['waiting','reading','stuck'].includes(agentState) ? agentState : 'idle', onCopy:()=>setAgentState('waiting'), onToggle:()=>setOpen(value=>!value)}} />
    </div>
  </div>;
}

// The original components and markup, with local sample state only.
// This gallery is served only by the PR preview Worker, never production.
export default function OnboardingPreview() {
  const [state, setState] = useState('Approved');
  const [dialogOpen, setDialogOpen] = useState(true);
  const [notice, setNotice] = useState('');
  let screen;
  if (state.startsWith('Tutorial ')) {
    screen = <TutorialPreview key={state} state={state} />;
  } else if (state === 'Sign-in complete' || state === 'Sign-in error') {
    screen = <StatusPage boot={state === 'Sign-in complete' ? { title: 'Signed in', message: 'Your account is connected. You can return to your agent.', actions: [{ label: 'Go to my docs', href: '/me', primary: true }] } : { title: 'Sign-in expired', message: 'This sign-in request has expired. Start again from your agent.', error: true, actions: [{ label: 'Return to tdoc', href: '/', primary: true }] }} />;
  } else if (state === 'GitHub dialog') {
    screen = <div className="op-dialog-stage"><button onClick={() => setDialogOpen(true)}>Open sign-in dialog</button>
      <SignInDialog open={dialogOpen} onOpenChange={setDialogOpen} onSuccess={() => {}} preview={{device:{user_code:'ABCD-1234',verification_uri:'https://github.com/login/device'},status:'Approve on GitHub, then return here.'}} />
    </div>;
  } else if (['Setup sign in', 'Connect agent', 'Connection help', 'Connected', 'First document', 'Document published'].includes(state)) {
    screen = <SetupGate key={state} boot={{ identity:state === 'Setup sign in' ? null : identity, oidcAuth: true, step: ['First document','Document published'].includes(state) ? 'doc' : 'connect' }} preview={{ record: { started: true, first_doc:state === 'Document published' ? 'my-first-tdoc' : null }, paired: ['Connected', 'First document', 'Document published'].includes(state), elapsed: state === 'Connection help' ? 65000 : 0 }} />;
  } else if (state.startsWith('Checklist')) {
    screen = <div className="docs-hub op-checklist"><OnboardingChecklist key={state} record={{started:true, agent_connected:true, first_doc:state === 'Checklist' ? null : 'my-first-tdoc', commented:state === 'Checklist after commenting'}} docs={state === 'Checklist' ? [] : [{slug:'my-first-tdoc',title:'My first tdoc'}]} /></div>;
  } else {
    screen = <ActivatePage key={state} boot={{code:state === 'Sign in' ? '' : 'ABCD-1234',identity:['Sign in','Sign in with code'].includes(state) ? null : state === 'Long account' ? {email:'alex.morgan.research-and-development@example.com'} : identity,oidcAuth:true}}
      preview={{approved:state === 'Approved',pending:['Confirm device','Approving','Long account'].includes(state) ? {label:'Preview terminal'} : null,busy:state === 'Approving',error:state === 'Expired code' ? 'This code has expired. Ask your agent to connect again.' : ''}} />;
  }
  const keepInPreview = event => {
    const target = event.target.closest('a,button');
    if (target && (target.tagName === 'A' || /^(Sign in|Use Another Account)/.test(target.textContent))) {
      event.preventDefault(); event.stopPropagation(); setNotice('Preview only. No account changes.');
    }
  };
  return <div className="op-preview" onClickCapture={keepInPreview}>
    <nav className="op-nav" aria-label="Onboarding preview states"><div><strong>Onboarding preview</strong><span>Original UI · sample data</span></div><label>Screen <select value={state} onChange={e => {setState(e.target.value);setDialogOpen(true);setNotice('');}}>{states.map(s => <option key={s}>{s}</option>)}</select></label></nav>
    {notice ? <p className="op-notice" role="status">{notice}</p> : null}
    {screen}
  </div>;
}
