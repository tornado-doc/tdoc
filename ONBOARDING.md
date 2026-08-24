# Onboarding tdoc

> **For agents (Claude Code, Codex, etc.):** read this file end-to-end before running any command. It's written for you, not the human. Execute every step in order, ask the user for confirmation on browser-side actions, and re-probe state with `bin/tdoc-doctor` after each step.

## What you are installing

`tdoc` is a Claude Code skill that gives the user prompt-native HTML documents with text- and artifact-anchored comments. After install + onboarding, the user can:

- `/tdoc new <prompt>` → generate a commentable HTML doc
- `/tdoc publish <slug>` → publish to **hosted tdoc.dev**; the first publish signs in with GitHub once
- Share the live URL; commenters sign in with GitHub

**Publishing is hosted by default and needs no Cloudflare account, no card, and nothing to click in a dashboard.** On a machine that already has Node, there is usually nothing to install at all. Self-hosting on your own Cloudflare or Vercel is still fully supported — it is at the end of this file, and you only go there if the user asks for it.

The first doc a new user gets is specified in [FIRST-DOC.md](FIRST-DOC.md); this file installs tdoc, that file builds the doc.

## Step 1 — Install the skill (if not already installed)

First check whether the user has already installed via the plugin marketplace. The marketplace install is a separate path the user runs themselves (`/plugin marketplace add tornado-doc/tdoc`) and does NOT need you to clone anything.

```bash
ls ~/.claude/skills/tdoc/SKILL.md 2>/dev/null && echo "already installed"
```

If that prints "already installed" → skip to Step 2.

Otherwise, the user reached this doc via Option B or Option C and you need to clone:

```bash
git clone https://github.com/tornado-doc/tdoc ~/.claude/skills/tdoc
```

If the user already has `~/.claude/skills/tdoc/` from a prior install, update instead:

```bash
cd ~/.claude/skills/tdoc && git pull --ff-only origin main
```

**Important about the plugin marketplace path:** if the user said they want the "one-line marketplace install," that's a direct slash-command they run themselves in Claude Code — NOT an agent task. The two commands are:

```
/plugin marketplace add tornado-doc/tdoc
/plugin install tdoc@tornado-tdoc
```

Don't try to run these for the user via Bash — they're Claude Code slash commands.

(Future: once Anthropic accepts `tdoc` into the official marketplace, the canonical install becomes `/plugin install tdoc@claude-plugins-official`. Until then, the lines above are canonical.)

## Step 2 — Verify install

```bash
ls ~/.claude/skills/tdoc/SKILL.md
ls ~/.claude/skills/tdoc/bin/tdoc-doctor
```

Both files must exist. If either is missing, the clone failed — re-run Step 1.

## Step 3 — Run the doctor

`tdoc-doctor` is a non-destructive health probe. Run it and parse the JSON:

```bash
~/.claude/skills/tdoc/bin/tdoc-doctor
```

The doctor is **target-aware**: it assesses readiness for the platform the user will actually publish to, and reports which one that was under `.target`. Unless the user said otherwise, that is `hosted`, and the Cloudflare block will be empty because it is never probed.

Pass `--platform cloudflare` (or `vercel`) only when the user has asked to self-host.

The JSON has these fields you care about:

```jsonc
{
  "target": "hosted",          // what readiness below was assessed against
  "deps": {
    "node":     { "ok": true/false, "version": "v22.x" },
    "curl":     { "ok": true/false },
    "jq":       { "ok": true/false },
    "wrangler": { "ok": true/false, "version": "4.x" },  // self-host only
    "vercel":   { "ok": true/false },                    // self-host only
    "gh":       { "ok": true/false }
  },
  "cloudflare": {
    "logged_in":   true/false,
    "account_id":  "<32-hex>",
    "subdomain":   { "ok": true/false, "name": "<subdomain>" },
    "r2_enabled":  true/false
  },
  "published": { "ok": true/false, "subdomain": "...", "worker": "..." },
  "ready_to_publish": true/false,
  "missing_steps": [
    { "id": "...", "label": "...", "kind": "install|login|click", "cmd": "..." }
  ],
  "update": {
    "ok": true/false,
    "checked": true/false,
    "behind": 0,
    "diverged": true/false,
    "cmd": "…/bin/tdoc-update --yes"
  }
}
```

