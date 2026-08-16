# tdoc — agent-native document review

**Turn a prompt into a commentable HTML document, share it as a live URL, and
bring anchored comments back into your agent workflow.**

tdoc is a prompt-native document surface for agent-assisted writing and review.
It creates versioned HTML snapshots, adds Google-Docs-style comments on text
and artifacts, and lets an agent pull those comments to generate the next
version with per-comment status replies.

**Source of truth (see [AGENTS.md](AGENTS.md)):** remote storage is source of
truth; local HTML is disposable; the local skill is authoring/scaffold.

It runs in two modes:

- **Local Studio** — temporary authoring/preview on `localhost`. Not the
  product source of truth; safe to discard.
- **Published Reader** — remote snapshots on your Cloudflare Worker or Vercel
  project. This is the durable document surface.

tdoc is a first-class **Claude Code** skill and also runs under **Codex**. The
skill auto-detects the host and falls back to plain-text prompts where
Claude-specific tools are unavailable. See [Using tdoc with Codex](#using-tdoc-with-codex).

```
You:  /tdoc new "an explainer of compound interest with a diagram of principal vs interest over time"
Claude: <generates doc, opens it locally>
You:  /tdoc publish
Claude: https://tdoc.yourname.workers.dev/d/compound-interest/v/1
```

Anyone with the link reads it instantly and comments on any sentence, image, or
chart. Your agent pulls those comments, regenerates the next version, and
replies on each comment with ✅ applied / 🟡 partial / ❓ question so reviewers
can see exactly what changed without leaving the doc.

## The pain point

**You no longer need to be the router between your colleagues' comments and your agent.**

Feedback on docs from a chat was always a tradeoff:

- A nice UI for people to comment (Google Doc, Slack thread, screenshots) → but you copy-paste it all back to the AI by hand, every round.
- Or clean structured input the agent can act on (raw JSON, "edit line 47") → but nobody wants to write feedback that way.

And docs made in chat have no version history — every regeneration overwrites the last.

`tdoc` gives you both sides: humans comment Google-Docs-style on any sentence/image/chart, the agent reads the same comments as structured input, and every edit is a new version you can flip back to. All free, all yours.

Think of it as **Google Docs, but for agent-authored HTML documents**:
multiplayer comments, comment status that stays in sync, full version history,
and a one-line CLI to drive it all.

## Install

Paste this into Claude Code or Codex:

```
Install tdoc by following https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md
```

The agent clones the repo, runs the doctor, walks you through the ~2 browser clicks for Cloudflare, and ends with a published URL. **Zero to live in ~3 minutes.**

Or via the plugin marketplace: `/plugin marketplace add tornado-doc/tdoc`

### Using tdoc with Codex

tdoc is authored as a Claude Code skill but is host-aware, so it works under Codex too:

- **Install location**: clone (or symlink) the repo into `~/.codex/skills/tdoc` (Codex reads `~/.codex/skills/`), the same way Claude Code uses `~/.claude/skills/tdoc`. The setup snippet resolves whichever location exists, and you can override with `TDOC_SKILL_DIR`.
- **Prompts**: where the skill would use Claude Code's `AskUserQuestion` picker (only the first-run telemetry consent), under Codex it falls back to asking the same question as plain text and reading your typed reply. No functionality is lost.
- **What's the same**: the worker, the CLI (`bin/tdoc-*`), comments, versions, publish — all host-independent.

What is *not* yet first-class on Codex: native slash-command registration (`/tdoc …`) — you invoke tdoc by pointing Codex at `SKILL.md` and asking it to run the workflow. That's the one rough edge versus Claude Code.

## Commands

| Command | What it does |
|---|---|
| `/tdoc new <prompt>` | Generate a new doc + open locally |
| `/tdoc edit <slug>` | New version from open comments; replies on each with ✅/🟡/❓ status |
| `/tdoc publish <slug>` | Deploy to your Cloudflare Worker (or Vercel, `--platform vercel`), get a public URL |
| `/tdoc pull <slug>` | Sync comments from the published doc back to local |
| `/tdoc fork <slug>` | Copy a doc to a new slug |
| `/tdoc unpublish <slug>` | Remove a published doc from your Worker |
| `/tdoc list` | Show all docs |
| `/tdoc onboard` | First-time guided setup |
| `/tdoc update` | Pull the latest skill code |
| `/tdoc doctor` | Health check (deps, Cloudflare config) |

## Cost

**$0 for normal use.** Cloudflare Workers + R2 + KV all have generous free tiers that personal usage will never come close to. The same goes for the Vercel target (Functions + Blob + Upstash Redis free tiers). You own your account; nobody else (including the maintainer) sees your traffic or pays your bills.

## Hosting targets

Publishing deploys the **same worker code** to a host you own; pick one on your
first publish and it sticks (saved in `~/.tdoc/published.json`):

- **Cloudflare (default)** — Worker + R2 + KV, with a Durable Object
  serializing concurrent comment writes. The most battle-tested target.
- **Vercel** — `/tdoc publish --platform vercel <slug>` deploys a catch-all
  Vercel Function backed by Vercel Blob (docs) and Upstash Redis (metadata +
  comments, from the Vercel Marketplace). Same URLs, same commenting, same
  GitHub sign-in. Two caveats vs. Cloudflare: concurrent comment writes are
  not serialized (no Durable Object equivalent), and uploads are capped at
  ~4.5 MB per doc by Vercel's request limit. Details in
  [vercel/README.md](vercel/README.md).

## Local vs published

Same document snapshots; different roles (see [AGENTS.md](AGENTS.md)):

- **Local Studio** reads `~/tdocs` from disk for fast anonymous preview and
  agent iteration. **Disposable.** Deleting local copies must never be treated
  as deleting the product document.
- **Published / remote storage** holds the durable snapshots, public URLs, and
  hosted comments. **Source of truth.** Document delete/unpublish/management
  targets remote storage via skill + API, not a particular local port UI.

Overlay code is bundled into the hosted runtime at publish time from the skill
checkout; local overlay edits only affect Local Studio until the next publish
redeploy. Published pages also expose the bundled runtime provenance at
`/api/runtime` and in `window.__TDOC__.runtime`.

## How comments work

It's the Google-Docs commenting model, built for generated HTML documents and
wired to your agent:

- **Text**: highlight any sentence (across paragraphs, across bold/links — anchors survive regeneration) → comment popup, cursor ready to type
- **Artifacts** (img / canvas / svg / video / `<pre>`): hover → comment icon → click
- **Threads**: emoji reactions (👍 ❤️ 🔥 ✅ ❓ + `LGTM`) and replies; hover a reaction to see who reacted
- **Move / remove anchor**: drag a comment to new text, or detach it entirely — it stays in the thread
- **Multiplayer**: anyone with the link signs in once with GitHub and comments. Every comment is attributed to its real author, and concurrent commenters never clobber each other (writes are serialized per-doc — see Reliability below).
- **Status sync**: comments carry a resolved-style status that stays in sync between the web view and your agent — the acting agent stamps each with ✅ applied / 🟡 partial / ❓ needs clarification when it regenerates, so "what's been addressed" is visible to everyone, live, without re-pinging.

## Version history

Every doc is versioned, and **every version is a full snapshot** — not a diff. You can:

- Flip back to any past version (`/d/<slug>/v/2`); a subtle banner on an older version links you to the latest.
- Keep commenting on old versions — comments anchored to text that a later version removed are preserved, never silently dropped.
- Pull the complete cross-version history of comments back to local with `/tdoc pull` (it merges, never overwrites).

This is the "edit history" half of the Google-Docs feeling: nothing you write — doc or comment — gets lost to a regeneration.

## Reliability (what makes the multiplayer part trustworthy)

- **Concurrent comments never lost.** Per-doc comment writes are serialized through a Cloudflare Durable Object, so two people commenting at the same instant both land — no last-write-wins clobber.
- **Comments survive every regenerate.** When a new version reshuffles the doc, comments re-anchor to their artifact by content identity; if a target genuinely disappears, the comment is shown unanchored ("click to re-anchor") rather than attached to the wrong place.
- **Untrusted input is escaped.** Comment text, author names, and avatars are HTML-escaped on render — a comment can't inject script into the page.
- **Auth**: local docs comment anonymously with zero setup. Published docs require a one-time GitHub sign-in (Device Flow, scope `read:user`) before commenting.

## Requirements

- Node 18+
- `jq` (for publishing)
- For publishing, ONE of:
  - `wrangler` + a free Cloudflare account with R2 enabled (default), or
  - `vercel` CLI + a free Vercel account (`/tdoc publish --platform vercel <slug>`)

`/tdoc onboard` checks and installs these for you.

## Roadmap (not built yet)

tdoc today is a **comment + version** surface — humans comment, the agent regenerates. These are wanted but **not yet shipped** (listed here so the feature list above stays honest):

- **Suggestion mode** — propose an inline edit a reviewer can accept/reject, instead of leaving a comment.
- **Edit mode** — edit the doc text in the browser, not only through the agent.
- **Collaborative / multi-editor editing** — two people editing the same doc live (today, *commenting* is multiplayer; *editing* is agent-driven and single-writer per regenerate).
- **Track-changes-style edit history** — version history exists today (full snapshots you can flip between); a per-change diff/track-changes view is the next step.

Want one of these? Open an issue.

## Testing

The suite runs offline by default; browser and network suites are gated.

```bash
npm test            # all offline suites (worker logic, comment fold, reconcile,
                    # security, CLI, P3 hardening — no network, no browser)
npm run test:all    # also runs the gated suites:
                    #   ui.test.js / responsive.test.js  — real browser (needs playwright;
                    #                                       skip loudly if absent)
                    #   publish.test.js / onboarding.test.js — publish + doctor flows
```

Browser suites default to a committed local fixture (so they test the working-tree
overlay, offline). Point them at a live doc with `TDOC_TEST_URL=<url>`. Install the
optional browser dep with `npm i -D playwright && npx playwright install chromium`.

## Telemetry

tdoc records when it runs, how it went (success / error / abandoned),
how long it took, and a random UUID for your machine, and sends those
events to the tdoc maintainer's Supabase. **It does NOT record your
tdoc content, your prompts, file paths, or anything else.** Nothing is
sent to Anthropic.

The maintainer uses this to figure out which features people use,
what breaks, and what to fix next — without guessing.

### What's collected (the full list)

| Field             | Example                              |
|-------------------|--------------------------------------|
| `ts`              | `2026-05-22T16:32:11Z`               |
| `skill`           | `tdoc`                               |
| `skill_version`   | `0.7.6`                              |
| `event_type`      | `skill_run` / `upgrade_prompted`     |
| `outcome`         | `success` / `error` / `abandoned`    |
| `duration_s`      | `87`                                 |
| `step`            | which tdoc command — `new` / `edit` / `publish` / … |
| `error_class`     | short error tag, e.g. `publish_timeout` |
| `error_message`   | longer error context, ≤400 chars     |
| `session_id`      | Claude Code session ID               |
| `installation_id` | random UUID per machine              |
| `os` / `arch`     | `darwin` / `arm64`                   |
| `sessions`        | count of concurrent active sessions  |

It does **not** record your tdoc content, your prompts, file paths,
or which git repo you were in. The full schema and edge-function code
live in `telemetry/` — read the code if you want to verify.

### Three opt-out paths

1. **On first run**: pick "Off" in the consent prompt.
2. **Persistent**: `echo off > ~/.tdoc/.telemetry-mode`
3. **Ephemeral** (one shell): `export SKILL_TELEMETRY=off`

### How to delete your data

Your installation_id is at `~/.tdoc/telemetry/installation-id`. Send it
to the maintainer and ask them to delete rows matching it (one SQL
line — no excuse not to).

## Credit

Originally inspired by [bdocs](https://x.com/jessepollak/status/2054313757543964857) by [Jesse Pollak](https://x.com/jessepollak). tdoc is an independent open-source project by [Tornado](https://github.com/tornado-doc) — created by [Serena Keyitan](https://github.com/serenakeyitan), maintained by [Serena Keyitan](https://github.com/serenakeyitan) and [Julie Shi](https://github.com/yayashuxue).

## License

MIT
