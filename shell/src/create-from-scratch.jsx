import React, { useEffect, useRef, useState } from 'react';
import { AppMenu, AppMenuItem, AppMenuSeparator } from './ui/menu.jsx';
import { ChevronLeft, FilePenLine, FileText, FolderPlus, MessageSquare, Presentation, Sheet, SquarePen, Table2 } from 'lucide-react';
import { AskIcon } from './ui/ask-icon.jsx';
import { copyText } from './document/model.js';
import { listWriteWithAgentAgents, writeWithAgent } from './document/api.js';
import { agentDisplayName, targetKey } from './document/agent-choices.js';
import { AppButton } from './ui/button.jsx';
import { AppSelect } from './ui/select.jsx';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AgentMarks } from './agent-marks.jsx';
import { DOC_SUBJECT_PLACEHOLDER, DOC_SUBJECT_PREFIX, DOC_SUBJECT_SUFFIX, docSubjectPrompt } from './setup-gate.jsx';

// "New" asks two questions, in the order people answer them: what are you
// making (a doc, a sheet, slides), then how (start blank, bring a file, or
// have your agent build it). A flat list of methods mixed the two -- "New
// sheet" sat beside a blank-doc row that only made docs -- and had no
// room for a third type.
//
// Both levels are the doc page's ⋯ menu (AppMenu): its rows, separators and
// keyboard. A modal to choose between three things is a room built for a
// sentence.
//
// Every answer finishes inside this menu or one dialog. The blank doc and the
// blank sheet open immediately -- you name them by typing into the page. The
// agent answer composes its line in a dialog (AgentRecipe below) rather than
// leaving for the onboarding gate: somebody on their fifth doc should not be
// sent to a page built to watch their first one arrive.
//
// `create`, `onNewSheet` and `onNewDeck` resolve truthy once the browser is on its way to
// the new document. `busy` is deliberately never cleared on success: the page
// is already leaving, and flipping the row back to its resting state
// underneath reads as a no-op.
//
// Sheet is behind the `sheets` flag: the hub passes `onNewSheet` and
// `onImport` (which opens its file chooser, sheet-import.jsx) only when it is
// on. `onNewDeck` makes a three-slide starter deck (blank-deck.js) that the
// editor edits in place like any doc.
// `onNewFolder` is the hub's New folder, under a rule at the bottom: a folder
// is also something new in this list.

// The line each type composes. The doc's prefix and suffix live with the gate,
// which composes the same line; sheet and slides follow SKILL.md, which sends
// "a sheet" to data-tdoc-sheet tables and "a slide deck" to data-tdoc-slide
// sections.
export const AGENT_RECIPES = Object.freeze({
  doc: Object.freeze({
    title: 'Write it with your agent',
    label: 'What the doc is about',
    prefix: DOC_SUBJECT_PREFIX,
    suffix: DOC_SUBJECT_SUFFIX,
    placeholder: DOC_SUBJECT_PLACEHOLDER,
    foot: 'Paste it into your agent. The doc turns up in this list.',
  }),
  sheet: Object.freeze({
    title: 'Build it with your agent',
    label: 'What the sheet keeps track of',
    prefix: 'Use tdoc to make a sheet of ',
    suffix: DOC_SUBJECT_SUFFIX,
    placeholder: 'what it should keep track of',
    foot: 'Paste it into your agent. The sheet turns up in this list.',
  }),
  slides: Object.freeze({
    title: 'Build it with your agent',
    label: 'What the deck is about',
    prefix: 'Use tdoc to make a slide deck about ',
    suffix: DOC_SUBJECT_SUFFIX,
    placeholder: 'what it should be about',
    foot: 'Paste it into your agent. The deck turns up in this list.',
  }),
});
export const agentRecipeFor = (kind) => AGENT_RECIPES[kind] || AGENT_RECIPES.doc;
// The doc's line is the gate's own docSubjectPrompt, so the two never drift.
export const agentRecipeLine = (kind, subject) => {
  if (!AGENT_RECIPES[kind] || kind === 'doc') return docSubjectPrompt(subject);
  const recipe = AGENT_RECIPES[kind];
  return `${recipe.prefix}${subject}${recipe.suffix}`;
};