`.update` is informational (this skill checkout vs `origin/main`), not a
`missing_step`. If `ok` is false and the checkout has not diverged, suggest
`/tdoc update --yes`. Do not treat a stale overlay as a Cloudflare dep.

## Step 4 — Walk the user through `missing_steps`

**On the hosted default this list is usually empty** — hosted publishing needs only Node 18+, curl and jq. If `ready_to_publish` is `true`, go straight to Step 5. Do not install wrangler, do not run `wrangler login`, and do not send the user to the Cloudflare dashboard; none of that is part of publishing to tdoc.dev.

Otherwise, iterate over `missing_steps` **in order**. Each step has a `kind`:

| `kind`     | What you do                                                                                                |
|------------|------------------------------------------------------------------------------------------------------------|
| `install`  | Run the `cmd` yourself in a Bash tool call. Example: `npm i -g wrangler`. Re-run doctor after.            |
| `login`    | The `cmd` is interactive (`wrangler login`). Run it; it opens the user's browser. Wait for it to finish.  |
| `click`    | The `cmd` is a URL. **You cannot click for the user.** Print the URL and what to do, then ask them to say "done" when they've clicked. After they say done, re-run doctor — Cloudflare can take 5–10s to propagate. |

Always re-run `bin/tdoc-doctor` between steps. State changes — what was missing in iteration N may be resolved in N+1.

`click` steps only ever appear on the self-host path. If you are seeing one on the hosted default, something is wrong — re-read `.target` before sending anyone to a dashboard.

## Step 5 — Build their first doc

**Skip this step entirely if `published.ok` is already `true` in the doctor
output** — the user already has a published doc and onboarding is done. Tell
them so and proceed to Step 6.

Otherwise, when `ready_to_publish` is `true`, **read
[FIRST-DOC.md](FIRST-DOC.md) end to end and follow it.** It is the whole
specification for what the first doc is, how much of the machine to read,
what the page says, and what happens before it is published. Do not improvise
a placeholder here.

Two things from that file are easy to skip and must not be:

- **Say the scan line before scanning.** Enumerating someone's assistant
  folders unannounced, on first run, is the fastest way to lose them.
- **Do not publish it automatically.** Every other tdoc is published as a
  matter of course; this one is about them. Build it, open it locally, and ask.

If the machine has no history to read, FIRST-DOC.md says what to do instead —
follow that rather than falling back to a placeholder document.

## Step 6 — Offer the routing line (ask once, never write silently)

`SKILL.md`'s description is what routes doc requests to tdoc, and it reaches
every session. A line in the user's `CLAUDE.md` is a stronger signal, because
project instructions read as rules rather than as a catalogue entry. Offer it;
do not take it.

**Skip this step entirely if either is true:**

```bash
# already asked, at any point in the past — never ask twice
[ -f "$HOME/.tdoc/.routing-prompted" ] && echo SKIP_ASKED
# already present — a reinstall must not append a second copy
grep -rq "<!-- tdoc:routing -->" CLAUDE.md "$HOME/.claude/CLAUDE.md" 2>/dev/null && echo SKIP_PRESENT
```

**Pick the target file** and name it in the question, because the user is
agreeing to an edit of a specific path:

- a `CLAUDE.md` in the current project that already has a `## Skill routing`
  section → add the line to that section
- otherwise `~/.claude/CLAUDE.md` — tdoc is not project-scoped, so global is
  the honest default. Create it if it does not exist.

**Ask, with the path in the question.** Use `AskUserQuestion` where the host
offers it; on a host without that tool, ask in prose and wait for a typed
answer:

> Add a routing line for tdoc to `<path>`? It tells your agent to use tdoc for
> document requests instead of writing a file by hand. The skill already
> describes itself this way — this makes it a rule rather than a suggestion.
>
> A) Add it
> B) No thanks

