import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { AppDialog } from './ui/dialog.jsx';
import { copyText } from './document/model.js';
import { getAgentStatus, getOnboarding, postOnboardingEvent } from './document/api.js';

const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
export const FIRST_DOC_RECIPE = `Set up tdoc and make my first doc: ${RECIPE_URL}`;
// The line for a person who already has one. tdoc is installed by then, and
// FIRST-DOC.md would only build the same portrait again, so this one is the
// ordinary way to make a doc, with a blank for what it is about.
export const ANOTHER_DOC_RECIPE = '/tdoc new "<what it is about>" — then publish it and give me the link';
// The document behind "See an example": a portrait with its threads resolved,
// so a stranger can see what a commented, revised doc looks like before they
// have one of their own.
export const EXAMPLE_URL = '/d/what-ai-knows/v/12';
// The definition sits under the door's title, always — a tooltip needed a
// pointer, covered the door's own text while it was open, and on a phone
// the word it hung from was a tap target inside a bigger tap target.
export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.';
export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work';
// The one concept the page states, once, the moment the person has picked
// the door that needs it.
export const TWO_WINDOWS = 'Two windows: you read and comment here. Your agent writes and fixes.';
export const WAITING = 'Waiting for your agent… this usually takes 1–3 minutes.';
export const NOTHING_YET = 'Taking a while? Check whether your agent asked you a question in its own window.';
export const STILL_WAITING = 'Still waiting — did you paste it into your agent?';
export const COPY_FALLBACK = "Couldn't copy automatically — the line is selected above. Copy it, paste it into your agent, and press Enter.";
// How often the waiting state asks the server what the agent has done. Only
// while waiting: the dialog stops the moment the doc arrives or closes.
const POLL_MS = 3000;
// The two points where the wait changes what it says: a nudge, then the one
// question that resolves a wait that has gone on too long.
const NOTHING_YET_MS = 90 * 1000;
const STILL_WAITING_MS = 5 * 60 * 1000;