// Level 1 is three tiles in a row -- the type's mark, its name under it --
// because "what are you making" is answered by recognising a shape, not by
// reading a list. Level 2 is the methods, in text, pushed into the same popup
// under a back row naming the type: one list at a time, in the place the
// pointer or finger already is, the same on a desktop and a phone. (A side
// submenu cannot hang off a tile in a row, and on a phone it landed on top of
// the menu it came from.)
//
// Keyboard: the popup is a vertical menu, so ↑/↓ walk every row (the tiles,
// then New folder) and ←/→ also step between tiles. Enter on a tile opens its
// methods with the first one focused; the back row, ← or Backspace returns to
// the tiles with that tile focused; Escape closes.
function TypeTile({ kind, icon: Icon, label, onPush }) {
  const step = (event) => {
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    const tiles = [...event.currentTarget.parentElement.querySelectorAll('.mk-tile')];
    const next = tiles[tiles.indexOf(event.currentTarget) + dir];
    event.preventDefault();
    if (next) next.focus();
  };
  return (
    <AppMenuItem className={`mk-tile mk-tile-${kind}`} data-kind={kind} aria-haspopup="menu" closeOnClick={false}
      onClick={() => onPush(kind)} onKeyDown={step}>
      <span className="mk-tile-mark" aria-hidden="true"><Icon size={22} strokeWidth={1.75} /></span>
      <span className="mk-tile-label">{label}</span>
    </AppMenuItem>
  );
}

// `mark`: who writes it, at the end of the row where AgentMarks sits -- tdoc
// AI's own mark (the one its row wears in the agent picker), not a symbol.
function MethodRow({ icon: Icon, title, busyTitle, busy = false, text, onClick, agents = false, mark = null }) {
  return (
    <AppMenuItem onClick={onClick} disabled={busy} className="mk-item">
      <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
      <span className="mk-text">
        <b>{busy ? busyTitle : title}</b>
        <em>{text}</em>
      </span>
      {/* At the end of the row, where a list says what it works with. */}
      {agents ? <AgentMarks size={21} /> : null}
      {mark ? <span className="agent-marks mk-ai-mark" aria-hidden="true"><i>{mark}</i></span> : null}
    </AppMenuItem>
  );
}

