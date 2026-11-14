import React, { useEffect, useRef, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';

// Write with tdoc AI (New -> Doc, flag writeWithTdocAi): one sentence, and
// tdoc AI drafts the doc and publishes it as v1, private. The sibling of
// "Write it with your agent" (AgentRecipe) and dressed the same way -- the
// subject field, the foot line -- so the two read as two answers to one
// question, not two features.
//
// Live: the request asks for server-sent events, so the draft appears in the
// dialog as tdoc AI writes it (WriteAiDraft), set like the doc it will be.
// When the server has stored v1 it says so and the dialog opens it. The text
// is rendered as React text nodes only (draftBlocks below): nothing the model
// writes is ever HTML here, as nothing it writes is HTML on the stored page
// (the server escapes it). Stop ends the request; the server gives the draft
// back to the allowance and keeps nothing.

export const WRITE_AI_PROMPT_CHARS = 500;

function seconds(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function writeAiErrorText(status, body) {
  if (body?.message) return body.message;
  if (status === 401) return 'Sign in to write with tdoc AI.';
  if (status === 429) return 'Too many drafts at once. Try again in a few minutes.';
  if (status === 503) return 'tdoc AI is not available right now.';
  return 'tdoc AI could not write it this time. Try again.';
}

// One POST that streams. Returns { ok, status, body } like the JSON answer
// it falls back to: an error the server gives before the model runs (sign-in,
// limit, allowance) is plain JSON; after that, `delta` events go to onDelta
// and the last event is `done` or `error`.
export async function writeWithAi(prompt, team = '', { onDelta = () => {}, signal } = {}) {
  const r = await fetch('/api/write-with-ai', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(team ? { prompt, team } : { prompt }),
    signal,
  });
  if (!(r.headers.get('content-type') || '').includes('text/event-stream') || !r.body) {
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok && body && body.ok, status: r.status, body };
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buf += decoder.decode(step.value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const event = (block.match(/^event: ?(.*)$/m) || [])[1];
      const data = (block.match(/^data: ?(.*)$/m) || [])[1];
      if (!event || data == null) continue;
      let body = null;
      try { body = JSON.parse(data); } catch { continue; }
      if (event === 'delta' && typeof body.text === 'string') onDelta(body.text);
      else if (event === 'done') return { ok: Boolean(body.ok), status: 200, body };
      else if (event === 'error') return { ok: false, status: body.status || 502, body };
    }
  }
  return { ok: false, status: 0, body: {} };
}

// ---- the draft, as it arrives -------------------------------------------
// A small Markdown reader for the live view: headings, paragraphs, lists,
// quotes, fenced code and tables, with bold, italics, inline code and link
// labels inside. It returns plain data; WriteAiDraft maps it to React
// elements whose text React escapes. Links are shown as their label only:
// the live view is read, not clicked, and the stored doc has the real links.

// The model may wrap the whole answer in one fence; the server unwraps it,
// and so does the live view, on the way in.
export function draftMarkdown(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n').replace(/^\s*```(?:markdown|md)?[ \t]*\n/i, '');
  if (t !== String(text || '').replace(/\r\n?/g, '\n')) t = t.replace(/\n```\s*$/, '');
  return t;
}

const INLINE = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\[([^\]\n]+)\]\([^)\s]*\)|\*([^*\n]+)\*|_([^_\n]+)_)/g;
export function draftInline(text) {
  const out = [];
  let last = 0;
  let m;
  INLINE.lastIndex = 0;
  const source = String(text || '');
  while ((m = INLINE.exec(source))) {
    if (m.index > last) out.push({ t: 'text', v: source.slice(last, m.index) });
    if (m[2] != null || m[3] != null) out.push({ t: 'strong', v: m[2] ?? m[3] });
    else if (m[4] != null) out.push({ t: 'code', v: m[4] });
    else if (m[5] != null) out.push({ t: 'link', v: m[5] });
    else out.push({ t: 'em', v: m[6] ?? m[7] });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ t: 'text', v: source.slice(last) });
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
export function draftBlocks(markdown) {
  const lines = draftMarkdown(markdown).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = line.match(/^\s*```/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { blocks.push({ t: 'h', level: h[1].length, v: draftInline(h[2]) }); i += 1; continue; }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(cells(lines[i]).map(draftInline));
        i += 1;
      }
      blocks.push({ t: 'table', head: rows[0] || [], rows: rows.slice(1) });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/;
    if (li.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && li.test(lines[i])) { items.push(draftInline(lines[i].replace(li, ''))); i += 1; }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({ t: 'quote', v: draftInline(body.join(' ')) });
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { blocks.push({ t: 'hr' }); i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) { para.push(lines[i].trim()); i += 1; }
    blocks.push({ t: 'p', v: draftInline(para.join(' ')) });
  }
  return blocks;
}

function Inline({ nodes }) {
  return (nodes || []).map((n, i) => {
    if (n.t === 'strong') return <strong key={i}>{n.v}</strong>;
    if (n.t === 'em') return <em key={i}>{n.v}</em>;
    if (n.t === 'code') return <code key={i}>{n.v}</code>;
    if (n.t === 'link') return <span key={i} className="mk-write-link">{n.v}</span>;
    return <React.Fragment key={i}>{n.v}</React.Fragment>;
  });
}

