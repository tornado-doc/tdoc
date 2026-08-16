# Onboarding tdoc

> **For agents (Claude Code, Codex, etc.):** read this file end-to-end before running any command. It's written for you, not the human. Execute every step in order, ask the user for confirmation on browser-side actions, and re-probe state with `bin/tdoc-doctor` after each step.

## What you are installing

`tdoc` is a Claude Code skill that gives the user prompt-native HTML documents with text- and artifact-anchored comments. After install + onboarding, the user can:

- `/tdoc new <prompt>` → generate a commentable HTML doc
- `/tdoc publish <slug>` → publish (default target is hosted tdoc.dev; signup may be closed, so onboarding uses `--platform cloudflare` below)
- Share the live URL; commenters sign in with GitHub

Install + onboarding takes ~3 minutes on a clean machine. Most steps are automatic. The user only has to click ~2 things in a browser.

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

The JSON has these fields you care about:

```jsonc
{
  "deps": {
    "node":     { "ok": true/false, "version": "v22.x" },
    "wrangler": { "ok": true/false, "version": "4.x" },
    "jq":       { "ok": true/false },
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
  ]
}
```

## Step 4 — Walk the user through `missing_steps`

If `ready_to_publish` is `true` and `published.ok` is `true`, skip to Step 5 — they're already set up.

Otherwise, iterate over `missing_steps` **in order**. Each step has a `kind`:

| `kind`     | What you do                                                                                                |
|------------|------------------------------------------------------------------------------------------------------------|
| `install`  | Run the `cmd` yourself in a Bash tool call. Example: `npm i -g wrangler`. Re-run doctor after.            |
| `login`    | The `cmd` is interactive (`wrangler login`). Run it; it opens the user's browser. Wait for it to finish.  |
| `click`    | The `cmd` is a URL. **You cannot click for the user.** Print the URL and what to do, then ask them to say "done" when they've clicked. After they say done, re-run doctor — Cloudflare can take 5–10s to propagate. |

Always re-run `bin/tdoc-doctor` between steps. State changes — what was missing in iteration N may be resolved in N+1.

**The two `click` steps you'll encounter most:**

1. **Claim a workers.dev subdomain** — one-time pick. URL: `https://dash.cloudflare.com/?to=/:account/workers-and-pages`. On the Workers & Pages page Cloudflare prompts for a subdomain; user chooses any name (typically their handle). Free.
2. **Enable R2** — one-time click. URL: `https://dash.cloudflare.com/<account_id>/r2`. Free tier is 10 GB. Requires acknowledging Cloudflare's pricing page.

Don't surprise the user — explain briefly *why* before you ask them to click.

## Step 5 — Offer a sample doc

**Skip this step entirely if `published.ok` is already `true` in the doctor output** — the user already has a published doc and onboarding is done. Tell them so and proceed to Step 6.

Otherwise, when `ready_to_publish` is `true` and the user has no published doc yet, offer to publish a sample. A reasonable default (note: respect `TDOC_DIR` env var if set; defaults to `~/tdocs/`):

```bash
# Pick a slug
SLUG="welcome"
# Generate a simple HTML doc (you can be more creative)
mkdir -p ~/tdocs/$SLUG/v1
cat > ~/tdocs/$SLUG/v1/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Hello tdoc</title>
<style>body{font:18px/1.6 system-ui;max-width:680px;margin:80px auto;padding:0 20px}h1{color:#1652f0}</style>
<h1>Hello, tdoc.</h1>
<p>This is your first document. Highlight any text to leave a comment.</p>
HTML
cat > ~/tdocs/$SLUG/meta.json <<EOF
{"title":"Hello tdoc","slug":"$SLUG","versions":[{"n":1,"created":"$(date -Iseconds)"}]}
EOF
echo '[]' > ~/tdocs/$SLUG/comments.json
# Publish to the user's own Cloudflare Worker. Hosted tdoc.dev is the
# default for `/tdoc publish`, but self-serve signup is closed — use an
# explicit self-host flag here.
~/.claude/skills/tdoc/bin/tdoc-publish --platform cloudflare $SLUG
```

The script prints the live URL. Show it to the user.

## Step 6 — Wrap up

Tell the user:

- They can now run `/tdoc new <prompt>` for any new doc
- Run `/tdoc update` to pull the latest skill code anytime
- Run `/tdoc doctor` if anything feels off
- Visit `https://github.com/tornado-doc/tdoc` for the source, issues, contributions

## Idempotency

Every step is safe to re-run. The doctor reads state; the publish script checks for existing resources before creating. The user can interrupt and resume at any point.

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
| Worker deploys but `/api/upload` returns 401      | The new TDOC_UPLOAD_TOKEN secret hasn't propagated. Wait 15s, retry. |
| `gh` is missing                                   | Optional — `tdoc` doesn't need it. Skip.                       |

## Credit

`tdoc` is an open-source project by [Tornado](https://github.com/tornado-doc). The original concept and framing come from [Jesse Pollak](https://x.com/jessepollak)'s [bdocs](https://x.com/jessepollak/status/2054313757543964857) — full credit to him for the idea tdoc builds on.
