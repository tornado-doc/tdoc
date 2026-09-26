import React, { useEffect, useRef, useState } from 'react';
import { AppMenu, AppMenuItem } from './ui/menu.jsx';
import { MessageSquare, SquarePen } from 'lucide-react';
import { copyText } from './document/model.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AgentMarks } from './agent-marks.jsx';
import { DOC_SUBJECT_PLACEHOLDER, DOC_SUBJECT_PREFIX, DOC_SUBJECT_SUFFIX, docSubjectPrompt } from './setup-gate.jsx';

// "Create a doc" is a fork, not a form: write it yourself, or have your agent
// write it. Two cards, one per answer.
//
// Both answers finish inside this dialog. The blank doc opens immediately —
// you name it by typing into the page, which is where the title lives anyway.
// The agent answer used to leave for the onboarding gate, which was the wrong
// errand: this button is the product's ordinary way to make a document, not a
// step in anybody's journey, and somebody on their fifth doc should not be
// sent to a page built to watch their first one arrive.
//
// `create` resolves truthy once the browser is on its way to the new document.
// `busy` is deliberately never cleared on success: the page is already
// leaving, and flipping the card back to its resting state underneath reads as
// a no-op.
// The fork is a menu now, not a screen: two answers, one line each, under the
// button that asked. A modal to choose between two things is a room built for
// a sentence.
//
// The two glyphs say what you do: write on a page, or send a message. Both
// are the same square family at the same weight, and neither is the sparkle
// every AI feature has worn since 2023 -- a symbol that says "a model was
// involved" and nothing about which of these two answers you are picking.
// Which agents is a separate question, answered by the marks at the end of
// the row, where a list of what something works with belongs.
export function CreateMenu({ create, canCreate = true, onAgent, onQuota, trigger }) {
  const [busy, setBusy] = useState(false);
  const startBlank = async () => {
    if (busy) return;
    setBusy(true);
    const result = await create();
    if (result === true) return;
    setBusy(false);
    if (result && result.quota && onQuota) onQuota(result.quota);
  };
  return (
    <AppMenu trigger={trigger}>
      {canCreate ? (
        <AppMenuItem onClick={startBlank} disabled={busy} className="mk-item">
          <SquarePen size={17} strokeWidth={1.75} aria-hidden="true" />
          <span className="mk-text">
            <b>{busy ? 'Creating…' : 'Start from scratch'}</b>
            <em>A blank doc, open in edit mode.</em>
          </span>
        </AppMenuItem>
      ) : null}
      <AppMenuItem onClick={onAgent} className="mk-item">
        <MessageSquare size={17} strokeWidth={1.75} aria-hidden="true" />
        <span className="mk-text">
          <b>Build it with your agent</b>
          <em>Name the subject. It writes and publishes the page.</em>
        </span>
        {/* At the end of the row, where a list says what it works with. The
            icon slot stays one width for both rows so the titles align; three
            logos were never going to fit in it. */}
        <AgentMarks size={21} />
      </AppMenuItem>
    </AppMenu>
  );
}

// The agent answer, and only that. Somebody on their fifth doc should not be
// sent to a page built to watch their first one arrive, so this finishes where
// it was asked: a subject, the line that subject composes, and Copy.
export function AgentRecipe() {
  const [subject, setSubject] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const subjectRef = useRef(null);
  const promptRef = useRef(null);

  useEffect(() => { subjectRef.current?.focus(); }, []);

  const trimmed = subject.trim();
  const line = docSubjectPrompt(trimmed || DOC_SUBJECT_PLACEHOLDER);
  const ready = Boolean(trimmed);

  const copy = async () => {
    const ok = await copyText(line);
    setCopied(ok !== false);
    setCopyFailed(ok === false);
    if (ok === false) selectContents(promptRef.current);
  };

  return (
    <div className="mk-agent">
      <label className="mk-subject">
        <span className="mk-sr">What the doc is about</span>
        <input
          ref={subjectRef}
          type="text"
          value={subject}
          placeholder={DOC_SUBJECT_PLACEHOLDER}
          onChange={(event) => { setSubject(event.target.value); setCopied(false); setCopyFailed(false); }}
        />
      </label>
      <div className={`mk-line${ready ? '' : ' pending'}`}>
        <p ref={promptRef}>
          <span className="mk-fixed">{DOC_SUBJECT_PREFIX}</span>
          <span className="mk-typed">{trimmed || DOC_SUBJECT_PLACEHOLDER}</span>
          <span className="mk-fixed">{DOC_SUBJECT_SUFFIX}</span>
        </p>
        <button type="button" className={copied ? 'copied' : ''} onClick={copy} disabled={!ready}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mk-foot">
        {copyFailed ? COPY_FALLBACK : 'Paste it into your agent. The doc turns up in this list.'}
      </p>
    </div>
  );
}
