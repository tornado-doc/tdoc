import React, { useState } from 'react';
import { AppButton } from './ui/button.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { CodeBlock } from './ui/code-block.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import { FIRST_DOC_LINE } from './onboarding-copy.js';
import { isFeatureOn } from './feature-flags.js';

// "Connect in one click": tdoc in the AI app somebody already uses, through
// the remote MCP server (/mcp) and its OAuth sign-in, with no terminal. One
// row per app, each the shortest path that app offers today:
//   Claude   a prefilled "Add custom connector" link
//   ChatGPT  Plugins -> + -> Add custom MCP server, with the URL to paste
//   Cursor   its MCP install deeplink
//   others   the server URL (VS Code, Gemini CLI, Codex)
// The CLI line stays at the bottom as the fallback. Behind the remoteMcp
// flag: on in PR previews, off in prod until the worker serves /mcp there.

export function remoteMcpUrl(origin = typeof location !== 'undefined' ? location.origin : 'https://tdoc.dev') {
  return `${origin}/mcp`;
}

export function claudeConnectorLink(url) {
  const q = new URLSearchParams({ modal: 'add-custom-connector', connectorName: 'tdoc', connectorUrl: url });
  return `https://claude.ai/customize/connectors?${q}`;
}

export function cursorInstallLink(url) {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=tdoc&config=${encodeURIComponent(config)}`;
}

export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

function openOut(href) {
  // A new tab for the web apps; the cursor:// scheme hands off to the app.
  if (/^https:/.test(href)) window.open(href, '_blank', 'noopener');
  else window.location.href = href;
}

export function ConnectAiApps({ showCli = true }) {
  const url = remoteMcpUrl();
  return (
    <div className="tdoc-connect-apps" data-testid="connect-ai-apps">
      <ul className="tdoc-connect-apps-list">
        <li className="tdoc-connect-app">
          <div className="tdoc-connect-app-text">
            <b>Claude</b>
            <span>Claude.ai, the desktop and mobile apps, and Cowork. Adds tdoc as a connector; you sign in to tdoc once.</span>
          </div>
          <AppButton variant="primary" data-app="claude" onClick={() => openOut(claudeConnectorLink(url))}>Connect Claude</AppButton>
        </li>
        <li className="tdoc-connect-app">
          <div className="tdoc-connect-app-text">
            <b>ChatGPT</b>
            <span>In ChatGPT open Plugins, choose + then Add custom MCP server, paste this URL, sign in to tdoc, then Create.</span>
          </div>
          <AppButton data-app="chatgpt" onClick={() => openOut(CHATGPT_PLUGINS_URL)}>Open ChatGPT</AppButton>
        </li>
        <li className="tdoc-connect-app">
          <div className="tdoc-connect-app-text">
            <b>Cursor</b>
            <span>Opens Cursor and adds the tdoc server; Cursor asks you to sign in.</span>
          </div>
          <AppButton data-app="cursor" onClick={() => openOut(cursorInstallLink(url))}>Add to Cursor</AppButton>
        </li>
      </ul>
      <div className="tdoc-connect-apps-url">
        <span>Any other app that takes an MCP server URL (VS Code, Gemini CLI, Codex):</span>
        <CodeBlock text={url} />
      </div>
      {showCli ? (
        <div className="tdoc-connect-apps-cli">
          <span>Working in Claude Code or Codex on your computer? Paste this line instead:</span>
          <CopyPromptButton text={FIRST_DOC_LINE} label="Copy the line" />
        </div>
      ) : null}
    </div>
  );
}

// Settings and the setup gate: a section with a heading. Renders nothing
// with the flag off.
export function ConnectAiAppsSection({ title = 'Connect an AI app', blurb = 'Use tdoc from Claude, ChatGPT or Cursor. Nothing to install.', className = '' }) {
  if (!isFeatureOn('remoteMcp')) return null;
  return (
    <section className={`tdoc-connect-apps-section${className ? ` ${className}` : ''}`} aria-label={title}>
      <h2>{title}</h2>
      <p>{blurb}</p>
      <ConnectAiApps />
    </section>
  );
}

// /start: a strip under the top bar and the panel in a dialog, so the
// tutorial document itself stays author HTML with no script.
export function ConnectAiAppsStrip() {
  const [open, setOpen] = useState(false);
  if (!isFeatureOn('remoteMcp')) return null;
  return (
    <>
      <div className="tdoc-connect-strip" role="region" aria-label="Connect an AI app">
        <span>No terminal? Use tdoc from Claude, ChatGPT or Cursor.</span>
        <AppButton variant="primary" size="s" onClick={() => setOpen(true)}>Connect in one click</AppButton>
      </div>
      <AppDialog
        open={open}
        onOpenChange={setOpen}
        title="Connect in one click"
        description="Pick the app you already use. You sign in to tdoc once; the app keeps you connected."
        className="tdoc-connect-dialog"
      >
        <ConnectAiApps />
      </AppDialog>
    </>
  );
}
