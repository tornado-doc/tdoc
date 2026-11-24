import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { Bookmark, CodeXml, MessageSquarePlus, MousePointerClick } from 'lucide-react';
import { AppButton } from './ui/button.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import { AppSelect } from './ui/select.jsx';
import { isFeatureOn } from './feature-flags.js';
import './docs-hub.css';
import './feedback-pages.css';

// /feedback — where the bookmarklet is picked up, and the one-line install
// is shown. The bookmarklet is a plain bookmark whose address is script:
// clicking it drops /feedback.js into whatever page is open. The worker
// builds that address (it is code, and our origin goes into it); this page
// only shows it.
//
// It was a page of its own, with a bar of its own: a letter for an avatar, no
// account menu, the favicon for a logo. It is an app page now, under the same
// top bar as every other one.

// The coach's handwriting. Only this page uses it, so it loads here rather
// than in every page's stylesheet.
export function useHandFont() {
  useEffect(() => {
    if (document.getElementById('tdoc-hand-font')) return;
    const link = document.createElement('link');
    link.id = 'tdoc-hand-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap';
    document.head.appendChild(link);
  }, []);
}

// Copy with a fallback that works off a secure context, and when both fail
// the snippet is selected so ⌘C finishes the job (#793).
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function copySnippet(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

export function CodeCopy({ code }) {
  const preRef = useRef(null);
  const [state, setState] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copySnippet(preRef.current ? preRef.current.textContent : code);
    setState(ok ? 'copied' : 'failed');
    if (!ok && preRef.current) {
      const range = document.createRange();
      range.selectNodeContents(preRef.current);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(''), 1600);
  };
  return (
    <div className="code-copy">
      <pre ref={preRef}><code>{code}</code></pre>
      {/* The one Copy control; this page keeps its own copy (with the ⌘C
          fallback), so the button is controlled. */}
      <CopyPromptButton
        className={`copy-btn${state ? ` ${state}` : ''}`}
        aria-label="Copy code"
        label="Copy"
        copied={Boolean(state)}
        copiedLabel={state === 'failed' ? 'Press ⌘C' : 'Copied'}
        showTick={state === 'copied'}
        onCopy={copy}
      />
    </div>
  );
}

export function Bookmarklet({ href, className = 'bookmarklet', onTeach = null, linkRef = null, id }) {
  // React 19 swaps a javascript: href it renders for one that throws, so the
  // address is set on the element itself. A bookmark dragged from here
  // carries it.
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('href', href);
    if (linkRef) linkRef.current = el;
  }, [href, linkRef]);
  return (
    <a
      ref={ref}
      id={id}
      className={className}
      title="Drag me to the bookmarks bar"
      draggable="true"
      onClick={(event) => { event.preventDefault(); onTeach?.(); }}
      onDragStart={() => onTeach?.()}
    >
      🌪️ tdoc
    </a>
  );
}

export function Coach({ open, target, onClose, numbered = true }) {
  const [d, setD] = useState('');
  const place = useCallback(() => {
    const btn = target.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const x1 = r.left + r.width / 2;
    const y1 = r.top + 4;
    const x2 = Math.min(Math.max(window.innerWidth / 2, 48), window.innerWidth - 48);
    const y2 = 10;
    const c1x = x1;
    const c1y = Math.max(y2 + 40, y1 - (y1 - y2) * 0.55);
    const c2x = x2 + (x1 < x2 ? -36 : 36);
    const c2y = y2 + Math.max(48, (y1 - y2) * 0.35);
    setD(`M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`);
  }, [target]);
  useEffect(() => {
    if (!open) return undefined;
    place();
    const key = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('resize', place);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('keydown', key); };
  }, [open, place, onClose]);
  if (!open) return null;
  return (
    <div id="coach" className="coach">
      <div className="coach-frost" onClick={onClose} />
      <svg className="coach-curve" aria-hidden="true">
        <defs>
          <marker id="coachHead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0 0 L7 4 L0 8 Z" fill="#1652f0" />
          </marker>
        </defs>
        <path d={d} fill="none" stroke="#1652f0" strokeWidth="2" strokeLinecap="round" markerEnd="url(#coachHead)" />
      </svg>
      <p className="coach-copy">
        <span className="line">{numbered ? <span className="n">2</span> : null}Drag onto the bookmarks bar ↑</span>
        <span className="line">{numbered ? <span className="n">3</span> : null}No bar? ⌘⇧B · Fullscreen top bar? ⌘⇧F</span>
      </p>
    </div>
  );
}