**On A**, append (or add to the existing `## Skill routing` list):

```markdown
<!-- tdoc:routing -->
- Write, draft, publish, or share any doc, write-up, explainer, or page → invoke tdoc
```

**On B**, record it and never raise it again:

```bash
touch "$HOME/.tdoc/.routing-declined"
```

**Either way**, mark it asked:

```bash
mkdir -p "$HOME/.tdoc" && touch "$HOME/.tdoc/.routing-prompted"
```

Do not commit the change, do not edit any other part of the file, and do not
re-ask on a later run. A declined offer is a decision, not a pending task.

## Step 7 — Wrap up

Tell the user:

- They can now run `/tdoc new <prompt>` for any new doc
- Run `/tdoc update` to pull the latest skill code anytime
- Run `/tdoc doctor` if anything feels off
- Visit `https://github.com/tornado-doc/tdoc` for the source, issues, contributions

## Idempotency

- `~/.tdoc/.routing-prompted` — the CLAUDE.md routing offer was already
  made. Never ask a second time, whichever way it was answered.
- `~/.tdoc/.routing-declined` — the user said no. Treat it as settled.
- `<!-- tdoc:routing -->` in a `CLAUDE.md` — the line is already there; a
  reinstall must not append another.
Every step is safe to re-run. The doctor reads state; the publish script checks for existing resources before creating. The user can interrupt and resume at any point.

## Appendix — self-hosting on your own Cloudflare or Vercel

Only do this when the user has explicitly said they want to host it themselves. It is not the default and not the recommended path for someone new.

Re-probe with the target named, so the checklist is the right one:

```bash
~/.claude/skills/tdoc/bin/tdoc-doctor --platform cloudflare
```

Then walk `missing_steps` as in Step 4. On Cloudflare the two `click` steps you'll hit are:

1. **Claim a workers.dev subdomain** — one-time pick. URL: `https://dash.cloudflare.com/?to=/:account/workers-and-pages`. On the Workers & Pages page Cloudflare prompts for a subdomain; the user chooses any name (typically their handle). Free.
2. **Enable R2** — one-time click. URL: `https://dash.cloudflare.com/<account_id>/r2`. Free tier is 10 GB. Requires acknowledging Cloudflare's pricing page.

Don't surprise the user — explain briefly *why* before you ask them to click. Budget about five minutes the first time. Their account, their bill, no card.

Publish with the platform named: `bin/tdoc-publish --platform cloudflare <slug>` (or `--platform vercel`). The choice is saved in `~/.tdoc/published.json` and becomes their default from then on.

## What to skip if the user just wants local

If the user says they only want local docs (no publishing, no Cloudflare), stop after Step 2. The local skill works with zero setup beyond Node 18+.

```bash
# Test that local works
node --version  # should be v18 or higher
/tdoc new "a doc that explains compound interest with a stepped diagram"
```

## Failure modes you might hit

| Symptom                                          | Fix                                                            |
|--------------------------------------------------|----------------------------------------------------------------|
| `R2 not enabled` even after the user clicked      | Wait 10s, re-run doctor. Cloudflare's API is briefly stale.    |
| `wrangler` works in terminal but doctor says no   | Path issue. Tell user to restart their terminal.               |
| Doctor asks for Cloudflare things on a hosted user | Check `.target`. Something set `TDOC_PLATFORM` or `published.json` to cloudflare. |
| Worker deploys but `/api/upload` returns 401      | The new TDOC_UPLOAD_TOKEN secret hasn't propagated. Wait 15s, retry. |
| `gh` is missing                                   | Optional — `tdoc` doesn't need it. Skip.                       |

## Credit

`tdoc` is an open-source project by [Tornado](https://github.com/tornado-doc). The original concept and framing come from [Jesse Pollak](https://x.com/jessepollak)'s [bdocs](https://x.com/jessepollak/status/2054313757543964857) — full credit to him for the idea tdoc builds on.
