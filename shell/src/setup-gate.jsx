import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent } from './document/api.js';
import { AGENT_NAMES } from './onboarding-dialog.jsx';

// `/setup` — the gate. Setup is not a tutorial: it is the one thing that has
// to be true before tdoc can do anything, so it gets its own full-screen
// route rather than a step inside a wizard. It asks for exactly one act
// (paste a prompt into your agent) and then watches the server until the
// agent turns up.
//
// Layout: the work on the left, the product on the right. The right half is
// not decoration — it is the thing the left half is asking for, drawn at the
// product's real pixel sizes, and it changes with the state so that what you
// are looking at is always what you are being asked to do.
//
// Three states, and only the server moves between them:
//   waiting   nothing has arrived yet
//   stuck     STUCK_MS of nothing; the doctor line appears
//   done      the record has `agent_connected`
//
// NOT here, and why: a fourth state ("your agent is asking to connect") would
// need the page to know that a pairing code was just issued *for this
// account*. It cannot: `/api/cli/pair/start` is unauthenticated — the CLI has
// no token yet, so the code belongs to nobody until it is approved. Giving the
// gate that state means handing out a per-account setup link and having the
// CLI fetch it. That is a real change to the prompt, not a UI tweak.

export const SETUP_PROMPT = 'Install tdoc and connect it to my account: https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md';
const POLL_MS = 3000;
const STUCK_MS = 60000;

function Mark({ size = 28 }) {
  return <img src="/tdoc_logo.svg" alt="" width={size} height={size} data-tdoc-dark="invert" />;
}

// ---------------------------------------------------------------- the scenes
// Where people actually paste is a conversation with an agent, not a shell —
// so the window here is a chat with a composer, and the paste happens in the
// composer. The four agents share that shape; switching only renames the
// window, because drawing four invented skins would be worse than one honest
// one.

function ChatWindow({ children }) {
  return (
    <div className="sg-chat">
      <div className="sg-chat-bar">
        <div className="sg-lights"><i /><i /><i /></div>
        <div className="sg-chat-name">Your agent</div>
      </div>
      <div className="sg-chat-body">{children}</div>
    </div>
  );
}

function Composer({ live = false, children }) {
  return (
    <div className={`sg-composer${live ? ' live' : ''}`}>
      <div className="sg-field">{children || <span className="sg-ph">Reply to your agent…</span>}</div>
      <div className="sg-tools">
        <span>＋</span><span>@</span><span className="sg-sp" />
        {live ? <span className="sg-hint">⏎ to send</span> : null}
        <span className={`sg-send${live ? '' : ' off'}`}>↑</span>
      </div>
    </div>
  );
}

function SceneWaiting() {
  return (
    <>
      <ChatWindow>
        <div className="sg-msg">
          <span className="sg-av bot" />
          <p className="sg-txt">What are we working on?</p>
        </div>
        <Composer live>
          <span className="sg-typed">{SETUP_PROMPT.slice(0, 62)}…</span>
          <span className="sg-caret" />
        </Composer>
      </ChatWindow>
    </>
  );
}

function SceneStuck() {
  return (
    <>
      <ChatWindow>
        <div className="sg-msg me">
          <p className="sg-txt">Run tdoc doctor and fix what it reports</p>
          <span className="sg-av you" />
        </div>
        <div className="sg-run f1"><span className="b ok">●</span><span>skill installed <span className="m">v0.9.4</span></span></div>
        <div className="sg-run f2"><span className="b ok">●</span><span>reaches tdoc.dev</span></div>
        <div className="sg-run f3"><span className="b bad">●</span><span>no account connected</span></div>
        <div className="sg-msg f4">
          <span className="sg-av bot" />
          <p className="sg-txt">The approval expired before I got there. I’ll ask for a new code — approve it in the tab I open.</p>
        </div>
        <Composer />
      </ChatWindow>
    </>
  );
}

