import React, { useEffect, useRef, useState } from 'react';
import { CodexWindow, Stamp, Ask, Worked, Answer, Feedback } from './codex-window.jsx';
import './codex-window.css';
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
// 640, not 1080. The camera's widest shot is 0.85 in a 544x612 frame, so what
// it can ever show is 544/0.85 x 612/0.85 = 640 x 720. The height was already
// exactly that; the width was 1080, which meant 41% of the desk -- the whole
// left and right of the screen -- was drawn and never rendered. Both
// informative ends of a menu bar live there: the apple and the app name on the
// left, the clock and status items on the right. At the widest shot a viewer
// saw a translucent band reading "iew Window Help".
//
// That is why three rounds of fixing the menu bar's contents changed nothing
// anybody could see. A desk the camera cannot reach is not a desk.
export const CANVAS = { w: 640, h: 720 };

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
// s is capped by what the lens can hold: 544 / 640 = 0.85 shows the whole
// window, 544 / 1080 = 0.50 shows the whole desk. Anything closer is a
// deliberate crop, never an accident -- and the approval sheet is 420 wide, so
// it can be pushed in on much further than the window can.
const SHOTS = [
  // At 0.85 the frame holds the whole desk vertically (648 / 0.85 = 762 > 720)
  // and the whole window across (544 / 0.85 = 640), so the menu bar and the
  // dock stay in shot for the entire script. They are always on a real screen;
  // half of one hanging off the top is worse than not drawing it.
  // 0.85 is the floor, not a wide shot: 612 / 720 = 0.85 is the scale at which
  // the desk exactly fills the frame, so anything smaller shrinks the desk
  // inside it and shows the frame's own ground around the edges. There is no
  // "further out" to go.
  { at: 0, s: 0.85, x: 320, y: 360 },
  { at: 1300, s: 0.85, x: 320, y: 360 },
  // In on the dock, to watch the app open.
  { at: 1950, s: 1.00, x: 320, y: 410 },
  { at: 2600, s: 1.00, x: 320, y: 410 },
  // Back out far enough to keep the desk whole while the window is read.
  { at: 3250, s: 0.85, x: 320, y: 360 },
  { at: 8300, s: 0.85, x: 320, y: 360 },
  // The sheet is a browser window opening in front of the app, so the app
  // stays whole behind it.
  { at: 9000, s: 0.92, x: 320, y: 340 },
  { at: 11500, s: 0.92, x: 320, y: 340 },
  { at: 12700, s: 0.85, x: 320, y: 360 },
  { at: 15500, s: 0.85, x: 320, y: 360 },
  { at: 18600, s: 0.85, x: 320, y: 360 },
  { at: REPLAY_MS, s: 0.85, x: 320, y: 360 },
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
const DOCK = { x: 320, y: 664, gap: 76 };
// What is always in a dock, then the three this story is about, then the bin.
// A dock holding only chat apps is not a dock anybody has, and that was most
// of why the desk read as a drawing.
const APPS = [
  // The real artwork, off a Mac, served by both hosts at /mac/*.png. These were
  // hand-drawn first and audited against the originals: Finder came out with
  // two faces on it and Safari as a white tile with a thin blue ring. At 46px a
  // wrong drawing names no app at all. The real files also bring the squircle
  // and each icon's own shadow, neither of which a border-radius can fake.
  //
  // Finder is always running. There is no state of a Mac in which it is not,
  // and a dock with nothing running is a screenshot of nothing.
  { id: 'finder', name: 'Finder', src: '/mac/finder.png', running: true },
  { id: 'safari', name: 'Safari', src: '/mac/safari.png' },
  { id: 'messages', name: 'Messages', src: '/mac/messages.png' },
  // Each app's own icon, off this machine, exactly like the four above. Drawing
  // a mark on a coloured tile got both the proportions and the identity wrong:
  // the black OpenAI petal is the ChatGPT web mark, and the app in a dock next
  // to Claude is Codex, whose icon is a pale violet cloud with a prompt in it.
  { id: 'claude', name: 'Claude', src: '/mac/claude.png' },
  // Codex's .icns is a full-bleed opaque white square -- its top-left pixel is
  // (255,255,255,255) where every other app's is (0,0,0,0). It was not drawn
  // for a dock: the others carry their own squircle and a transparent margin,
  // this one is a flat tile, so beside them it read as a white box. It gets
  // the same superellipse mask the marks we draw get.
  { id: 'codex', name: 'ChatGPT', src: '/mac/codex.png', square: true, fill: 1.00 },
  { id: 'grok', name: 'Grok', src: '/mac/grok.png' },
  { id: 'sep', separator: true },
  // The separator divides applications from the stacks-and-Trash region, and
  // that region always holds at least Downloads. A separator with only the bin
  // behind it is a dock nobody has.
  { id: 'downloads', src: '/mac/downloads.png', name: 'Downloads', fill: 0.93 },
  { id: 'trash', src: '/mac/trash.png', name: 'Trash' },
];
const LAUNCHES = 'codex';
const LAUNCH_INDEX = APPS.findIndex((a) => a.id === LAUNCHES);

// `launch` is the connect script's own beat -- the click that opens the app.
// The doc script has no such beat (the window is already open and the person is
// typing into it), so it says so rather than inheriting a bounce from a
// timeline it is not on. Overriding `wake` alone left the icon jumping and its
// running-dot lighting up at 1650ms of a script that had moved on.
function Dock({ t, wake: fixed, launch = true }) {
  // Two different things, and conflating them cost the dock its existence.
  //
  // `shown` is whether the dock is on screen at all -- it slides up at the
  // start of the take and stays, because a dock does not leave when you open
  // an app. `hover` is whether the pointer is on it, which drives the
  // magnification and the name bubble and ends the moment the app opens and
  // the pointer moves into the window. Driving both from one value meant
  // either the bubble hung there for the rest of the twenty seconds, or -- as
  // soon as that was fixed -- the whole dock vanished when the window opened.
  const shown = fixed === undefined ? phase(t, T.dockWake) : fixed;
  const hover = shown * (1 - phase(t, T.windowIn));
  const press = launch ? phase(t, T.dockPress) : 0;
  return (
    <div className="rp-dock" style={{ opacity: shown, transform: `translate(-50%, ${(1 - shown) * 26}px)` }}>
      {APPS.map((app, i) => {
        if (app.separator) return <i key={app.id} className="rp-dock-sep" />;
        // Magnification is the pointer's doing, so it only happens on the
        // script where a pointer goes there. On the other one the dock sits
        // flat -- and a magnified icon reaches higher than the window's bottom
        // edge, so this was also poking through it.
        const near = Math.abs(i - LAUNCH_INDEX);
        const lift = (launch ? hover : 0) * (near === 0 ? 1 : near === 1 ? 0.42 : 0);
        const bounce = app.id === LAUNCHES ? Math.sin(press * Math.PI) * 12 : 0;
        return (
          <div
            key={app.id}
            className="rp-app"
            style={{ transform: `translateY(${-lift * 14 - bounce}px) scale(${1 + lift * 0.34})` }}
          >
            {app.src
              ? (
                <img
                  className={`rp-icon real${app.square ? ' squared' : ''}`}
                  src={app.src}
                  alt=""
                  width="46"
                  height="46"
                  // Measured, not guessed. A dock icon's artwork fills 80.5% of
                  // its tile and the rest is transparent margin -- that is what
                  // makes a row of them look the same size. Six of these files
                  // do that on their own (81-83%); Codex's fills 100% and the
                  // Downloads folder 93%, so at equal width they rendered 23%
                  // and 13% larger than everything beside them.
                  style={app.fill ? { transform: `scale(${(0.805 / app.fill).toFixed(3)})` } : undefined}
                />
              )
              : <span className="rp-icon" style={{ background: app.bg }}>{app.mark(28)}</span>}
            <i className="rp-run" style={{ opacity: app.running ? 1 : (app.id === LAUNCHES ? press : 0) }} />
            {/* The name bubble a real dock shows under the pointer. Light, with
                a tail, above the icon -- and only for the one being pointed at. */}
            {app.name && lift > 0.55 ? <span className="rp-tip">{app.name}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

// The apple, the front app's name in bold, that app's menus, then the status
// items on the right. A dark strip with one word on it was the giveaway.
// Finder's menus and an app's are not the same list: Finder has Go, and
// nothing else does.
const MENUS = {
  Finder: ['File', 'Edit', 'View', 'Go', 'Window', 'Help'],
  app: ['File', 'Edit', 'View', 'Window', 'Help'],
};

function MenuBar({ app, clock }) {
  return (
    <div className="rp-menubar" aria-hidden="true">
      {/* U+F8FF, as a JS string rather than an HTML entity -- the entity went
          in as U+2318 (the Command key) and nobody could see it to catch it,
          because the left of the bar was off-frame. */}
      <span className="rp-mb-apple">{'\uF8FF'}</span>
      <span className="rp-mb-app">{app}</span>
      <span className="rp-mb-menu">
        {(app === 'Finder' ? MENUS.Finder : MENUS.app).map((m) => <span key={m}>{m}</span>)}
      </span>
      <span className="rp-sp" />
      <span className="rp-mb-status">
        {/* Battery, Wi-Fi, Control Centre, clock -- the real order. Battery and
            Wi-Fi were the other way round, and Control Centre was missing
            entirely; it is the mark that says "a Mac from the last five
            years". */}
        <svg viewBox="0 0 26 14" width="24" height="13" aria-hidden="true"><rect x=".8" y=".8" width="21" height="12.4" rx="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".65" /><rect x="2.6" y="2.6" width="15" height="8.8" rx="2" fill="currentColor" /><path d="M23.4 5v4a2.6 2.6 0 0 0 0-4Z" fill="currentColor" opacity=".55" /></svg>
        <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M8 12.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm0-3.5c1.2 0 2.3.5 3.1 1.3l-1.1 1.1A2.8 2.8 0 0 0 8 10.4c-.8 0-1.5.3-2 .9L4.9 10.2A4.4 4.4 0 0 1 8 8.9Zm0-3.4c2.1 0 4 .8 5.4 2.2l-1.1 1.1A6.1 6.1 0 0 0 8 7.1c-1.7 0-3.2.6-4.3 1.7L2.6 7.7A7.6 7.6 0 0 1 8 5.5Zm0-3.4c3 0 5.7 1.2 7.7 3.2l-1.1 1.1A9.4 9.4 0 0 0 8 3.7c-2.6 0-4.9 1-6.6 2.7L.3 5.3A11 11 0 0 1 8 2.1Z" /></svg>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="6" rx="3" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="10.5" cy="4.5" r="1.6" fill="currentColor" /><rect x="2.5" y="8.5" width="11" height="6" rx="3" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.5" cy="11.5" r="1.6" fill="currentColor" /></svg>
        <span>{clock}</span>
      </span>
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

// ---------------------------------------------------------------- the turns
// The words below are not written for this picture: they are what
// `hosted_pair_signin` prints to stderr in bin/tdoc-publish, in order.
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

function workedLabel(t, range) {
  const secs = Math.min(268, Math.round(phase(t, range) * 268));
  return `Worked for ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

function ConnectTurns({ t, prompt }) {
  const pasted = phase(t, T.paste);
  const sent = after(t, T.send);
  const shown = Math.floor(phase(t, T.cli) * (CLI_LINES.length + 0.4));
  const signed = Math.floor(phase(t, T.signedIn) * (SIGNED_LINES.length + 0.4));
  const summary = phase(t, T.summary);
  // Open while it is working, folded once the answer arrives -- which is what
  // the real one does, and what a finished turn looks like: a "Worked for"
  // line with a chevron, then the reply. Leaving the tool output permanently
  // expanded put a grey slab of log in the middle of a chat window.
  const logOpen = summary === 0 && shown > 0;
  // Before it is sent, the line lives in the composer -- that is what pasting
  // looks like. It used to appear straight away as a sent bubble, so the one
  // gesture this whole scene is teaching (paste it into your agent) never
  // happened on screen: the message simply existed.
  if (!sent) return <Stamp>Today 2:59 AM</Stamp>;
  return (
    <>
      <Stamp>Today 2:59 AM</Stamp>
      <Ask>{prompt}</Ask>
      {after(t, T.working) ? (
        <Worked label={workedLabel(t, T.working)} open={logOpen}>
          {CLI_LINES.slice(0, shown).join('\n')}
          {signed ? `\n${SIGNED_LINES.slice(0, signed).join('\n')}` : ''}
        </Worked>
      ) : null}
      {summary > 0 ? (
        <>
          <Answer>
            <p>tdoc is installed and connected to your account.</p>
            <ul>
              <li>Account: <code>serenakeyitan</code></li>
              <li>Target: <code>tdoc.dev</code></li>
              <li>Doctor check: ready to publish; no missing steps</li>
            </ul>
          </Answer>
          <Feedback />
        </>
      ) : null}
    </>
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
  // No line yet: the desk, the dock, and no app open. Running the script
  // would be a recording of pasting something that does not exist.
  const idle = !prompt;
  const reduced = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t = useClock(!reduced && !idle, REPLAY_MS);
  // The desk and the dock never fade -- only the window does, so the loop
  // reads as somebody closing it and starting over rather than as the screen
  // being switched off and on.
  const fade = 1 - phase(t, T.fade);
  const cam = camera(t);
  return (
    <div className="rp-view" aria-hidden="true">
      <div className="rp-lens" style={{ transform: `scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)` }}>
      <div className="rp-canvas">
        {/* Whatever is in front. Before the icon is pressed nothing is open but
            Finder, which is always running -- naming the app that has not
            launched yet was the bar describing a window that was not there. */}
        <MenuBar app={!idle && phase(t, T.windowIn) > 0.5 ? 'ChatGPT' : 'Finder'} clock="Fri Sep 12  2:59 AM" />
        {/* The app opens when the icon is pressed, not before. Lifting the
            window into a shared component dropped its entrance: it was drawn
            from the first frame, so the pointer was still walking to a dock
            whose app was already open.

            Never a component called `Window`, either: delete its definition
            and the name does not go undefined, it quietly resolves to the
            DOM's own global and React tries to construct it. */}
        <div
          className="rp-app-window"
          style={{
            opacity: idle ? 0 : phase(t, T.windowIn) * fade,
            transform: `scale(${0.965 + phase(t, T.windowIn) * 0.035})`,
          }}
        >
          <CodexWindow
            title="Install tdoc and connect account"
            typing={!idle && phase(t, T.paste) > 0 && !after(t, T.send) ? prompt : null}
          >
            <ConnectTurns t={t} prompt={prompt} />
          </CodexWindow>
        </div>
        {idle ? null : <ApprovalSheet t={t} />}
        <Dock t={t} wake={idle ? 1 : undefined} launch={!idle} />
        {idle ? null : <Cursor t={t} />}
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
  { p: 0, s: 0.85, x: 320, y: 360 },
  { p: 0.42, s: 0.85, x: 320, y: 360 },
  { p: 0.58, s: 0.85, x: 320, y: 360 },
  { p: 0.82, s: 0.85, x: 320, y: 360 },
  { p: 1, s: 0.85, x: 320, y: 360 },
];
const docShots = (total) => DOC_FRAMES.map((f) => ({ at: Math.round(f.p * total), s: f.s, x: f.x, y: f.y }));

function DocTurns({ t, s, prompt, slug }) {
  const url = `https://tdoc.dev/d/${slug}`;
  const typed = Math.round(phase(t, s.type) * prompt.length);
  const sent = after(t, s.send);
  const pub = phase(t, s.published);
  const doc = phase(t, s.doc);
  if (!sent) {
    return (
      <>
        <Stamp>Today 3:04 AM</Stamp>
        {typed > 0 ? <Ask caret>{prompt.slice(0, typed)}</Ask> : null}
      </>
    );
  }
  return (
    <>
      <Stamp>Today 3:04 AM</Stamp>
      <Ask>{prompt}</Ask>
      {after(t, s.working) ? (
        <Worked label={workedLabel(t, s.working)} open={pub > 0}>
          {`[tdoc] Published v1 — ${url}`}
        </Worked>
      ) : null}
      {doc > 0 ? (
        <>
          <Answer>
            <p>Published. Your first tdoc is live.</p>
            <p><a href="#">{url}</a></p>
            <ul>
              <li>Anyone with the link can read it</li>
              <li>Comments are open to you</li>
            </ul>
          </Answer>
          <Feedback />
        </>
      ) : null}
    </>
  );
}

// The slug travels with the line, because the two are the same take: a
// recording of publishing THIS doc. Hard-coding one meant the person typed
// "trip" on the left and watched a doc about standups get published on the
// right -- the one thing a 1:1 replay must never do is show something that
// did not follow from what they just did.
export function DocReplay({ prompt, slug }) {
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
          <MenuBar app="ChatGPT" clock="Fri Sep 12  3:04 AM" />
          <div className="rp-app-window" style={{ opacity: 1 - phase(t, s.fade) }}>
            <CodexWindow title="Make a tdoc">
              <DocTurns t={t} s={s} prompt={line} slug={slug} />
            </CodexWindow>
          </div>
          <Dock t={t} wake={1} launch={false} />
        </div>
      </div>
    </div>
  );
}
