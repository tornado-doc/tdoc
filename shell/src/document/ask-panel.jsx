// Ask this doc: a free, server-side answer about this one document for a
// reader who has not connected an agent of their own. A side panel (bottom
// sheet on a phone) so the document stays readable beside the answer. The
// server keeps only how many questions this account has used; the question
// and answer live in this component until the reader posts them as a comment.

import React, { useEffect, useRef, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { askDocument, getAskAllowance } from './api.js';

const CONNECT_HREF = '/start';

// What a comment made from an answer says. The "AI answer" label is in the
// text itself, so it reads as one wherever the comment is shown or exported.
export function askCommentText(question, answer) {
  return `Q: ${question.trim()}\n\nAI answer (Ask this doc): ${answer.trim()}`;
}

// Markdown-lite: paragraphs, "- " / "1. " lists, **bold** and `code`. Built as
// React elements -- never HTML -- so a model answer cannot inject markup.
function inline(text, key) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**')
      ? <strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>
      : <code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AnswerText({ text }) {
  const blocks = [];
  let list = null;
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => { if (list) blocks.push(list); list = null; };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (!line) { flushPara(); flushList(); continue; }
    if (bullet) {
      flushPara();
      const ordered = /^\d/.test(line);
      if (!list || list.ordered !== ordered) { flushList(); list = { t: 'list', ordered, items: [] }; }
      list.items.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flushPara();
  flushList();
  return (
    <div className="tdoc-ask-answer-text">
      {blocks.map((b, i) => (b.t === 'p'
        ? <p key={i}>{inline(b.text, i)}</p>
        : React.createElement(b.ordered ? 'ol' : 'ul', { key: i },
          b.items.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>))))}
    </div>
  );
}

function remainingText(n) {
  return n === 1 ? '1 free question left' : `${n} free questions left`;
}

export function AskPanel({
  open,
  onClose,
  slug,
  version,
  selection,
  limit,
  canPost,
  onPost,
}) {
  const [question, setQuestion] = useState('');
  const [focus, setFocus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const input = useRef(null);

  // Each opening starts from what the reader has highlighted now.
  useEffect(() => {
    if (!open) return;
    setFocus(selection && selection.text ? selection : null);
    setError('');
    let live = true;
    getAskAllowance(slug)
      .then((body) => { if (live && typeof body?.remaining === 'number') setRemaining(body.remaining); })
      .catch(() => {});
    setTimeout(() => input.current?.focus(), 0);
    return () => { live = false; };
  }, [open, slug, selection]);

  // Answers can take a minute: count the seconds so "thinking" never looks
  // stuck.
  useEffect(() => {
    if (!busy) return undefined;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const used = remaining === 0;

  const submit = async (event) => {
    event?.preventDefault();
    const q = question.trim();
    if (!q || busy || used) return;
    setBusy(true);
    setError('');
    setPosted(false);
    try {
      const body = await askDocument(slug, { question: q, version, selection: focus?.text || '' });
      setResult({ question: q, answer: body.answer, selection: focus });
      if (typeof body.remaining === 'number') setRemaining(body.remaining);
      setQuestion('');
    } catch (err) {
      if (err.status === 429) {
        setRemaining(0);
      } else if (err.status === 503) {
        setError('Ask is not available right now.');
      } else if (err.status === 401) {
        setError('Sign in to ask about this document.');
      } else {
        setError('Could not get an answer. Your question was not counted — try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const post = async () => {
    if (!result || posting) return;
    setPosting(true);
    try {
      const ok = await onPost(askCommentText(result.question, result.answer), result.selection);
      if (ok) setPosted(true);
    } finally {
      setPosting(false);
    }
  };

  return (
    <AppDialog
      side
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Ask this doc"
      className="tdoc-ask-panel"
      description="AI answers about this document only. It can't edit the doc."
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      {result ? (
        <div className="tdoc-ask-result" aria-live="polite">
          <p className="tdoc-ask-q">{result.question}</p>
          <AnswerText text={result.answer} />
          <div className="tdoc-ask-result-actions">
            {canPost ? (
              <button type="button" className="tdoc-ask-post" disabled={posting || posted} onClick={post}>
                {posted ? 'Posted as comment' : posting ? 'Posting…' : 'Post as comment'}
              </button>
            ) : null}
          </div>
          {!used ? (
            <a className="tdoc-ask-connect" href={CONNECT_HREF}>
              Connect your own agent for unlimited use and edits →
            </a>
          ) : null}
        </div>
      ) : null}

      {used ? (
        <p className="tdoc-ask-limit">
          <a className="tdoc-ask-connect" href={CONNECT_HREF}>
            You’ve used your free questions — connect your own agent for unlimited use and edits →
          </a>
        </p>
      ) : (
        <form className="tdoc-ask-form" onSubmit={submit}>
          {focus ? (
            <div className="tdoc-ask-focus">
              <span className="tdoc-ask-focus-label">About</span>
              <q>{focus.text.length > 160 ? `${focus.text.slice(0, 160)}…` : focus.text}</q>
              <button type="button" className="text-btn" onClick={() => setFocus(null)}>Clear</button>
            </div>
          ) : null}
          <textarea
            ref={input}
            className="tdoc-ask-input"
            aria-label="Your question"
            placeholder={result ? 'Ask another question…' : 'Ask a question about this document…'}
            rows={3}
            maxLength={2000}
            value={question}
            disabled={busy}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          />
          <div className="tdoc-ask-row">
            <span className="tdoc-ask-remaining">
              {busy
                ? `Thinking… ${elapsed}s${elapsed >= 10 ? ' · this can take up to a minute' : ''}`
                : remaining == null ? (limit ? `${limit} free questions per account` : '') : remainingText(remaining)}
            </span>
            <button type="submit" className="primary" disabled={busy || !question.trim()}>
              {busy ? 'Thinking…' : 'Ask'}
            </button>
          </div>
          {error ? <p className="tdoc-ask-error" role="alert">{error}</p> : null}
        </form>
      )}
    </AppDialog>
  );
}
