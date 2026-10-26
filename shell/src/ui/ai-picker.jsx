import React from 'react';
import { ArrowRight, Bot } from 'lucide-react';
import codexIcon from '../../../assets/mac-codex.png?inline';
import cursorIcon from '../../../assets/cursor-icon.png?inline';
import { ClaudeMark, OpenAIMark, GrokMark, RaftMark } from '../agent-marks.jsx';

const CodexMark = ({ size }) => <img src={codexIcon} width={size} height={size} alt="" />;
const CursorMark = ({ size }) => <img src={cursorIcon} width={size} height={size} alt="" />;

export const AI_PRODUCTS = [
  { value: 'chatgpt', label: 'ChatGPT Work', location: 'Web / app', route: 'manual', group: 'chat', mark: OpenAIMark },
  { value: 'cowork', label: 'Claude Cowork', location: 'Web / app', route: 'manual', group: 'chat', mark: ClaudeMark },
  { value: 'claude', label: 'Claude Code', location: 'Your computer', route: 'connect', group: 'agent', mark: ClaudeMark },
  { value: 'codex', label: 'Codex', location: 'Your computer', route: 'connect', group: 'agent', mark: CodexMark },
  { value: 'grok', label: 'Grok Bot', location: 'Bot / cloud', route: 'platform', group: 'agent', mark: GrokMark },
  { value: 'raft', label: 'Raft', location: 'Agent platform', route: 'platform', group: 'agent', mark: RaftMark },
  { value: 'cursor', label: 'Cursor', location: 'Your editor', route: 'manual', group: 'agent', mark: CursorMark },
  { value: 'other', label: 'Other AI / Agent', location: 'Connect your AI', route: 'manual', group: 'agent', mark: Bot },
];

const GROUPS = [{ id: 'chat', label: 'Chat apps' }, { id: 'agent', label: 'Agents' }];

export function AIPicker({ onChoose }) {
  return <div className="ui-ai-groups">
    {GROUPS.map(group => <section key={group.id} className="ui-ai-group" aria-label={group.label}>
      <h3>{group.label}</h3>
      <div className="ui-ai-picker" role="group" aria-label={group.label}>
        {AI_PRODUCTS.filter(p => p.group === group.id).map(({ value, label, location, mark: Mark }) => <button key={value} type="button" className="ui-ai-option" onClick={() => onChoose(value)}>
          <span className="ui-ai-mark"><Mark size={32} /></span>
          <span className="ui-ai-label"><strong>{label}</strong><span>{location}</span></span>
          <ArrowRight size={18} aria-hidden="true" />
        </button>)}
      </div>
    </section>)}
  </div>;
}
