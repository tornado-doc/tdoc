import React, { useEffect, useRef, useState } from 'react';
import { ClaudeMark, OpenAIMark, GrokMark } from '../agent-marks.jsx';
import './replay.css';

// What actually happens when somebody does this, replayed at 1:1.
//
// Every frame here is copied from something real and checkable, never invented:
// the lines the agent prints are the ones `hosted_pair_signin` writes to stderr
// in bin/tdoc-publish, word for word; the approval sheet is the /activate page
// (shell/src/activate-page.jsx) down to its heading and its button; the window
// is the shape of the app the prompt is pasted into. The point of a picture on
// an instruction screen is that the reader recognises it when they get there,
// and a picture of something that does not exist cannot do that.
//
// ---------------------------------------------------------------- the canvas
//
// One fixed coordinate space, 1080x720, and every element in every scene is
// placed in it absolutely. Nothing is laid out by flow, so nothing can be moved
// by the length of what is beside it -- which is the bug that kept turning up
// on this screen: a choice that added a row to the left column moved the
// picture on the right. Scenes cannot drift because their coordinates are
// written down, not computed.
export const CANVAS = { w: 1080, h: 720 };

// ------------------------------------------------------------- the timeline
// One clock, read by everything. A scene is a window on it, and an element
// reads the clock rather than being told what to do by a chain of timeouts:
// timeouts drift and cannot be scrubbed, a clock cannot.
const T = {
  cursorToDock: [200, 1200],
  dockWake: [1000, 1500],
  dockPress: [1650, 1950],
  windowIn: [1950, 2450],
  paste: [2850, 3150],
  send: [3500, 3800],
  working: [3800, 6000],
  cli: [6000, 8200],
  sheetIn: [8500, 9100],
  cursorToApprove: [9100, 10100],
  approvePress: [10250, 10550],
  approved: [10550, 11500],
  sheetOut: [11800, 12300],
  signedIn: [12400, 13400],
  summary: [13700, 15600],
  hold: [15600, 19000],
  fade: [19000, 20000],
};
export const REPLAY_MS = 20000;

// 0 before `from`, 1 after `to`, eased in between.
function phase(t, [from, to]) {
  if (t <= from) return 0;
  if (t >= to) return 1;
  const p = (t - from) / (to - from);
  return p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2;
}
const after = (t, [from]) => t >= from;

// `restart` is anything whose change should send the replay back to zero --
// on the doc step that is the line itself, so every keystroke on the left
// starts the typing on the right again rather than joining it halfway.
function useClock(running, total, restart) {
  // `total` is required and has no default on purpose. A clock with no length
  // is not a slow clock, it is a stopped one: `% undefined` is NaN, every
  // derived style becomes `scale(NaN)` / `opacity: NaN`, the browser drops
  // them, and the scene holds whatever it rendered at t=0 for ever -- which is
  // exactly what step 1 did after the doc step taught this hook to take a
  // length and its own caller was not updated. A default would have hidden
  // that; setup-gate.test.js pins both call sites instead.
  const [t, setT] = useState(0);
  const frame = useRef(0);
  useEffect(() => {
    if (!running) { setT(total - 2200); return undefined; }
    const start = performance.now();
    const tick = (now) => {
      setT((now - start) % total);
      frame.current = window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame.current);
  }, [running, total, restart]);
  return t;
}


// ---------------------------------------------------------------- the camera
// A desk at 1:1 does not fit in a side panel, and shrinking it until it does
// makes the type 9px -- a picture of a screen nobody can read. So the desk
// stays at 1:1 and the camera moves: wide enough to see where things are,
// close enough to read them when they matter. Shots are keyframes on the same
// clock as everything else, so the camera cannot get out of step with the
// scene it is pointing at.
// Only the aim lives here. Where the middle of the frame is on screen is the
// stylesheet's business -- a number for it in here would have to agree with a
// number over there, and the two would drift the first time the pane resized.
// s is capped by what the lens can hold: 544 / 600 = 0.90 shows the whole
// window, 544 / 1080 = 0.50 shows the whole desk. Anything closer is a
// deliberate crop, never an accident.
const SHOTS = [
  { at: 0, s: 0.50, x: 540, y: 360 },
  { at: 1300, s: 0.50, x: 540, y: 360 },
  { at: 1950, s: 1.00, x: 540, y: 640 },
  { at: 2600, s: 1.00, x: 540, y: 640 },
  { at: 3250, s: 0.90, x: 540, y: 300 },
  { at: 5200, s: 0.90, x: 540, y: 300 },
  { at: 6300, s: 0.90, x: 540, y: 340 },
  { at: 8300, s: 0.90, x: 540, y: 340 },
  { at: 9000, s: 1.10, x: 540, y: 330 },
  { at: 11500, s: 1.10, x: 540, y: 330 },
  { at: 12700, s: 0.90, x: 540, y: 340 },
  { at: 15500, s: 0.90, x: 540, y: 300 },
  { at: 18600, s: 0.50, x: 540, y: 360 },
  { at: REPLAY_MS, s: 0.50, x: 540, y: 360 },
];

