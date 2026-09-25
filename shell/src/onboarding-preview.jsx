import React, { useState } from 'react';
import { ActivateView } from './activate-page.jsx';
import { StatusPage } from './status-page.jsx';
import { SetupGate } from './setup-gate.jsx';
import { DeviceSignInContent } from './sign-in-dialog.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import './docs-hub.css';
import './onboarding-preview.css';

const identity = { name: 'Alex Morgan', email: 'alex.morgan@example.com' };
const states = ['Approved', 'Confirm device', 'Enter code', 'Expired code', 'Approving', 'Long account', 'Sign in', 'Sign-in complete', 'Sign-in error', 'GitHub dialog', 'Connect agent', 'Connection help', 'Connected', 'First document', 'Checklist'];

// Read-only design review. Only the PR preview Worker serves this entry point.
// No real accounts, pairing requests, polling, or onboarding writes are used.
export default function OnboardingPreview() {
  const [state, setState] = useState('Approved');
  const [code, setCode] = useState('ABCD-1234');
  const [dialogOpen, setDialogOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const noAuth = () => setNotice('Design preview only. No account was connected.');
  let screen;
  if (state === 'Sign-in complete' || state === 'Sign-in error') {
    screen = <StatusPage boot={state === 'Sign-in complete' ? { title: 'Signed in', message: 'Your account is connected. You can return to your agent.', actions: [{ label: 'Go to my docs', href: '/me', primary: true }] } : { title: 'Sign-in expired', message: 'This sign-in request has expired. Start again from your agent.', error: true, actions: [{ label: 'Return to tdoc', href: '/', primary: true }] }} />;
  } else if (state === 'GitHub dialog') {
    screen = <div className="op-dialog-stage"><button onClick={() => setDialogOpen(true)}>Open sign-in dialog</button>
      <AppDialog open={dialogOpen} onOpenChange={setDialogOpen} title="Sign in with GitHub" description="Connect your account in three steps." className="tdoc-sign-in-dialog" actions={<button onClick={() => setDialogOpen(false)}>Cancel</button>}>
        <DeviceSignInContent device={{user_code:'ABCD-1234', verification_uri:'https://github.com/login/device'}} copied={copied} onCopy={() => setCopied(true)} status="Open GitHub to approve, then return to this tab." />
      </AppDialog></div>;
  } else if (['Connect agent', 'Connection help', 'Connected', 'First document'].includes(state)) {
    screen = <SetupGate key={state} boot={{ identity, oidcAuth: true, step: state === 'First document' ? 'doc' : 'connect' }} preview={{ record: { started: true }, paired: ['Connected', 'First document'].includes(state), elapsed: state === 'Connection help' ? 65000 : 0 }} />;
  } else if (state === 'Checklist') {
    screen = <div className="docs-hub op-checklist"><OnboardingChecklist record={{started:true, agent_connected:true}} docs={[]} /></div>;
  } else {
    screen = <ActivateView code={code} identity={state === 'Sign in' ? null : state === 'Long account' ? { email: 'alex.morgan.research-and-development@example.com' } : identity}
      busy={state === 'Approving'} pending={['Confirm device', 'Approving', 'Long account'].includes(state) ? { label: 'Claude Code · MacBook Pro' } : null}
      approved={state === 'Approved'} error={state === 'Expired code' ? 'This code has expired. Ask your agent to connect again.' : ''}
      canSignIn onCodeChange={setCode} onSignIn={noAuth} onSwitchAccount={noAuth}
      onContinue={() => setState('Confirm device')} onApprove={() => setState('Approved')} />;
  }
  return <div className="op-preview">
    <nav className="op-nav" aria-label="Onboarding preview states"><div><strong>Onboarding preview</strong><span>Sample data · no account changes</span></div><label>Screen <select value={state} onChange={(e) => { setState(e.target.value); setDialogOpen(true); setNotice(''); }}>{states.map(s => <option key={s}>{s}</option>)}</select></label></nav>
    {notice ? <p className="op-notice" role="status">{notice}</p> : null}
    {screen}
  </div>;
}
