import React from 'react';
import { Check } from 'lucide-react';
import { agentDisplayName, targetKey } from './agent-choices.js';
import { ProviderMark } from './notify-handoff.jsx';
import { AppMenuItem, AppMenuLinkItem } from '../ui/menu.jsx';
import { freeLeftText } from './ai-answerer.js';

// Whose an agent is, as both agent lists group it.
export const AGENT_GROUPS = ['Mine', 'Team', 'tdoc AI'];
export const whose = (t) => (t.tdoc_ai ? 'tdoc AI' : t.team_agent ? 'Team' : 'Mine');

// The agents a comment may name, grouped Mine / Team / tdoc AI (with its
// free answers left when few are), and "Connect my agent". The agent pill's
// dropdown in both composers: the same agents typing @ offers.
export function AgentMenuItems({ choices, ai = null, current = null, onPick }) {
  return AGENT_GROUPS.map((group) => {
    const rows = (choices || []).filter((t) => whose(t) === group);
    if (!rows.length) return null;
    return (
      <React.Fragment key={group}>
        <div className="tdoc-agent-menu-group">{group}</div>
        {rows.map((t) => (
          <AppMenuItem key={targetKey(t)} className="tdoc-action-menu-item tdoc-agent-menu-item" onClick={() => onPick(t)}>
            <ProviderMark target={t} size={14} />
            <span className="tdoc-agent-menu-name">{agentDisplayName(t, choices)}</span>
            {t.tdoc_ai && freeLeftText(ai?.remaining)
              ? <span className="tdoc-agent-menu-hint">{freeLeftText(ai.remaining)}</span>
              : t.last_writer ? <span className="tdoc-agent-menu-hint">edited last</span> : null}
            {current && targetKey(current) === targetKey(t) ? <Check size={14} className="tdoc-space-check" aria-label="Picked" /> : null}
          </AppMenuItem>
        ))}
        {group === 'tdoc AI' ? (
          <AppMenuLinkItem className="tdoc-action-menu-item tdoc-agent-menu-connect" href="/start">Connect my agent →</AppMenuLinkItem>
        ) : null}
      </React.Fragment>
    );
  });
}