function camera(t, shots = SHOTS) {
  let i = 0;
  while (i < shots.length - 2 && t >= shots[i + 1].at) i += 1;
  const a = shots[i];
  const b = shots[i + 1] || a;
  const span = b.at - a.at;
  const p = span > 0 ? phase(t, [a.at, b.at]) : 1;
  return {
    s: a.s + (b.s - a.s) * p,
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
  };
}

// ------------------------------------------------------------------ the desk
const DOCK = { x: 540, y: 664, gap: 76 };
const APPS = [
  { id: 'claude', name: 'Claude', bg: '#D97757', mark: (s) => <ClaudeMark size={s} color="#fff" /> },
  { id: 'chatgpt', name: 'ChatGPT', bg: '#0D0D0D', mark: (s) => <OpenAIMark size={s} color="#fff" /> },
  { id: 'grok', name: 'Grok', bg: '#0A0A0A', mark: (s) => <GrokMark size={s} color="#fff" /> },
];

function Dock({ t, wake: fixed }) {
  const wake = fixed === undefined ? phase(t, T.dockWake) : fixed;
  const press = phase(t, T.dockPress);
  return (
    <div className="rp-dock" style={{ opacity: wake, transform: `translate(-50%, ${(1 - wake) * 26}px)` }}>
      {APPS.map((app, i) => {
        // The magnification is real: the pointer is over ChatGPT, so ChatGPT
        // stands up and its neighbours lean.
        const near = Math.abs(i - 1);
        const lift = wake * (near === 0 ? 1 : near === 1 ? 0.42 : 0);
        const bounce = app.id === 'chatgpt' ? Math.sin(press * Math.PI) * 12 : 0;
        return (
          <div
            key={app.id}
            className="rp-app"
            style={{ transform: `translateY(${-lift * 14 - bounce}px) scale(${1 + lift * 0.34})` }}
          >
            <span className="rp-icon" style={{ background: app.bg }}>{app.mark(30)}</span>
            <i className="rp-run" style={{ opacity: app.id === 'chatgpt' ? press : 0 }} />
          </div>
        );
      })}
    </div>
  );
}

