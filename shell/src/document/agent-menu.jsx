import React from 'react';
import { Check } from 'lucide-react';
import { agentDisplayName, agentMentionName, targetKey } from './agent-choices.js';
import { ProviderMark } from './notify-handoff.jsx';
import { AppMenuItem, AppMenuLinkItem, AppSubmenu } from '../ui/menu.jsx';

// Whose an agent is, the order both agent lists keep: Mine, Team, tdoc AI.
export const AGENT_GROUPS = ['Mine', 'Team', 'tdoc AI'];
export const whose = (t) => (t.tdoc_ai ? 'tdoc AI' : t.team_agent ? 'Team' : 'Mine');

// The small grey tag at a row's right end, in both agent lists.
export function agentTag(t, ai = null) {
  if (!t) return '';
  if (!t.tdoc_ai) return whose(t);
  return ai?.remaining === 0 ? 'No free answers left' : 'Limited-time free';
}

// The agents a comment may name -- one quiet row each, short name and its
// tag, Mine / Team / tdoc AI in that order -- then "Connect my agent" where
// tdoc AI is offered. The agent pill's dropdown in both composers, in the
// typed-@ list's light style (Julie, 2026-10-25): the same agents typing @
// offers.
export function AgentMenuItems({ choices, ai = null, current = null, onPick,
  preserveOrder = false, maxVisible = Infinity, showConnect = true, showRelevance = false, pinTdocAi = false,
  disabledChoices = [], guestAction = null }) {
  const list = choices || [];
  const rows = preserveOrder ? list : AGENT_GROUPS.flatMap((group) => list.filter((t) => whose(t) === group));
  const aiRow = pinTdocAi ? rows.find((t) => t.tdoc_ai) : null;
  const agentRows = aiRow ? rows.filter((t) => t !== aiRow) : rows;
  const visible = agentRows.slice(0, Math.max(0, maxVisible - (aiRow ? 1 : 0)));
  if (aiRow) visible.push(aiRow);
  const more = agentRows.slice(visible.length - (aiRow ? 1 : 0));
  const renderRow = (t) => {
    const picked = Boolean(current) && targetKey(current) === targetKey(t);
    const tag = showRelevance && t.last_writer ? 'Edited last' : agentTag(t, ai);
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
      {visible.map(renderRow)}
      {more.length ? <AppSubmenu trigger="More agents" className="tdoc-agent-menu-more">
        {more.map(renderRow)}
      </AppSubmenu> : null}
      {disabledChoices.map((agent) => <AppMenuItem key={`disabled:${targetKey(agent)}`} disabled title="You are a guest. Team agents are for members." className="tdoc-agent-menu-item">
        <span className="tdoc-mention-agent-mark"><ProviderMark target={agent} size={14} /></span>
        <span className="tdoc-agent-menu-name">{agentMentionName(agent, disabledChoices)}</span>
        <span className="tdoc-agent-menu-tag">Team · members only</span>
      </AppMenuItem>)}
      {disabledChoices.length && guestAction ? <AppMenuItem className="tdoc-agent-menu-connect" onClick={guestAction.onClick}>{guestAction.label}</AppMenuItem> : null}
      {showConnect && rows.some((t) => t.tdoc_ai) ? (
        <AppMenuLinkItem className="tdoc-agent-menu-connect" href="/start">Connect my agent</AppMenuLinkItem>
      ) : null}
    </>
  );
}
