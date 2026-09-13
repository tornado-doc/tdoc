import React, { useEffect, useRef, useState } from 'react';
import { AppMenu, AppMenuItem } from './ui/menu.jsx';
import { File, FileText } from 'lucide-react';
import { copyText } from './document/model.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { ClaudeMark, OpenAIMark } from './agent-marks.jsx';
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
// The two glyphs are one object with one difference: an empty page, and a page
// with writing already on it. That IS the choice -- who puts the words there --
// and it needs no third metaphor to say it. The sparkle that used to sit on the
// second one is the house style of every AI feature shipped since 2023 and says
// nothing about this one; it was also competing with the two agent marks on the
// same row, which do say something. Monochrome, at the label's weight: in a
// menu, colour should mean state, and neither of these is a state.
export function CreateMenu({ create, canCreate = true, onAgent, trigger }) {
  const [busy, setBusy] = useState(false);
  const startBlank = async () => {
    if (busy) return;
    setBusy(true);
    if (!await create()) setBusy(false);
  };
  return (
    <AppMenu trigger={trigger}>
      {canCreate ? (
        <AppMenuItem onClick={startBlank} disabled={busy} className="mk-item">
          <File size={17} strokeWidth={1.75} aria-hidden="true" />
          <span>
            <b>{busy ? 'Creating…' : 'Start from scratch'}</b>
            <em>A blank doc, open in edit mode.</em>
          </span>
        </AppMenuItem>
      ) : null}
      <AppMenuItem onClick={onAgent} className="mk-item">
        <FileText size={17} strokeWidth={1.75} aria-hidden="true" />
        <span>
          <b>Build it with your agent</b>
          <em>Name the subject. It writes and publishes the page.</em>
        </span>
        {/* Four product names set as a list was the longest thing in the old
            dialog. Two marks say the same and read in a glance. */}
        <i className="mk-works"><ClaudeMark size={15} /><OpenAIMark size={13} /></i>
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
