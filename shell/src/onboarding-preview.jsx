import React, { useState } from 'react';
import { ActivatePage } from './activate-page.jsx';
import { AppSelect } from './ui/select.jsx';
import { ComputersBody } from './computers-settings.jsx';
import { SetupGate } from './setup-gate.jsx';
import { DocsHub } from './docs-hub.jsx';
import { SignInDialog } from './sign-in-dialog.jsx';
import { StatusPage } from './status-page.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import { TutorialCoach } from './document/tutorial-coach.jsx';
import { DocStepHint } from './document/step-hint.jsx';
import { CommentCard } from './document/comment-card.jsx';
import './docs-hub.css';
import './onboarding-preview.css';

const identity = { name: 'Alex Morgan', email: 'alex.morgan@example.com' };
const states = ['Start', 'Connect your AI', 'AI ready', 'Computer ready', 'Computers & AI', 'Approved', 'Confirm device', 'Enter code', 'Expired code', 'Approving', 'Long account', 'Sign in', 'Sign in with code', 'Sign-in complete', 'Sign-in error', 'GitHub dialog', 'Setup sign in', 'Connect agent', 'Connection help', 'Connected', 'Use without helper', 'AI missing', 'AI needs check', 'AI offline', 'First document', 'Document published', 'Checklist', 'Checklist after publishing', 'Checklist after commenting', 'Tutorial comment', 'Tutorial manual', 'Tutorial handoff', 'Tutorial waiting', 'Tutorial reading', 'Tutorial stuck', 'Tutorial complete', 'Tutorial shared'];

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
    <TutorialCoach slug={`preview-${state.replaceAll(' ', '-').toLowerCase()}`} step={done ? null : state === 'Tutorial comment' ? 'comment' : 'handoff'} product="chatgpt" automatic={state !== 'Tutorial manual'} agentState={['waiting','reading','stuck'].includes(agentState) ? agentState : 'idle'} onComment={noop} onSendAll={noop} onCopy={() => true} />
    <div className="op-tutorial-card"><CommentCard comment={comment} currentUser="alex" onReply={noop} onReact={noop} onDelete={noop} onResolve={noop} onEdit={noop}
      handoff={state === 'Tutorial comment' || done ? null : {threadId:comment.id, open, line:'Read https://tdoc.dev/d/my-first-tdoc and fix the comments.', state:['waiting','reading','stuck'].includes(agentState) ? agentState : 'idle', onCopy:()=>setAgentState('waiting'), onToggle:()=>setOpen(value=>!value)}} />
    </div>
  </div>;
}