// The browser window with the real bookmark in it, to drag onto the bar
// (here and on an invite's page, feedback-invite.jsx).
export function BookmarkDemo({ bookmarklet, omnibox, coaching, pillRef, onTeach, hint = '1 · Click Me!' }) {
  return (
    <div className="demo" id="demo">
      <div className="demo-titlebar">
        <div className="demo-dots" aria-hidden="true"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="demo-omnibox">{omnibox}</div>
      </div>
      <div className="demo-bookmarks">
        <span className="demo-bm">Docs</span>
        <span className="demo-bm">GitHub</span>
        <span className="demo-slot" aria-hidden="true" />
      </div>
      <div className="demo-page">
        <span className="demo-ghost" aria-hidden="true">🌪️ tdoc</span>
        <Bookmarklet id="bookmarklet" href={bookmarklet} className={coaching ? 'bookmarklet' : 'bookmarklet demo-fly'} linkRef={pillRef} onTeach={onTeach} />
        <span className="step-1" aria-hidden="true">{hint}</span>
      </div>
    </div>
  );
}

// The SDK's setup guide: the npm and React forms, CSP and COOP.
export const FEEDBACK_SDK_GUIDE = 'https://github.com/tornado-doc/tdoc/tree/main/packages/feedback#readme';
// What to ask an agent with tdoc connected: it calls create_feedback_space
// and adds the line to the site (the MCP server's own instructions).
export const FEEDBACK_SDK_PROMPT = 'Add tdoc feedback to my site';
export const FEEDBACK_SDK_PLACEHOLDER = 'YOUR_SPACE_ID';
export const feedbackSdkLine = (scriptSrc, space) => `<script src="${scriptSrc}" data-tdoc-space="${space || FEEDBACK_SDK_PLACEHOLDER}" async></script>`;

// The SDK's picture, drawn like the bookmark's browser window: someone's
// own site with the widget's resting button in its corner (the same round
// white button and icon feedback.js draws) and one comment pinned on it.
export function SiteDemo({ omnibox = 'app.example.com', animated = false }) {
  return (
    <div className={`demo site-demo${animated ? ' is-animated' : ''}`} aria-hidden="true">
      <div className="demo-titlebar">
        <div className="demo-dots"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="demo-omnibox">{omnibox}</div>
      </div>
      <div className="site-demo-page">
        <div className="site-demo-nav"><i className="logo" /><i /><i /><i /></div>
        <div className="site-demo-body">
          <i className="h" /><i className="l" /><i className="l short" />
          <span className="site-demo-target">Start free trial<span className="site-demo-pin">1</span></span>
        </div>
        <div className="site-demo-note">
          <b>Ana</b> This button is hard to find on a phone
          {/* commentsSitesTabs: the loop ends with the agent's fix. */}
          {animated ? <span className="site-demo-fix">✓ Agent: made it blue and moved it up</span> : null}
        </div>
        <span className="site-demo-fab"><MessageSquarePlus aria-hidden="true" /></span>
      </div>
    </div>
  );
}

// The loop the animated demo plays, named under it: each step lights up in
// turn with the picture.
export function SiteDemoSteps() {
  return (
    <p className="site-demo-steps" aria-hidden="true"><span>1 Select</span><span>2 Comment</span><span>3 Agent fixes</span></p>
  );
}

