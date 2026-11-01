# tdoc agent model

Status: draft for review · 2026-10-29 · Serena
Companion: [Onboarding](onboarding.md) (installing tdoc and connecting each platform)

People manage "my agents": one card per agent, one **Handles comments** toggle on each. Daemon, webhook and Raft are implementation details the system picks from the agent's type. This replaces the per-connector Agents settings (Raft / Local / Webhook cards) with a per-agent list.

## Agent

An agent is one concrete thing that writes tdoc: a product plus where it runs. It registers itself the first time it connects; nobody adds agents by hand except bots.

| Field | Meaning | Example |
| --- | --- | --- |
| Name | Product + place, editable | Claude Code · serena-mbp |
| Type | Decides the comment channel | local / hosted / bot / raft |
| Can write | Has a valid authorization | ✓ / authorization expired |
| Handles comments | on / off / not supported | on |
| Status | Only meaningful with comment handling on | online / offline 2 h / last delivery failed |
| Last activity | Last doc written or comment handled | revised "Q4 plan", 3 min ago |

| Type | Covers | Registered when | Handles comments |
| --- | --- | --- | --- |
| local | Claude Code, Codex on a computer | Local CLI signs in; `detectAgentRuntime` names the product, the host name the computer | yes (daemon) |
| hosted | claude.ai, ChatGPT, Cursor, VS Code, MCP-only CLIs | First MCP OAuth; identified by DCR `client_name` / `redirect_uri` | no: "we'll remind you" instead |
| bot | Own agents, Grok bot, Slack bot, n8n | Added on the Agents page, or first call with its token | yes (webhook) |
| raft | Agents on Raft | After Connect with Raft | yes (Raft) |

