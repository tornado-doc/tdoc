// Mounts the comment composer with agents on offer, for
// test/agent-mention-ui.test.js. ?agents=0 is a reader who cannot send.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { AgentMentionContext } from '../../../shell/src/document/mention-field.jsx';
import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx';
import { orderedAgentChoices } from '../../../shell/src/document/agent-choices.js';

const canSend = new URLSearchParams(location.search).get('agents') !== '0';
const local = (device, cli) => ({ provider: 'local', server_id: device, device, cli, agent_sub: `${device}_${cli}`, agent_name: `${cli} on ${device}` });
const doc = { provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: 'a', agent_name: 'xiaocc', source: 'doc' };
const targets = {
  default: doc,
  candidates: [doc, local('juliesmac', 'claude'), local('juliesmac', 'codex')],
  fallback: { provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: 'b', agent_name: 'devin' },
};
const agents = canSend
  ? { choices: orderedAgentChoices(targets), preselected: targets.default }
  : { choices: [], preselected: null };

window.__posts = [];
// "claude" commented here as an agent once; the server no longer lists it.
const people = [{ login: 'dana', name: 'Dana', avatar_url: '', tags: ['doc'] }];
createRoot(document.getElementById('root')).render(
  <AgentMentionContext.Provider value={agents}>
    <CommentComposer
      selection={{ text: 'a sentence', rect: { left: 20, top: 20, bottom: 40 } }}
      mentionable={people}
      canSendToAgent={canSend}
      onSubmit={async (text, opts) => { window.__posts.push({ text, opts }); }}
      onClose={() => {}}
    />
  </AgentMentionContext.Provider>,
);
