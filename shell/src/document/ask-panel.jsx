// Ask this doc: a free, server-side answer about this one document for a
// reader who has not connected an agent of their own. A side panel (bottom
// sheet on a phone) so the document stays readable beside the answer. The
// server keeps only how many questions this account has used; the question
// and answer live in this component until the reader posts them as a comment.
//
// The same panel is "Send to my agent" and "Copy for my agent" (see
// my-agent.js): one question box, one look, three ways to get an answer.

import React, { useEffect, useRef, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { askDocument, getAskAllowance } from './api.js';
import { agentDisplayName } from './agent-choices.js';
import { deliveryErrorText } from './notify-handoff.jsx';
import { agentAskLine } from './my-agent.js';

const CONNECT_HREF = '/start';

// What a comment made from an answer says. The "AI answer" label is in the
// text itself, so it reads as one wherever the comment is shown or exported;
// an answer from the reader's own agent names that agent instead.
export function askCommentText(question, answer, label = 'AI answer (Ask this doc)') {
  return `Q: ${question.trim()}\n\n${label}: ${answer.trim()}`;
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

// "Claude Code on juliesmac", "my-raft-agent": the reader's own agent, by
// the name its row on the Agents page has.
export function myAgentName(t) {
  if (!t) return 'your agent';
  const name = agentDisplayName(t);
  return t.provider === 'local' && t.device ? `${name} on ${t.device}` : name;
}

function Passage({ passage, onClear = null }) {
  if (!passage?.text) return null;
  const text = passage.text;
  return (
    <div className="tdoc-ask-focus">
      <span className="tdoc-ask-focus-label">About</span>
      <q>{text.length > 160 ? `${text.slice(0, 160)}…` : text}</q>
      {onClear ? <button type="button" className="text-btn" onClick={onClear}>Clear</button> : null}
    </div>
  );
}

// One question sent to the reader's own agent: where it is, then the answer,
// which only this reader sees until they post it.
function AgentAsk({ ask, canPost, posted, posting, onPost }) {
  const name = myAgentName(ask.recipient);
  const failed = ask.delivery?.status === 'failed';
  const status = ask.answer
    ? `Answer from ${name} · only you can see this`
    : failed
      ? `Not answered: ${deliveryErrorText(ask.delivery.error) || 'the agent did not reply'}`
      : ask.acked_at ? `${name} is working on it…` : `Sent to ${name} · waiting for the answer…`;
  return (
    <div className="tdoc-ask-result" aria-live="polite">
      <p className="tdoc-ask-q">{ask.question}</p>
      <Passage passage={ask.passage} />
      <p className={`tdoc-ask-status${failed ? ' is-failed' : ''}`}>{status}</p>
      {ask.answer ? (
        <>
          <AnswerText text={ask.answer.text} />
          {canPost ? (
            <div className="tdoc-ask-result-actions">
              <button type="button" className="tdoc-ask-post" disabled={posting || posted} onClick={onPost}>
                {posted ? 'Posted as comment' : posting ? 'Posting…' : 'Post as comment'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const TITLES = { ai: 'Ask this doc', agent: 'Send to my agent', copy: 'Copy for my agent' };

export function AskPanel({
  open,
  onClose,
  slug,
  version,
  selection,
  limit,
  canPost,
  onPost,
  // 'ai' answers here (free, counted); 'agent' sends to the reader's own
  // agent; 'copy' gives the line to paste when that agent cannot be woken.
  mode = 'ai',
  // A question typed in the selection popover arrives with the panel, and
  // `autoSubmit` asks it at once: the reader already pressed the button.
  initialQuestion = '',
  autoSubmit = false,
  // Set when the popover already copied the line for the reader.
  initialCopied = '',
  myAgent = null,
  docUrl = '',
  onSendAgent = null,
  onCopy = null,
}) {
  const [question, setQuestion] = useState('');
  const [focus, setFocus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(null);
  const [posting, setPosting] = useState('');
  const [posted, setPosted] = useState(() => new Set());
  const [copied, setCopied] = useState('');
  const input = useRef(null);
  const pendingSubmit = useRef(null);

  // Each opening starts from what the reader has highlighted now, and from
  // what they typed in the popover, if anything.
  useEffect(() => {
    if (!open) return undefined;
    const start = selection && selection.text ? selection : null;
    setFocus(start);
    setError('');
    setQuestion(initialQuestion || '');
    setCopied(initialCopied || '');
    let live = true;
    if (mode === 'ai') {
      getAskAllowance(slug)
        .then((body) => { if (live && typeof body?.remaining === 'number') setRemaining(body.remaining); })
        .catch(() => {});
    }
    pendingSubmit.current = autoSubmit && initialQuestion.trim() ? { question: initialQuestion, focus: start } : null;
    setTimeout(() => input.current?.focus(), 0);
    return () => { live = false; };
  }, [open, slug, selection, mode, initialQuestion, autoSubmit, initialCopied]);

  // Answers can take a minute: count the seconds so "thinking" never looks
  // stuck.
  useEffect(() => {
    if (!busy) return undefined;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const used = mode === 'ai' && remaining === 0;
  const agentName = myAgentName(myAgent?.agent);

  const askAi = async (q, about) => {
    setBusy(true);
    setError('');
    try {
      const body = await askDocument(slug, { question: q, version, selection: about?.text || '' });
      setResult({ question: q, answer: body.answer, selection: about });
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

  const sendAgent = async (q, about) => {
    setBusy(true);
    setError('');
    try {
      await onSendAgent(q, about);
      setQuestion('');
    } catch (err) {
      setError(err?.status === 409
        ? 'Your agent cannot be reached right now. Copy the question for it instead.'
        : 'Could not send to your agent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const copyLine = async (q, about) => {
    const line = agentAskLine(docUrl, q, about?.text);
    if (await onCopy(line)) {
      setCopied(line);
      setQuestion('');
    } else {
      setError('Could not copy. Select the line below and copy it yourself.');
      setCopied(line);
    }
  };

  const run = (q, about) => (mode === 'agent' ? sendAgent(q, about) : mode === 'copy' ? copyLine(q, about) : askAi(q, about));

  const submit = async (event) => {
    event?.preventDefault();
    const q = question.trim();
    if (!q || busy || used) return;
    setPosted(new Set());
    await run(q, focus);
  };

  // The popover's question, asked once the panel is up.
  useEffect(() => {
    const next = pendingSubmit.current;
    if (!open || !next) return;
    pendingSubmit.current = null;
    run(next.question.trim(), next.focus);
  });

  const post = async (key, text, about) => {
    if (posting) return;
    setPosting(key);
    try {
      const ok = await onPost(text, about);
      if (ok) setPosted((prev) => new Set([...prev, key]));
    } finally {
      setPosting('');
    }
  };

  const asks = mode === 'agent' ? (myAgent?.asks || []).slice(0, 3) : [];
  const description = mode === 'agent'
    ? `Goes to ${agentName}, your own agent, on your account. Only you see the reply.`
    : mode === 'copy'
      ? 'Your agent’s background helper is off, so tdoc cannot wake it. Copy the question and paste it into your agent.'
      : 'AI answers about this document only. It can’t edit the doc.';
  const placeholder = mode === 'ai'
    ? (result ? 'Ask another question…' : 'Ask a question about this document…')
    : 'Ask your agent about this document…';
  const submitLabel = mode === 'agent' ? 'Send to my agent' : mode === 'copy' ? 'Copy for my agent' : 'Ask';
  const busyLabel = mode === 'agent' ? 'Sending…' : 'Thinking…';
  const rowText = busy
    ? (mode === 'ai' ? `Thinking… ${elapsed}s${elapsed >= 10 ? ' · this can take up to a minute' : ''}` : 'Sending…')
    : mode === 'agent' ? 'Only you see the reply'
      : mode === 'copy' ? 'Copies the question with this doc’s link'
        : remaining == null ? (limit ? `${limit} free questions per account` : '') : remainingText(remaining);

  return (
    <AppDialog
      side
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={TITLES[mode] || TITLES.ai}
      className={`tdoc-ask-panel tdoc-ask-panel-${mode}`}
      description={description}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      {mode === 'ai' && result ? (
        <div className="tdoc-ask-result" aria-live="polite">
          <p className="tdoc-ask-q">{result.question}</p>
          <AnswerText text={result.answer} />
          <div className="tdoc-ask-result-actions">
            {canPost ? (
              <button type="button" className="tdoc-ask-post" disabled={Boolean(posting) || posted.has('ai')} onClick={() => post('ai', askCommentText(result.question, result.answer), result.selection)}>
                {posted.has('ai') ? 'Posted as comment' : posting ? 'Posting…' : 'Post as comment'}
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

      {asks.map((ask) => (
        <AgentAsk
          key={ask.ask_id}
          ask={ask}
          canPost={canPost}
          posted={posted.has(ask.ask_id)}
          posting={posting === ask.ask_id}
          onPost={() => post(ask.ask_id, askCommentText(ask.question, ask.answer.text, `Answer from my agent (${myAgentName(ask.recipient)})`), ask.passage)}
        />
      ))}

      {mode === 'copy' && copied ? (
        <div className="tdoc-ask-result" aria-live="polite">
          <p className="tdoc-ask-status">{error ? 'Copy this line into your agent:' : 'Copied. Paste it into your agent.'}</p>
          <pre className="tdoc-ask-line">{copied}</pre>
          <a className="tdoc-ask-connect" href={myAgent?.helper_href || '/me?view=settings#agents'}>
            Turn on the background helper so Send to my agent works from here →
          </a>
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
          <Passage passage={focus} onClear={() => setFocus(null)} />
          <textarea
            ref={input}
            className="tdoc-ask-input"
            aria-label="Your question"
            placeholder={placeholder}
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
            <span className="tdoc-ask-remaining">{rowText}</span>
            <button type="submit" className="primary" disabled={busy || !question.trim()}>
              {busy ? busyLabel : submitLabel}
            </button>
          </div>
          {error && !(mode === 'copy' && copied) ? <p className="tdoc-ask-error" role="alert">{error}</p> : null}
        </form>
      )}
    </AppDialog>
  );
}
