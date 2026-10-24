// Real Ask AI entry (bar + phone ⋯ menu) and the real Ask panel, against a
// stubbed /api/docs/<slug>/ask. The stub answers slowly, like a reasoning
// model, so the thinking state is on screen long enough to check.
// `?mode=agent|copy` opens the same panel as Send to my agent / Copy for my
// agent, with the real useMyAgent hook against a stubbed /my-agent: the
// reader's own agent picks the question up, then answers it.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MoreHorizontal } from 'lucide-react';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { AppMenu } from '../../../shell/src/ui/menu.jsx';
import { DocumentAskAction, DocumentOverflowActions } from '../../../shell/src/document/document-toolbar.jsx';
import { AskPanel } from '../../../shell/src/document/ask-panel.jsx';
import { sendToMyAgent } from '../../../shell/src/document/api.js';
import { useMyAgent } from '../../../shell/src/document/my-agent.js';

const params = new URLSearchParams(location.search);
let remaining = Number(params.get('remaining') || 2);
window.__askCalls = [];
const realFetch = window.fetch.bind(window);
const mode = params.get('mode') || 'ai';
const agent = { provider: 'local', device: 'sams-mac', cli: 'claude', agent_sub: 'sams-mac_claude', status: 'active' };
let asks = [];
window.__agentCalls = [];
window.__copied = [];
window.fetch = async (url, init = {}) => {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (String(url).startsWith('/api/docs/launch-plan/my-agent')) {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      window.__agentCalls.push(body);
      const ask = { ask_id: `q_${asks.length + 1}`, at: new Date().toISOString(), question: body.question, passage: body.passage || null, recipient: agent, delivery: { status: 'queued', error: null }, acked_at: null, answer: null };
      asks = [ask, ...asks];
      return reply(200, { ok: true, ask });
    }
    // The first read after sending finds it picked up; the next, answered.
    asks = asks.map((a) => (a.answer ? a : a.acked_at
      ? { ...a, answer: { text: 'Billing ships **first** because invoices block renewals.', at: new Date().toISOString(), agent: { login: 'claude', name: 'Claude' } } }
      : { ...a, acked_at: new Date().toISOString() }));
    return reply(200, { tier: mode === 'copy' ? 'offline' : 'online', agent: mode === 'copy' ? null : agent, agents: [agent], asks, helper_href: '/me?view=settings#agents' });
  }
  if (!String(url).startsWith('/api/docs/launch-plan/ask')) return realFetch(url, init);
  if (!init.method || init.method === 'GET') return reply(200, { available: true, limit: 5, remaining });
  const body = JSON.parse(init.body);
  window.__askCalls.push(body);
  await new Promise((r) => setTimeout(r, Number(params.get('delay') || 1500)));
  if (remaining <= 0) return reply(429, { error: 'ask_limit', limit: 5 });
  remaining -= 1;
  return reply(200, {
    answer: 'Billing ships **first**, then search.\n\n- Billing: March\n- Search: `April`',
    remaining,
  });
};

const config = { mode: 'published', version: 2, versions: [{ n: 1 }, { n: 2 }], slug: 'launch-plan' };
const selection = params.get('selection') ? { text: params.get('selection'), context_before: 'Plan. ', context_after: '. Then', occurrence: 0, occurrences: 1 } : null;

function Harness() {
  const [open, setOpen] = useState(false);
  const [posted, setPosted] = useState('');
  const myAgent = useMyAgent('launch-plan', mode !== 'ai');
  return (
    <>
      <header className="tdoc-bar">
        <div className="tdoc-bar-left">
          <span className="doc-title">Launch plan</span>
        </div>
        <div className="tdoc-bar-right">
          <div className="tdoc-bar-actions">
            <DocumentAskAction onClick={() => setOpen(true)} />
          </div>
          <AppMenu
            trigger={(
              <button id="tdoc-more-btn" type="button" className="tdoc-secondary-toggle" aria-label="More actions">
                <MoreHorizontal size={18} />
              </button>
            )}
          >
            <DocumentOverflowActions
              config={config}
              onAsk={() => setOpen(true)}
              starred={false}
              onToggleStar={() => {}}
              onPublish={() => {}}
              onShare={() => {}}
              onCopyMarkdown={() => {}}
              onDuplicate={() => {}}
              onDownload={() => {}}
              onPrint={() => {}}
              onMoveDocument={null}
              onDelete={() => {}}
              resolvedCount={0}
              showResolved={false}
              onToggleResolved={() => {}}
              onCompare={() => {}}
            />
          </AppMenu>
        </div>
      </header>
      <main style={{ maxWidth: 720, margin: '56px auto', padding: '0 20px', font: '16px/1.6 system-ui' }}>
        <h1>Launch plan</h1>
        <p>Billing ships first. Then search. A reader without an agent asks the doc.</p>
        {posted ? <pre id="posted">{posted}</pre> : null}
      </main>
      <AskPanel
        open={open}
        onClose={() => setOpen(false)}
        slug="launch-plan"
        version={2}
        selection={selection}
        limit={5}
        canPost
        onPost={async (text, about) => { setPosted(text); window.__postedAnchor = about || null; return true; }}
        mode={mode}
        initialQuestion={params.get('question') || ''}
        autoSubmit={Boolean(params.get('question'))}
        myAgent={myAgent.state}
        docUrl="https://tdoc.dev/d/launch-plan"
        onSendAgent={async (question, passage) => {
          const body = await sendToMyAgent('launch-plan', { question, passage });
          myAgent.addAsk(body.ask);
          return body.ask;
        }}
        onCopy={async (line) => { window.__copied.push(line); return true; }}
      />
    </>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