The same product on two computers is two agents. Claude Code on one computer using both the local CLI and MCP is one local agent (local wins; see the duplicate-skill note in [onboarding.md](onboarding.md#plugins-what-exists-and-what-changes)).

## Agents page

A list, one row per agent, one control that matters. Channel details live under "Advanced" in the expanded row.

```
Agents                                              [+ Add a bot]
──────────────────────────────────────────────────────────────────
Claude Code · serena-mbp   ★ default
  Handles comments  [● on ]    ● Online · revised "Q4 plan" 3 min ago
Codex · serena-mbp
  Handles comments  [ off○]    Turn on to let Codex pick up comments
Claude (claude.ai)
  Handles comments   —         You'll get a notification to ask Claude
My Grok bot
  Handles comments  [● on ]    ⚠ Last delivery failed (HTTP 502)  [Retry]
```

- Each row answers three things: which agent, does it handle comments, is it healthy.
- Three status colours: green online, grey off / not supported, amber needs attention (offline with waiting comments, failed delivery, expired authorization).
- Expanded row: recent handoffs, make default, pause, remove, and Advanced (daemon interval and permission mode, webhook URL and secret rotation, Raft server).
- **Add a bot** is the only manual add. Raft sits in its menu.

## Handles comments toggle

One toggle; the system runs the matching setup. Every setup ends with an automatic test comment, and it counts as on only when the agent has replied to it.

| Type | After turning it on | User does | On when |
| --- | --- | --- | --- |
| local | Explains "runs in the background on your computer and checks every minute; comment text is untrusted input, it only edits this doc", then gives one line to paste into the agent (it runs `tdoc-daemon install`) | Pastes it into Claude Code / Codex | First daemon heartbeat → test comment → agent replies |
| bot | Form: URL → secret shown once → verification sample code | Configures the bot | Test event returns 2xx |
| raft | Raft authorization → pick the default agent | Confirms in Raft | Raft accepts the test event |
| hosted | No toggle. "Why?" explains claude.ai / ChatGPT can't be woken from outside and suggests "Have Claude Code on your computer? Connect it and it handles comments on its own." | — | — |

**Off** pauses and keeps the setup; turning it back on needs no new setup. A paused daemon keeps polling and simply gets no work. **Remove** tears it down: for local, show `tdoc-daemon uninstall` (and uninstalling on the computer removes the agent here too); for a bot, delete the secret.

## Send to agent picker and routing

The picker is the agent list. Picking an agent that can't handle comments is not a failure; it becomes "we'll remind you to do it there".

```
Send to  [ Claude Code · serena-mbp  ● Online       ▾ ]
         ├ Claude Code · serena-mbp   ● Online · handles it now
         ├ My Grok bot                ● handles it now
         ├ Codex · serena-mbp         ○ Off · turn on
         └ Claude (claude.ai)         ✉ We'll remind you to ask Claude
```

**Default**: unchanged rule, now shown on the button: the agent last picked for this doc > the agent that last edited it > the account default.

**After sending**, the status beside the comment moves: sent → picked up (daemon fetched / webhook 2xx / Raft accepted) → replied (with the new version's link). For a hosted agent it reads "reminded you", and the reminder includes a line to paste into Claude.

**No agents at all**: the button stays enabled and opens the tip card below.

## Tip card

Same structure and interaction as Cursor's bottom-left update card; the content invites people to let their agent handle comments and changes with the agent type. Clickable prototype: [tdoc Agent Tip](https://claude.ai/artifact/SWWu45B43WwX7LpbdTt4Df). The hero uses tdoc's own visuals, not Cursor's artwork.

| Part | Cursor | tdoc |
| --- | --- | --- |
| Placement | Floating bottom-left, ~300 px wide, rounded, hairline border, shadow, slides up | Same, on the docs list and the doc page |
| Hero | ~125 px gradient landscape with a product window cycling three frames; round close button top right | Three frames: ① @agent in a comment → ② agent picked it up, revising → ③ new version, replied |
| Heading | Small grey "Now Available" + title | "New for your agents" + title per type |
| Three rows | Icon + bold line + two grey lines | Same; the row matching the current frame is lit, the others dimmed; hovering a row holds its frame |
| Footer | Hairline; "Learn more ↗" left, small white "Try it" right | "Learn more ↗" left, primary button right |

| Type | Title | Rows | Button |
| --- | --- | --- | --- |
| local | Let Claude Code handle your comments | Hand off from any comment · Keeps working in the background · Every change is visible | Turn on |
| bot | Send comments to your own bot | Hand off from any comment · Runs wherever your bot runs · Every change is visible | Add a bot |
| hosted | Get comments back to Claude | A reminder for every comment · Want it fully automatic? · Same doc, same account | Set up Claude Code |

The title uses the user's actual agent name. The hosted version steers people to connect local Claude Code so comments are handled automatically.

**After the button**: the card stays put and swaps to the next step (a line to paste or the form, with Copy) and a live status line, "Waiting for serena-mbp…" → green "Claude Code replied to a test comment". It closes itself 3 s after success.

**When it shows**

- Condition: a doc the user owns got a comment from someone else, and no agent has comment handling on. Not right after the first doc: there is nothing for it to act on yet.
- Timing: at most once per session, 5 s after the page opens.
- Also: Send to agent with no agents opens it directly (not rate limited).
- Dismiss: × collapses it to a small pill for the session. After two dismissals it stops appearing; the Agents page and Send to agent remain.
- One card at a time; future announcements reuse the same slot and style.

## Alerts

Only when comments are affected, naming the agent, how many comments, and the fix. Same bottom-left slot (amber) plus email.

| Case | When | Says | One-click |
| --- | --- | --- | --- |
| Local offline | No heartbeat for 30 min and comments are waiting | "3 comments are waiting for Claude Code on serena-mbp. The computer may be asleep." | Send to another agent / Remind me to do it |
| Bot failing | 5 failures in a row, then auto-pause | "My Grok bot returned HTTP 502 five times in a row and is paused." | Retry / Delivery log |
| Authorization expired | Next write fails | "Claude (claude.ai) needs to sign in again." | Sign in |
| Stuck handoff | No progress 2 h after sending | "Still waiting for the agent" beside the comment | Another agent / Handle it myself |

## Open questions

- [ ] Hosted agent identity: are client `client_name` / `redirect_uri` values stable enough to merge repeat authorizations from one user
- [ ] Merge rule for local CLI + MCP on one computer (decide with the duplicate-skill question in [onboarding.md](onboarding.md#open-questions))
- [ ] Daemon support for more CLIs (Gemini CLI, Grok), which would turn them from hosted into local
- [ ] Tip card hero: HTML animation (as in the prototype) or a recorded video
- [ ] "Remind me" channel: in-app, email or browser push (the shell already has a push service worker)
