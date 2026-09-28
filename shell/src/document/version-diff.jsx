import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import './version-diff.css';

const empty = { units: [], styles: '', duration: 0, animationCount: 0, unsupported: false };
const send = (frame, data) => frame?.contentWindow?.postMessage({ source: 'tdoc-compare-shell', ...data }, '*');

function ComparisonFrames({ slug, before, after, view, narrow, theme }) {
  const refs = useRef({});
  const models = useRef(before ? {} : { before: empty });
  const applied = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [motion, setMotion] = useState({ duration: 0, unsupported: false });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [changeIndex, setChangeIndex] = useState(-1);

  useEffect(() => {
    const timeout = setTimeout(() => setError('A version could not be loaded. It may be unavailable or you may not have access. Open the version directly to check.'), 20000);
    const receive = (event) => {
      const side = ['before', 'after'].find((key) => refs.current[key]?.contentWindow === event.source);
      const message = event.data;
      if (!side || !message || message.source !== 'tdoc-compare') return;
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
      if (view === 'changes') {
        if (before) send(refs.current.before, { type: 'apply', peer: b, side: 'before' });
        send(refs.current.after, { type: 'apply', peer: a, side: 'after', inline: narrow });
      }
    };
    window.addEventListener('message', receive);
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [before, view, narrow]);

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

  const src = (n) => `/d/${encodeURIComponent(slug)}/v/${n}/frame?tdoc_compare=1`;
  const init = (side) => {
    const frame = refs.current[side];
    frame?.contentWindow?.postMessage({ source: 'tdoc-shell', type: 'tdoc:theme', theme }, '*');
    send(frame, { type: 'snapshot' });
  };
  const navigate = (index) => {
    setChangeIndex(index);
    for (const frame of Object.values(refs.current)) send(frame, { type:'navigate', index });
  };
  return <>
    {!ready && !error ? <p role="status">Loading versions…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result && !error ? <div className="tdoc-diff-summary" role="status">
      {result.count ? `${result.count} changed ${result.count === 1 ? 'block' : 'blocks'}` : 'No text or markup changes detected'}
      {before && result.styleChanged ? ' · Document styles also changed; use Before / After to inspect.' : ''}
      <span><span className="tdoc-diff-legend-add">+ Added</span> · <span className="tdoc-diff-legend-delete">− Removed</span> · Changed outline</span>
      {result.count ? <div className="tdoc-diff-navigation">
        <button type="button" disabled={changeIndex <= 0} onClick={() => navigate(changeIndex-1)}>Previous change</button>
        <output>{changeIndex < 0 ? '—' : changeIndex+1} / {result.count}</output>
        <button type="button" disabled={changeIndex >= result.count-1} onClick={() => navigate(changeIndex+1)}>Next change</button>
      </div> : null}
    </div> : null}
    <div className={`tdoc-diff-frames is-${view}${narrow ? ' is-narrow' : ''}`}>
      <section className="tdoc-diff-pane is-before">
        <div className="tdoc-diff-pane-label">{before ? `v${before} · Before` : 'Empty document'}</div>
        {before ? <iframe ref={(node) => { refs.current.before = node; }} aria-label="Previous version" sandbox="allow-scripts" src={src(before)} onLoad={() => init('before')} /> : <p className="tdoc-diff-empty">All content is shown as added.</p>}
      </section>
      <section className="tdoc-diff-pane is-after">
        <div className="tdoc-diff-pane-label">v{after} · After</div>
        <iframe ref={(node) => { refs.current.after = node; }} aria-label="New version" sandbox="allow-scripts" src={src(after)} onLoad={() => init('after')} />
      </section>
    </div>
    {motion.duration > 0 && ready ? <div className="tdoc-diff-motion">
      <button type="button" onClick={() => { if (time >= motion.duration) setTime(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play together'}</button>
      <button type="button" onClick={() => { for (const frame of Object.values(refs.current)) send(frame,{type:'motion'}); }}>Show animation</button>
      <label>Shared time <output>{time.toFixed(2)} / {motion.duration.toFixed(2)}s</output>
        <input type="range" aria-label="Shared animation time" min="0" max={motion.duration} step="0.01" value={time} onChange={(e) => { setPlaying(false); setTime(Number(e.target.value)); }} />
      </label>
    </div> : null}
    {ready && motion.unsupported ? <p className="muted tdoc-diff-note">Embedded widgets, video, SMIL or unbounded animations cannot be precisely synchronized. Their appearance is a before/after reference, not a frame-accurate diff.</p> : null}
    {ready && motion.limited ? <p className="muted tdoc-diff-note">The shared timeline covers the first 120 seconds.</p> : null}
    {ready && motion.external ? <p className="muted tdoc-diff-note">Linked assets are rendered from each version’s URLs. Changes inside those files are not inferred from HTML; shared external URLs may show their current content in both versions.</p> : null}
  </>;
}

export function VersionDiffDialog({ config, theme, narrow, onClose }) {
  const versions = useMemo(() => [...new Set([...(config.versions || []).map((v) => Number(v.n)), Number(config.version)].filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b), [config.versions, config.version]);
  const [after, setAfter] = useState(Number(config.version));
  const previous = (n) => versions.filter((v) => v < n).at(-1) || 0;
  const [before, setBefore] = useState(() => previous(Number(config.version)));
  const [view, setView] = useState('changes');
  const [attempt, setAttempt] = useState(0);
  return <AppDialog open title="Compare versions" className="tdoc-version-diff-dialog" onOpenChange={(open) => { if (!open) onClose(); }}
    actions={<><button type="button" onClick={() => setAttempt((n) => n + 1)}>Reload</button><button type="button" onClick={onClose}>Close</button></>}>
    <div className="tdoc-diff-controls">
      <label>Before<select aria-label="Before version" value={before} onChange={(e) => setBefore(Number(e.target.value))}>
        <option value="0">Empty document</option>{versions.filter((v) => v < after).map((v) => <option key={v} value={v}>v{v}</option>)}
      </select></label>
      <label>After<select aria-label="After version" value={after} onChange={(e) => { const n = Number(e.target.value); setAfter(n); setBefore(previous(n)); }}>
        {versions.map((v) => <option key={v} value={v}>v{v}{v === Number(config.version) ? ' · viewing' : ''}</option>)}
      </select></label>
      <SegmentedControl value={view} onChange={setView} ariaLabel="Comparison view" options={[
        { value: 'changes', label: 'Changes' }, { value: 'both', label: 'Both' },
        { value: 'before', label: 'Before' }, { value: 'after', label: 'After' },
      ]} />
    </div>
    <ComparisonFrames key={`${before}:${after}:${view}:${narrow}:${attempt}`} slug={config.slug} before={before} after={after} view={view} narrow={narrow} theme={theme} />
    <p className="muted tdoc-diff-note">Published versions only. On mobile, Changes combines text and table edits; Both stacks the versions for visual or motion review.</p>
  </AppDialog>;
}
