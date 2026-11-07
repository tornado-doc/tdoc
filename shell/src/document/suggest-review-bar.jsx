import React, { useLayoutEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';

// The review bar for AI suggestions in the doc (flag askEditV2): which one
// you are on, ↑ ↓ between them, Reject / Accept it, or all of them. One
// component on both widths: a floating bar at the bottom of the reading
// column on a desktop, a bottom sheet on a phone (chrome.css). Why not the
// demo bar (DemoRewriteBar): that one is the homepage's scripted call to
// action, with no review controls.
export function SuggestReviewBar({ suggestions, narrow = false }) {
  const { ordered, active, busy, deciding, elsewhere } = suggestions;
  const ref = useRef(null);
  const showing = Boolean(ordered.length || busy || elsewhere);
  // On a phone the sheet sits where the comment button is: the page lifts
  // the button above it (chrome.css, data-tdoc-suggest-bar).
  useLayoutEffect(() => {
    if (!narrow || !showing || !ref.current) return undefined;
    document.body.dataset.tdocSuggestBar = '1';
    document.body.style.setProperty('--tdoc-suggest-bar-h', `${ref.current.offsetHeight}px`);
    return () => { delete document.body.dataset.tdocSuggestBar; document.body.style.removeProperty('--tdoc-suggest-bar-h'); };
  });
  if (!showing) return null;
  const at = active ? ordered.findIndex((p) => p.key === active.key) + 1 : 0;
  const who = active?.set.agent?.name || 'tdoc AI';
  // Whose agent it is, beside its name, as a comment card signs it: a name
  // is the agent's own choice, the owner is the account it came from.
  const owner = active?.set.agent?.owner?.display || active?.set.by || '';
  const what = active ? (active.set.summary || active.set.instruction || '') : '';
  return <div ref={ref} className={`tdoc-suggest-bar${narrow ? ' is-narrow' : ''}`} role="region" aria-label="Review AI suggestions">
    {busy && !ordered.length ? <span className="tdoc-suggest-bar-text"><span className="tdoc-demo-rewrite-bar-dot tdoc-suggest-dot" aria-hidden="true" />{busy.label}</span> : !ordered.length ? <>
      <span className="tdoc-suggest-bar-text">
        <Sparkles size={14} aria-hidden="true" className="tdoc-suggest-bar-mark" />
        <span className="tdoc-suggest-bar-what">{elsewhere.count === 1 ? '1 suggestion is' : `${elsewhere.count} suggestions are`} on v{elsewhere.version}</span>
      </span>
      <span className="tdoc-suggest-bar-actions">
        <AppButton variant="primary" size="s" onClick={() => suggestions.openVersion(elsewhere.version)}>Open v{elsewhere.version}</AppButton>
      </span>
    </> : <>
      <span className="tdoc-suggest-bar-text">
        <Sparkles size={14} aria-hidden="true" className="tdoc-suggest-bar-mark" />
        <span className="tdoc-suggest-bar-who">{who}</span>
        {owner && owner !== who ? <span className="tdoc-suggest-bar-owner">· {owner}</span> : null}
        {what ? <span className="tdoc-suggest-bar-what" title={what}>{what}</span> : null}
        <span className="tdoc-suggest-bar-count">{at || 1} of {ordered.length}</span>
      </span>
      <span className="tdoc-suggest-bar-actions">
        {ordered.length > 1 ? <>
          <AppButton variant="icon" size="s" aria-label="Previous suggestion" title="Previous" onClick={suggestions.prev}><ChevronUp size={16} /></AppButton>
          <AppButton variant="icon" size="s" aria-label="Next suggestion" title="Next" onClick={suggestions.next}><ChevronDown size={16} /></AppButton>
        </> : null}
        {ordered.length > 1 ? <AppButton variant="quiet" size="s" disabled={deciding} onClick={suggestions.rejectAll}>Reject all</AppButton> : null}
        {ordered.length > 1 ? <AppButton variant="secondary" size="s" disabled={deciding} onClick={suggestions.acceptAll}>Accept all</AppButton> : null}
        <AppButton variant="secondary" size="s" disabled={deciding || !active} title="Reject (Esc)" onClick={() => suggestions.reject()}>Reject</AppButton>
        <AppButton variant="primary" size="s" data-suggest-accept="" disabled={deciding || !active} title="Accept (⌘↵)" onClick={() => suggestions.accept()}>{deciding ? 'Publishing…' : 'Accept'}</AppButton>
      </span>
    </>}
  </div>;
}

// Accept / Reject at the suggestion itself, drawn by the shell over the
// frame where the active suggestion ends (desktop; on a phone the bottom
// sheet is right there). The frame only says where; the buttons are ours.
export function SuggestInlineChip({ suggestions, style }) {
  const { active, deciding } = suggestions;
  if (!active) return null;
  return <div className="tdoc-suggest-chip" style={style} role="group" aria-label="This suggestion">
    <AppButton variant="primary" size="s" aria-label="Accept suggestion" title="Accept (⌘↵)" disabled={deciding} onClick={() => suggestions.accept()}><Check size={14} /></AppButton>
    <AppButton variant="secondary" size="s" aria-label="Reject suggestion" title="Reject (Esc)" disabled={deciding} onClick={() => suggestions.reject()}><X size={14} /></AppButton>
  </div>;
}
