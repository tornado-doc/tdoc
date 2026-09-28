import React, { useEffect, useRef, useState } from 'react';
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
    const id = requestAnimationFrame(() => { for (const frame of Object.values(refs.current)) send(frame, {type:'motion'}); });
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

export function VersionDiffView({ config, theme, narrow, onClose }) {
  const after = Number(config.version);
  const before = Math.max(0, after - 1);
  return <main className="tdoc-version-diff" aria-label="Version changes">
    <div className="tdoc-diff-heading">
      <strong>{before ? `v${after} · Changes from v${before}` : `v${after} · First version`}</strong>
      <button type="button" onClick={onClose}>Back to document</button>
    </div>
    <ComparisonFrames key={`${before}:${after}:${narrow}`} slug={config.slug} before={before} after={after} narrow={narrow} theme={theme} />
  </main>;
}
