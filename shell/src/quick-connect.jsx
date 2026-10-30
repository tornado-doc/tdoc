import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AppButton } from './ui/button.jsx';
import { CodeBlock } from './ui/code-block.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import {
  CHATGPT_PLUGINS_URL, claudeConnectorLink, cursorInstallLink, remoteMcpUrl, vscodeInstallLink,
} from './connect-ai-apps.jsx';
import {
  installCommand, orderPlatforms, parseInstallTable, platformById, setupPrompt,
} from './quick-connect-data.js';
import { readStored, writeStored } from './safe-storage.js';
import PLUGINS_README from '../../plugins/README.md?raw';

// Quick connect (docs/design/onboarding.md, "Landing page" and "Button
// behaviour and dialogs"): the one setup prompt on top, a button per platform
// below, each labelled with what it costs, and one dialog frame per button.
// Commands come from plugins/README.md (quick-connect-data.js). Behind the
// quickConnect flag: with it on, /start's "Connect in one click" opens this
// instead of the ConnectAiApps list, and /start?connect=<platform> opens that
// platform's frame. The status line is a slot for the backend signals of the
// next step (authorized, first doc); until then it stays empty.

const ROWS = parseInstallTable(PLUGINS_README);
export const MARKETPLACE = 'tornado-doc/tdoc';
// claude.ai's plugin settings, beside the documented Customize > Connectors.
export const CLAUDE_PLUGINS_URL = 'https://claude.ai/customize/plugins';
export const AGENTS_PAGE = '/me?view=settings#agents';
const CHATGPT_STEP_KEY = 'tdoc.quickConnect.chatgptStep';
const TEST_PROMPT = 'Use tdoc to write a one-page doc about what you can help me with, and give me the link';

function openOut(href) {
  if (/^https:/.test(href)) window.open(href, '_blank', 'noopener');
  else window.location.href = href;
}

