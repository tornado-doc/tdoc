// Mounts the Send to agent dialog on its own, for test/notify-handoff-ui.test.js.
// The document page and the feedback overlay render this same component.
// ?view=status mounts comment-card handoff lines instead (handoff-status-line).
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { NotifyHandoffPanel } from '../../../shell/src/document/notify-handoff.jsx';
import { HandoffStatusChips } from '../../../shell/src/document/handoff-status-line.jsx';
import { DocumentSendAgentAction, DocumentSendToAgentButton } from '../../../shell/src/document/document-toolbar.jsx';
import { HandoffDetailsPanel } from '../../../shell/src/document/handoff-details.jsx';
import { AskAiPanel } from '../../../shell/src/document/ask-ai-panel.jsx';
import { useCommentArea } from '../../../shell/src/document/comment-area.js';
import { summarizeHandoffSurfaces } from '../../../shell/src/document/handoff-state.js';
import { isThreadUnread } from '../../../shell/src/document/thread-seen.js';
import { DesktopCommentLayer, MobileCommentDrawer } from '../../../shell/src/document/comment-layer.jsx';
import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx';
import { AgentMentionContext } from '../../../shell/src/document/mention-field.jsx';
import { TDOC_AI } from '../../../shell/src/document/ai-answerer.js';
import { AGENT_TAG_JOINER, agentMentionName } from '../../../shell/src/document/agent-choices.js';
import { anchorFromSelection } from '../../../shell/src/document/model.js';

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
  text: 'please fix this',
  replies: [],
  handoff_status: 'sent',
  handoff_id: `h-${id}`,
  handoff_to: { provider: 'raft', agent_name: 'smarter-tdoc-claw' },
  ...partial,
});
const CARDS = [
  base('queued', { handoff_at: iso(2 * MIN), handoff_delivery: { status: 'delivered', at: iso(2 * MIN), expires_at: later(24 * 60 * MIN) } }),
  base('local-queued', { handoff_at: iso(2 * MIN), handoff_to: { provider: 'local', agent_name: 'Claude' }, handoff_delivery: { status: 'queued', at: iso(2 * MIN) } }),
  base('failed', { text: 'Add a conclusion to the report', handoff_at: iso(3 * MIN), handoff_delivery: { status: 'failed', error: 'request_403', at: iso(3 * MIN) } }),
  base('picked', { text: 'Shorten the third section', handoff_at: iso(6 * MIN), handoff_acked_at: iso(3 * MIN), handoff_delivery: { status: 'delivered', at: iso(6 * MIN), expires_at: later(60 * MIN) } }),
  base('stale', { handoff_at: iso(7 * MIN), handoff_delivery: { status: 'delivered', at: iso(7 * MIN), expires_at: later(60 * MIN) } }),
  base('expired', { handoff_at: iso(25 * 60 * MIN), handoff_delivery: { status: 'delivered', at: iso(25 * 60 * MIN), expires_at: iso(60 * MIN) } }),
  base('replied', { text: 'Fix the heading wording', handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'r', author: { kind: 'agent', login: 'claw' }, text: 'Fixed the wording.', created: iso(1 * MIN) }] }),
  base('question', { text: 'Should pricing be per seat?', handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'q', author: { kind: 'agent', login: 'claw' }, text: 'What should I change?', agent_status: 'question', created: iso(1 * MIN) }] }),
  base('partial', { text: 'Add competitor pricing data', handoff_at: iso(10 * MIN), handoff_delivery: { status: 'delivered', at: iso(10 * MIN) }, replies: [{ id: 'p', author: { kind: 'agent', login: 'claw' }, text: 'One price is missing.', agent_status: 'partial', created: iso(1 * MIN) }] }),
  base('resolved', { text: 'Turn the table into a chart', status: 'applied', handoff_at: iso(9 * MIN), handoff_delivery: { status: 'delivered', at: iso(9 * MIN) }, replies: [{ id: 'q2', author: { kind: 'agent', login: 'claw' }, text: 'The change is live.', agent_status: 'applied', created: iso(1 * MIN) }] }),
  base('human-followup', { text: 'The opening sentence is too long', handoff_at: iso(12 * MIN), handoff_delivery: { status: 'delivered', at: iso(12 * MIN) }, replies: [{ id: 'q3', author: { kind: 'agent', login: 'claw' }, agent_status: 'question', created: iso(10 * MIN) }, { id: 'h3', author: { kind: 'human', login: 'julie' }, created: iso(8 * MIN) }] }),
  base('new-comment', { text: 'Clarify the chart caption', handoff_status: 'note', handoff_id: null, handoff_at: null, handoff_delivery: null }),
  base('resent-followup', { handoff_at: iso(2 * MIN), handoff_delivery: { status: 'delivered', at: iso(2 * MIN) }, replies: [{ id: 'q4', author: { kind: 'agent', login: 'claw' }, agent_status: 'question', created: iso(10 * MIN) }, { id: 'h4', author: { kind: 'human', login: 'julie' }, created: iso(8 * MIN) }] }),
];