// Select the text of an element, for the person to copy by hand when the
// clipboard refused. Never throws: a page that cannot select just shows the
// fallback sentence.
export function selectContents(element) {
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

// The one rendering of the first-doc recipe. Shown inside the "Use my own
// agent" door, which is what the Docs Hub's "Build it with your agent" card
// opens too — one door, two entrances, so the wait and the arrival are the
// same wherever the person came in (the hub used to show the bare recipe, and
// nothing after it ever happened).
// `onCopied(ok)` reports whether the clipboard took it; on failure the line is
// left selected so a manual copy is one keystroke away, and the button says so.
export function FirstDocRecipe({ line = FIRST_DOC_RECIPE, onCopied }) {
  const [copied, setCopied] = useState(null); // null | true | false
  const codeRef = useRef(null);

  const copy = async () => {
    const ok = await copyText(line);
    if (!ok && codeRef.current) selectContents(codeRef.current);
    setCopied(ok);
    onCopied?.(ok);
  };

  return (
    <div className="tdoc-recipe-wrap">
      <code ref={codeRef}>{line}</code>
      <button type="button" className={copied ? 'done' : undefined} onClick={copy}>
        {copied === true ? 'Copied' : copied === false ? 'Select & copy' : 'Copy'}
      </button>
    </div>
  );
}

// Bridge 1. The person has pasted (or is about to paste) the line into their
// agent; everything after that happens in another window. The server sees
// each step the agent takes — the token it mints, the first doc it publishes —
// so this state is read off the server rather than guessed, and the page
// leaves for the doc on its own when it arrives.
//
// A person who already has a doc is not made to wait for one: the door says
// so, opens it, and offers the line again for another.
export function OwnAgentDoor({ onOpenChange, closeLabel = 'Close' }) {
  const [copied, setCopied] = useState(null);
  const [record, setRecord] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  // Set once, on the first answer from the server: a doc that was already
  // there when the door opened is "you have one", not "it just arrived".
  const [existing, setExisting] = useState(null);
  const copiedAt = useRef(null);
  const firstAnswer = useRef(true);

  useEffect(() => {
    // Reaching this door is the journey's first stamp — whether it was chosen
    // just now or returned to after the sign-in redirect.
    postOnboardingEvent('door_own_agent').catch(() => {});
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await getOnboarding();
        if (cancelled) return;
        const next = result?.record || null;
        setRecord(next);
        if (next?.published_first && next?.first_doc) {
          if (firstAnswer.current) {
            // Already had one before this door opened. Say so; don't leave.
            const status = await getAgentStatus(next.first_doc).catch(() => null);
            if (cancelled) return;
            setExisting({
              slug: next.first_doc,
              title: status?.title || next.first_doc,
              version: Number(status?.latest_version) || 1,
            });
            return;
          }
          location.href = `/d/${encodeURIComponent(next.first_doc)}/v/1?welcome=1`;
          return;
        }
      } catch {}
      firstAnswer.current = false;
      if (copiedAt.current) setElapsed(Date.now() - copiedAt.current);
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  const onCopied = (ok) => {
    copiedAt.current = Date.now();
    setCopied(ok);
    postOnboardingEvent('copy_clicked').catch(() => {});
  };

  if (existing) {
    const url = `/d/${encodeURIComponent(existing.slug)}/v/${existing.version}`;
    return (
      <div className="tdoc-own-door">
        <p className="tdoc-two-windows">You already have a doc.</p>
        <a className="tdoc-open-doc" href={url}>
          Open {existing.title} · v{existing.version}
        </a>
        <p className="muted">Want another? Fill in the blank, then paste the line into your agent.</p>
        <FirstDocRecipe line={ANOTHER_DOC_RECIPE} onCopied={onCopied} />
        <button type="button" className="tdoc-door-back" onClick={() => onOpenChange(false)}>{closeLabel}</button>
      </div>
    );
  }

  let status = 'Copy the line, paste it into your agent, and press Enter.';
  let live = false;
  if (record?.agent_connected) {
    status = 'Your agent is connected. Publishing your first doc…';
    live = true;
  } else if (copied !== null && elapsed > STILL_WAITING_MS) {
    status = STILL_WAITING;
  } else if (copied !== null && elapsed > NOTHING_YET_MS) {
    status = NOTHING_YET;
    live = true;
  } else if (copied === false) {
    status = COPY_FALLBACK;
    live = true;
  } else if (copied === true) {
    status = WAITING;
    live = true;
  }

  return (
    <div className="tdoc-own-door">
      <p className="tdoc-two-windows">{TWO_WINDOWS}</p>
      <FirstDocRecipe onCopied={onCopied} />
      <p className={`tdoc-wait${live ? ' live' : ''}`} role="status" aria-live="polite">
        {live ? <span className="tdoc-wait-dot" aria-hidden="true" /> : null}
        {status}
      </p>
      {live ? <div className="tdoc-wait-bar" aria-hidden="true" /> : null}
      <p className="muted">This page opens your doc the moment it is published. Keep it open, or come back later — it remembers where you were.</p>
      <details className="tdoc-onboarding-details">
        <summary>Advanced</summary>
        <p className="muted">
          To publish to your own Cloudflare instead of tdoc.dev, add to the line: <strong>Publish it to my own Cloudflare, not the hosted service.</strong>
        </p>
        <a className="tdoc-onboarding-link" href="/start">Read the full tutorial</a>
      </details>
      <button type="button" className="tdoc-door-back" onClick={() => onOpenChange(false)}>{closeLabel}</button>
    </div>
  );
}

function WaitlistDoor({ onOpenChange }) {
  return (
    <div className="tdoc-own-door">
      <p className="tdoc-waitlist-done">You're on the list.</p>
      <p className="muted">Until then, the example is open for comments — highlight any sentence or chart and say what you think.</p>
      <a className="tdoc-onboarding-link" href={EXAMPLE_URL}>
        Open the example <ExternalLink size={14} />
      </a>
      <button type="button" className="tdoc-door-back" onClick={() => onOpenChange(false)}>Close</button>
    </div>
  );
}

// First-time onboarding, and only that. Behind the landing page's own CTA —
// the page itself is unchanged — this is one screen with two doors. The left
// one needs an account (the doc it produces has to belong to someone), so the
// sign-in happens the moment that door is chosen, and the page returns here
// with `?onboard=own` so the person lands back inside the door they picked.
export function OnboardingDialog({ open, onOpenChange, config, onSignIn, initialDoor = null }) {
  const [view, setView] = useState('doors');
  const signedIn = Boolean(config?.identity);

  useEffect(() => {
    if (!open) return;
    setView(initialDoor === 'own' && signedIn ? 'own' : 'doors');
  }, [open, initialDoor, signedIn]);

  const chooseOwn = () => {
    if (!signedIn) {
      onSignIn?.('/?onboard=own');
      return;
    }
    setView('own');
  };

  const chooseWaitlist = () => {
    postOnboardingEvent('waitlist').catch(() => {});
    setView('waitlist');
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a free doc"
      description={view === 'doors' ? 'Your own doc, published and open for comments in a few minutes.' : undefined}
      actions={null}
    >
      {view === 'doors' ? (
        <>
          <div className="tdoc-doors">
            <button type="button" className="tdoc-door" onClick={chooseOwn}>
              <strong>Use my own agent</strong>
              <span className="tdoc-agent-def">{AGENT_DEFINITION} {AGENT_NAMES}</span>
              <span>Copy one line into it. It builds a page about you from traces you choose to share, and publishes it.</span>
              <em>{signedIn ? 'Get the line' : 'Sign in to start'}</em>
            </button>
            <button type="button" className="tdoc-door" onClick={chooseWaitlist}>
              <strong>Use tdoc's agent — coming soon</strong>
              <span>Join the waitlist. Meanwhile, leave a comment on the example.</span>
              <em>Join the waitlist</em>
            </button>
          </div>
          <a
            className="tdoc-doors-example"
            href={EXAMPLE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => postOnboardingEvent('example_opened').catch(() => {})}
          >
            See an example <ExternalLink size={14} />
          </a>
        </>
      ) : null}
      {view === 'own' ? <OwnAgentDoor onOpenChange={onOpenChange} /> : null}
      {view === 'waitlist' ? <WaitlistDoor onOpenChange={onOpenChange} /> : null}
    </AppDialog>
  );
}
