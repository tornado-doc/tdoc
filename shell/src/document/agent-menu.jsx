import React from 'react';
import { Check } from 'lucide-react';
import { agentDisplayName, agentMentionName, targetKey } from './agent-choices.js';
import { ProviderMark } from './notify-handoff.jsx';
import { AppMenuItem, AppMenuLinkItem, AppSubmenu } from '../ui/menu.jsx';
import { FEW_FREE_LEFT } from './ai-answerer.js';

// Whose an agent is, the order both agent lists keep: Mine, Team, tdoc AI.
export const AGENT_GROUPS = ['Mine', 'Team', 'tdoc AI'];
export const whose = (t) => (t.tdoc_ai ? 'tdoc AI' : t.team_agent ? 'Team' : 'Mine');

// The small grey tag at a row's right end, in both agent lists: "Mine",
// "Team", or tdoc AI's free answers left when few are ("5 free").
export function agentTag(t, ai = null) {
  if (!t) return '';
  if (!t.tdoc_ai) return whose(t);
  const left = ai && ai.remaining;
  return typeof left === 'number' && left <= FEW_FREE_LEFT ? `${left} free` : '';
}

// The agents a comment may name -- one quiet row each, short name and its
// tag, Mine / Team / tdoc AI in that order -- then "Connect my agent" where
// tdoc AI is offered. The agent pill's dropdown in both composers, in the
// typed-@ list's light style (Julie, 2026-10-25): the same agents typing @
// offers.
export function AgentMenuItems({ choices, ai = null, current = null, onPick,
  preserveOrder = false, maxVisible = Infinity, showConnect = true }) {
  const list = choices || [];
  const rows = preserveOrder ? list : AGENT_GROUPS.flatMap((group) => list.filter((t) => whose(t) === group));
  const renderRow = (t) => {
    const picked = Boolean(current) && targetKey(current) === targetKey(t);
    const tag = agentTag(t, ai);
    return (
      <AppMenuItem
        key={targetKey(t)}
        className="tdoc-agent-menu-item"
        title={agentDisplayName(t, list)}
        onClick={() => onPick(t)}
      >
        <span className="tdoc-mention-agent-mark"><ProviderMark target={t} size={14} /></span>
        <span className="tdoc-agent-menu-name">{agentMentionName(t, list)}</span>
        {tag ? <span className="tdoc-agent-menu-tag">{tag}</span> : null}
        <span className="tdoc-agent-menu-check">{picked ? <Check size={13} aria-label="Picked" /> : null}</span>
      </AppMenuItem>
    );
  };
  return (
    <>
      {rows.slice(0, maxVisible).map(renderRow)}
      {rows.length > maxVisible ? <AppSubmenu trigger="More agents" className="tdoc-agent-menu-more">
        {rows.slice(maxVisible).map(renderRow)}
      </AppSubmenu> : null}
      {showConnect && rows.some((t) => t.tdoc_ai) ? (
        <AppMenuLinkItem className="tdoc-agent-menu-connect" href="/start">Connect my agent</AppMenuLinkItem>
      ) : null}
    </>
  );
}
