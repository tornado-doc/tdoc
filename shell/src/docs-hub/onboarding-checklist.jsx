import React, { useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

// The onboarding, after setup: four things, rendered from the record's own
// timestamps rather than a second set of counters. Setup and the seeded doc
// are already done by the time anyone reads this, so it opens at two of four
// — the progress is real, not a welcome mat.
//
// Collapsing is a view preference, not a step, so it lives in this browser and
// not on the account: a person who tidies it away on their laptop has not told
// us anything about their phone.
const STORE_KEY = 'tdoc.onboarding.collapsed';

function stored() {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}
function remember(value) {
  try { localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch {}
}

export function onboardingSteps(record, firstDocHref) {
  const r = record || {};
  return [
    { id: 'connect', label: 'Connect your agent', done: Boolean(r.agent_connected || r.published_first), href: '/setup' },
    { id: 'doc', label: 'Your first doc', done: Boolean(r.published_first || r.first_doc), href: firstDocHref },
    { id: 'comment', label: 'Say what you think about one sentence', done: Boolean(r.commented || r.revised), href: firstDocHref },
    { id: 'revise', label: 'Send it back and read v2', done: Boolean(r.revised), href: firstDocHref },
  ];
}

export function OnboardingChecklist({ record, docs }) {
  const [collapsed, setCollapsed] = useState(stored);
  // Only link to the doc if it is still in their list: a seeded doc they
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

  if (collapsed) {
    return (
      <button type="button" className="onb-chip" onClick={() => toggle(false)}>
        <span className="onb-chip-count">{done}/{steps.length}</span> Finish setting up
      </button>
    );
  }

  return (
    <section className="onb-card" aria-label="Getting started">
      <header>
        <div>
          <h2>Finish setting up</h2>
          <p>{done} of {steps.length}</p>
        </div>
        <button type="button" className="onb-hide" onClick={() => toggle(true)} aria-label="Hide">
          <X size={15} />
        </button>
      </header>
      <div className="onb-bar" aria-hidden="true"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol>
        {steps.map((step) => (
          <li key={step.id} className={step.done ? 'done' : ''}>
            <span className="onb-tick">{step.done ? <Check size={12} strokeWidth={3} /> : null}</span>
            {!step.done && step.href
              ? <a href={step.href}>{step.label}</a>
              : <span>{step.label}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
