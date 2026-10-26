import React from 'react';
import { ArrowRight, Bot } from 'lucide-react';
import codexIcon from '../../../assets/mac-codex.png';
import cursorIcon from '../../../assets/cursor-icon.png';
import { ClaudeMark, OpenAIMark, GrokMark, RaftMark } from '../agent-marks.jsx';

const CodexMark = ({ size }) => <img src={codexIcon} width={size} height={size} alt="" />;
const CursorMark = ({ size }) => <img src={cursorIcon} width={size} height={size} alt="" />;

export const AI_PRODUCTS = [
  { value: 'chatgpt', label: 'ChatGPT Work', location: 'Web / app', route: 'manual', mark: OpenAIMark },
  { value: 'cowork', label: 'Claude Cowork', location: 'Web / app', route: 'manual', mark: ClaudeMark },
  { value: 'claude', label: 'Claude Code', location: 'Your computer', route: 'connect', mark: ClaudeMark },
  { value: 'codex', label: 'Codex', location: 'Your computer', route: 'connect', mark: CodexMark },
  { value: 'grok', label: 'Grok Bot', location: 'Bot / cloud', route: 'platform', mark: GrokMark },
  { value: 'raft', label: 'Raft', location: 'Agent platform', route: 'platform', mark: RaftMark },
  { value: 'cursor', label: 'Cursor', location: 'Your editor', route: 'manual', mark: CursorMark },
  { value: 'other', label: 'Other AI / Agent', location: 'Connect your AI', route: 'manual', mark: Bot },
];

export function AIPicker({ onChoose }) {
  return <div className="ui-ai-picker" role="group" aria-label="Choose your AI">
    {AI_PRODUCTS.map(({ value, label, location, mark: Mark }) => <button key={value} type="button" className="ui-ai-option" onClick={() => onChoose(value)}>
      <span className="ui-ai-mark"><Mark size={32} /></span>
      <span className="ui-ai-label"><strong>{label}</strong><span>{location}</span></span>
      <ArrowRight size={18} aria-hidden="true" />
    </button>)}
  </div>;
}