// The SDK's two ways in, the same block on /feedback and on an empty Sites
// tab (commentsSitesTabs): ask your agent, or paste the one line. `space`
// fills in the line's space id; with more than one, `onPick` chooses it.
// `arrive` adds the third step /feedback ends on.
export function SdkSteps({ scriptSrc, space = null, spaces = [], onPick = null, arrive = true }) {
  return (
    <ol className="fb-steps">
      <li className="fb-step" id="sdk-ask">
        <h3>Ask your agent</h3>
        <div className="fb-prompt">
          <q>{FEEDBACK_SDK_PROMPT}</q>
          <CopyPromptButton text={FEEDBACK_SDK_PROMPT} label="Copy prompt" variant="primary" size="m" />
        </div>
        <p className="muted">With tdoc connected, it makes your site’s feedback space and adds the line.</p>
      </li>
      <li className="fb-step" id="sdk-paste">
        <h3>Or paste one line before <code>&lt;/head&gt;</code></h3>
        {spaces.length > 1 && onPick ? (
          <div className="fb-space-pick">
            <AppSelect
              ariaLabel="Feedback space"
              value={space.slug}
              onChange={onPick}
              options={spaces.map((s) => ({ value: s.slug, label: s.site.origins.map(hostOf).join(', ') }))}
            />
          </div>
        ) : null}
        <CodeCopy code={feedbackSdkLine(scriptSrc, space && space.slug)} />
        {space
          ? <p className="muted" id="sdk-space-note">Your space for {space.site.origins.map(hostOf).join(', ')}.</p>
          : <p className="muted" id="sdk-space-note">Your agent fills in <code>{FEEDBACK_SDK_PLACEHOLDER}</code> in step 1.</p>}
      </li>
      {arrive ? (
        <li className="fb-step" id="sdk-arrive">
          <h3>Comments arrive in your feedback space</h3>
          <p className="muted">Hand them to your agent from there. Private by default: everyone on the site sees the button, but only you and the people you invite (or your team) can comment, signed in to tdoc. Open it wider in Share.</p>
        </li>
      ) : null}
    </ol>
  );
}

// The viewer's own site spaces (signed in), so the one line can carry a
// real space id instead of the placeholder. Only spaces they own that are
// bound to a site (create_feedback_space, or Add to your site) qualify.
function useOwnSiteSpaces(identity) {
  const [spaces, setSpaces] = useState([]);
  useEffect(() => {
    if (!identity) return undefined;
    let live = true;
    fetch('/api/me/feedback', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live || !data || !Array.isArray(data.spaces)) return;
        setSpaces(data.spaces.filter((s) => s && s.mine && s.site && Array.isArray(s.site.origins) && s.site.origins.length));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [identity]);
  return spaces;
}

// Try it on this page: the real widget (feedback.js from this origin) in its
// demo mode, which feedback/src/demo.js allows only on this page of tdoc's
// own origin. No account, nothing posted: comments stay in this tab.
// A real widget already on the page (the bookmark clicked here) would post
// for real and sign in: the demo does not start then, and says why.
export const DEMO_BLOCKED = 'The tdoc widget is already on — this demo is off';
export function startFeedbackDemo() {
  if (window.tdocFeedback) {
    if (window.tdocFeedback.demo === true) { window.tdocFeedback.comment(); return true; }
    return false;
  }
  if (document.getElementById('tdoc-feedback-demo-script')) return true;
  const script = document.createElement('script');
  script.id = 'tdoc-feedback-demo-script';
  script.src = `${location.origin}/feedback.js`;
  script.async = true;
  script.setAttribute('data-tdoc-demo', '1');
  script.setAttribute('data-tdoc-open', '1');
  document.documentElement.appendChild(script);
  return true;
}

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return String(origin || ''); } };