// `onWriteWithAi` (flag writeWithTdocAi) adds tdoc AI as a third way to a
// doc: one sentence, and it writes and publishes it (write-with-ai.jsx).
export function CreateMenu({ create, team = '', canCreate = true, onAgent, onWriteWithAi, onQuota, onImport, onNewSheet, onNewDeck, onNewFolder, trigger }) {
  const [making, setMaking] = useState('');
  const [pushed, setPushed] = useState(null);
  const popupRef = useRef(null);
  // After a push or a pop the rows under focus are gone; put focus on the
  // first method, or back on the tile that was opened.
  const focusNext = useRef('');
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = '';
    const popup = popupRef.current?.closest('.ui-menu-popup') || document.querySelector('.ui-menu-popup.mk-types');
    const target = popup && (want === 'methods'
      ? popup.querySelector('.mk-item:not([data-disabled])')
      : popup.querySelector(`.mk-tile[data-kind="${want}"]`));
    if (target) target.focus();
  }, [pushed]);
  const push = (kind) => { focusNext.current = 'methods'; setPushed(kind); };
  const pop = () => { focusNext.current = pushed || ''; setPushed(null); };

  const start = (key, begin) => async () => {
    if (making) return;
    setMaking(key);
    const result = await begin(team);
    if (result === true) return;
    setMaking('');
    if (result && result.quota && onQuota) onQuota(result.quota);
  };
  const blank = (key, begin, title, text) => (
    <MethodRow icon={SquarePen} title={title} busyTitle="Creating…" busy={making === key}
      text={text} onClick={start(key, begin)} />
  );

  const types = [
    {
      kind: 'doc', icon: FileText, label: 'Doc',
      methods: (
        <>
          {canCreate ? blank('doc', create, 'Blank doc', 'Opens in edit mode. Type the title on the page.') : null}
          <MethodRow icon={MessageSquare} title="Write it with your agent" agents
            text="Name the subject. It writes and publishes the doc." onClick={() => onAgent('doc')} />
          {canCreate && onWriteWithAi ? (
            <MethodRow icon={FilePenLine} title="Write it with tdoc AI" mark={<AskIcon size={13} />}
              text="One sentence. tdoc AI drafts it and publishes v1." onClick={() => onWriteWithAi('doc')} />
          ) : null}
        </>
      ),
    },
    (onNewSheet || onImport) ? {
      kind: 'sheet', icon: Table2, label: 'Sheet',
      methods: (
        <>
          {canCreate && onNewSheet ? blank('sheet', onNewSheet, 'Blank sheet', 'Typed columns, open in edit mode.') : null}
          {canCreate && onImport ? (
            <MethodRow icon={Sheet} title="Import CSV or Excel"
              text="A .csv, .tsv or .xlsx file becomes a sheet." onClick={onImport} />
          ) : null}
          <MethodRow icon={MessageSquare} title="Build it with your agent" agents
            text="Say what it tracks. It builds and publishes the sheet." onClick={() => onAgent('sheet')} />
        </>
      ),
    } : null,
    {
      kind: 'slides', icon: Presentation, label: 'Slides',
      methods: (
        <>
          {canCreate && onNewDeck ? blank('slides', onNewDeck, 'Blank deck', 'Three starter slides, open in edit mode.') : null}
          <MethodRow icon={MessageSquare} title="Build it with your agent" agents
            text="Name the subject. It builds and publishes the deck." onClick={() => onAgent('slides')} />
        </>
      ),
    },
  ].filter(Boolean);
  const current = pushed ? types.find((type) => type.kind === pushed) : null;

  return (
    <AppMenu
      trigger={trigger}
      popupClassName={current ? 'mk-types mk-pushed' : 'mk-types'}
      onOpenChange={(open) => { if (!open) setPushed(null); }}
    >
      <span ref={popupRef} hidden />
      {current ? (
        <>
          <AppMenuItem className="tdoc-action-menu-item mk-back-row" closeOnClick={false} onClick={pop}
            onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'Backspace') { event.preventDefault(); pop(); } }}
            aria-label={`Back from ${current.label}`}>
            <ChevronLeft size={16} aria-hidden="true" />
            <current.icon size={15} aria-hidden="true" />
            <span>{current.label}</span>
          </AppMenuItem>
          <AppMenuSeparator />
          {current.methods}
        </>
      ) : (
        <>
          <div className="mk-tiles" role="group" aria-label="New">
            {types.map((type) => (
              <TypeTile key={type.kind} kind={type.kind} icon={type.icon} label={type.label} onPush={push} />
            ))}
          </div>
          {onNewFolder ? (
            <>
              <AppMenuSeparator />
              <AppMenuItem className="tdoc-action-menu-item mk-folder" onClick={onNewFolder}>
                <FolderPlus size={15} aria-hidden="true" /> New folder
              </AppMenuItem>
            </>
          ) : null}
        </>
      )}
    </AppMenu>
  );
}

// Where Settings lists the agents tdoc can reach.
export const CONNECT_AGENT_HREF = '/me?view=settings#agents';

// `send` (flag writeWithAgent): above the line, the sentence goes straight to
// one of the person's own agents tdoc can push to -- a Raft agent, a webhook,
// Claude Code or Codex through the tdoc app. tdoc makes a private doc, hands
// the sentence to that agent, and opens the doc, where the comment's
// progress line shows the agent at work until it publishes. Chat apps
// connected over MCP cannot be sent to; with none of the others connected
// the dialog says so, links to Connect an agent, and the copy line stays.
// A send that made the doc but did not reach the agent (`sent: false`): the
// server's message, else a plain line.
export function writeWithAgentFailure(body) {
  const msg = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : '';
  return msg || 'tdoc made the doc but could not send it to your agent.';
}