// The product, at its own sizes: 48px bar, 280px card, #fff7d0 anchor. Scaled
// down it would stop being the product, so it is cropped by the pane instead.
function SceneDone() {
  return (
    <>
      <div className="sg-app">
        <div className="sg-bar">
          <div className="sg-mk"><Mark size={24} /></div>
          <div className="sg-ver">v2 ▾</div>
          <div className="sg-title">What AI knows about you</div>
          <div className="sg-owner">· you</div>
          <div className="sg-star">☆</div>
          <div className="sg-sp" />
          <div className="sg-res"><span className="sg-sw" /> Resolved (1)</div>
          <div className="sg-btn tint">Comment ▾</div>
          <div className="sg-btn solid">Share</div>
          <div className="sg-ic">⋯</div>
          <div className="sg-me"><i /> You</div>
        </div>
        <div className="sg-page">
          <div className="sg-doc">
            <h2>What AI knows about you</h2>
            <p>You have been treating your agent like a search box, and it shows.</p>
            <p><span className="sg-anchor">Nothing you asked it this month required memory.</span> Every session started from nothing, and you paid for that in re-explaining yourself.</p>
            <p className="faint">The traces say you work in bursts, late, and abandon about a third of what you start before the second message.</p>
          </div>
          <div className="sg-margin">
            <div className="sg-pin"><i /></div>
            <div className="sg-card active">
              <div className="sg-cc-head">
                <div className="sg-cc-av" />
                <div className="sg-cc-who"><b>You</b><span className="sg-cc-when">2:41 PM</span></div>
                <div className="sg-cc-acts"><span>✓</span><span>⋯</span></div>
              </div>
              <p className="sg-cc-text">This is too kind. I abandon far more than a third — check the real number.</p>
              <div className="sg-react"><span>👍 1</span></div>
            </div>
            <div className="sg-pin b"><i /></div>
            <div className="sg-card b">
              <div className="sg-chip">✓ Applied in v2</div>
              <div className="sg-cc-head">
                <div className="sg-cc-av bot" />
                <div className="sg-cc-who"><b>Your agent</b><span className="sg-cc-when">2:48 PM</span></div>
              </div>
              <p className="sg-cc-text">Counted it properly: 61%. Rewrote the paragraph and published v2.</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ the gate

export function SetupGate({ boot }) {
  const [record, setRecord] = useState(null);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [identity, setIdentity] = useState(boot?.identity || null);
  const signedIn = Boolean(identity);
  const copiedAt = useRef(null);
  const stamped = useRef(false);

  const connected = Boolean(record?.agent_connected || record?.published_first);
  const state = connected ? 'done' : elapsed > STUCK_MS ? 'stuck' : 'waiting';

  // The record is the only thing that moves this page.
  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await getOnboarding();
        if (!cancelled) setRecord(result?.record || {});
      } catch {}
      if (cancelled) return;
      if (copiedAt.current) setElapsed(Date.now() - copiedAt.current);
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn]);

  // The site's own sign-in, and only that: a full-page redirect out to the
  // OIDC provider and back to /setup. Signing in is signing up, so there is no
  // second door to offer.
  const signIn = () => {
    location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent('/setup')}`;
  };

  const copy = async () => {
    const ok = await copyText(SETUP_PROMPT);
    setCopied(ok !== false);
    copiedAt.current = Date.now();
    if (!stamped.current) { stamped.current = true; postOnboardingEvent('door_own_agent').catch(() => {}); }
    postOnboardingEvent('copy_clicked').catch(() => {});
  };

  const scene = state === 'done' ? <SceneDone />
    : state === 'stuck' ? <SceneStuck />
      : <SceneWaiting />;

  return (
    <div className="sg-split">
      <section className="sg-pane-form">
        <a className="sg-brand" href="/me" title="My docs" aria-label="My docs"><Mark /></a>
        <div className="sg-mid">
          <div className="sg-col">
            <h1 className="sg-h1">Connect your agent</h1>

            {signedIn ? (
              <>
                <div className="sg-section">
                  <span className="sg-section-label">Setup prompt</span>
                  <span className="sg-section-note">{AGENT_NAMES}</span>
                </div>

                <div className="sg-prompt">
                  <p className="sg-prompt-text">{SETUP_PROMPT}</p>
                  <button type="button" className={`sg-prompt-copy${copied ? ' copied' : ''}`} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <ol className="sg-steps">
                  <li>Paste it into your agent.</li>
                  <li>Approve the request when it opens in your browser.</li>
                  <li>Your agent shows up here on its own. No need to refresh.</li>
                </ol>

                <div className="sg-status-slot">
                  {state === 'waiting' ? (
                    <div className="sg-status">
                      <span className="sg-spin" aria-hidden="true" />
                      {copied ? 'Waiting for your agent.' : 'Waiting for you to paste the prompt.'}
                    </div>
                  ) : null}
                  {state === 'stuck' ? (
                    <div className="sg-status stuck">
                      <div className="head">Still nothing after a minute.</div>
                      <div className="sg-doctor">
                        <code>Run tdoc doctor and fix what it reports</code>
                        <button type="button" onClick={() => copyText('Run tdoc doctor and fix what it reports')}>Copy</button>
                      </div>
                    </div>
                  ) : null}
                  {state === 'done' ? (
                    <div className="sg-status done">
                      <svg className="tick" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="2" />
                        <path d="M8.2 12.3l2.6 2.6 5-5.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <div><b>Connected.</b> <span className="found">Your agent can publish as you.</span></div>
                    </div>
                  ) : null}
                </div>

                <a className={`sg-primary${state === 'done' ? '' : ' off'}`} href={state === 'done' ? '/me' : undefined} aria-disabled={state !== 'done'}>
                  Continue
                </a>
                <p className="sg-account"><a href="/me">I’ll do this later</a></p>
              </>
            ) : (
              <>
                <button type="button" className="sg-primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in to start</button>
                <p className="sg-account">
                  {boot?.oidcAuth
                    ? 'Signing in creates your account. There is no separate sign-up.'
                    : 'Sign-in is not configured on this host.'}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <aside className="sg-pane-art">
        <div className="sg-stage">
          <div className="sg-scene run" key={state}>{scene}</div>
        </div>
      </aside>
    </div>
  );
}
