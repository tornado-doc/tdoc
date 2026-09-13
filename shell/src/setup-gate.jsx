import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent } from './document/api.js';
import { ANOTHER_DOC_RECIPE, COPY_FALLBACK, NOTHING_YET, RECIPE_URL, selectContents } from './onboarding-copy.js';
import { ClaudeMark, OpenAIMark } from './agent-marks.jsx';

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

// ONBOARDING.md only reaches the connection in its step 5, as a side effect of
// building a first doc -- which this page deliberately no longer asks for. So
// the line names the command that pairs, and stops there.
export const SETUP_PROMPT = 'Install tdoc from https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md, then connect it to my account by running: bin/tdoc-publish --signin-only';
// The second ask, on the same route, and the one place in the whole journey
// where there is a choice to make. Everybody being marched through the same
// "what AI knows about you" is what made the old version feel like a
// kidnapping to anyone who already knew what they wanted to write.
//
// Two live choices, and they differ in what the agent is being asked for, not
// in how the page behaves: one names a subject the person supplies, the other
// asks for the portrait FIRST-DOC.md builds out of their own traces. Both end
// as one line, pasted once.
//
// A third -- fork a doc that already exists -- is drawn but not wired. Its
// whole value was a first doc in ten seconds with no agent, and the seeding
// now delivers exactly that, earlier and without a click; the only forkable
// template today IS the one already sitting in their Onboarding folder. It
// becomes real when there is a second thing to fork.
export const DOC_SUBJECT_PREFIX = '/tdoc new "';
export const DOC_SUBJECT_SUFFIX = '" — then publish it and give me the link';
export const docSubjectPrompt = (subject) => `${DOC_SUBJECT_PREFIX}${subject}${DOC_SUBJECT_SUFFIX}`;
// FIRST_DOC_RECIPE opens with "Set up tdoc and", which is true on the landing
// page and false here: by the time anyone reads this screen the skill is
// installed and the account is connected. Same recipe, without the preamble.
export const PORTRAIT_PROMPT = `Make my first doc: ${RECIPE_URL}`;
export const DOC_CHOICES = [
  { id: 'own', label: 'I know what it’s about', sub: 'Name the subject. Your agent writes it.' },
  { id: 'portrait', label: 'Make the one about me', sub: 'Built from the traces you choose to share.' },
];
// Kept as the export it always was: the placeholder line still answers "what
// do I paste" for anyone who lands here with no choice made.
export const FIRST_DOC_PROMPT = ANOTHER_DOC_RECIPE;
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
      <ClaudeMark size={17} />
      <OpenAIMark size={15} />
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