export function FeedbackInstall({ boot }) {
  const { identity = null, bookmarklet, scriptSrc, host } = boot;
  const [coaching, setCoaching] = useState(false);
  const pill = useRef(null);
  useHandFont();
  const close = useCallback(() => setCoaching(false), []);
  const spaces = useOwnSiteSpaces(identity);
  const [picked, setPicked] = useState('');
  const space = spaces.find((s) => s.slug === picked) || spaces[0] || null;
  const [tryBlocked, setTryBlocked] = useState(false);
  const [sitesTabs] = useState(() => isFeatureOn('commentsSitesTabs'));
  const tryIt = useCallback(() => setTryBlocked(!startFeedbackDemo()), []);
  // /feedback#sdk (the homepage links there): the page renders after load,
  // so the browser's own jump to the fragment finds nothing. #try (the
  // homepage's Any web app) starts the demo too.
  useEffect(() => {
    const id = location.hash.slice(1);
    const el = id && document.getElementById(id);
    if (el) el.scrollIntoView();
    if (id === 'try' && el) setTryBlocked(!startFeedbackDemo());
  }, []);

  return (
    <div className={`tdoc-app docs-hub tdoc-feedback-page${coaching ? ' coaching' : ''}`}>
      <TopBar identity={identity} />
      <main className="fb-main">
        <h1>Comments on any web app</h1>
        <p className="fb-lead">Click anything on a page, say what is wrong, and hand it to a person or an agent.</p>
        <div className="fb-try" id="try">
          <AppButton variant="primary" size="m" id="try-demo" onClick={tryIt}><MousePointerClick size={16} aria-hidden="true" />Try it on this page</AppButton>
          <span className="muted" id="try-note" role="status">{tryBlocked ? DEMO_BLOCKED : 'No account. What you write stays in this tab.'}</span>
        </div>

        <nav className="fb-choices" id="add" aria-label="Two ways in">
          <a className="fb-choice" href="#bookmark" id="choose-bookmark">
            <span className="fb-choice-icon"><Bookmark aria-hidden="true" /></span>
            <span className="fb-choice-name">Bookmark</span>
            <span className="fb-choice-what">Quick feedback, no setup. Any site.</span>
          </a>
          <a className="fb-choice" href="#sdk" id="choose-sdk">
            <span className="fb-choice-icon"><CodeXml aria-hidden="true" /></span>
            <span className="fb-choice-name">SDK</span>
            <span className="fb-choice-what">Built into your own product. For your team, always on.</span>
          </a>
        </nav>
        <p className="fb-rule muted">Quick feedback, no setup → Bookmark. Feedback built into your product → SDK.</p>

        <section className="fb-path bookmark-path" id="bookmark">
          <h2>Bookmark</h2>
          <p className="fb-path-sub muted">Comment on any site yourself.</p>
          <p className="phone-only" id="phoneOnly"><strong>Desktop only for now.</strong> The bookmark lives in a desktop browser’s bookmarks bar: open this page on a computer to get it. For comments from a phone, add <a href="#sdk">the SDK</a> to your site.</p>
          <div className="install-desktop" id="installDesktop">
            <BookmarkDemo bookmarklet={bookmarklet} omnibox="localhost:3000" coaching={coaching} pillRef={pill} onTeach={() => setCoaching(true)} />
            <ol className="install-steps">
              <li><strong>Click Me!</strong> — that blue pill is the real bookmark</li>
              <li><strong>Drag it up</strong> onto the bookmarks bar at the top of the window</li>
              <li><strong>No bookmarks bar?</strong> Hit <kbd>⌘⇧B</kbd> — same in Chrome and Safari (Safari calls it the Favorites bar)</li>
            </ol>
            <p className="chrome-hint"><strong>Fullscreen?</strong> In Chrome, <kbd>⌘⇧F</kbd> keeps the top bar visible, or exit fullscreen, then drag.</p>
            <p className="muted step-after">Then open a site and click the bookmark. The first time, a small {host} window connects your account. Some production sites block outside scripts; local and preview builds usually don't.</p>
          </div>
          <p className="muted">Comments land in one thread per site on {host}. To review together, press <strong>Share</strong> on the site and send the invite link.</p>
        </section>

        <section className="fb-path script-path" id="sdk">
          <h2>SDK</h2>
          <p className="fb-path-sub muted">Feedback built into your own product.</p>
          <SiteDemo omnibox={space ? hostOf(space.site.origins[0]) : 'app.example.com'} animated={sitesTabs} />
          {sitesTabs ? <SiteDemoSteps /> : null}
          <SdkSteps scriptSrc={scriptSrc} space={space} spaces={spaces} onPick={setPicked} />
          <p className="fb-more muted">
            <a href={FEEDBACK_SDK_GUIDE} target="_blank" rel="noopener">npm, React and CSP guide →</a>
            {sitesTabs
              ? <span>Already using the bookmark there? Turn that space into the site’s own in <a href="/me?view=sites">My docs → Sites</a>.</span>
              : <span>Already using the bookmark there? Turn that space into the site’s own in <a href="/me?view=comments">My docs → Comments</a>.</span>}
          </p>
        </section>
      </main>
      <Coach open={coaching} target={pill} onClose={close} />
    </div>
  );
}
