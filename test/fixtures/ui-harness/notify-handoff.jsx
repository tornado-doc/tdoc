// Mounts the Send to agent dialog on its own, for test/notify-handoff-ui.test.js.
// The document page and the feedback overlay render this same component.
// ?view=status mounts comment-card handoff lines instead (handoff-status-line).
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { NotifyHandoffPanel } from '../../../shell/src/document/notify-handoff.jsx';
import { HandoffStatusChips } from '../../../shell/src/document/handoff-status-line.jsx';

const params = new URLSearchParams(location.search);
const ids = JSON.parse(params.get('ids') || '[]');
const avoid = params.get('avoid') ? { provider: 'raft', agent_name: params.get('avoid') } : null;

const MIN = 60000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();
const base = (id, partial) => ({
  id,
  status: 'open',
  author: { kind: 'human', login: 'julie' },
  created: iso(48 * 60 * MIN),
  replies: [],
  handoff_status: 'sent',
  handoff_id: `h-${id}`,
  handoff_to: { provider: 'raft', agent_name: 'smarter-tdoc-claw' },
  ...partial,
});
const CARDS = [
  base('queued', { handoff_at: iso(2 * MIN), handoff_delivery: { status: 'delivered', at: iso(2 * MIN), expires_at: later(24 * 60 * MIN) } }),
  base('picked', { handoff_at: iso(6 * MIN), handoff_acked_at: iso(3 * MIN), handoff_delivery: { status: 'delivered', at: iso(6 * MIN), expires_at: later(60 * MIN) } }),
  base('stale', { handoff_at: iso(7 * MIN), handoff_delivery: { status: 'delivered', at: iso(7 * MIN), expires_at: later(60 * MIN) } }),
  base('expired', { handoff_at: iso(25 * 60 * MIN), handoff_delivery: { status: 'delivered', at: iso(25 * 60 * MIN), expires_at: iso(60 * MIN) } }),
  base('replied', { handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'r', author: { kind: 'agent', login: 'claw' }, created: iso(1 * MIN) }] }),
  base('question', { handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'q', author: { kind: 'agent', login: 'claw' }, agent_status: 'question', created: iso(1 * MIN) }] }),
  base('resolved', { status: 'applied', handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'q2', author: { kind: 'agent', login: 'claw' }, agent_status: 'question', created: iso(1 * MIN) }] }),
];

function StatusCards() {
  const [log, setLog] = useState([]);
  return (
    <div style={{ display: 'grid', gap: 12, padding: 16, width: 300 }}>
      {CARDS.map((c) => (
        <article key={c.id} className="tdoc-margin-comment active" data-comment-id={c.id} style={{ position: 'static', width: 280 }}>
          <div className="tdoc-status-row">
            <HandoffStatusChips
              comment={c}
              onResend={async (x) => { await new Promise((r) => setTimeout(r, 150)); setLog((l) => [...l, `resend:${x.id}`]); }}
              onSendElsewhere={(x) => setLog((l) => [...l, `elsewhere:${x.id}`])}
            />
          </div>
          <div className="text">please fix this</div>
        </article>
      ))}
      <output id="log">{log.join(',')}</output>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  params.get('view') === 'status'
    ? <StatusCards />
    : <NotifyHandoffPanel slug="doc" open commentIds={ids} avoid={avoid} onClose={() => {}} />,
);