export function WriteAiDraft({ markdown, live }) {
  const ref = useRef(null);
  const pinned = useRef(true);
  const blocks = draftBlocks(markdown);
  // Follow the end while the reader is at it; scrolling up to reread stops
  // following until they come back down.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [markdown]);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <div ref={ref} className="mk-write-paper" onScroll={onScroll} aria-busy={live ? 'true' : 'false'}>
      <article className="mk-write-doc">
        {blocks.map((b, i) => {
          if (b.t === 'h') {
            const Tag = `h${Math.min(4, b.level)}`;
            return <Tag key={i}><Inline nodes={b.v} /></Tag>;
          }
          if (b.t === 'p') return <p key={i}><Inline nodes={b.v} /></p>;
          if (b.t === 'quote') return <blockquote key={i}><Inline nodes={b.v} /></blockquote>;
          if (b.t === 'pre') return <pre key={i}><code>{b.v}</code></pre>;
          if (b.t === 'hr') return <hr key={i} />;
          if (b.t === 'list') {
            const Tag = b.ordered ? 'ol' : 'ul';
            return <Tag key={i}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</Tag>;
          }
          if (b.t === 'table') {
            return (
              <div key={i} className="mk-write-table">
                <table>
                  <thead><tr>{b.head.map((c, j) => <th key={j}><Inline nodes={c} /></th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline nodes={c} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          }
          return null;
        })}
        {live ? <span className="mk-write-caret" aria-hidden="true" /> : null}
      </article>
    </div>
  );
}

function words(markdown) {
  const t = draftMarkdown(markdown).replace(/[#>*_`|-]/g, ' ').trim();
  if (!t) return 0;
  // CJK has no spaces: count its characters as words.
  const cjk = (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  const rest = t.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + rest;
}

export function WriteWithAiDialog({ team = '', onClose, navigate = (url) => { location.href = url; } }) {
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | writing | opening
  const [error, setError] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [units, setUnits] = useState(1);
  const [draft, setDraft] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    fetch('/api/write-with-ai', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!live || !body) return;
        if (Number.isInteger(body.remaining)) setRemaining(body.remaining);
        if (Number.isInteger(body.units) && body.units > 0) setUnits(body.units);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (phase !== 'writing') return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);
  // Leaving the dialog any way at all ends the request.
  useEffect(() => () => abortRef.current?.abort(), []);

  const trimmed = prompt.trim();
  const busy = phase !== 'idle';
  const tooLong = [...trimmed].length > WRITE_AI_PROMPT_CHARS;
  const out = Number.isInteger(remaining) && remaining < units;
  const showDraft = busy || (error && draft);

  const submit = async () => {
    if (!trimmed || busy || tooLong) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setError(null);
    setDraft('');
    setStartedAt(Date.now());
    setNow(Date.now());
    setPhase('writing');
    const result = await writeWithAi(trimmed, team, {
      signal: ctl.signal,
      onDelta: (text) => setDraft((d) => d + text),
    }).catch((e) => ({ ok: false, status: 0, body: {}, stopped: e && e.name === 'AbortError' }));
    abortRef.current = null;
    if (result.ok) {
      setPhase('opening');
      if (Number.isInteger(result.body.remaining)) setRemaining(result.body.remaining);
      navigate(result.body.url || `/d/${encodeURIComponent(result.body.slug)}`);
      return;
    }
    if (result.body?.error === 'ask_limit' && Number.isInteger(result.body.remaining)) setRemaining(result.body.remaining);
    setError(result.stopped
      ? { text: 'Stopped. Nothing was saved, and the request was not charged.' }
      : { text: writeAiErrorText(result.status, result.body), connect: result.body?.error === 'ask_limit' });
    setPhase('idle');
  };
  const stop = () => abortRef.current?.abort();

  const count = words(draft);
  const status = phase === 'writing'
    ? `${draft ? 'Writing' : 'Starting'} · ${seconds(now - startedAt)}${count ? ` · ${count} ${count === 1 ? 'word' : 'words'}` : ''}`
    : phase === 'opening' ? 'Published v1 · Opening the doc…' : '';

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title="Write it with tdoc AI"
      className={showDraft ? 'mk-write-live' : ''}
      actions={(
        <>
          {phase === 'writing'
            ? <AppButton onClick={stop}>Stop</AppButton>
            : <AppButton onClick={onClose} disabled={busy}>Cancel</AppButton>}
          <AppButton variant="primary" className="primary" onClick={submit} disabled={!trimmed || busy || tooLong || out}>
            {busy ? 'Writing…' : error && draft ? 'Try again' : 'Write it'}
          </AppButton>
        </>
      )}
    >
      <div className="mk-agent mk-write-ai">
        <label className="mk-subject">
          <span className="mk-sr">What the doc is about, in one sentence</span>
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            disabled={busy}
            placeholder="A packing list for a week of hiking in Iceland"
            onChange={(event) => { setPrompt(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </label>
        {showDraft ? <WriteAiDraft markdown={draft} live={phase === 'writing'} /> : null}
        {status ? <p className="mk-foot mk-write-status" role="status" aria-live="polite">{status}</p> : null}
        {error ? (
          <p className="mk-foot mk-write-error" role="alert">
            {error.text}
            {error.connect ? <> <a href="/start">Connect your agent</a></> : null}
          </p>
        ) : null}
        {!status && !error ? (
          <p className="mk-foot">
            {tooLong
              ? `Keep it to one sentence (${WRITE_AI_PROMPT_CHARS} characters at most).`
              : out
                ? <>{remaining > 0 ? `A draft uses ${units} free tdoc AI requests and you have ${remaining} left. ` : 'You have used your free tdoc AI requests. '}<a href="/start">Connect your agent</a> to keep writing.</>
                : `tdoc AI writes it here as you watch, then publishes it, private to you.${Number.isInteger(remaining) ? ` A draft uses ${units} of your ${remaining} free ${remaining === 1 ? 'request' : 'requests'}.` : ''}`}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
