import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
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
function useHandFont() {
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
      <button type="button" className={`copy-btn${state ? ` ${state}` : ''}`} aria-label="Copy code" onClick={copy}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : 'Copy'}
      </button>
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

function Coach({ open, target, onClose }) {
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
        <span className="line"><span className="n">2</span>Drag onto the bookmarks bar ↑</span>
        <span className="line"><span className="n">3</span>No bar? ⌘⇧B · Fullscreen top bar? ⌘⇧F</span>
      </p>
    </div>
  );
}

export function FeedbackInstall({ boot }) {
  const { identity = null, bookmarklet, scriptSrc, host } = boot;
  const [coaching, setCoaching] = useState(false);
  const pill = useRef(null);
  useHandFont();
  const close = useCallback(() => setCoaching(false), []);

  return (
    <div className={`tdoc-app docs-hub tdoc-feedback-page${coaching ? ' coaching' : ''}`}>
      <TopBar identity={identity} />
      <main className="fb-main">
        <h1>Leave feedback on your own app</h1>
        <p>Click anything in the app you are building, say what is wrong, and hand it to a person or an agent.</p>

        <p className="phone-only" id="phoneOnly"><strong>Desktop only for now.</strong> Setting this up needs a bookmarks bar (or editing your app’s HTML) — open this page on a computer.</p>

        <div className="install-desktop" id="installDesktop">
          <div className="bookmark-path" id="bookmarkPath">
            <h2>Drag a bookmark</h2>
            <p className="device-note muted">Desktop only — drag the pill onto your bookmarks bar.</p>
            <p className="chrome-hint"><strong>Fullscreen tip.</strong> In Chrome, <kbd>⌘⇧F</kbd> keeps the top bar visible in fullscreen so the bookmarks bar has somewhere to live — or exit fullscreen, then drag.</p>
            <div className="demo" id="demo">
              <div className="demo-titlebar">
                <div className="demo-dots" aria-hidden="true"><i className="r" /><i className="y" /><i className="g" /></div>
                <div className="demo-omnibox">localhost:3000</div>
              </div>
              <div className="demo-bookmarks">
                <span className="demo-bm">Docs</span>
                <span className="demo-bm">GitHub</span>
                <span className="demo-slot" aria-hidden="true" />
              </div>
              <div className="demo-page">
                <span className="demo-ghost" aria-hidden="true">🌪️ tdoc</span>
                <Bookmarklet id="bookmarklet" href={bookmarklet} className={coaching ? 'bookmarklet' : 'bookmarklet demo-fly'} linkRef={pill} onTeach={() => setCoaching(true)} />
                <span className="step-1" aria-hidden="true">1 · Click Me!</span>
              </div>
            </div>
            <ol className="install-steps">
              <li><strong>Click Me!</strong> — that blue pill is the real bookmark</li>
              <li><strong>Drag it up</strong> onto the bookmarks bar at the top of the window</li>
              <li><strong>No bookmarks bar?</strong> Hit <kbd>⌘⇧B</kbd> — same in Chrome and Safari (Safari calls it the Favorites bar)</li>
            </ol>
            <p className="muted step-after">After that, open your app and click the bookmark. First time opens a small {host} window to connect your account. Some production sites block outside scripts; local and preview builds generally don't.</p>
          </div>

          <div className="script-path" id="scriptPath">
            <h2>Or one line in the app</h2>
            <p>Add this once in your HTML (dev and preview builds). Anyone who opens that build — including on a phone — gets the comment button. You still add the line from a computer.</p>
            <CodeCopy code={`<script src="${scriptSrc}"></script>`} />
          </div>
        </div>

        <h2>Where it goes</h2>
        <p>Comments land in one shared thread on {host}, named after your app and created the first time you connect. To give feedback together, press <strong>Share</strong> in the app and send the invite link — teammates who open it join the same thread instead of starting their own.</p>
      </main>
      <Coach open={coaching} target={pill} onClose={close} />
    </div>
  );
}
