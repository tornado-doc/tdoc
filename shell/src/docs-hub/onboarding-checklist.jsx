import React, { useState } from 'react';
import { Check, X } from 'lucide-react';

// The onboarding, after setup. Four things, rendered from the record's own
// timestamps rather than a second set of counters, each with a small drawing
// of what it produces — the way Notion's setup list carries a thumbnail per
// row, because a row of labels alone makes four abstractions and a reader has
// to imagine all of them.
//
// Setup and the seeded doc are already done by the time anyone reads this, so
// it opens at two of four. The progress is real, not a welcome mat.
//
// Collapsing is a view preference, not a step, so it lives in this browser and
// not on the account: somebody who tidies it away on their laptop has not told
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

// Four drawings at the product's own proportions: a composer, a page, a page
// with a card in its margin, and that card answered. Built from divs rather
// than art, so they follow the theme and cost nothing to ship.
function Thumb({ id }) {
  if (id === 'connect') {
    return (
      <span className="onb-thumb" aria-hidden="true">
        <i className="t-line w60" />
        <i className="t-box" />
      </span>
    );
  }
  if (id === 'doc') {
    return (
      <span className="onb-thumb" aria-hidden="true">
        <i className="t-line w70 strong" />
        <i className="t-line w90" />
        <i className="t-line w50 mark" />
      </span>
    );
  }
  if (id === 'comment') {
    return (
      <span className="onb-thumb withcard" aria-hidden="true">
        <i className="t-line w60 strong" />
        <i className="t-line w45 mark" />
        <i className="t-card" />
      </span>
    );
  }
  return (
    <span className="onb-thumb withcard" aria-hidden="true">
      <i className="t-line w60 strong" />
      <i className="t-line w45" />
      <i className="t-card done"><Check size={9} strokeWidth={3.5} /></i>
      <i className="t-ver">v2</i>
    </span>
  );
}

export function OnboardingChecklist({ record, docs }) {
  const [collapsed, setCollapsed] = useState(stored);
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
        <button type="button" className="onb-hide" onClick={() => toggle(true)} aria-label="Hide">
          <X size={15} />
        </button>
      </header>
      <div className="onb-bar" aria-hidden="true"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol>
        {steps.map((step) => {
          const body = (
            <>
              <span className="onb-tick">{step.done ? <Check size={12} strokeWidth={3} /> : null}</span>
              <span className="onb-label">{step.label}</span>
              <Thumb id={step.id} />
            </>
          );
          return (
            <li key={step.id} className={step.done ? 'done' : ''}>
              {!step.done && step.href ? <a href={step.href}>{body}</a> : <span className="onb-row">{body}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
