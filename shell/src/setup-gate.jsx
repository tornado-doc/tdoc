import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-dialog.jsx';

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
// The same names the server's table uses. It builds every record itself, so
// this list only decides which buttons exist.
export const DEBUG_STATES = ['new', 'started', 'connected', 'published', 'commented', 'revised'];
function recordName(record) {
  if (!record || !Object.keys(record).length) return 'new';
  if (record.revised) return 'revised';
  if (record.commented) return 'commented';
  if (record.published_first) return 'published';
  if (record.agent_connected) return 'connected';
  if (record.started) return 'started';
  return 'new';
}
export const DOCTOR_PROMPT = 'Run tdoc doctor and fix what it reports';
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

// The two coding agents this line is written for, as their own marks — taken
// from each vendor's published favicon, not redrawn. A row of four product
// names set as text ran as wide as the prompt above it and made the block tall
// for nothing; two 16px marks say the same thing in the corner of a foot.
function WorksWith() {
  return (
    <p className="sg-works">
      <span>Works with</span>
      <svg viewBox="0 0 248 248" width="17" height="17" aria-hidden="true" focusable="false"><path fill="#D97757" d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" /></svg>
      <svg viewBox="0 0 180 180" width="15" height="15" aria-hidden="true" focusable="false"><path fill="#0D0D0D" d="M75.91 73.628V62.232c0-.96.36-1.68 1.199-2.16l22.912-13.194c3.119-1.8 6.838-2.639 10.676-2.639 14.394 0 23.511 11.157 23.511 23.032 0 .839 0 1.799-.12 2.758l-23.752-13.914c-1.439-.84-2.879-.84-4.318 0L75.91 73.627Zm53.499 44.383v-27.23c0-1.68-.72-2.88-2.159-3.719L97.142 69.55l9.836-5.638c.839-.48 1.559-.48 2.399 0l22.912 13.195c6.598 3.839 11.035 11.995 11.035 19.912 0 9.116-5.397 17.513-13.915 20.992v.001Zm-60.577-23.99-9.836-5.758c-.84-.48-1.2-1.2-1.2-2.16v-26.39c0-12.834 9.837-22.55 23.152-22.55 5.039 0 9.716 1.679 13.676 4.678L70.993 55.516c-1.44.84-2.16 2.039-2.16 3.719v34.787-.002Zm21.173 12.234L75.91 98.339V81.546l14.095-7.917 14.094 7.917v16.793l-14.094 7.916Zm9.056 36.467c-5.038 0-9.716-1.68-13.675-4.678l23.631-13.676c1.439-.839 2.159-2.038 2.159-3.718V85.863l9.956 5.757c.84.48 1.2 1.2 1.2 2.16v26.389c0 12.835-9.957 22.552-23.27 22.552v.001Zm-28.43-26.75L47.72 102.778c-6.599-3.84-11.036-11.996-11.036-19.913 0-9.236 5.518-17.513 14.034-20.992v27.35c0 1.68.72 2.879 2.16 3.718l29.989 17.393-9.837 5.638c-.84.48-1.56.48-2.399 0Zm-1.318 19.673c-13.555 0-23.512-10.196-23.512-22.792 0-.959.12-1.919.24-2.879l23.63 13.675c1.44.84 2.88.84 4.32 0l30.108-17.392v11.395c0 .96-.361 1.68-1.2 2.16l-22.912 13.194c-3.119 1.8-6.837 2.639-10.675 2.639Zm29.748 14.274c14.515 0 26.63-10.316 29.39-23.991 13.434-3.479 22.071-16.074 22.071-28.91 0-8.396-3.598-16.553-10.076-22.43.6-2.52.96-5.039.96-7.557 0-17.153-13.915-29.99-29.989-29.99-3.239 0-6.358.48-9.477 1.56-5.398-5.278-12.835-8.637-20.992-8.637-14.515 0-26.63 10.316-29.39 23.991-13.434 3.48-22.07 16.074-22.07 28.91 0 8.396 3.598 16.553 10.075 22.431-.6 2.519-.96 5.038-.96 7.556 0 17.154 13.915 29.989 29.99 29.989 3.238 0 6.357-.479 9.476-1.559 5.397 5.278 12.835 8.637 20.992 8.637Z" /></svg>
      <span className="sg-sr">Claude Code and ChatGPT</span>
    </p>
  );
}

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
  const [copyFailed, setCopyFailed] = useState(false);
  const promptRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [identity, setIdentity] = useState(boot?.identity || null);
  const signedIn = Boolean(identity);
  const [busyState, setBusyState] = useState('');
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
    setCopyFailed(ok === false);
    if (ok === false) selectContents(promptRef.current);
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
                <div className="sg-prompt">
                  <p className="sg-prompt-text" ref={promptRef}>{SETUP_PROMPT}</p>
                  <button type="button" className={`sg-prompt-copy${copied ? ' copied' : ''}`} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <WorksWith />

                <ol className="sg-steps">
                  <li>Paste it into your agent.</li>
                  <li>Approve the request when it opens in your browser.</li>
                  <li>Your agent shows up here on its own. No need to refresh.</li>
                </ol>

                <div className="sg-status-slot">
                  {state === 'waiting' ? (
                    <div className="sg-status">
                      <span className="sg-spin" aria-hidden="true" />
                      {copyFailed ? COPY_FALLBACK : copied ? 'Waiting for your agent.' : 'Waiting for you to paste the prompt.'}
                    </div>
                  ) : null}
                  {state === 'stuck' ? (
                    <div className="sg-status stuck">
                      <div className="head">Still nothing. Ask your agent to check itself:</div>
                      <div className="sg-doctor">
                        <code>{DOCTOR_PROMPT}</code>
                        <button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy</button>
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

      {boot?.debug ? (
        <div className="sg-debug" role="group" aria-label="Internal testing">
          <span className="sg-debug-tag">Internal</span>
          {DEBUG_STATES.map((name) => (
            <button
              key={name}
              type="button"
              disabled={Boolean(busyState)}
              onClick={async () => {
                setBusyState(name);
                await fetch('/api/onboarding/state', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ state: name }),
                }).catch(() => {});
                setCopied(false); setCopyFailed(false); copiedAt.current = null; setElapsed(0);
                const result = await getOnboarding().catch(() => null);
                setRecord(result?.record || {});
                setBusyState('');
              }}
            >{busyState === name ? '…' : name}</button>
          ))}
          <span className="sg-debug-now">record: {recordName(record)}</span>
        </div>
      ) : null}

      <aside className="sg-pane-art">
        <div className="sg-stage">
          <div className="sg-scene run" key={state}>{scene}</div>
        </div>
      </aside>
    </div>
  );
}