function SendToAgent({ kind, subject, onError }) {
  const [agents, setAgents] = useState(null);
  const [picked, setPicked] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [madeUrl, setMadeUrl] = useState('');
  useEffect(() => {
    let live = true;
    listWriteWithAgentAgents()
      .then((body) => { if (!live) return; const list = Array.isArray(body?.agents) ? body.agents : []; setAgents(list); setPicked(list[0] ? targetKey(list[0]) : ''); })
      .catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, []);
  if (agents === null) return <p className="mk-foot mk-send-loading">Looking for your agents…</p>;
  if (!agents.length) {
    return (
      <div className="mk-send mk-send-none" role="note">
        <p>No agent tdoc can send this to yet. It can reach a Raft agent, a webhook, or Claude Code or Codex through the tdoc app on your computer. Chat apps like claude.ai or ChatGPT can only take the line below.</p>
        <a className="ui-btn ui-btn-secondary ui-btn-s" href={CONNECT_AGENT_HREF}>Connect an agent</a>
      </div>
    );
  }
  const agent = agents.find((t) => targetKey(t) === picked) || agents[0];
  const ready = Boolean(subject) && !sending;
  const send = async () => {
    if (!ready) return;
    setSending(true);
    setError('');
    setMadeUrl('');
    try {
      const body = await writeWithAgent({ prompt: subject, kind, recipient: agent });
      // The doc was made but the request never reached the agent: say so
      // here rather than open a doc nobody is writing.
      if (!body?.sent) {
        setSending(false);
        setError(writeWithAgentFailure(body));
        setMadeUrl(typeof body?.url === 'string' && body.url.startsWith('/') ? body.url : '');
        return;
      }
      // On its way to the new doc: the busy state stays (see CreateMenu).
      location.assign(body.url);
    } catch (err) {
      setSending(false);
      setError(err?.message || 'Could not send it');
      onError?.(err);
    }
  };
  return (
    <div className="mk-send">
      <div className="mk-send-row">
        {agents.length > 1 ? (
          <AppSelect ariaLabel="Agent" className="mk-send-agent" value={targetKey(agent)} onChange={setPicked}
            options={agents.map((t) => ({ value: targetKey(t), label: agentDisplayName(t, agents) }))} />
        ) : <span className="mk-send-agent mk-send-one">{agentDisplayName(agent, agents)}</span>}
        <AppButton variant="primary" onClick={send} disabled={!ready}>{sending ? 'Sending…' : 'Send'}</AppButton>
      </div>
      <p className={`mk-foot${error ? ' mk-send-error' : ''}`} role={error ? 'alert' : undefined}>
        {error || 'tdoc makes a private doc and asks your agent to write it. You watch it there.'}
        {error && madeUrl ? <> <a href={madeUrl}>Open the doc</a></> : null}
      </p>
    </div>
  );
}

// The agent answer: a subject, the line that subject composes, and Copy.
// `kind` picks the line (AGENT_RECIPES); `send` adds SendToAgent above it.
export function AgentRecipe({ kind = 'doc', send = false }) {
  const recipe = agentRecipeFor(kind);
  const [subject, setSubject] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const subjectRef = useRef(null);
  const promptRef = useRef(null);

  useEffect(() => { subjectRef.current?.focus(); }, []);

  const trimmed = subject.trim();
  const line = agentRecipeLine(kind, trimmed || recipe.placeholder);
  const ready = Boolean(trimmed);

  const copy = async () => {
    const ok = await copyText(line);
    setCopied(ok !== false);
    setCopyFailed(ok === false);
    if (ok === false) selectContents(promptRef.current);
  };

  return (
    <div className="mk-agent" data-kind={kind}>
      <label className="mk-subject">
        <span className="mk-sr">{recipe.label}</span>
        <input
          ref={subjectRef}
          type="text"
          value={subject}
          placeholder={recipe.placeholder}
          onChange={(event) => { setSubject(event.target.value); setCopied(false); setCopyFailed(false); }}
        />
      </label>
      {send ? <SendToAgent kind={kind} subject={trimmed} /> : null}
      {send ? <p className="mk-or">Or copy it into any agent</p> : null}
      <div className={`mk-line${ready ? '' : ' pending'}`}>
        <p ref={promptRef}>
          <span className="mk-fixed">{recipe.prefix}</span>
          <span className="mk-typed">{trimmed || recipe.placeholder}</span>
          <span className="mk-fixed">{recipe.suffix}</span>
        </p>
        <button type="button" className={copied ? 'copied' : ''} onClick={copy} disabled={!ready}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mk-foot">
        {copyFailed ? COPY_FALLBACK : recipe.foot}
      </p>
    </div>
  );
}
