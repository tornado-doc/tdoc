# tdoc onboarding design

Status: draft for review · 2026-10-29 · Serena
Companion: [Agent model](agent-model.md) (what happens after setup: agents, comment handling, the tip card)

## Goals

Onboarding has two directions. **Forward**: an agent can write tdoc (plugin, MCP or local CLI). **Reverse**: tdoc can hand comments back to an agent (Send to agent / @agent) through the local daemon, a webhook or Raft. This doc covers forward setup; the reverse direction is designed as an agent model in [agent-model.md](agent-model.md).

- **Two plugins, picked for the user.** `tdoc-cloud` (remote MCP + skill, installs anywhere) and `tdoc` (local CLI with `bin/` scripts, only for Claude Code / Codex with Bash). Users never have to learn the difference; the buttons and the setup prompt choose.
- **One install covers all Anthropic surfaces.** `tdoc-cloud` installed on claude.ai syncs to Cowork and Claude Code, and the MCP sign-in is shared through the Claude account.
- **One sign-in per computer.** The local CLI credential (`~/.tdoc/published.json`) is shared by Claude Code, Codex and the daemon on that machine.
- **Ask about comment handling after the first doc**, not before. The success screen shows the newly registered agent card with its "Handles comments" toggle ([agent-model.md](agent-model.md#handles-comments-toggle)).
- **One prompt as the fallback.** Today: `Install tdoc by following https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md`. Proposed: the shorter `set up https://tdoc.dev/SKILL.md` backed by a small router file (below).
- **Success means the first doc**, not "installed": the user sees a doc their agent wrote, target under 60 seconds (ChatGPT excepted). Dialogs advance on backend signals, so nobody clicks "I'm done".

Supported: claude.ai / Cowork, Claude Code, Codex, Gemini CLI, Cursor, VS Code, ChatGPT. Anything else uses the setup prompt.

## Platforms

Four kinds: **P** install a plugin, **A** one-click MCP link, **C** manual paste, plus reverse-only agents. Install commands come from `plugins/README.md`.

| Platform | Kind | Install | Sign-in | Comments come back via | Notes |
| --- | --- | --- | --- | --- | --- |
| claude.ai / Cowork | P | Customize → Plugins → Add marketplace `tornado-doc/tdoc` → install `tdoc-cloud` | Connectors → Connect (OAuth) | none: user asks Claude to revise | Only `tdoc-cloud`: `tdoc` ships `bin/`, which claude.ai rejects. Free-plan support for custom plugins unconfirmed |
| Claude Code | P | With Bash: `tdoc@tornado-tdoc` (local CLI). MCP only: `claude plugin install tdoc-cloud --marketplace tornado-doc/tdoc` | local: browser sign-in once; cloud: `/mcp` | **local daemon** | `tdoc-cloud` from claude.ai syncs here too; both plugins ship a skill named `tdoc` (open question) |
| Codex | P | `codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc` | same | **local daemon** | Does not sync from claude.ai |
| Gemini CLI | P | clone, then `gemini extensions install ./tdoc/plugins/gemini` | `/mcp auth tdoc` | none (daemon supports claude, codex) | Installing from the GitHub URL fails until a release ships `tdoc-gemini.tar.gz` |
| Cursor | A (P once listed) | `https://cursor.com/install-mcp?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9` | Connect in Cursor | none | Marketplace listing is manually reviewed; `.cursor-plugin` exists |
| VS Code | A | `code --add-mcp '{"name":"tdoc","type":"http","url":"https://tdoc.dev/mcp"}'` or the web redirect link | in VS Code | none | Whether Copilot agent mode is required: unconfirmed |
| ChatGPT | C | Plugins → + → Add custom MCP server → `https://tdoc.dev/mcp` | OAuth | none | Paid plans, web only; an Apps directory listing would make it one click |
| Bot / own agent with an HTTPS endpoint (Grok bot, n8n, Zapier) | reverse only | calls tdoc its own way (MCP or `Bearer tdoc_…`) | token | **webhook** | tdoc POSTs, HMAC-signed |
| Raft agent | reverse only | Connect with Raft | Raft | **Raft push** | live |

Sign-ins: once for all Anthropic surfaces (account sync), once per computer for the local CLI, once each for Cursor, VS Code and ChatGPT.

## Landing page

A universal prompt on top, a quick-connect row below, each button labelled with what it costs.

```
┌───────────────────────────────────────────────────────────┐
│  Connect your agent to tdoc                               │
│                                                           │
│  Paste this into any agent:                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ set up https://tdoc.dev/SKILL.md             [Copy] │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  Or quick connect:                                        │
│  [Claude]      [Claude Code]  [Codex]      [Gemini CLI]   │
│   plugin        plugin         plugin       extension     │
│  [Cursor]      [VS Code]      [ChatGPT]                   │
│   1 click       1 command      ~2 min, paid               │
│                                                           │
│  Your agent runs as a bot or service?  [Add a webhook →]  │
└───────────────────────────────────────────────────────────┘
```

- The Claude button is labelled "claude.ai · Cowork · Claude Code".
- The bottom line opens the bot flow on the Agents page (`/me?view=settings#agents`).
- Order the buttons by User-Agent and referrer; the likely platform goes first.
- Every button and prompt carries `?src=landing&client=<platform>` for funnel numbers.

## Button behaviour and dialogs

Every button opens the same dialog frame: platform on top, the action in the middle, a status line at the bottom ("Waiting for sign-in…" → "Connected ✓"). The backend signal moves it to the success screen.

### P: Claude (claude.ai / Cowork)

1. **Screen 1**: copy `tornado-doc/tdoc` + "Open Claude plugins". GIF: Customize → Plugins → Add → Add marketplace → paste → install **tdoc Cloud** (in red: "not tdoc, that is the local version").
2. **Screen 2**: "Open the plugin's Connectors tab, click Connect on tdoc and sign in." Backend sees the claude.ai authorization → success.
3. **Fallbacks**: no "Add marketplace" (free plan or turned off by an admin) → the connector-only prefill link plus a message for the admin; no authorization after 45 s → expand the written steps.
4. Success: "Claude Code and Cowork can use it too." plus the new agent card ([agent-model.md](agent-model.md#agents-page)).

### P: Claude Code, Codex, Gemini CLI

1. **Local (recommended)** first, **MCP only** second.
    - Claude Code local: `/plugin marketplace add tornado-doc/tdoc`, `/plugin install tdoc@tornado-tdoc`
    - Codex local: `codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc`
    - MCP only: the `tdoc-cloud` plugin or the client's `mcp add`
    - Gemini CLI is MCP only: clone + `extensions install`
2. Say the difference: "Local lets comments come back to this computer and works with local files; MCP needs no scripts."
3. Claude Code users who already have `tdoc-cloud` from claude.ai: "Turn off tdoc Cloud in Claude Code before installing the local version."
4. Status line waits for the first sign-in; the success screen shows the agent card with the toggle.

### A: Cursor, VS Code

1. Cursor opens the `cursor.com/install-mcp` link; VS Code copies `code --add-mcp …` or opens the web link. "Click Install, then Connect."
2. No authorization after 45 s → manual steps.
3. No reverse channel; the success screen says "When people comment, ask Cursor to revise from the tdoc comments."

### C: ChatGPT stepper

Five screens, one task each, screenshots, a copy button per value.

1. **Check**: "Needs a paid ChatGPT plan, on the web. About 2 minutes." Buttons: Start | I'm on the free plan → suggest Claude or Cursor.
2. **Open the setting** in a new tab, screenshot of where it is. Team / Enterprise: "Don't see it?" → message for the admin.
3. **Add the server**: name `tdoc`, URL `https://tdoc.dev/mcp`, OAuth, "I trust this provider".
4. **Sign in**; the backend sees the authorization and moves on.
5. **Use it in a chat (emphasised)**: "Start a new chat → + → pick tdoc. Every new chat needs this." Plus a test prompt. First tool call from ChatGPT → success with the doc link.

The dialog remembers its step while the user switches tabs.

### Success screen (all platforms)

"Connected ✓", the first doc's link (or a test prompt), the new agent card with its "Handles comments" toggle, and "Connect another".

## Plugins: what exists and what changes

The repo is already a marketplace (`tornado-tdoc`) with two plugins and per-vendor manifests under `plugins/`.

```
tornado-doc/tdoc
├── .claude-plugin/marketplace.json   ← marketplace "tornado-tdoc"
├── .agents/plugins/marketplace.json  ← Codex
├── .cursor-plugin/marketplace.json   ← Cursor
├── SKILL.md + bin/                   ← plugin tdoc: local CLI (Bash, Node, Python, curl, Git)
└── plugins/
    ├── claude/  (.mcp.json + skill)  ← plugin tdoc-cloud: remote MCP
    ├── codex/   cursor/   vscode/
    └── gemini/  (gemini-extension.json)
```

| Plugin | Contents | Installs on | Comments come back |
| --- | --- | --- | --- |
| `tdoc-cloud` | remote MCP `https://tdoc.dev/mcp` + skill | claude.ai, Cowork, Claude Code, Codex, Cursor, Gemini | no |
| `tdoc` | full SKILL.md + `bin/` (publish, pull, daemon…) | Claude Code, Codex with Bash only (`bin/` makes claude.ai / Cowork reject it) | daemon |

Changes:

1. **Both plugins ship a skill named `tdoc`.** claude.ai syncs `tdoc-cloud` into Claude Code; with the local plugin installed there are two. Proposal: keep both, local wins. The local skill says "if `tdoc_` MCP tools are also present, use the local CLI and don't call them"; the cloud skill's description says "use the local tdoc skill with `bin/` if it is installed"; `tdoc-doctor` flags both installed and compares the CLI account with the MCP account (a mismatch makes Send to agent go to an account the daemon doesn't watch).
2. **One-line Gemini install**: a release whose only asset is `tdoc-gemini.tar.gz` (see `plugins/SUBMITTING.md`).
3. **Listings**: submit to Anthropic, Cursor and ChatGPT per `plugins/SUBMITTING.md`; our own marketplace works meanwhile.

## One sign-in per computer

The local CLI signs in once (browser, written to `~/.tdoc/published.json`); Claude Code, Codex and the daemon on that machine share it.

- **Exists**: `tdoc-publish --signin-only`; `tdoc-doctor --json` lists missing steps; ONBOARDING.md walks the agent through them.
- **Add**: after sign-in, detect the other CLI (Claude Code ↔ Codex) and ask once whether to install there too. No second sign-in, and the daemon registers both.
- **Optional**: give Cursor / Gemini an MCP entry that uses the local credential (`Authorization: Bearer tdoc_…`), skipping their OAuth.

Not for claude.ai chat or cloud Cowork: no local scripts, no stored credential.

## Reverse channels (technical)

MCP cannot do this; the CLI and webhooks can. Remote MCP is request/response started by the client: tdoc cannot open a Claude or ChatGPT conversation, nothing runs after the client closes, and neither product offers a way for an outside service to wake it. The local CLI can stay resident (LaunchAgent) and poll; webhooks and Raft are pushed by tdoc. All three exist in the repo.

| Channel | For | How it works | Turned on by |
| --- | --- | --- | --- |
| Local daemon | Claude Code, Codex on a computer | Polls every 60 s for handoffs to "claude on &lt;device&gt;", runs the CLI non-interactively with a conservative permission mode, edits, replies, resolves. Outbound only | `bin/tdoc-daemon install` (macOS, at login); Linux `start` or cron + `once` |
| Webhook | Bots / own agents with HTTPS (Grok bot, Slack bot, n8n, Zapier) | POST `tdoc.handoff` JSON with `X-Tdoc-Signature: sha256=HMAC(secret, body)`; the bot writes back through MCP or a token | Agents → Add a bot: URL, then the one-time secret |
| Raft | Agents on Raft | tdoc pushes to Raft | Connect with Raft |
| none | claude.ai, ChatGPT, Cursor, VS Code, MCP-only Claude Code | Pull only: after the notification the user asks the agent to revise; it calls `get_comments` | nothing to turn on |

Webhook receivers: HMAC-SHA256 over the raw body, constant-time compare with `X-Tdoc-Signature`; dedupe on `X-Tdoc-Delivery`; answer 2xx within 8 s and do the work in the background.

What users see (Agents page, the toggle, Send to agent, the tip card, alerts) is in [agent-model.md](agent-model.md).

## Setup prompt: tdoc.dev/SKILL.md

The repo SKILL.md is the 90 KB local manual and doesn't suit an entry point. Proposal: serve a small router at `tdoc.dev/SKILL.md` that hands Bash agents to ONBOARDING.md and points everyone else at `tdoc-cloud` or MCP.

```markdown
---
name: tdoc-setup
description: Install tdoc (agent-written HTML docs that people comment on) in the agent you are running in. Use when the user pastes this link or asks to set up tdoc.
---

# Set up tdoc

Stop at the first check that succeeds.

## 1. Already set up?
- You have tools starting with `tdoc_`, or a `tdoc` skill with
  `bin/tdoc-doctor` -> already installed. Go to step 5.

## 2. Local install (Bash on the USER'S computer)
If you are Claude Code or Codex and can run Bash on the user's own
machine, follow https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md
end to end. It installs the local plugin, signs in, runs the doctor and
builds the first doc. Then go to step 6.

## 3. Plugin or MCP (no local Bash)
Work out which product you are in and give the user ONE of these.

- claude.ai / Claude Desktop / Cowork (also reaches Claude Code):
  Customize -> Plugins -> Add -> Add marketplace -> `tornado-doc/tdoc`
  -> install "tdoc Cloud" (NOT "tdoc") -> its Connectors tab -> Connect.
  No "Add marketplace"? Use the connector-only link:
  https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=tdoc&connectorUrl=https%3A%2F%2Ftdoc.dev%2Fmcp
- ChatGPT (paid plan, web): Plugins -> + -> Add custom MCP server ->
  `https://tdoc.dev/mcp` -> sign in. Then start a NEW chat and pick tdoc.
  Guide with screenshots: https://tdoc.dev/connect/chatgpt
- Cursor: https://cursor.com/install-mcp?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9
- VS Code: `code --add-mcp '{"name":"tdoc","type":"http","url":"https://tdoc.dev/mcp"}'`
- Gemini CLI: clone the repo, then `gemini extensions install ./tdoc/plugins/gemini`
- A bot or service you run yourself: https://tdoc.dev/me?view=settings#agents
- Not sure: https://tdoc.dev/connect
Ask the user to reply "done".

## 4. Installed but not connected?
No `tdoc_` tools after a plugin install -> tell the user to open
Connectors (or /mcp in Claude Code) and click Connect on tdoc.

## 5. First doc
Call get_writing_guide, write a one-screen "Hello from <your product>"
doc, publish it, and send the user the link.

## 6. Comments back to the agent (ask once)
- Local Claude Code / Codex: offer `bin/tdoc-daemon install` so comments
  sent with "Send to agent" are handled on this computer.
- A bot with an HTTPS endpoint: point to the Agents page.
- MCP only: say "When people comment, come back and ask me to revise
  from the tdoc comments." Nothing to set up.
```

Note: `/SKILL.md` is served by the worker today (the reader/commenter guide). The router needs either that path or a new one such as `/setup.md`; to decide.

| Platform | Reaches | Comments come back |
| --- | --- | --- |
| Local Claude Code / Codex | step 2 → ONBOARDING.md | step 6 offers the daemon |
| claude.ai / Cowork | step 3 → tdoc Cloud plugin | no |
| Cursor / VS Code / Gemini CLI | step 3 → MCP | no |
| ChatGPT | step 3 → manual add | no |
| Own bot | step 3 → Agents page | webhook |

## Backend and CLI work

Most of it exists; onboarding adds "the dialog knows which step finished" and the reverse-channel guidance.

| Piece | Today | To add |
| --- | --- | --- |
| Remote MCP | OAuth 2.1 + DCR + PKCE, `Bearer tdoc_…`, `instructions` describe usage | On a client's first call, suggest a welcome doc |
| Local CLI | `bin/tdoc-*`, `tdoc-publish --signin-only`, `tdoc-doctor --json` | After sign-in, offer the other CLI; doctor flags two `tdoc` skills and account mismatch |
| Local daemon | `tdoc-daemon install / start / once / status`, claude + codex | The ask-once after the first doc; a Linux systemd user unit |
| Webhook | `/api/me/connectors/webhook`, HMAC, 8 s timeout | Verification samples (Node / Python); send-test; retry policy in docs |
| Raft | Connect with Raft | — |

Signals the dialog needs:

1. **Onboarding session**: a short id minted on click; the backend pushes "this account just authorized client X" to the dialog (poll or SSE).
2. **Client identity**: DCR / CIMD `client_name` and `redirect_uri` for MCP; `detectAgentRuntime` for the local CLI (Claude Code, Codex, Grok, Cursor, Gemini).
3. **Done signals**: authorized → "Connected"; first publish → doc link; first daemon heartbeat / first webhook 2xx → comment handling on.

## Fallbacks, metrics, open questions

### Fallbacks

| Case | Handling |
| --- | --- |
| Local `tdoc` installed on claude.ai | Rejected (`bin/`); dialog and prompt both say "install tdoc Cloud" |
| No "Add marketplace" on claude.ai | Connector-only prefill link; admin message |
| Two `tdoc` skills in Claude Code | Doctor reports it; local skill says which wins |
| Plugin installed, never connected | Prompt step 4; dialog reminder after 10 min |
| Daemon down (sleep, shutdown) | Handoffs queue; Agents page shows offline; after 30 min a note beside Send to agent |
| Webhook non-2xx or timeout | Handoff shows `webhook_<status>` / `webhook_timeout`; send-test on the card |
| ChatGPT user never picks tdoc in a new chat | No tool call 10 min after authorization → reminder |
| Agent guesses the wrong platform | Last item falls back to tdoc.dev/connect |

### Metrics

- Funnel per platform: click → install → authorize → first doc → used again within 7 days.
- Median time from click to first doc, target under 60 s (ChatGPT excepted).
- Reverse channel adoption: share of local users who turn on the daemon; share of webhooks whose first delivery succeeds.
- Median time from Send to agent to the agent's reply (the daemon adds up to 60 s).
- Drop-off per ChatGPT dialog screen.

### Open questions

- [ ] Two `tdoc` skills: rename the cloud one, or local takes over (proposal above)
- [ ] Entry prompt: keep the ONBOARDING.md link, or add the tdoc.dev router (and at which path)
- [ ] Gemini release tarball for a one-line install
- [ ] Daemon support for more CLIs (Gemini CLI, Grok) and Linux autostart
- [ ] Whether Anthropic scheduled / remote-trigger tasks could serve as a reverse channel for claude.ai users (unverified)
- [ ] Test whether plugins load in claude.ai chat (Anthropic's pages disagree) and whether free plans can add custom plugins
- [ ] Test that `tdoc-cloud` synced from claude.ai to Claude Code needs no second MCP sign-in
- [ ] Current ChatGPT path (repo README: Plugins → +; third-party guides: developer mode) and plan limits
- [ ] OAuth `client_name` / `redirect_uri` map per client

### Sources

- This repo: `plugins/README.md`, `bin/lib/daemon.js`, webhook and local providers in `worker/worker.js` (main, 2026-10-29)
- [Claude plugins overview](https://claude.com/docs/plugins/overview), [platform support](https://claude.com/docs/plugins/platform-support), [admin settings](https://claude.com/docs/plugins/admin.md), [Cowork plugins guide](https://claude.com/docs/cowork/guide/plugins.md)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins), [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [MCP](https://code.claude.com/docs/en/mcp)
- [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [Glasser homepage](https://glasser.ai/) (Quick send to Claude.ai prefill link); [anthropics/claude-code#105428](https://github.com/anthropics/claude-code/issues/105428) ("Add to Claude" link request)
- [OpenAI plugins build docs](https://developers.openai.com/plugins/build/plugins), [Codex marketplace distribution (third party)](https://codex.danielvaughan.com/2026/04/11/codex-marketplace-plugin-distribution/)
- [Cursor plugins](https://cursor.com/docs/plugins), [Cursor marketplace post](https://cursor.com/blog/marketplace), [Cursor / VS Code install links](https://danywalls.com/create-one-click-mcp-installation-links-cursor-vscode)
- [Gemini CLI extension reference](https://geminicli.com/docs/extensions/reference.md), [Gemini CLI MCP](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)
- [ChatGPT MCP (Hjarni)](https://hjarni.com/blog/how-to-use-mcp-with-chatgpt), [ChatGPT + FastMCP](https://gofastmcp.com/integrations/chatgpt)
