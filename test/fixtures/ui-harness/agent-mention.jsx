// Mounts the comment composer with agents on offer, for
// test/agent-mention-ui.test.js. ?agents=0 is a reader who cannot send.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { AgentMentionContext } from '../../../shell/src/document/mention-field.jsx';
import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx';
import { Author } from '../../../shell/src/document/comment-card.jsx';
import { orderedAgentChoices } from '../../../shell/src/document/agent-choices.js';

const params = new URLSearchParams(location.search);
const canSend = params.get('agents') !== '0';
// The worker stamps whose connection each agent is.
const owner = { key: 'julie', display: 'julie' };
const local = (device, cli) => ({ provider: 'local', server_id: device, device, cli, agent_sub: `${device}_${cli}`, agent_name: `${cli} on ${device}`, owner });
const doc = { provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: 'a', agent_name: 'xiaocc', source: 'doc', owner };
const targets = {
  default: doc,
  candidates: [doc, local('juliesmac', 'claude'), local('juliesmac', 'codex')],
  fallback: { provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: 'b', agent_name: 'devin', owner },
};
const agents = canSend
  ? { choices: orderedAgentChoices(targets), preselected: targets.default }
  : { choices: [], preselected: null };

window.__posts = [];
// "claude" commented here as an agent once; the server no longer lists it.
const people = [{ login: 'dana', name: 'Dana', avatar_url: '', tags: ['doc'] }];
// ?view=authors: agent replies as the worker stamps them now, and as it did
// before the owner was stamped.
const AUTHORS = [
  { kind: 'agent', login: 'claude', name: 'Claude', provider: 'raft', handle: '@smarter-tdoc-claw', location: 'julie', scope: 'personal',
    owner: { key: 'yayashuxue', display: 'yayashuxue' }, principal: { display: '@yayashuxue', terminal: 'Claude' } },
  { kind: 'agent', login: 'codex', name: 'Codex', provider: 'local', cli: 'codex', location: 'juliesmac', scope: 'team', owner },
  { kind: 'agent', login: 'claude', name: 'Claude', provider: 'raft', handle: '@smarter-tdoc-claw', principal: { display: '@julie', terminal: 'Claude' } },
];
createRoot(document.getElementById('root')).render(params.get('view') === 'authors' ? (
  <div style={{ display: 'grid', gap: 12, padding: 16, width: 300 }}>
    {AUTHORS.map((a, i) => <div key={i} className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={a} /></div>)}
  </div>
) : (
  <AgentMentionContext.Provider value={agents}>
    <CommentComposer
      selection={{ text: 'a sentence', rect: { left: 20, top: 20, bottom: 40 } }}
      mentionable={people}
      canSendToAgent={canSend}
      onSubmit={async (text, opts) => { window.__posts.push({ text, opts }); }}
      onClose={() => {}}
    />
  </AgentMentionContext.Provider>
));