function StatusCards() {
  const [log, setLog] = useState([]);
  return (
    <div style={{ display: 'grid', gap: 12, padding: 16, width: 300 }}>
      {CARDS.map((c) => (
        <article key={c.id} className="tdoc-margin-comment active" data-comment-id={c.id} style={{ position: 'static', width: 280 }}>
          <div className="tdoc-status-row">
            {c.status === 'applied' ? <span className="tdoc-resolved-chip">✅ Done</span> : null}
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

function ActivityDemo() {
  const [open, setOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [askDraft, setAskDraft] = useState('');
  const [log, setLog] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState('comments');
  const phone = window.innerWidth < 700;
  if (phone) document.body.classList.add('tdoc-narrow');
  const activityCards = CARDS.filter((c) => (params.has('failed') || c.id !== 'failed') && (!params.has('noready') || !['human-followup', 'new-comment'].includes(c.id)))
    .map((card) => params.has('mixed') && card.id === 'failed' ? { ...card, handoff_resend_allowed: false } : card);
  const commentArea = useCommentArea({ comments: activityCards, slug: 'doc', handoffViewer: 'julie', isOwner: true });
  const { seenMap } = commentArea;
  const buckets = summarizeHandoffSurfaces(activityCards);
  const counts = Object.fromEntries(Object.entries(buckets).map(([state, items]) => [state, items.length]));
  const unreadCount = activityCards.filter((card) => isThreadUnread(card, seenMap, 'julie')).length;
  const visibleUnread = params.get('unread') === '0' ? 0 : unreadCount;
  const unread = Number(params.get('badge')) || visibleUnread;
  return <>
    <div className="tdoc-bar" style={{ display: 'flex', alignItems: 'center', gap: phone ? 10 : 18, height: 48, padding: '0 16px', background: '#fff', borderBottom: '1px solid #e8e7e3' }}>
      <span>🌪</span><strong style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>RaftBench pricing plan</strong>
      <span style={{ flex: 1 }} />
      {!phone ? <span style={{ color: '#888' }}>Edited 2m ago</span> : null}
      <DocumentSendAgentAction counts={counts} unread={unread} open={open} onOpenChange={setOpen}>
        <AskAiPanel open={open} draft={askDraft} onDraft={setAskDraft} targetKey="tdoc-ai" onTarget={() => {}}
          targets={[{ key: 'tdoc-ai', label: 'tdoc AI', tdocAi: true }]} turns={[]} busy={false} remaining={5}
          onAsk={() => {}} onKeep={() => {}} onPost={() => {}} readyCount={counts.ready}
          onSendReady={() => setLog(`send-ready:${buckets.ready.map((item) => item.id).join(',')}`)}
          activityOpen={activityOpen} onActivityOpen={setActivityOpen} unreadCount={visibleUnread}>
        <HandoffDetailsPanel slug="doc" open={open} comments={activityCards} seenMap={seenMap} handoffViewer="julie" onClose={() => setOpen(false)}
          onJump={(id) => setLog(`jump:${id}`)} onSendReady={(selected) => { setLog(`send-ready:${selected.join(',')}`); setOpen(false); }}
          onSendElsewhere={(comment) => { setLog(`elsewhere:${comment.id}`); setOpen(false); }}
          onMarkRead={commentArea.markRead} onMarkAllRead={commentArea.markAllRead} autoRead={params.has('auto-read')} />
        <button id="activity-refresh" type="button" onClick={() => setLog('refreshed')}>Refresh comments</button>
        </AskAiPanel>
      </DocumentSendAgentAction>
      {!phone ? <DocumentSendToAgentButton count={counts.ready} onClick={() => setLog(`send-plane:${buckets.ready.map((item) => item.id).join(',')}`)} /> : null}
      {!phone ? <><strong>Share</strong><span>⋯</span><span style={{ color: '#888' }}>Tdoc ▾</span><span style={{ background: '#1652f0', color: '#fff', borderRadius: '50%', width: 26, height: 26, display: 'grid', placeItems: 'center' }}>J</span></> : null}
    </div>
    <main style={{ margin: phone ? '28px 20px' : '70px 0 0 145px', maxWidth: 720, fontSize: phone ? 16 : 20, lineHeight: 2 }}>
      <h1 style={{ fontSize: phone ? 24 : 32 }}>RaftBench pricing plan</h1>
      <p>We propose charging per team seat, with a free personal tier and team seats at $8 per month.</p>
      <p>The third section compares three options. The final recommendation is a seat based plan.</p>
    </main>
    {!phone ? <div style={{ position: 'absolute', left: '72%', top: 145 }}><PinDemo seenMap={seenMap} /></div>
      : <MobileCommentDrawer open={drawerOpen} onOpenChange={setDrawerOpen} comments={activityCards} openCount={activityCards.length}
          unread={visibleUnread > 0} pinIds={new Set()} currentUser="julie" isOwner onStartComment={() => {}}
          askAi={params.has('unified') ? <div>Ask AI panel</div> : null} tab={drawerTab} onTab={setDrawerTab}
          sendAction={params.has('unified') ? <DocumentSendToAgentButton count={counts.ready}
            onClick={() => { setDrawerOpen(false); setLog(`send-plane:${buckets.ready.map((item) => item.id).join(',')}`); }} /> : null} />}
    <output id="activity-log">{log}</output>
  </>;
}

function PinDemo({ seenMap = {} }) {
  const viewer = params.get('viewer') || 'julie';
  const pins = ['question', 'partial', 'resolved', 'failed', 'picked', 'queued', 'local-queued'];
  const nearStale = params.has('near-stale') ? base('near-stale', {
    handoff_at: iso(4 * MIN + 45000),
    handoff_delivery: { status: 'delivered', at: iso(4 * MIN + 45000), expires_at: later(24 * 60 * MIN) },
  }) : null;
  const byId = new Map([...CARDS, ...(nearStale ? [nearStale] : [])].map((card) => [card.id, card]));
  const item = (id) => ({ comment: { id, resolved: byId.get(id).status === 'applied' } });
  const clusters = [
    ...pins.slice(0, 5).map((id, index) => ({ key: id, y: 50 + index * 58, items: [item(id)] })),
    { key: 'group', y: 360, items: [item('queued'), item('local-queued')] },
    ...(nearStale ? [{ key: 'near-stale', y: 410, items: [item('near-stale')] }] : []),
  ];
  return <div id="tdoc-pin-layer" style={{ position: 'relative', height: 450, width: 180 }}>
    <DesktopCommentLayer clusters={clusters} commentsById={byId} seenMap={seenMap} frameScrollY={0} frameTop={0}
      pinLeft={60} openComment={null} openClusterKey={null} pinIds={new Set(pins)}
      currentUser={viewer} isOwner={viewer === 'owner'} hoveredAnchorId={params.get('hover') || null}
      onOpenComment={() => {}} onOpenCluster={() => {}} />
  </div>;
}

function MobileFabDemo() {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(null);
  const [posted, setPosted] = useState('');
  const active = params.get('state') === 'active';
  const visible = active ? [CARDS.find((c) => c.id === 'replied'), CARDS.find((c) => c.id === 'question')]
    : params.get('state') === 'empty' ? [] : [CARDS.find((c) => c.id === 'resolved')];
  document.body.classList.add('tdoc-narrow');
  return <>
    <div className="tdoc-bar" style={{ height: 48, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 12, background: '#fff', borderBottom: '1px solid #e8e7e3' }}><span>🌪</span><strong>RaftBench pricing plan</strong></div>
    <main style={{ padding: '32px 20px', fontSize: 16, lineHeight: 1.8 }}><h1>RaftBench pricing plan</h1><p>We propose charging per team seat, with a free personal tier and team seats at $8 per month.</p><p>The third section compares three options. The final recommendation is a seat based plan.</p></main>
    <MobileCommentDrawer open={open} onOpenChange={setOpen} comments={visible} openCount={active ? 2 : 0} unread={active}
      pinIds={new Set()} currentUser="julie" isOwner onStartComment={() => setComposing('comment')}
      onAskAi={() => setComposing('ask-ai')} />
    {composing ? <AgentMentionContext.Provider value={{ choices: [TDOC_AI], ai: { offered: true, remaining: 10 } }}>
      <CommentComposer selection={{ kind: 'document', rect: { top: 600, bottom: 600, left: 16 } }}
        initialText={composing === 'ask-ai' ? `@${AGENT_TAG_JOINER}${agentMentionName(TDOC_AI, [TDOC_AI])} ` : ''}
        initialMode={composing === 'ask-ai' ? 'ask' : null}
        onSubmit={async (text) => { setPosted(JSON.stringify({ text, anchor: anchorFromSelection({ kind: 'document' }) })); setComposing(null); }}
        onClose={() => setComposing(null)} />
    </AgentMentionContext.Provider> : null}
    <output id="mobile-comment-log">{posted}</output>
  </>;
}

createRoot(document.getElementById('root')).render(
  params.get('view') === 'status'
    ? <StatusCards />
    : params.get('view') === 'activity'
      ? <ActivityDemo />
      : params.get('view') === 'pins'
        ? <PinDemo />
      : params.get('view') === 'mobile-fab'
        ? <MobileFabDemo />
      : <NotifyHandoffPanel slug="doc" open commentIds={ids} avoid={avoid} onClose={() => {}} />,
);
