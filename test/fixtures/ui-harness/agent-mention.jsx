import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { AgentMentionContext } from '../../../shell/src/document/mention-field.jsx';
import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx';

window.__posts = [];
const people = [{ login: 'dana', name: 'Dana', avatar_url: '' }];
createRoot(document.getElementById('root')).render(
  <AgentMentionContext.Provider value="Claude">
    <CommentComposer
      selection={{ text: 'a sentence', rect: { left: 20, top: 20, bottom: 40 } }}
      mentionable={people}
      canSendToAgent
      onSubmit={async (text, opts) => { window.__posts.push({ text, opts }); }}
      onClose={() => {}}
    />
  </AgentMentionContext.Provider>,
);