function Choice({ title, children }) {
  return (
    <section className="tdoc-qc-choice">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function ClaudeSteps({ onPick }) {
  const [screen, setScreen] = useState(1);
  const url = remoteMcpUrl();
  if (screen === 2) {
    return (
      <div className="tdoc-qc-steps">
        <p>Open the plugin’s <b>Connectors</b> tab, click <b>Connect</b> on tdoc and sign in.</p>
        <p className="tdoc-qc-note">Claude Code and Cowork can use it too: the plugin and the sign-in follow your Claude account.</p>
        <div className="tdoc-qc-nav">
          <AppButton variant="quiet" size="s" onClick={() => setScreen(1)}>Back</AppButton>
        </div>
      </div>
    );
  }
  return (
    <div className="tdoc-qc-steps">
      <p>In Claude, open <b>Customize → Plugins → Add → Add marketplace</b>, paste this, then install <b>tdoc Cloud</b>.</p>
      <CodeBlock text={MARKETPLACE} />
      <p className="tdoc-qc-warn">Pick tdoc Cloud, not tdoc: tdoc is the local version, and claude.ai rejects it.</p>
      <div className="tdoc-qc-nav">
        <AppButton variant="primary" onClick={() => openOut(CLAUDE_PLUGINS_URL)}>Open Claude plugins</AppButton>
        <AppButton onClick={() => setScreen(2)}>Installed, next</AppButton>
      </div>
      <details className="tdoc-qc-fallback">
        <summary>No Add marketplace?</summary>
        <p>On the free plan, or when an admin turned plugins off, add tdoc as a connector instead. An admin can also add it for the whole organization.</p>
        <AppButton size="s" onClick={() => openOut(claudeConnectorLink(url))}>Add tdoc as a connector</AppButton>
      </details>
      <div className="tdoc-qc-nav">
        <span className="tdoc-qc-note">Prefer Claude Code on your computer?</span>
        <AppButton variant="quiet" size="s" onClick={() => onPick('claude-code')}>Use Claude Code</AppButton>
      </div>
    </div>
  );
}

function LocalOrMcp({ platform }) {
  const url = remoteMcpUrl();
  const prompt = setupPrompt();
  const difference = 'Local lets comments come back to this computer and works with local files; MCP needs no scripts.';
  if (platform === 'gemini') {
    return (
      <div className="tdoc-qc-steps">
        <Choice title="MCP">
          <CodeBlock text={installCommand(ROWS, 'Gemini CLI', url)} />
          <p className="tdoc-qc-note">Then sign in from Gemini CLI with <code>/mcp auth tdoc</code>.</p>
        </Choice>
      </div>
    );
  }
  if (platform === 'claude-code') {
    return (
      <div className="tdoc-qc-steps">
        <p className="tdoc-qc-note">{difference}</p>
        <Choice title="Local (recommended)">
          <CodeBlock text={installCommand(ROWS, 'Claude Code, local CLI', url)} />
          <p className="tdoc-qc-note">Already have tdoc Cloud from claude.ai? Turn it off in Claude Code before installing the local version.</p>
        </Choice>
        <Choice title="MCP only">
          <CodeBlock text={installCommand(ROWS, 'Claude Code', url)} />
        </Choice>
      </div>
    );
  }
  // Codex: in Codex the marketplace's tdoc plugin is the MCP one, so the
  // local install is the setup prompt, which installs the CLI.
  return (
    <div className="tdoc-qc-steps">
      <p className="tdoc-qc-note">{difference}</p>
      <Choice title="Local (recommended)">
        <p>Paste this into Codex:</p>
        <div className="tdoc-qc-prompt">
          <code>{prompt}</code>
          <CopyPromptButton text={prompt} />
        </div>
      </Choice>
      <Choice title="MCP only">
        <CodeBlock text={installCommand(ROWS, 'Codex CLI', url)} />
      </Choice>
    </div>
  );
}

function OneClick({ platform }) {
  const url = remoteMcpUrl();
  const cursor = platform === 'cursor';
  return (
    <div className="tdoc-qc-steps">
      <p>{cursor ? 'Opens Cursor with the tdoc server filled in.' : 'Opens VS Code and adds the tdoc server for Copilot.'} Click <b>Install</b>, then <b>Connect</b> and sign in.</p>
      <div className="tdoc-qc-nav">
        <AppButton variant="primary" onClick={() => openOut(cursor ? cursorInstallLink(url) : vscodeInstallLink(url))}>
          {cursor ? 'Add to Cursor' : 'Add to VS Code'}
        </AppButton>
      </div>
      {cursor ? null : (
        <>
          <p className="tdoc-qc-note">Or run this in a terminal:</p>
          <CodeBlock text={installCommand(ROWS, 'VS Code (Copilot)', url)} />
        </>
      )}
      <p className="tdoc-qc-note">When people comment, ask {cursor ? 'Cursor' : 'Copilot'} to revise from the tdoc comments.</p>
    </div>
  );
}

const CHATGPT_STEPS = ['Check', 'Open the setting', 'Add the server', 'Sign in', 'Use it in a chat'];

function ChatGptStepper({ onPick }) {
  // Remembered while the person switches to ChatGPT and back.
  const [step, setStepState] = useState(() => {
    const saved = Number(readStored(CHATGPT_STEP_KEY));
    return saved >= 1 && saved <= CHATGPT_STEPS.length ? saved : 1;
  });
  const [free, setFree] = useState(false);
  const setStep = (n) => { setStepState(n); writeStored(CHATGPT_STEP_KEY, String(n)); };
  const url = remoteMcpUrl();
  const next = () => setStep(Math.min(step + 1, CHATGPT_STEPS.length));
  const back = () => setStep(Math.max(step - 1, 1));
  let body;
  if (step === 1) {
    body = free ? (
      <>
        <p>Custom MCP servers need a paid ChatGPT plan. Claude and Cursor connect for free.</p>
        <div className="tdoc-qc-nav">
          <AppButton onClick={() => onPick('claude')}>Use Claude</AppButton>
          <AppButton onClick={() => onPick('cursor')}>Use Cursor</AppButton>
        </div>
      </>
    ) : (
      <>
        <p>Needs a paid ChatGPT plan, on the web. About 2 minutes.</p>
        <div className="tdoc-qc-nav">
          <AppButton variant="primary" onClick={next}>Start</AppButton>
          <AppButton variant="quiet" onClick={() => setFree(true)}>I’m on the free plan</AppButton>
        </div>
      </>
    );
  } else if (step === 2) {
    body = (
      <>
        <p>Open <b>Plugins</b> in ChatGPT, then choose <b>+</b> and <b>Add custom MCP server</b>.</p>
        <div className="tdoc-qc-nav">
          <AppButton variant="primary" onClick={() => openOut(CHATGPT_PLUGINS_URL)}>Open ChatGPT plugins</AppButton>
        </div>
        <details className="tdoc-qc-fallback">
          <summary>Don’t see it?</summary>
          <p>On Business and Enterprise plans an admin adds custom MCP servers. Send them this:</p>
          <CodeBlock text={`Please add tdoc as a custom MCP server in ChatGPT: ${url} (OAuth).`} />
        </details>
      </>
    );
  } else if (step === 3) {
    body = (
      <>
        <p>Name</p>
        <CodeBlock text="tdoc" />
        <p>Connection URL</p>
        <CodeBlock text={url} />
        <p>Authentication: <b>OAuth</b>. Then select <b>I understand and want to continue</b> and create it.</p>
      </>
    );
  } else if (step === 4) {
    body = <p>ChatGPT opens tdoc’s sign-in. Click <b>Allow</b>, then come back here.</p>;
  } else {
    body = (
      <>
        <p className="tdoc-qc-emphasis">Start a new chat, choose <b>+</b> (or type <b>@</b>) and pick <b>tdoc</b>. Every new chat needs this.</p>
        <p>Then try:</p>
        <div className="tdoc-qc-prompt">
          <code>{TEST_PROMPT}</code>
          <CopyPromptButton text={TEST_PROMPT} />
        </div>
      </>
    );
  }
  return (
    <div className="tdoc-qc-steps" data-step={step}>
      <p className="tdoc-qc-progress">Step {step} of {CHATGPT_STEPS.length} · {CHATGPT_STEPS[step - 1]}</p>
      {body}
      {step > 1 ? (
        <div className="tdoc-qc-nav">
          <AppButton variant="quiet" size="s" onClick={back}>Back</AppButton>
          {step < CHATGPT_STEPS.length ? <AppButton size="s" onClick={next}>Next</AppButton> : null}
        </div>
      ) : null}
    </div>
  );
}

// One frame for every platform: name on top, the action in the middle, the
// status line at the bottom.
export function QuickConnectFrame({ platform, onBack, onPick, status = '' }) {
  const p = platformById(platform);
  if (!p) return null;
  let body;
  if (p.id === 'claude') body = <ClaudeSteps onPick={onPick} />;
  else if (p.id === 'cursor' || p.id === 'vscode') body = <OneClick platform={p.id} />;
  else if (p.id === 'chatgpt') body = <ChatGptStepper onPick={onPick} />;
  else body = <LocalOrMcp platform={p.id} />;
  return (
    <div className="tdoc-qc-frame" data-platform={p.id}>
      <div className="tdoc-qc-frame-hd">
        <AppButton variant="quiet" size="s" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /><span>All apps</span></AppButton>
        <h4>{p.name}{p.note ? <span> · {p.note}</span> : null}</h4>
      </div>
      {body}
      <p className="tdoc-qc-status" role="status">{status}</p>
    </div>
  );
}

export function QuickConnect({ initial = null }) {
  const [platform, setPlatform] = useState(() => (platformById(initial) ? initial : null));
  const [order] = useState(() => orderPlatforms({
    referrer: typeof document !== 'undefined' ? document.referrer : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  }));
  useEffect(() => {
    if (initial && platformById(initial)) setPlatform(initial);
  }, [initial]);
  if (platform) {
    return <QuickConnectFrame platform={platform} onBack={() => setPlatform(null)} onPick={setPlatform} />;
  }
  const prompt = setupPrompt();
  return (
    <div className="tdoc-qc" data-testid="quick-connect">
      <p className="tdoc-qc-label">Paste this into any agent:</p>
      <div className="tdoc-qc-prompt">
        <code>{prompt}</code>
        <CopyPromptButton text={prompt} />
      </div>
      <p className="tdoc-qc-label">Or quick connect:</p>
      <ul className="tdoc-qc-grid">
        {order.map((p) => (
          <li key={p.id}>
            <AppButton data-app={p.id} onClick={() => setPlatform(p.id)} title={p.note || undefined}>{p.name}</AppButton>
            <span>{p.cost}</span>
          </li>
        ))}
      </ul>
      <p className="tdoc-qc-note">Your agent runs as a bot or service? <a href={AGENTS_PAGE}>Add a webhook →</a></p>
    </div>
  );
}

export { PLATFORMS, orderPlatforms, platformById, setupPrompt } from './quick-connect-data.js';
