import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, X } from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import './version-diff.css';

const empty = { units: [], styles: '', duration: 0, animationCount: 0, unsupported: false };
const send = (frame, data) => frame?.contentWindow?.postMessage({ source: 'tdoc-compare-shell', ...data }, '*');

function ComparisonFrames({ slug, before, after, narrow, theme }) {
  const refs = useRef({});
  const models = useRef(before ? {} : { before: empty });
  const applied = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [motion, setMotion] = useState({ duration: 0, unsupported: false });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [motionPreview, setMotionPreview] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setError('A version could not be loaded. It may be unavailable or you may not have access. Open the version directly to check.'), 20000);
    const receive = (event) => {
      const side = ['before', 'after'].find((key) => refs.current[key]?.contentWindow === event.source);
      const message = event.data;
      if (!side || !message || message.source !== 'tdoc-compare') return;
      if (message.type === 'scroll' && applied.current && before && Number.isFinite(message.position)) {
        send(refs.current[side === 'before' ? 'after' : 'before'], {type:'scroll', position:message.position});
        return;
      }
      if (message.type === 'previous' && before) {
        location.href = `/d/${encodeURIComponent(slug)}/v/${before}${message.anchor ? '#' + encodeURIComponent(message.anchor) : ''}`;
        return;
      }
      if (message.type === 'error') { clearTimeout(timeout); setError(message.message); return; }
      if (message.type === 'result') {
        if (side === 'after') setResult(message);
        return;
      }
      if (message.type !== 'snapshot' || !Array.isArray(message.model?.units)) return;
      models.current[side] = message.model;
      const a = models.current.before, b = models.current.after;
      if (!a || !b || applied.current) return;
      applied.current = true;
      clearTimeout(timeout);
      setReady(true);
      setMotion({ duration: Math.max(a.duration || 0, b.duration || 0), unsupported: Boolean(a.unsupported || b.unsupported), limited:Boolean(a.limited || b.limited), external:Boolean(a.external || b.external) });
      if (before) send(refs.current.before, { type: 'apply', peer: b, side: 'before' });
      send(refs.current.after, { type: 'apply', peer: a, side: 'after', inline: narrow });
    };
    window.addEventListener('message', receive);
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [before, narrow, slug]);

  useEffect(() => {
    for (const frame of Object.values(refs.current)) {
      frame?.contentWindow?.postMessage({ source: 'tdoc-shell', type: 'tdoc:theme', theme }, '*');
    }
  }, [theme]);

  useEffect(() => {
    for (const frame of Object.values(refs.current)) send(frame, { type: 'time', time });
  }, [time]);

  useEffect(() => {
    if (!playing) return undefined;
    let id, last = performance.now();
    const tick = (now) => {
      const elapsed = (now - last) / 1000;
      last = now;
      setTime((current) => Math.min(motion.duration, current + elapsed));
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, motion.duration]);
  useEffect(() => { if (time >= motion.duration) setPlaying(false); }, [time, motion.duration]);

  useEffect(() => {
    if (!motionPreview) return;
    const id = requestAnimationFrame(() => send(refs.current.after, {type:'motion'}));
    return () => cancelAnimationFrame(id);
  }, [motionPreview]);

  const src = (n) => `/d/${encodeURIComponent(slug)}/v/${n}/frame?tdoc_compare=1`;
  const init = (side) => {
    const frame = refs.current[side];
    frame?.contentWindow?.postMessage({ source: 'tdoc-shell', type: 'tdoc:theme', theme }, '*');
    send(frame, { type: 'snapshot' });
  };
  return <>
    {!ready && !error ? <p role="status">Loading versions…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result && !error ? <p className="tdoc-diff-summary ui-sr-only" role="status">{result.count ? `${result.count} changed blocks` : 'No text or markup changes detected'}</p> : null}
    <div className={`tdoc-diff-frames${narrow ? ' is-narrow' : ''}${!before ? ' is-first' : ''}${motionPreview ? ' is-motion' : ''}`}>
      <section className="tdoc-diff-pane is-before" aria-hidden={!before || (narrow && !motionPreview)} inert={!before || (narrow && !motionPreview)}>
        <div className="tdoc-diff-pane-label">{before ? `v${before} · Before` : 'First version'}</div>
        {before ? <iframe ref={(node) => { refs.current.before = node; }} aria-label="Previous version" sandbox="allow-scripts" src={src(before)} onLoad={() => init('before')} /> : <p className="tdoc-diff-empty">All content is shown as added.</p>}
      </section>
      <section className="tdoc-diff-pane is-after">
        <div className="tdoc-diff-pane-label">v{after} · After</div>
        <iframe ref={(node) => { refs.current.after = node; }} aria-label="New version" sandbox="allow-scripts" src={src(after)} onLoad={() => init('after')} />
      </section>
    </div>
    {motion.duration > 0 && ready ? <div className="tdoc-diff-motion">
      <button type="button" onClick={() => { if (time >= motion.duration) setTime(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play together'}</button>
      <button type="button" onClick={() => setMotionPreview(!motionPreview)}>{motionPreview ? 'Back to changes' : 'Show animation'}</button>
      <label>Shared time <output>{time.toFixed(2)} / {motion.duration.toFixed(2)}s</output>
        <input type="range" aria-label="Shared animation time" min="0" max={motion.duration} step="0.01" value={time} onChange={(e) => { setPlaying(false); setTime(Number(e.target.value)); }} />
      </label>
    </div> : null}
    {result?.styleChanged && before ? <p className="muted tdoc-diff-note">Document styles also changed. <a href={`/d/${encodeURIComponent(slug)}/v/${before}`}>View previous version</a></p> : null}
    {ready && motion.unsupported ? <p className="muted tdoc-diff-note">Embedded widgets, video, SMIL or unbounded animations cannot be precisely synchronized. Their appearance is a before/after reference, not a frame-accurate diff.</p> : null}
    {ready && motion.limited ? <p className="muted tdoc-diff-note">The shared timeline covers the first 120 seconds.</p> : null}
    {ready && motion.external ? <p className="muted tdoc-diff-note">Linked assets are rendered from each version’s URLs. Changes inside those files are not inferred from HTML; shared external URLs may show their current content in both versions.</p> : null}
  </>;
}

// The pair a comparison shows. Unknown or out-of-order numbers fall back to
// the viewed version and the one before it, so a stale link still opens.
export function comparisonPair(config, requested = {}) {
  const current = Number(config.version);
  const known = (config.versions || []).map((v) => Number(v.n)).filter((n) => n > 0);
  const versions = [...new Set([...known, current])].sort((a, b) => a - b);
  const to = versions.includes(Number(requested.to)) ? Number(requested.to) : current;
  const older = versions.filter((n) => n < to);
  const from = older.includes(Number(requested.from)) ? Number(requested.from)
    : older.length ? older[older.length - 1]
      : versions.length > 1 ? 0 : Math.max(0, to - 1);
  return { from, to, versions };
}

function VersionPicker({ label, value, options, onPick }) {
  const name = (n) => (n ? `v${n}` : 'Empty');
  if (options.length < 2) return <span className="tdoc-diff-version is-fixed">{name(value)}</span>;
  return <AppMenu align="start" trigger={(
    <button type="button" className="tdoc-diff-version" aria-label={`${label}: ${name(value)}`}>
      {name(value)}<ChevronDown size={12} aria-hidden="true" />
    </button>
  )}>
    {options.map((n) => <AppMenuItem key={n} className={`tdoc-version-item${n === value ? ' current' : ''}`} onClick={() => onPick(n)}>
      {name(n)}
    </AppMenuItem>)}
  </AppMenu>;
}

export function VersionDiffView({ config, theme, narrow, pair, onPick, onClose }) {
  const { from: before, to: after, versions } = comparisonPair(config, pair);
  const hasEmpty = versions.length > 1;
  const olderOptions = versions.filter((n) => n < after);
  const fromOptions = olderOptions.length ? olderOptions : (hasEmpty ? [0] : [before]);
  useEffect(() => {
    // An open picker owns Escape; otherwise it is the way out.
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.ui-menu-popup')) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <main className="tdoc-version-diff" aria-label="Version changes">
    <div className="tdoc-diff-heading">
      <div className="tdoc-diff-pair" role="group" aria-label="Versions to compare">
        <span className="tdoc-diff-pair-label">Compare</span>
        <VersionPicker label="Older version" value={before} options={fromOptions} onPick={(n) => onPick(comparisonPair(config, { from: n, to: after }))} />
        <ArrowRight size={14} aria-hidden="true" />
        <VersionPicker label="Newer version" value={after} options={versions} onPick={(n) => onPick(comparisonPair(config, { from: before && before < n ? before : null, to: n }))} />
      </div>
      <button type="button" className="tdoc-diff-close" aria-label="Back to document" title="Back to document (Esc)" onClick={onClose}>
        <X size={16} aria-hidden="true" /><span>Back to document</span>
      </button>
    </div>
    <ComparisonFrames key={`${before}:${after}:${narrow}`} slug={config.slug} before={before} after={after} narrow={narrow} theme={theme} />
  </main>;
}
