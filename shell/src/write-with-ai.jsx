import React, { useEffect, useRef, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';

// Write with tdoc AI (New -> Doc, flag writeWithTdocAi): one sentence, and
// tdoc AI drafts the doc and publishes it as v1, private. The sibling of
// "Write it with your agent" (AgentRecipe) and dressed the same way -- the
// subject field, the foot line -- so the two read as two answers to one
// question, not two features.
//
// Progress is honest: the server writes and publishes in one request, so the
// dialog says "Writing the draft" with the seconds it has taken, then
// "Opening the doc" once v1 exists. There are no fake intermediate steps.

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

export async function writeWithAi(prompt, team = '') {
  const r = await fetch('/api/write-with-ai', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(team ? { prompt, team } : { prompt }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok && body && body.ok, status: r.status, body };
}

export function WriteWithAiDialog({ team = '', onClose, navigate = (url) => { location.href = url; } }) {
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | writing | opening
  const [error, setError] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    fetch('/api/write-with-ai', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body && Number.isInteger(body.remaining)) setRemaining(body.remaining); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (phase !== 'writing') return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const trimmed = prompt.trim();
  const busy = phase !== 'idle';
  const tooLong = [...trimmed].length > WRITE_AI_PROMPT_CHARS;
  const out = remaining === 0;

  const submit = async () => {
    if (!trimmed || busy || tooLong) return;
    setError(null);
    setStartedAt(Date.now());
    setNow(Date.now());
    setPhase('writing');
    const result = await writeWithAi(trimmed, team).catch(() => ({ ok: false, status: 0, body: {} }));
    if (result.ok) {
      setPhase('opening');
      navigate(result.body.url || `/d/${encodeURIComponent(result.body.slug)}`);
      return;
    }
    if (result.body?.error === 'ask_limit') setRemaining(0);
    setError({ text: writeAiErrorText(result.status, result.body), connect: result.body?.error === 'ask_limit' });
    setPhase('idle');
  };

  const status = phase === 'writing'
    ? `Writing the draft · ${seconds(now - startedAt)}`
    : phase === 'opening' ? 'Published v1 · Opening the doc…' : '';

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title="Write it with tdoc AI"
      actions={(
        <>
          <AppButton onClick={onClose} disabled={busy}>Cancel</AppButton>
          <AppButton variant="primary" className="primary" onClick={submit} disabled={!trimmed || busy || tooLong || out}>
            {busy ? 'Writing…' : 'Write it'}
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
                ? <>You have used your free tdoc AI requests. <a href="/start">Connect your agent</a> to keep writing.</>
                : `tdoc AI writes the doc and publishes it, private to you.${Number.isInteger(remaining) ? ` ${remaining} free ${remaining === 1 ? 'request' : 'requests'} left.` : ''}`}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