function Cursor({ t }) {
  const toDock = phase(t, T.cursorToDock);
  const toApprove = phase(t, T.cursorToApprove);
  const press = phase(t, T.approvePress) > 0 && phase(t, T.approvePress) < 1;
  const from = { x: 300, y: 360 };
  const dock = { x: DOCK.x, y: DOCK.y - 10 };
  const approve = { x: 610, y: 470 };
  const a = { x: from.x + (dock.x - from.x) * toDock, y: from.y + (dock.y - from.y) * toDock };
  const p = { x: a.x + (approve.x - a.x) * toApprove, y: a.y + (approve.y - a.y) * toApprove };
  return (
    <svg className="rp-cursor" width="22" height="26" viewBox="0 0 22 26" aria-hidden="true"
      style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${press ? 0.88 : 1})` }}>
      <path d="M2 1.5 L2 20.5 L7.2 15.6 L10.6 23.2 L13.6 21.9 L10.3 14.5 L17.2 14.2 Z"
        fill="#fff" stroke="#1a1a1a" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

// -------------------------------------------------------------- the window
// The shape of the app the prompt goes into: traffic lights, the thread's own
// name in the title, the message from the human as a dark bubble on the right,
// then what the tool printed. The words below are not written for this picture
// -- they are what bin/tdoc-publish prints on this path.
const CLI_LINES = [
  '[tdoc] Sign in to publish on https://tdoc.dev',
  '[tdoc] A tdoc page just opened in your browser — the code is filled in;',
  '[tdoc] sign in and approve.',
  "[tdoc] Once it's approved, I'll continue here on my own.",
  '[tdoc] Waiting for approval · 9:52 remaining',
];
const SIGNED_LINES = [
  '[tdoc] Approved — signed in as serenakeyitan.',
  '[tdoc] Credential saved to ~/.tdoc/published.json',
];

function Working({ t, range = T.working, done }) {
  const finished = done === undefined ? after(t, T.cli) : done;
  const spin = after(t, range) && !finished;
  const secs = Math.min(268, Math.round(phase(t, range) * 268));
  return (
    <div className="rp-worked">
      {spin ? <i className="rp-spin" /> : <i className="rp-done">✓</i>}
      <span>Worked for {Math.floor(secs / 60)}m {String(secs % 60).padStart(2, '0')}s</span>
      <span className="rp-chev">›</span>
    </div>
  );
}

function Window({ t, prompt, fade }) {
  const open = phase(t, T.windowIn) * fade;
  const pasted = phase(t, T.paste);
  const sent = after(t, T.send);
  // Lines arrive one after another across the CLI window, the way they arrive
  // in a terminal -- not as a block that appears.
  const cliShown = Math.floor(phase(t, T.cli) * (CLI_LINES.length + 0.4));
  const signedShown = Math.floor(phase(t, T.signedIn) * (SIGNED_LINES.length + 0.4));
  const summary = phase(t, T.summary);
  return (
    <div
      className="rp-win"
      style={{ opacity: open, transform: `translate(-50%, 0) scale(${0.94 + open * 0.06})` }}
    >
      <div className="rp-win-bar">
        <span className="rp-lights"><i /><i /><i /></span>
        <span className="rp-win-title">Install tdoc and connect account</span>
      </div>
      <div className="rp-win-body">
        {sent ? (
          <div className="rp-bubble">{prompt}</div>
        ) : (
          <div className="rp-composer">
            <span className="rp-typed" style={{ opacity: pasted }}>{prompt}</span>
            {pasted < 1 ? <span className="rp-ph">Message ChatGPT</span> : null}
            <span className="rp-caret" style={{ opacity: pasted }} />
          </div>
        )}

        {after(t, T.working) ? <Working t={t} /> : null}

        {/* Only once there is a line in it. An empty block that fills in later
            is a grey bar with nothing to say for two seconds. */}
        {cliShown > 0 ? (
          <pre className="rp-cli">
            {CLI_LINES.slice(0, cliShown).join('\n')}
            {signedShown ? `\n${SIGNED_LINES.slice(0, signedShown).join('\n')}` : ''}
          </pre>
        ) : null}

        {summary > 0 ? (
          <div className="rp-summary" style={{ opacity: summary }}>
            <p>tdoc is installed and connected to your account.</p>
            <ul>
              <li>Account: <code>serenakeyitan</code></li>
              <li>Target: <code>tdoc.dev</code></li>
              <li>Doctor check: ready to publish; no missing steps</li>
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the approval
// tdoc's own /activate page, which is what the browser opens. Heading, code
// field and button are the ones in shell/src/activate-page.jsx.
function ApprovalSheet({ t }) {
  const inP = phase(t, T.sheetIn);
  const outP = phase(t, T.sheetOut);
  const done = after(t, T.approved);
  const press = phase(t, T.approvePress);
  if (inP === 0 || outP === 1) return null;
  return (
    <div className="rp-sheet" style={{ opacity: inP * (1 - outP), transform: `translate(-50%, ${(1 - inP) * 18 + outP * -10}px)` }}>
      <img src="/tdoc_logo.svg" width="38" height="38" alt="" data-tdoc-dark="invert" />
      {done ? (
        <>
          <h3>Device login approved</h3>
          <p>Sign-in is complete. You can close this browser page.</p>
        </>
      ) : (
        <>
          <h3>Approve Device Login</h3>
          <p>Signed in as <b>serenatan1125@gmail.com</b>.</p>
          <div className="rp-code">WXNB-7QKD</div>
          <button type="button" className="rp-approve" style={{ transform: `scale(${1 - press * 0.04})` }}>
            Approve
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- the set
export function ConnectReplay({ prompt }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t = useClock(!reduced, REPLAY_MS);
  // The desk and the dock never fade -- only the window does, so the loop
  // reads as somebody closing it and starting over rather than as the screen
  // being switched off and on.
  const fade = 1 - phase(t, T.fade);
  const cam = camera(t);
  return (
    <div className="rp-view" aria-hidden="true">
      <div className="rp-lens" style={{ transform: `scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)` }}>
      <div className="rp-canvas">
        <div className="rp-menubar"><span className="rp-mb-app">ChatGPT</span><span className="rp-sp" /><span>Fri 2:59 AM</span></div>
        <Window t={t} prompt={prompt} fade={fade} />
        <ApprovalSheet t={t} />
        <Dock t={t} />
        <Cursor t={t} />
      </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------- the second ask
// The same desk, the same window, a different act: on this screen the line is
// not pasted, it is typed -- and it is typed as the reader types it, because
// the subject they are naming on the left is what the agent is being asked
// about on the right. Every keystroke restarts the take, so the picture is
// never showing a sentence they have moved on from.
const TYPE_MS = 38;
export function docScript(prompt) {
  const type = Math.max(900, String(prompt || '').length * TYPE_MS);
  const t0 = 600;
  return {
    type: [t0, t0 + type],
    send: [t0 + type + 420, t0 + type + 700],
    working: [t0 + type + 700, t0 + type + 2600],
    published: [t0 + type + 2600, t0 + type + 3400],
    doc: [t0 + type + 3500, t0 + type + 4400],
    fade: [t0 + type + 7200, t0 + type + 8000],
    total: t0 + type + 8000,
  };
}

// The doc script's length moves with the line, so its shots are written as
// fractions of it rather than as milliseconds that would fall in the wrong
// place the moment somebody typed a longer subject.
const DOC_FRAMES = [
  { p: 0, s: 0.90, x: 540, y: 190 },
  { p: 0.42, s: 0.90, x: 540, y: 190 },
  { p: 0.58, s: 0.90, x: 540, y: 300 },
  { p: 0.82, s: 0.90, x: 540, y: 300 },
  { p: 1, s: 0.90, x: 540, y: 260 },
];
const docShots = (total) => DOC_FRAMES.map((f) => ({ at: Math.round(f.p * total), s: f.s, x: f.x, y: f.y }));

function DocWindow({ t, s, prompt }) {
  const typed = Math.round(phase(t, s.type) * prompt.length);
  const sent = after(t, s.send);
  const pub = phase(t, s.published);
  const doc = phase(t, s.doc);
  const fade = 1 - phase(t, s.fade);
  return (
    <div className="rp-win" style={{ opacity: fade, transform: 'translate(-50%, 0)' }}>
      <div className="rp-win-bar">
        <span className="rp-lights"><i /><i /><i /></span>
        <span className="rp-win-title">Make a tdoc</span>
      </div>
      <div className="rp-win-body">
        {sent ? (
          <div className="rp-bubble">{prompt}</div>
        ) : (
          <div className="rp-composer">
            <span className="rp-typed">{prompt.slice(0, typed)}</span>
            <span className="rp-caret" />
          </div>
        )}
        {after(t, s.working) ? <Working t={t} range={s.working} done={after(t, s.published)} /> : null}
        {pub > 0 ? (
          <pre className="rp-cli" style={{ opacity: pub }}>
            {'[tdoc] Published v1 — https://tdoc.dev/d/what-standups-cost'}
          </pre>
        ) : null}
        {doc > 0 ? (
          <div className="rp-summary" style={{ opacity: doc }}>
            <p>Published. Your first tdoc is live.</p>
            <ul><li>Anyone with the link can read it</li><li>Comments are open to you</li></ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DocReplay({ prompt }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const line = String(prompt || '');
  const s = docScript(line);
  const t = useClock(!reduced, s.total, line);
  const cam = camera(t, docShots(s.total));
  return (
    <div className="rp-view" aria-hidden="true">
      <div className="rp-lens" style={{ transform: `scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)` }}>
        <div className="rp-canvas">
          <div className="rp-menubar"><span className="rp-mb-app">ChatGPT</span><span className="rp-sp" /><span>Fri 2:59 AM</span></div>
          <DocWindow t={t} s={s} prompt={line} />
          <Dock t={t} wake={1} />
        </div>
      </div>
    </div>
  );
}