function SceneWaiting({ line }) {
  return (
    <>
      <ChatWindow>
        <div className="sg-msg">
          <span className="sg-av bot" />
          <p className="sg-txt">What are we working on?</p>
        </div>
        {/* Nothing typed until there is something to type: the composer showing
            a line the left column has not handed over yet would be the page
            answering its own question. */}
        {line ? (
          <Composer live>
            <span className="sg-typed">{line.slice(0, 62)}{line.length > 62 ? '…' : ''}</span>
            <span className="sg-caret" />
          </Composer>
        ) : <Composer />}
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
function SceneDone({ bare = false }) {
  return (
    <>
      <div className="sg-app">
        <div className="sg-bar">
          <div className="sg-mk"><Mark size={24} /></div>
          <div className="sg-ver">{bare ? 'v1 ▾' : 'v2 ▾'}</div>
          <div className="sg-title">{bare ? 'How our pricing actually works' : 'What AI knows about you'}</div>
          <div className="sg-owner">· you</div>
          <div className="sg-star">☆</div>
          <div className="sg-sp" />
          {bare ? null : <div className="sg-res"><span className="sg-sw" /> Resolved (1)</div>}
          <div className="sg-btn tint">Comment ▾</div>
          <div className="sg-btn solid">Share</div>
          <div className="sg-ic">⋯</div>
          <div className="sg-me"><i /> You</div>
        </div>
        <div className={`sg-page${bare ? ' bare' : ''}`}>
          <div className="sg-doc">
            {bare ? (
              <>
                <h2>How our pricing actually works</h2>
                <p>Three plans, one number that matters: what you pay when a month goes badly.</p>
                <p>Seats are billed on the day you add them and refunded to the hour when you take them away. Nothing renews without an invoice you can read first.</p>
                <p className="faint">Published a moment ago. Your agent has the link.</p>
              </>
            ) : (
              <>
                <h2>What AI knows about you</h2>
                <p>You have been treating your agent like a search box, and it shows.</p>
                <p><span className="sg-anchor">Nothing you asked it this month required memory.</span> Every session started from nothing, and you paid for that in re-explaining yourself.</p>
                <p className="faint">The traces say you work in bursts, late, and abandon about a third of what you start before the second message.</p>
              </>
            )}
          </div>
          {bare ? null : (
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
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ the gate

export function SetupGate({ boot }) {
  const [record, setRecord] = useState(null);
  const [paired, setPaired] = useState(false);
  // The choice, and the subject it may carry. Nothing is chosen on arrival:
  // pre-selecting one would answer the only question this screen asks.
  const [choice, setChoice] = useState(null);
  // Nothing in the form column is drawn until the server has answered once.
  // Before that the record is empty, which reads as "not connected" and paints
  // the connect step for a beat on a page that was asked for the doc step.
  const [loaded, setLoaded] = useState(false);
  // The newest doc this account owns, and the one it already owned when this
  // page opened. The record cannot answer the second ask on its own: both of
  // its doc stamps are written once, so a SECOND doc moves nothing on it. What
  // this page waits for is a doc that was not here a moment ago.
  const [newestDoc, setNewestDoc] = useState(null);
  // Both answers, as they stood when this page opened. Two different questions
  // get asked of them and they are not the same question, which is what went
  // wrong: the catalog knows whether a doc exists, the record knows whether
  // the JOURNEY has one, and an account can easily have the first without the
  // second.
  const known = useRef(null);
  const [subject, setSubject] = useState('');
  const subjectRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const promptRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [identity, setIdentity] = useState(boot?.identity || null);
  const signedIn = Boolean(identity);
  const [busyState, setBusyState] = useState('');
  const waitingSince = useRef(null);
  const stamped = useRef(false);

  // `paired` -- has this account ever connected a terminal -- is precisely the
  // question this page asks, and it survives the record being cleared. Reading
  // only the record's own stamps left anyone whose agent was already connected
  // waiting forever: that agent holds a token, so it does nothing visible, and
  // nothing re-stamps a connection that already happened.
  const connected = Boolean(paired || record?.agent_connected || record?.published_first);
  // Two asks, one route. `?step=doc` is the second, and it is only ever shown
  // to somebody whose agent is already connected -- you cannot ask an agent
  // for a doc before it can publish as you. Anyone else gets the first ask,
  // and the page moves on to the second by itself once the agent turns up, so
  // the link is safe to hand to anybody.
  const wantsDoc = boot?.step === 'doc';
  const step = wantsDoc && connected ? 'doc' : 'connect';
  const subjectTrimmed = subject.trim();
  const docPrompt = choice === 'portrait' ? PORTRAIT_PROMPT
    : choice === 'own' ? docSubjectPrompt(subjectTrimmed || '<what it is about>')
      : FIRST_DOC_PROMPT;
  const prompt = step === 'doc' ? docPrompt : SETUP_PROMPT;
  // A subject that has not been typed is not a line anybody should be handed.
  const promptReady = step !== 'doc' || choice === 'portrait' || Boolean(subjectTrimmed);
  // The doc step has no stuck state of its own: there is nothing to repair.
  // An agent that has not published yet is usually mid-question, so the wait
  // just says where to look.
  const catalogDoc = newestDoc || null;
  const journeyDoc = record?.first_doc || null;
  const ownDoc = catalogDoc || journeyDoc;
  if (step === 'doc' && loaded && known.current === null) {
    known.current = { catalog: catalogDoc, journey: journeyDoc };
  }
  // Something moved since this page opened. The catalog is what makes a SECOND
  // doc visible, because the record's doc stamps are written once and a second
  // doc moves nothing on them. The record is what makes the FIRST one visible
  // to a journey that had none -- including one put into that state by hand.
  const arrived = Boolean(known.current && (
    (catalogDoc && catalogDoc !== known.current.catalog)
    || (journeyDoc && journeyDoc !== known.current.journey)
  ));
  const state = step === 'doc'
    ? (arrived ? 'done' : 'waiting')
    : connected ? 'done' : elapsed > STUCK_MS ? 'stuck' : 'waiting';
  // The connect step ends on the docs page, which is right whether their first
  // doc exists yet or not. The doc step ends on the doc it just watched
  // arrive, and it arrives the way row 3 does -- `?step=comment`, so tdoc's
  // question is open and the corner row is saying what to do with it. Landing
  // bare here was the coldest arrival in the whole journey: the one moment
  // somebody has just made a thing and is most ready to be handed the next
  // move, and the page said nothing.
  // The clock starts when this page starts waiting, not when somebody presses
  // a button. It is the same wait either way.
  if (loaded && signedIn && state !== 'done' && !waitingSince.current) waitingSince.current = Date.now();
  const onward = step === 'doc' && ownDoc
    ? `/d/${encodeURIComponent(ownDoc)}?step=comment`
    : '/me';
  // Both steps are one layout with a status line under it. Swapping the doc
  // step into a second, emptier face when its doc arrived made a page out of a
  // sentence: whoever landed on it was told their first tdoc is live and
  // offered nothing to do, and whoever wanted another one had to find their
  // way back to the question. The ask stays; the line below it changes.
  //
  // The heading is the one thing read once rather than live, so it does not
  // rename itself from "your first" to "another" in front of somebody who is
  // watching their first arrive.
  // "Another" has to mean what the checklist means by it. Row 2 there reads
  // `first_doc`, so an account that owns docs but whose journey has not
  // recorded one is on its FIRST -- the catalog saying otherwise had the two
  // surfaces contradicting each other on the same screen's worth of clicks.
  const another = step === 'doc' && Boolean(known.current && known.current.journey);

  // The record is the only thing that moves this page.
  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await getOnboarding(wantsDoc ? { docs: 1 } : undefined);
        if (!cancelled) {
          setRecord(result?.record || {});
          setPaired(Boolean(result?.paired));
          setNewestDoc(result?.newest_doc || null);
        }
      } catch {}
      if (!cancelled) setLoaded(true);
      if (cancelled) return;
      // The wait is timed from when this page started waiting, not from a
      // click on Copy. Somebody who selects the line and hits cmd-C is waiting
      // exactly as much as somebody who pressed the button, and used to be
      // told nothing at all when it went wrong.
      if (waitingSince.current) setElapsed(Date.now() - waitingSince.current);
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, wantsDoc]);

  // The site's own sign-in, and only that: a full-page redirect out to the
  // OIDC provider and back to /setup. Signing in is signing up, so there is no
  // second door to offer.
  const signIn = () => {
    const here = wantsDoc ? '/setup?step=doc' : '/setup';
    location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(here)}`;
  };

  const copy = async () => {
    const ok = await copyText(prompt);
    setCopied(ok !== false);
    setCopyFailed(ok === false);
    if (ok === false) selectContents(promptRef.current);
    if (!stamped.current) { stamped.current = true; postOnboardingEvent('door_own_agent').catch(() => {}); }
    postOnboardingEvent('copy_clicked').catch(() => {});
  };

  // The scene is the left column's mirror, so it waits for the same answer.
  // Drawn early it paints the connect step's chat beside a heading that has
  // not decided which step it is yet.
  const scene = signedIn && !loaded ? null
    : state === 'done' ? <SceneDone bare={step === 'doc'} />
      : state === 'stuck' ? <SceneStuck />
        : <SceneWaiting line={step === 'doc' && !choice ? null : prompt} />;

  return (
    <div className="sg-split">
      <section className="sg-pane-form">
        <a className="sg-brand" href="/me" title="My docs" aria-label="My docs"><Mark /></a>
        <div className="sg-mid">
          <div className="sg-col">
            {signedIn && !loaded ? null : (
              <h1 className="sg-h1">
                {step !== 'doc' ? 'Connect your agent' : another ? 'Make another tdoc' : 'Make your first tdoc'}
              </h1>
            )}

            {signedIn && !loaded ? null : signedIn ? (
              <>
                {step === 'doc' ? (
                  <div className="sg-choices" role="radiogroup" aria-label="What the doc is about">
                    {DOC_CHOICES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={choice === item.id}
                        className={`sg-choice${choice === item.id ? ' on' : ''}`}
                        onClick={() => {
                          setChoice(item.id);
                          setCopied(false); setCopyFailed(false);
                          if (item.id === 'own') window.setTimeout(() => subjectRef.current?.focus(), 0);
                        }}
                      >
                        <span className="sg-radio" aria-hidden="true" />
                        <span className="sg-choice-text">
                          <b>{item.label}</b>
                          <span>{item.sub}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {step === 'doc' && choice === 'own' ? (
                  <label className="sg-subject">
                    <span className="sg-sr">What the doc is about</span>
                    <input
                      ref={subjectRef}
                      type="text"
                      value={subject}
                      placeholder="what it should be about"
                      onChange={(event) => { setSubject(event.target.value); setCopied(false); }}
                    />
                  </label>
                ) : null}

                {step !== 'doc' || choice ? (
                  <div className={`sg-prompt${promptReady ? '' : ' pending'}`}>
                    <p className="sg-prompt-text" ref={promptRef}>{prompt}</p>
                    <button
                      type="button"
                      className={`sg-prompt-copy${copied ? ' copied' : ''}`}
                      onClick={copy}
                      disabled={!promptReady}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : null}

                {step === 'doc' ? null : <WorksWith />}

                {step === 'doc' && !choice ? null : (
                <ol className="sg-steps">
                  {step === 'doc' ? (
                    <>
                      <li>Paste it into your agent.</li>
                      <li>It writes the page and publishes it as you.</li>
                      <li>The doc turns up here on its own. No need to refresh.</li>
                    </>
                  ) : (
                    <>
                      <li>Paste it into your agent.</li>
                      <li>Approve the request when it opens in your browser.</li>
                      <li>Your agent shows up here on its own. No need to refresh.</li>
                    </>
                  )}
                </ol>
                )}

                <div className="sg-status-slot">
                  {state === 'waiting' && !(step === 'doc' && !choice) ? (
                    <div className="sg-status">
                      <span className="sg-spin" aria-hidden="true" />
                      {/* Not "waiting for you to paste": the page cannot see a
                          paste, and it cannot see a selection copied by hand
                          either. What it can say is what it is doing. */}
                      {copyFailed ? COPY_FALLBACK
                        : step === 'doc' && elapsed > STUCK_MS ? NOTHING_YET
                          : 'Waiting for your agent.'}
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
                      {step === 'doc'
                        ? <div><b>Published.</b> <span className="found">{another ? 'Your new tdoc is live.' : 'Your first tdoc is live.'}</span></div>
                        : <div><b>Connected.</b> <span className="found">Your agent can publish as you.</span></div>}
                    </div>
                  ) : null}
                </div>

                <a className={`sg-primary${state === 'done' ? '' : ' off'}`} href={state === 'done' ? onward : undefined} aria-disabled={state !== 'done'}>
                  {step === 'doc' ? 'Open it' : 'Continue'}
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
                setCopied(false); setCopyFailed(false); waitingSince.current = Date.now(); setElapsed(0);
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
