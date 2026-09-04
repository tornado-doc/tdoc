import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { AppDialog } from './ui/dialog.jsx';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent } from './document/api.js';

const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
export const FIRST_DOC_RECIPE = `Set up tdoc and make my first doc: ${RECIPE_URL}`;
// The document behind "See an example": a portrait with its threads resolved,
// so a stranger can see what a commented, revised doc looks like before they
// have one of their own.
export const EXAMPLE_URL = '/d/what-ai-knows/v/12';
export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.';
export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work';
// The one concept the page states, once, the moment the person has picked
// the door that needs it.
export const TWO_WINDOWS = 'Two windows: you read and comment here. Your agent writes and fixes.';
export const WAITING = 'Waiting for your agent…';
export const STILL_WAITING = 'Still waiting — did you paste it into your agent?';
// How often the waiting state asks the server what the agent has done. Only
// while waiting: the dialog stops the moment the doc arrives or closes.
const POLL_MS = 3000;
// Past this the wait reads as stuck, and the line changes to ask the one
// question that resolves it.
const STILL_WAITING_MS = 5 * 60 * 1000;

// The one rendering of the first-doc recipe. Shown inside the "Use my own
// agent" door here, and behind the "Build it with your AI" card in the Docs Hub.
export function FirstDocRecipe({ onCopied }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="tdoc-recipe-wrap">
      <code>{FIRST_DOC_RECIPE}</code>
      <button
        type="button"
        className={copied ? 'done' : undefined}
        onClick={() => copyText(FIRST_DOC_RECIPE).then((ok) => { setCopied(ok); if (ok) onCopied?.(); })}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// "agent", underlined, with its definition on hover. The definition is state
// that appears on demand rather than a paragraph everyone reads.
function AgentTerm() {
  return (
    <span className="tdoc-term">
      agent
      <span className="tdoc-term-tip" role="tooltip">
        {AGENT_DEFINITION}
        <b>{AGENT_NAMES}</b>
      </span>
    </span>
  );
}

// Bridge 1. The person has pasted (or is about to paste) the line into their
// agent; everything after that happens in another window. The server sees
// each step the agent takes — the token it mints, the first doc it publishes —
// so this state is read off the server rather than guessed, and the page
// leaves for the doc on its own when it arrives.
function OwnAgentDoor({ onOpenChange }) {
  const [copied, setCopied] = useState(false);
  const [record, setRecord] = useState(null);
  const [stuck, setStuck] = useState(false);
  const copiedAt = useRef(null);

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
          location.href = `/d/${encodeURIComponent(next.first_doc)}/v/1`;
          return;
        }
      } catch {}
      if (copiedAt.current && Date.now() - copiedAt.current > STILL_WAITING_MS) setStuck(true);
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  let status = 'Copy the line, paste it into your agent, and press Enter.';
  let live = false;
  if (record?.agent_connected) {
    status = 'Your agent is connected. Publishing your first doc…';
    live = true;
  } else if (stuck) {
    status = STILL_WAITING;
  } else if (copied) {
    status = WAITING;
    live = true;
  }

  return (
    <div className="tdoc-own-door">
      <p className="tdoc-two-windows">{TWO_WINDOWS}</p>
      <FirstDocRecipe onCopied={() => { copiedAt.current = Date.now(); setCopied(true); postOnboardingEvent('copy_clicked').catch(() => {}); }} />
      <p className={`tdoc-wait${live ? ' live' : ''}`} role="status" aria-live="polite">
        {live ? <span className="tdoc-wait-dot" aria-hidden="true" /> : null}
        {status}
      </p>
      <p className="muted">This page will open your doc the moment it is published. Keep it open, or come back to it later.</p>
      <p className="muted">
        To self-host, add: <strong>Publish it to my own Cloudflare, not the hosted service.</strong>
      </p>
      <a className="tdoc-onboarding-link" href="/start">Read the full tutorial</a>
      <button type="button" className="tdoc-door-back" onClick={() => onOpenChange(false)}>Close</button>
    </div>
  );
}

function WaitlistDoor({ onOpenChange }) {
  return (
    <div className="tdoc-own-door">
      <p className="tdoc-waitlist-done">You're on the list.</p>
      <p className="muted">Until then, the example is yours to argue with — leave a comment on any sentence or chart.</p>
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
              <strong>Use my own <AgentTerm /></strong>
              {/* A phone has no hover, so the definition sits under the title
                  there — one line, where the tooltip would have been. */}
              <span className="tdoc-agent-def">{AGENT_DEFINITION} {AGENT_NAMES}</span>
              <span>Copy one line into it. It publishes something you wrote recently.</span>
              <em>{signedIn ? 'Get the line' : 'Sign in to start'}</em>
            </button>
            <button type="button" className="tdoc-door" onClick={chooseWaitlist}>
              <strong>Use tdoc's agent — coming soon</strong>
              <span>Join the waitlist, and argue with the example in the meantime.</span>
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
