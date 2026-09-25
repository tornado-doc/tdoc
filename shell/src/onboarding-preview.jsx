import React, { useState } from 'react';
import { ActivatePage } from './activate-page.jsx';
import { SetupGate } from './setup-gate.jsx';
import { SignInDialog } from './sign-in-dialog.jsx';
import { StatusPage } from './status-page.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import './docs-hub.css';
import './onboarding-preview.css';

const identity = { name: 'Alex Morgan', email: 'alex.morgan@example.com' };
const states = ['Approved', 'Confirm device', 'Enter code', 'Expired code', 'Approving', 'Long account', 'Sign in', 'Sign-in complete', 'Sign-in error', 'GitHub dialog', 'Connect agent', 'Connection help', 'Connected', 'First document', 'Checklist'];

// The original components and markup, with local sample state only.
// This gallery is served only by the PR preview Worker, never production.
export default function OnboardingPreview() {
  const [state, setState] = useState('Approved');
  const [dialogOpen, setDialogOpen] = useState(true);
  const [notice, setNotice] = useState('');
  let screen;
  if (state === 'Sign-in complete' || state === 'Sign-in error') {
    screen = <StatusPage boot={state === 'Sign-in complete' ? { title: 'Signed in', message: 'Your account is connected. You can return to your agent.', actions: [{ label: 'Go to my docs', href: '/me', primary: true }] } : { title: 'Sign-in expired', message: 'This sign-in request has expired. Start again from your agent.', error: true, actions: [{ label: 'Return to tdoc', href: '/', primary: true }] }} />;
  } else if (state === 'GitHub dialog') {
    screen = <div className="op-dialog-stage"><button onClick={() => setDialogOpen(true)}>Open sign-in dialog</button>
      <SignInDialog open={dialogOpen} onOpenChange={setDialogOpen} onSuccess={() => {}} preview={{device:{user_code:'ABCD-1234',verification_uri:'https://github.com/login/device'},status:'Open GitHub to approve, then return to this tab.'}} />
    </div>;
  } else if (['Connect agent', 'Connection help', 'Connected', 'First document'].includes(state)) {
    screen = <SetupGate key={state} boot={{ identity, oidcAuth: true, step: state === 'First document' ? 'doc' : 'connect' }} preview={{ record: { started: true }, paired: ['Connected', 'First document'].includes(state), elapsed: state === 'Connection help' ? 65000 : 0 }} />;
  } else if (state === 'Checklist') {
    screen = <div className="docs-hub op-checklist"><OnboardingChecklist record={{started:true, agent_connected:true}} docs={[]} /></div>;
  } else {
    screen = <ActivatePage key={state} boot={{code:'ABCD-1234',identity:state === 'Sign in' ? null : state === 'Long account' ? {email:'alex.morgan.research-and-development@example.com'} : identity,oidcAuth:true}}
      preview={{approved:state === 'Approved',pending:['Confirm device','Approving','Long account'].includes(state) ? {label:'Preview terminal'} : null,busy:state === 'Approving',error:state === 'Expired code' ? 'This code has expired. Ask your agent to connect again.' : ''}} />;
  }
  const keepInPreview = event => {
    const target = event.target.closest('a,button');
    if (target && (target.tagName === 'A' || /^(Sign in|Use Another Account)/.test(target.textContent))) {
      event.preventDefault(); event.stopPropagation(); setNotice('Preview only. No account changes.');
    }
  };
  return <div className="op-preview" onClickCapture={keepInPreview}>
    <nav className="op-nav" aria-label="Onboarding preview states"><div><strong>Onboarding spacing preview</strong><span>Original UI · sample data</span></div><label>Screen <select value={state} onChange={e => {setState(e.target.value);setDialogOpen(true);setNotice('');}}>{states.map(s => <option key={s}>{s}</option>)}</select></label></nav>
    {notice ? <p className="op-notice" role="status">{notice}</p> : null}
    {screen}
  </div>;
}
