import React from 'react';

// One set of badge rules for "what the agents are doing" on every surface:
// the doc page's Ask AI button and the widget's Send to agent button.
//   counts: summarizeHandoffSurfaces buckets as numbers (ready, waiting,
//   received, failed, replied); unread: new agent replies for this viewer.
// The badge is a dot, never a number (the label says the numbers):
//   unread (an answer to read) > ready (to send) > failed (none arrived).
export function agentActivitySummary(counts = {}, unread = 0) {
  const ready = counts.ready || 0;
  const waiting = (counts.waiting || 0) + (counts.received || 0);
  const failed = counts.failed || 0;
  const details = [
    ready ? `${ready} to send` : null,
    waiting ? `${waiting} waiting for agent` : null,
    unread ? `${unread} new agent ${unread === 1 ? 'reply' : 'replies'}` : null,
    failed ? `${failed} not delivered` : null,
  ].filter(Boolean).join(' · ');
  const badge = unread ? 'unread' : ready ? 'ready' : failed ? 'failed' : null;
  return { ready, waiting, failed, unread, details, badge };
}

export function agentActivityLabel(name, summary) {
  return `${name}${summary.details ? ` · ${summary.details}` : ''}`;
}

export function AgentActivityBadge({ summary }) {
  return summary.badge ? <span className={`tdoc-send-agent-badge is-${summary.badge}`} aria-hidden="true" /> : null;
}

// The button: an icon, the surface's own word ("Ask AI" on the doc, "Send to
// agent" in the widget), and the badge. Everything else is the caller's.
export function AgentActivityButton({ icon, label, summary, className = '', labelClassName = '', ...props }) {
  const full = agentActivityLabel(label, summary);
  return (
    <button type="button" className={className} aria-label={full} title={full} {...props}>
      {icon}
      <span className={labelClassName}>{label}</span>
      <AgentActivityBadge summary={summary} />
    </button>
  );
}
