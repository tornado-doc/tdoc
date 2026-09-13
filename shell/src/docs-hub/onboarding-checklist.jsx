import React, { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { ClaudeMark, OpenAIMark } from '../agent-marks.jsx';

// The onboarding, after setup. Four things, rendered from the record's own
// timestamps rather than a second set of counters.
//
// Setup and the seeded doc are already done by the time anyone reads this, so
// it opens at two of four. The progress is real, not a welcome mat.
//
// Collapsing is a view preference, not a step, so it lives in this browser and
// not on the account: somebody who tidies it away on their laptop has not told
// us anything about their phone.
// Two preferences, both this browser's: whether the list is expanded, and
// whether it is here at all.
const STORE_KEY = 'tdoc.onboarding.collapsed';
const OPEN_KEY = 'tdoc.onboarding.open';

function stored() {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}
function remember(value) {
  try { localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch {}
}
function storedOpen() {
  // Open until they close it. The first arrival should see the whole shape
  // once, and a modal to achieve that would be the second thing to open
  // itself within a minute of the gate, which is the pattern that performs
  // worst: a list opened from is completed far more often than one thrown.
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === null ? true : v === '1';
  } catch { return true; }
}
function rememberOpen(value) {
  try { localStorage.setItem(OPEN_KEY, value ? '1' : '0'); } catch {}
}

// The four rows, in the only order they can happen in. Every one of them
// stands on the same object -- the doc this person made in row 2 -- so the
// list is a single story about a single document rather than four errands.
//
// That ordering is not decoration: you cannot comment on a doc that does not
// exist, and you cannot ask an agent to fix comments nobody has left. A row
// whose turn has not come is shown and not offered, so the shape of the whole
// thing is visible from the first arrival without inviting a click that would
// land nowhere.
export function onboardingSteps(record, firstDocHref) {
  const r = record || {};
  const steps = [
    { id: 'connect', label: 'Set up the tdoc skill', done: Boolean(r.agent_connected || r.published_first), href: '/setup' },
    { id: 'create', label: 'Create your first tdoc', done: Boolean(r.first_doc), href: '/setup?step=doc' },
    // Both rows open the same doc, and each says which of its two things it
    // came for: the question already on the page, or the card carrying the
    // line for the agent. Landing on the bare URL left the last two rows
    // pointing at the same wall of text.
    { id: 'comment', label: 'Leave a comment on your doc', done: Boolean(r.commented || r.revised), href: firstDocHref && `${firstDocHref}?step=comment` },
    { id: 'revise', label: 'Tell your agent to fix the comments', done: Boolean(r.revised), href: firstDocHref && `${firstDocHref}?step=fix` },
  ];
  // Locked until everything above it is done. The first unfinished row is the
  // only one anybody can act on.
  let reached = true;
  return steps.map((step) => {
    // A row is out of reach either because its turn has not come, or because
    // the doc it stands on is gone. Deleting the journey's doc used to leave
    // row 4 in full ink with no href: it read as the next thing to do and did
    // nothing when clicked.
    const locked = !step.done && (!reached || !step.href);
    if (!step.done) reached = false;
    return { ...step, locked };
  });
}

// Notion's rows carry a thumbnail because theirs are recognisable: a Gmail
// logo, a calendar grid, a waveform with a record button. The first attempt at
// ours was grey bars, which is why it read as a smudge and got deleted. These
// carry the things this product is actually recognised by — the two agents'
// own marks, the anchor highlight's yellow, a comment card, a v2 chip.
function Thumb({ id }) {
  if (id === 'connect') {
    return (
      <span className="onb-thumb agents" aria-hidden="true">
        <ClaudeMark size={19} />
        <OpenAIMark size={17} />
      </span>
    );
  }
  if (id === 'create') {
    return (
      <span className="onb-thumb" aria-hidden="true">
        <i className="t-line title" />
        <i className="t-line w95" />
        <i className="t-mark w70" />
      </span>
    );
  }
  if (id === 'comment') {
    return (
      <span className="onb-thumb" aria-hidden="true">
        <i className="t-line title short" />
        <i className="t-mark w55" />
        <i className="t-card" />
      </span>
    );
  }
  return (
    <span className="onb-thumb" aria-hidden="true">
      <i className="t-line title short" />
      <i className="t-mark w55 pale" />
      <i className="t-card done"><Check size={10} strokeWidth={3.5} /></i>
      <i className="t-ver">v2</i>
    </span>
  );
}

export function OnboardingChecklist({ record, docs }) {
  const [collapsed, setCollapsed] = useState(stored);
  const [open, setOpen] = useState(storedOpen);
  // Only link to the doc while it is still in their list: a seeded doc they
  // deleted would otherwise leave every row pointing at a 404.
  const first = record && record.first_doc;
  const alive = Boolean(first && (docs || []).some((d) => d && d.slug === first));
  const href = alive ? `/d/${encodeURIComponent(first)}` : null;
  const steps = onboardingSteps(record, href);
  const done = steps.filter((s) => s.done).length;
  // Nothing to say before the journey starts, and nothing left to say after it
  // ends: the card is for the middle.
  if (!record || !record.started || done === steps.length) return null;

  const toggle = (next) => { setCollapsed(next); remember(next); };
  const setOpenState = (next) => { setOpen(next); rememberOpen(next); };
  // There is only ever one thing to do. Finished steps need no room and
  // unreached ones need none yet, so at rest the card carries the next step
  // alone. The heading and the bar stay: without them a count and a sentence
  // do not say what they are, or why they are on this page.
  const next = steps.find((s) => !s.done) || steps[steps.length - 1];

  if (collapsed) {
    return (
      <button type="button" className="onb-chip" onClick={() => toggle(false)}>
        <span className="onb-chip-count">{done}/{steps.length}</span> Finish setting up
      </button>
    );
  }

  return (
    <section className="onb-card" aria-label="Finish setting up">
      <header>
        <div>
          <h2>Finish setting up</h2>
          <p>{done} of {steps.length}</p>
        </div>
        <div className="onb-acts">
          <button
            type="button"
            onClick={() => setOpenState(!open)}
            aria-label={open ? 'Show only the next step' : 'Show all steps'}
            aria-expanded={open}
          >
            <ChevronDown size={15} style={open ? { transform: 'rotate(180deg)' } : undefined} />
          </button>
          <button type="button" onClick={() => toggle(true)} aria-label="Hide"><X size={15} /></button>
        </div>
      </header>
      {/* The mark rides the bar. Notion puts its duck on the marker for the
          same reason: a bar alone is a measurement, and a thing standing on it
          is somebody's progress. The puck is positioned across the track minus
          its own width, so it never hangs off either end -- at zero its left
          edge sits on the start, at full its right edge sits on the finish. */}
      <div className="onb-bar" aria-hidden="true">
        <i style={{ width: `${(done / steps.length) * 100}%` }} />
        <span className="onb-mark" style={{ left: `calc(${(done / steps.length) * 100}% - ${(done / steps.length) * 26}px)` }}>
          <img src="/tdoc_logo.svg" width="17" height="17" alt="" data-tdoc-dark="invert" />
        </span>
      </div>
      <ol>
        {(open ? steps : [next]).map((step) => {
          const body = (
            <>
              <span className="onb-tick">{step.done ? <Check size={12} strokeWidth={3} /> : null}</span>
              <span className="onb-label">{step.label}</span>
              <Thumb id={step.id} />
            </>
          );
          return (
            <li key={step.id} className={step.done ? 'done' : step.locked ? 'locked' : ''}>
              {/* A finished row still goes somewhere, and where it goes is still
                  worth going: row 1 is how you connect a second machine, row 2
                  is how you make another doc -- the page it opens was built
                  for exactly the person who has already done it once. Struck
                  through says it is finished; it does not have to mean the
                  door is gone. Only a locked row is inert. */}
              {step.locked || !step.href
                ? <span className="onb-row">{body}</span>
                : <a href={step.href}>{body}</a>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