// The original components and markup, with local sample state only.
// This gallery is served only by the PR preview Worker, never production.
export default function OnboardingPreview() {
  const [state, setState] = useState(() => {
    const screen = new URLSearchParams(location.search).get('screen');
    return states.includes(screen) ? screen : 'Start';
  });
  const [dialogOpen, setDialogOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const setupPreview = ['Start', 'Connect your AI', 'AI ready', 'Computer ready', 'Setup sign in', 'Connect agent', 'Connection help', 'Connected', 'Use without helper', 'AI missing', 'AI needs check', 'AI offline', 'First document', 'Document published'].includes(state);
  let screen;
  if (state === 'Computers & AI') {
    screen = <div className="docs-hub"><main className="wrap"><section className="tm-settings"><section className="tm-settings-card"><ComputersBody identity={identity} preview={{ default: {provider:'local',device:'alex-mac',cli:'codex'}, computers:[{device:'alex-mac',status:'active',paused:false,runtimes:[{cli:'claude',state:'not_installed'},{cli:'codex',state:'ready',version:'0.1.0'}]},{device:'office-mac',status:'paused',paused:true,runtimes:[{cli:'claude',state:'ready',version:'2.1.0'},{cli:'codex',state:'needs_check'}]}] }} /></section></section></main></div>;
  } else if (state.startsWith('Tutorial ')) {
    screen = <TutorialPreview key={state} state={state} />;
  } else if (state === 'Sign-in complete' || state === 'Sign-in error') {
    screen = <StatusPage boot={state === 'Sign-in complete' ? { title: 'Signed in', message: 'Your account is connected. You can return to your agent.', actions: [{ label: 'Go to my docs', href: '/me', primary: true }] } : { title: 'Sign-in expired', message: 'This sign-in request has expired. Start again from your agent.', error: true, actions: [{ label: 'Return to tdoc', href: '/', primary: true }] }} />;
  } else if (state === 'GitHub dialog') {
    screen = <div className="op-dialog-stage"><button onClick={() => setDialogOpen(true)}>Open sign-in dialog</button>
      <SignInDialog open={dialogOpen} onOpenChange={setDialogOpen} onSuccess={() => {}} preview={{device:{user_code:'ABCD-1234',verification_uri:'https://github.com/login/device'},status:'Approve on GitHub, then return here.'}} />
    </div>;
  } else if (setupPreview) {
    const choosing = ['Computer ready', 'Connected', 'Use without helper', 'AI missing', 'AI needs check', 'AI offline', 'First document', 'Document published'].includes(state);
    const status = state === 'AI offline' ? 'inactive' : 'active';
    const runtimeState = state === 'AI missing' ? 'not_installed' : state === 'AI needs check' ? 'needs_check' : 'ready';
    screen = <><DocsHub boot={{ identity, capabilities: {create: false} }} /><SetupGate key={state} boot={{ identity:state === 'Setup sign in' ? null : identity, oidcAuth: true, step: ['First document','Document published'].includes(state) ? 'doc' : 'connect' }} preview={{ product: ['Connect agent', 'Connection help', 'Connected', 'AI missing', 'AI needs check', 'AI offline', 'Computer ready'].includes(state) ? 'codex' : 'chatgpt', stage: ['AI ready', 'Computer ready', 'Document published'].includes(state) ? 'done' : ['Start', 'Setup sign in'].includes(state) ? 'intro' : ['Connect your AI', 'Use without helper', 'First document'].includes(state) ? 'manual' : 'connect', path: state === 'Computer ready' ? 'connect' : 'manual', record: { started: true, first_doc:state === 'Document published' ? 'my-first-tdoc' : null }, paired: choosing, local_agents: choosing && runtimeState === 'ready' ? [{ device: 'alex-mac', cli: 'codex', ready: true, status }] : [], local_computers: choosing ? [{ device: 'alex-mac', status, runtimes: [{ cli: 'claude', state: 'not_installed' }, { cli: 'codex', state: runtimeState, ...(runtimeState !== 'not_installed' ? {version:'0.1.0'} : {}) }] }] : [], elapsed: state === 'Connection help' ? 95000 : 0 }} /></>;
  } else if (state.startsWith('Checklist')) {
    screen = <div className="docs-hub op-checklist"><OnboardingChecklist key={state} record={{started:true, agent_connected:true, first_doc:state === 'Checklist' ? null : 'my-first-tdoc', commented:state === 'Checklist after commenting'}} docs={state === 'Checklist' ? [] : [{slug:'my-first-tdoc',title:'My first tdoc'}]} /></div>;
  } else {
    screen = <ActivatePage key={state} boot={{code:state === 'Sign in' ? '' : 'ABCD-1234',identity:['Sign in','Sign in with code'].includes(state) ? null : state === 'Long account' ? {email:'alex.morgan.research-and-development@example.com'} : identity,oidcAuth:true}}
      preview={{approved:state === 'Approved',pending:['Confirm device','Approving','Long account'].includes(state) ? {label:'Preview terminal'} : null,busy:state === 'Approving',error:state === 'Expired code' ? 'This code has expired. Ask your agent to connect again.' : ''}} />;
  }
  const keepInPreview = event => {
    const target = event.target.closest('a,button');
    if (target && (target.tagName === 'A' || /^(Sign in|Use another account)/.test(target.textContent))) {
      event.preventDefault(); event.stopPropagation(); setNotice('Preview only. No account changes.');
    }
  };
  return <div className={`op-preview${setupPreview ? ' op-setup-preview' : ''}`} onClickCapture={keepInPreview}>
    <nav className="op-nav" aria-label="Onboarding preview states"><div><strong>Onboarding preview</strong><span>Original UI · sample data</span></div><label>Screen <AppSelect ariaLabel="Screen" value={state} onChange={next => {setState(next);setDialogOpen(true);setNotice('');const url=new URL(location.href);url.searchParams.set('screen',next);history.replaceState(null,'',url);}} options={states.map(value => ({value,label:value}))} /></label></nav>
    {notice ? <p className="op-notice" role="status">{notice}</p> : null}
    {screen}
  </div>;
}
