import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { ConnectorsBody } from './connectors-page.jsx';
import { DevicesBody } from './tokens-page.jsx';
import './docs-hub.css';

// One place for the agent side of an account, two different questions:
//   Send comments to — where Send to agent / @agent deliver (connectors)
//   Access           — which computers and agents can act as you (devices)
// They used to be two pages with names that blurred together.
const TABS = [['send', 'Send comments to'], ['access', 'Access']];

export function AgentsPage({ boot }) {
  const [tab, setTab] = useState(() => {
    const asked = new URLSearchParams(location.search).get('tab');
    return TABS.some(([id]) => id === asked) ? asked : 'send';
  });
  const pick = (id) => {
    setTab(id);
    const u = new URL(location.href); u.searchParams.set('tab', id); history.replaceState(null, '', u);
  };
  return (
    <div className="tdoc-app docs-hub tdoc-agents-page">
      <TopBar identity={boot.identity || null} />
      <main className="wrap">
        <div className="page-hd"><h1>Agents</h1></div>
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" className={`tab${tab === id ? ' is-active' : ''}`} aria-selected={tab === id} onClick={() => pick(id)}>{label}</button>
          ))}
        </div>
        <div className="tdoc-agents-pane">
          {tab === 'send' ? <ConnectorsBody /> : <DevicesBody tokens={boot.tokens} />}
        </div>
      </main>
    </div>
  );
}
