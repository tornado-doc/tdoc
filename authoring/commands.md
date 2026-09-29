# Commands — full /tdoc reference

Read the section you need. The SKILL.md first screen only keeps the
generation-path essentials (`/tdoc new`, `/tdoc edit`) and points here
for the rest.

### `/tdoc new <prompt>` — create a new doc

**Where it goes.** A doc is published to hosted `tdoc.dev` and the user is
handed a shareable link. That is the default and it is not something to ask
about. Two things change it, and only if the user says so in their own words:

| The user said | Destination | What they get back |
|---|---|---|
| nothing about hosting | **hosted tdoc.dev** | `https://tdoc.dev/d/<slug>/v/1` — link-readable, not listed anywhere |
| "publish to my own Cloudflare / Vercel", "self-host it" | their own worker | `<worker>.workers.dev` / `tdoc-<scope>.vercel.app` — still a public link, **not localhost** |
| "keep it local", "don't upload it anywhere", "just show me locally" | local only | `http://localhost:7878/...` |

**The localhost rule: never hand over a `localhost` URL unless the user asked
to keep the doc local.** Not as a fallback, not when a sign-in did not finish,
not as "here it is locally in the meantime". Asking to self-host on Cloudflare
or Vercel is NOT asking for localhost — that path still ends at a public URL.
If publishing cannot complete, say so and leave the doc in `$TDOC_DIR/<slug>/`;
do not substitute a local URL for the link the user was promised.

This rule is about **what you hand over**, not about the local server, which is
untouched. `/tdoc serve` still works for everyone, and previewing locally while
iterating is fine whenever the user asks for it — it is simply not what a
finished doc is delivered as.

**Step 0 — start the sign-in before you start writing.** Hosted publishing
needs a one-time sign-in. Generating a doc takes 30–60 s and the pairing
flow is a poll loop, so run them at the same time rather than interrupting the
user at the end:

```bash
# no-op and instant when already signed in
bash "$SKILL_DIR/bin/tdoc-publish" --signin-only
```

Launch this in the **background** (Bash `run_in_background: true`) and go
straight on to writing the doc. Against a current hosted worker this is the
tdoc pairing flow: it opens `tdoc.dev/activate` in the user's browser with
the code prefilled — they sign in there however they like and click Approve.
Where auto-open cannot fire, relay the URL and code to the human and wait;
never open the URL in your own browser (your session is not theirs). Against
an older worker it falls back to the GitHub device flow, where the code is
typed on github.com. Tell the user in one line what opened and that the code
is in the terminal; then keep working. Skip Step 0 entirely for the local-only and self-host destinations.

1. Pick a slug from the prompt (kebab-case, ≤4 words).
2. **Read `$SKILL_DIR/authoring/voice.md`, `$SKILL_DIR/authoring/visuals.md`, `$SKILL_DIR/authoring/structure/components.md`, and the `$SKILL_DIR/authoring/style/` entry you picked.**
   Voice constrains the prose as you generate it, not as a later cleanup
   pass. The style tells you which components to reach for and its palette —
   apply it unless the user named another entry in `$SKILL_DIR/authoring/style/`.
   The named style file is the complete visual contract: use its CSS, but do
   not invent a second page-wide aesthetic on top of it.
3. Write the host document to a temp file (not into `~/tdocs` — step 4 puts it
   there):
   - All host CSS inline in `<style>`. **Never put JavaScript in the host.**
     Host `<script>`, `on*=` handlers, and `javascript:` URLs are inert under
     CSP and therefore create controls or empty panels that cannot work. If
     the idea needs computation, write `v1/widgets/<name>.html` and iframe it.
   - No external CDNs in the host unless requested. No build step.
   - Pick the style that fits the content when the user names none. A full-page
     custom design is allowed only when the user explicitly requests one;
     programmatic callers must make that exception visible with
     `--custom-template`.
   - Interactive: if the prompt implies a model or diagram, build it with the CSS-only techniques in "Interactivity: CSS only" — `:checked` toggles, CSS keyframes, `<style>` inside the `<svg>`. If the idea genuinely needs computation, emit a sandboxed widget island (see that section); do NOT put `<script>` in the host document.
4. **Hand the HTML to `bin/tdoc-write`. Do not write into `~/tdocs` yourself.**

   ```bash
   bash "$SKILL_DIR/bin/tdoc-write" \
     --slug <slug> --title "<title>" --style <selected-style> \
     --prompt "<the user's request, one line>" \
     --html-file /tmp/<slug>.html
   ```

   One call does everything a version needs: validates the host, bakes the
   reading template so the document is self-contained, writes
   `v1/index.html`, writes `meta.json`, and initializes `comments.json`. It
   prints the local URL on the last line.

   Doing these by hand is what let documents ship without a reading template —
   validation and baking are properties of *writing a version*, not of any one
   command, so they live in one place that every path goes through. Add
   `--widgets-dir <dir>` for sandboxed islands, and `--custom-template` only
   when the user explicitly asked for a whole-page custom design.

   If it exits non-zero, fix the host and run it again; nothing has been
   written. Do not open, publish, or report the document as complete.
5. **Review the document before publishing.** Check the content, table structure,
   SVG labels and responsive styles against `authoring/visuals.md`.
   The write command validates the template and bakes the reading styles; it
   does not perform rendered layout verification. For changed SVG charts, use
   the small standalone preview helper described in `$SKILL_DIR/authoring/structure/components.md`
   and inspect its images. An existing browser can review the full document;
   do not install a browser for authoring. Only claim visual verification for
   what was actually rendered and inspected.

6. **Publish and hand over the link.**

   *Hosted (the default).* Confirm the background sign-in from Step 0 finished,
   then publish:

   ```bash
   bash "$SKILL_DIR/bin/tdoc-publish" <slug>
   # keep earlier drafts to yourself:
   #   bash "$SKILL_DIR/bin/tdoc-publish" --history owner <slug>
   ```

   Report the `https://tdoc.dev/d/<slug>/v/1` URL on its own line, and say what
   it is — the user may never have seen a tdoc page before. Describe the
   access it actually has, which for a plain publish is the legacy policy:

   > Your doc is live. Anyone with this link can read it — and can page back
   > through earlier versions — but it is not listed anywhere, so only people
   > you send it to will find it.

   Do **not** call it "unlisted". A publish with no explicit flags stores no
   access block and takes the legacy policy (`visibility: public`,
   `history_visibility: public`); saying unlisted would understate what a
   recipient can see. If the user wants earlier versions kept private, that is
   `--history owner`.

   *If the sign-in has not completed yet*, do not fall back to localhost and do
   not go quiet. Say the doc is written and waiting, and that approving the
   approval page finishes it — or that they can say "publish it" later and you'll
   get them a fresh code. The doc stays in `$TDOC_DIR/<slug>/`.

   *Self-host.* `bash "$SKILL_DIR/bin/tdoc-publish" --platform cloudflare <slug>`
   (or `vercel`). Report the worker URL, with the same note about access.

   **Local preview stays available to self-hosting users** — `/tdoc serve` and
   `http://localhost:7878` are unchanged, and iterating locally before pushing
   to your own worker is a perfectly good loop. That is an *authoring* step the
   user can ask for at any time; it does not change what gets handed over at
   the end, which is still the worker URL. Nothing about the local server was
   removed.

   *Local only — because the user asked.* Start the server if needed and open
   the local URL:

   ```bash
   open "http://localhost:7878/d/<slug>/v/1"
   ```

   This is the only branch that reports a `localhost` URL.

### `bin/tdoc-new` — programmatic entry for agents in other skills

This is the contract OTHER skills (`/document-release`, `/retro`,
`/investigate`, `/cso`, `/qa-only`, `/office-hours`, `/plan-*`, etc.)
use when an agent inside them is about to emit a doc-shaped artifact.
The human-facing `/tdoc new` flow is a chat-driven prompt → HTML
generation. `bin/tdoc-new` is the other direction: the calling agent
already has the finished HTML and just wants tdoc to scaffold storage,
serve it locally, and (optionally) publish.

**When to use it:** any time inside another skill you would otherwise
have written a document such as `cat > some-report.md <<EOF ...`, unless
the output format or file target was explicitly requested. Generate the doc
as HTML (use the template + styling rules from the `/tdoc new` section
above), then hand it off:

```bash
HTML_FILE=$(mktemp -t tdoc-handoff.XXXXXX.html)
cat > "$HTML_FILE" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>...</title></head>
<body><div class="wrap">
  <h1>...</h1>
  <!-- sections; tag author-composed wrappers data-tdoc-artifact
       wherever you want a comment surface -->
</div></body>
</html>
HTML

TDOC_NEW_CALLER=document-release \
  ~/.claude/skills/tdoc/bin/tdoc-new \
    --slug "release-notes-$(date +%Y%m%d)" \
    --title "Release notes — $(date +%Y-%m-%d)" \
    --html-file "$HTML_FILE" \
    --publish
```

**Args:**
- `--slug <kebab-case>` (required) — slug for `~/tdocs/<slug>/`.
- `--title "<title>"` (required) — recorded in `meta.json`.
- `--html-file <path>` OR `--html-stdin` (required) — full HTML for v1.
- `--widgets-dir <path>` — optional directory of sandboxed widget HTML files.
  Each `<name>.html` is stored as `v1/widgets/<name>.html`; JavaScript belongs
  there, never in the host HTML.
- `--prompt "<one-line>"` — prompt-of-record in `meta.json` (defaults
  to `Imported via tdoc-new by <caller>`).
- `--publish` — also run `tdoc-publish` so a shareable URL is returned.
- `--open` — open the resulting URL in the default browser.
- `--quiet` — suppress informational output (the URL is still printed
  on the last line so callers can capture it).
- `--style default|technical|editorial|paper` — selected house-style
  contract. Omit it to use `default`.
- `--custom-template` — explicit opt-out from the default template for a
  user-requested presentation, landing page, or full-bleed simulation. Normal
  docs must not pass it.
- `--force` — overwrite an existing slug. Without this, an existing
  slug is a hard error (no silent clobber).

**Output contract:** the local URL is always the last line on stdout.
If `--publish` succeeded, the published URL appears on a second line.
This is what callers should `tail -n 1` (or `tail -n 2`) to capture.

**Guards built in:** refuses to clobber existing slugs without `--force`;
validates the host before replacing an existing doc; copies explicitly
supplied widget files; restarts the local server if needed. Host validation
rejects `<script>`, `on*=` handlers, `javascript:` URLs, and `<canvas>` even in
custom-template mode, because all of them are inert under the host CSP and can
silently create empty UI. It also enforces the selected house-style boundary.
Whole-page custom styling requires the deliberate `--custom-template` flag;
that flag never permits host JavaScript.

**Set `TDOC_NEW_CALLER`** (or rely on `CLAUDE_SKILL_NAME`) so `meta.json`
records which skill scaffolded the doc — useful for later auditing or
for `/tdoc list` to show provenance.

### `/tdoc edit <slug> [<extra prompt>]` — new version from comments

You MUST report back on every open comment — applied, partial, or unclear.
This is a hard requirement, not a suggestion. The user can't tell which
comments you handled unless you reply on each one. Skipping comments
silently is the #1 source of regression complaints.

1. **Pull the comments first, then read them.** `~/tdocs/<slug>/comments.json`
   is a cache of a file other people are writing: everything said since your
   last round — including a comment someone deleted — is only in the published
   doc. Skip for a doc that was never published.

   ```bash
   bash "$SKILL_DIR/bin/tdoc-pull" <slug>
   ```

   Then read `~/tdocs/<slug>/comments.json` and filter to `status: "open"`.
2. **Get the current document — remote is the source of truth, local is a
   cache.** The local `v<n>/index.html` can be stale: a browser edit or a
   publish from another machine creates versions your checkout never saw, and
   an edit based on a stale copy silently discards them. One conditional
   request settles it (`published.json` holds the base URL; skip this entirely
   for a doc that was never published):

   ```bash
   REMOTE_SHA="$(curl -sfI "$BASE/d/<slug>/v/<n>/raw" | tr -d '\r' | sed -n 's/^etag: "\(.*\)"$/\1/Ip')"
   LOCAL_SHA="$(node -e 'const m=require(process.argv[1]);const e=(m.versions||[]).find(v=>v.n===Number(process.argv[2]));console.log(e&&e.sha||"")' "$TDOC_DIR/<slug>/meta.json" <n>)"
   ```

   - **Match** → your local copy produced what remote holds; use it as the base.
   - **Differ (or no local sha)** → pull the truth: `curl -sf "$BASE/d/<slug>/v/<n>/raw" -o "$TDOC_DIR/<slug>/v<n>/index.html"` and base the edit on that.
   - **Unreachable** → use the local copy, and say so in your reply: the edit
     is based on a possibly-stale cache.

   Then re-read `$SKILL_DIR/authoring/voice.md`, `$SKILL_DIR/authoring/visuals.md` and `$SKILL_DIR/authoring/structure/components.md`.
   Review the new version using the same content and responsive-style checks
   as `/tdoc new`, including image review for changed SVG charts.
   A regeneration writes new prose, so the contract applies here exactly as
   it does on `/tdoc new`. Prose you carry over unchanged from the previous
   version stays as it is — do not re-edit untouched sections for voice, and
   keep whichever style the existing version already uses rather than
   restyling a doc the reader has been reading.
3. For EACH open comment, decide one of three outcomes BEFORE writing:
   - **applied** — the comment is clear and you can act on it.
   - **partial** — you applied part of it but couldn't fully address it
     (e.g. the user asked to "add a chart and explain compound interest";
     you added the chart but the explanation is shallow).
   - **question** — you can't act without clarification (the comment is
     ambiguous, contradicts another comment, or refers to content that
     doesn't exist in the current doc).
4. Regenerate the full HTML to a temp file, incorporating every `applied` and
   `partial` comment. A comment's anchor has:
   - `anchor.text` — the exact text the user highlighted (may span across
     paragraphs and inline elements)
   - `anchor.context_before` / `anchor.context_after` — surrounding text
     (~60 chars each side) for disambiguation when the same text appears
     multiple times
5. **Hand it to `bin/tdoc-write --version next`. Do not write `v<n+1>/` yourself.**

   ```bash
   bash "$SKILL_DIR/bin/tdoc-write" \
     --slug <slug> --title "<existing title>" --style <the doc's style> \
     --prompt "<what this revision changes, one line>" \
     --html-file /tmp/<slug>-next.html --version next
   ```

   Same gateway as `/tdoc new`, so a new version gets the same treatment a
   first version does: validated, baked, `meta.json` appended, and
   `comments.json` left alone — the thread you are answering survives.
   Earlier versions are untouched.

   This is not a convenience. Writing `v<n+1>/index.html` by hand skipped the
   bake, so a document that predates creation-time baking could be edited any
   number of times and still ship without a reading template — it had no path
   to recover on its own. The gateway is that path.
6. **For each comment, post an agent reply** so the user sees the outcome
   in the doc UI. This is mandatory.

   Use `bin/tdoc-agent-reply`. It auto-detects the host runtime (Claude Code,
   Codex, Grok, Cursor, Gemini) from the process environment and stamps
   `agent_login` so the comment shows that product's logo. Do **not** invent
   a login or pass `tdoc-agent`. Only pass `--login` if you must override
   detection. The published Worker cannot see your env, so do not raw-curl
   `/api/agent/reply` yourself — the helper stamps identity before the
   request leaves the machine.

   ```bash
   bash "$SKILL_DIR/bin/tdoc-agent-reply" \
     --slug "<slug>" \
     --parent "<comment_id>" \
     --text "<one or two sentences>" \
     --status applied \
     --applied-in <n+1>
   ```

   It posts to the published Worker when `~/.tdoc/published.json` exists,
   otherwise to `http://localhost:${TDOC_PORT:-7878}`. Users can also reply
   to any reply (HN/Reddit-style nesting); `parent` is the comment or reply
   you are answering.

   **A skip is a normal outcome, not an error.** The published Worker answers
   a comment once per human turn: if your answer is already the last word on
   that thread it prints `not posted: this comment already has your answer`
   and exits 0. That is the server protecting the reader from hearing the same
   thing twice — most often because they deleted your last answer, which
   removes it from the comments.json you just read but not from the log the
   server keeps. Do not retry it, and do not reach for `--force`: pass that
   only when a person has asked you to say it again.

   The reply text should be specific:
   - applied: "Rewrote the second paragraph in English. The section heading
     is now 'What an Agent Needs'."
   - partial: "Added the chart but the compound-interest explainer is still
     basic — want me to flesh it out?"
   - question: "Two of your comments asked for different tones — formal in
     the intro and casual in section II. Which should I prioritize?"

7. Update `comments.json`: set `status: "applied"` (or leave `"open"` for
   partial/question) and `applied_in: n+1`. The agent-reply endpoint
   already flips the status server-side AND drops a status emoji on the
   parent comment (✅ applied, 🟡 partial, ❓ question), clearing any
   previous agent emoji first. You don't need to send a separate reaction
   request — the reply endpoint does it. Users see the verdict at a
   glance from the comment cards without expanding replies.

   If a comment is later re-anchored by the user (anchor moved to new
   text), the server automatically clears the agent's emoji and resets
   `status: "open"`. Re-running `/tdoc edit` will pick it up again.
8. **Publish the new version and hand back its link**, the same way `/tdoc new`
   does. A doc that was published stays published; report
   `https://tdoc.dev/d/<slug>/v/<n+1>` so the reviewer can see the version
   their comment produced. The link a user already shared keeps working — a new
   version never breaks it.

   ```bash
   bash "$SKILL_DIR/bin/tdoc-publish" <slug>
   ```

   Only report a `localhost` URL if this doc is local-only because the user
   asked for that (see the localhost rule in `/tdoc new`).

If there are zero open comments AND no extra prompt, ask the user what to change before doing anything.

### `/tdoc fork <slug> [<new-slug>]` — copy a doc

```bash
cp -R "$TDOC_DIR/<slug>" "$TDOC_DIR/<new-slug>"
```
Reset `comments.json` to `[]`. Update `meta.json` title to include `(fork)`.

### `/tdoc list` — show all docs

Read each `meta.json` and print: slug, title, latest version, # open comments.

### `/tdoc me` — remote catalog (owned docs + folders)

Same inventory the user sees on `/me` on the published host (not local
`~/tdocs`). Requires a connected account (`~/.tdoc/published.json`):

```bash
bash "$SKILL_DIR/bin/tdoc-me"
# optional: open a folder share link as this account
bash "$SKILL_DIR/bin/tdoc-me" --shared <share_id>
```

See **Agent catalog** under Access policy for the ACL rules.

### `/tdoc serve` — (re)start the server

```bash
pkill -f "$SKILL_DIR/server/server.js" 2>/dev/null
nohup node "$SKILL_DIR/server/server.js" > "$TDOC_DIR/.server.log" 2>&1 &
echo "tdoc server: http://localhost:7878"
```

### `/tdoc stop` — stop the server

```bash
pkill -f "$SKILL_DIR/server/server.js"
```

### `/tdoc publish <slug>` — publish to hosted tdoc (default), or self-host

Publishes the latest version of `<slug>` to a public URL.

Architecture — publish auth, multi-tenant scoping, account/BYOK
switching, and the client-version gap — is written up as a tdoc:
`docs/publish-auth-architecture.html` (live: `tdoc.dev/d/tdoc-auth-arch`). Read
it before changing `bin/tdoc-publish`, `bin/tdoc-update-nag`, or the worker
auth/hosted-token routes.

Default target is **hosted** (`https://tdoc.dev`). First run signs in with
the tdoc pairing flow: the CLI shows a short code, the human approves it at
`tdoc.dev/activate` in their own browser (signed in with whatever that page
offers), and the poll returns an account-scoped upload token stored in
`~/.tdoc/published.json`. Workers that predate pairing fall back to the
GitHub Device Flow automatically. That token can
only mutate docs it owns. The sign-in is **resumable**: if the process dies
while waiting (agent harness timeout, killed sandbox), just run the same
command again — it picks up the pending device code and keeps polling, so an
approval the human already granted still lands. Never mint a fresh sign-in by
hand after an interruption; the re-run does the right thing.
`/me` on tdoc.dev lists that account's docs. If
hosted signup is not open on the target, the CLI fails with a clear prompt to
self-host instead — do **not** tell the user to flip a Worker env flag.

**Self-host — Cloudflare**: `tdoc-publish --platform cloudflare <slug>`.
First run (or an explicit switch onto cloudflare) prompts `wrangler login`,
creates an R2 bucket (`tdoc-docs`) and KV namespace (`META`) in *your*
Cloudflare account, generates an upload token, and deploys your own Worker.
The choice is persisted in `~/.tdoc/published.json` as the default.

**Self-host — Vercel**: `tdoc-publish --platform vercel <slug>`. First run
(or an explicit switch onto vercel) needs the `vercel` CLI (`npm i -g vercel`),
links a Vercel project named `tdoc`, then asks you (via an agent prompt) to
connect a **Blob** store and an **Upstash Redis** store in the Vercel
dashboard's Storage tab — both free tier, ~2 clicks each — and deploys.
Caveats: no per-doc write serialization (Cloudflare uses a Durable Object for
that) and a ~4.5 MB upload cap per doc (Vercel request limit).

Subsequent runs upload the latest version of `<slug>` using the saved default.
Pass a different `--platform` any time to switch: full re-setup rewrites
`published.json` (previous file kept as `published.json.bak.switch`). A custom
domain and `*.workers.dev` on the same Worker are two hostnames, not two
platforms. Self-host targets
compare a content hash of the bundled Worker (shell + probe + reader CSS) against the last deployed
hash in `~/.tdoc/published.json` and redeploy automatically when runtime code
changed. Set `TDOC_SKIP_WORKER_DEPLOY=1` to skip the redeploy (useful for batch
uploads). Published pages expose runtime provenance at `/api/runtime` and in
`window.__TDOC__.runtime`.

**Existing GitHub users migrate by doing nothing.** Their saved upload token
keeps working (nothing in the CLI re-authenticates until the token is lost),
and in the browser they pick GitHub inside the sign-in page — the worker
recognises the connected GitHub identity and lands them on their existing
account, docs intact — and the session keeps their verified handle, so old
comments stay editable and handle-shaped invites keep matching. (The bridge
needs CLERK_SECRET_KEY on the worker; without it a legacy user should pick
GitHub via the legacy device flow instead.) There is nothing for the local
skill to detect or convert; the pending-signin/pairing machinery is the same
file either way.

Local preview (`tdoc serve`) does not need any sign-in. Published docs —
hosted (`tdoc.dev`) and BYOK remote (your Cloudflare/Vercel worker) — gate
commenting behind a sign-in. On hosted that is the provider seat (email,
Google, or GitHub, all in one page). On a BYOK worker with no OIDC config the
LEGACY fallback is GitHub Device Flow via the org-owned OAuth App in
`shared/github-oauth.js` (scope `read:user`); viewers authorize that shared
app, they do not register their own, and the App's callback URL is
`https://<host>/auth/github/callback` (a device approve may still bounce to
`/auth/done`, a friendly static page). `shared/github-oauth.js` stays the
source of truth for that fallback only.

Hosted needs no extra CLI beyond Node 18+ and curl. Self-hosting needs `jq`. Cloudflare needs `wrangler`
(`npm i -g wrangler`); Vercel needs `vercel` (`npm i -g vercel`).

```bash
bash "$SKILL_DIR/bin/tdoc-publish" <slug>
```

Prints the published URL: `https://tdoc.dev/d/<slug>/v/<N>` (hosted),
`https://<worker>.<subdomain>.workers.dev/d/<slug>/v/<N>` (Cloudflare), or
`https://tdoc-<scope>.vercel.app/d/<slug>/v/<N>` (Vercel).

### `/tdoc pull <slug>` — pull comments from the published doc

Overwrites local `~/tdocs/<slug>/comments.json` with comments collected on the
published Worker. Run before `/tdoc edit` to regenerate using community feedback.

```bash
bash "$SKILL_DIR/bin/tdoc-pull" <slug>
```

### `/tdoc unpublish <slug>` — remove from your Worker

Deletes all versions, meta, and comments for `<slug>` from R2/KV. Local files
are untouched.

```bash
bash "$SKILL_DIR/bin/tdoc-unpublish" <slug>
```

### `/tdoc onboard` — guided first-time setup

You are walking a user through tdoc onboarding. The user might have nothing
installed, or might be partway through. You **must** drive the flow from
`bin/tdoc-doctor --json` output, not assume state.

**Algorithm:**

1. Run `bash "$SKILL_DIR/bin/tdoc-doctor" --json` and parse the JSON. This is non-destructive.
   The doctor is target-aware and reports what it assessed under `.target`.
   The default is `hosted` (tdoc.dev), which needs only Node 18+ and curl —
   **no Cloudflare account, no wrangler, nothing to click in a dashboard.**
   Only pass `--platform cloudflare` / `--platform vercel` when the user has
   asked to self-host.
2. If `.ready_to_publish == true` AND `.published.ok == true` → tell the user
   they are fully set up, and offer to run `/tdoc new <prompt>` or to test
   publishing with a sample doc.
3. If `.ready_to_publish == true` AND `.published.ok == false` → they have all
   deps but haven't published yet. Offer to create a quick sample doc with
   `/tdoc new` and then `/tdoc publish` it.
4. Otherwise, walk through `.missing_steps` in order. On the hosted default
   this list is usually empty. For each step:
   - **kind == "install"**: run the `cmd` for them via Bash (e.g. `brew install jq`).
     After install, re-run `tdoc-doctor --json` to confirm.
   - **kind == "login"**: explain that this opens a browser, then run the `cmd`.
     `wrangler login` is interactive — print clear instructions and wait.
   - **kind == "click"**: you cannot click for the user. Print the URL clearly
     and tell them what to do ("Open this and click 'Enable R2'"). Then wait
     for the user to say "done", then re-run `tdoc-doctor --json` to verify.
     `login` and `click` steps are **self-host only**. If one appears for a
     user who never asked to self-host, re-read `.target` before sending them
     to a dashboard.
5. After every step, re-run `tdoc-doctor --json` and continue from the new state.
6. When `.ready_to_publish == true`, congratulate and offer to create + publish
   a sample doc.

**Important behavioral rules:**

- NEVER skip the doctor check before suggesting a step. State changes between
  steps (e.g. R2 takes a few seconds after enabling).
- NEVER walk a hosted user through Cloudflare setup. Publishing to tdoc.dev
  does not use wrangler, a workers.dev subdomain, or R2.
- ALWAYS show the user what you're running. Print the JSON status if helpful.
- If a "click" step doesn't take effect after the user says "done", offer to
  re-check after waiting 10s (Cloudflare API can be slow to reflect changes).
- Published/BYOK remotes bake in the shared org OAuth client ID from
  `shared/github-oauth.js` — users do NOT register their own. Local preview
  never needs that login path.

### `/tdoc update` — check for updates and pull the latest

Wraps `bin/tdoc-update`. Runs `git fetch + git merge --ff-only` against
`origin/main` of `tornado-doc/tdoc`.

- `tdoc-update --check` → report-only, prints incoming commits without changing anything
- `tdoc-update` → apply, with auto-stash of local edits, **auto-restarts the running local server** so new routes / shell code take effect
- `tdoc-update --yes` → also redeploy the Worker so readers get the new shell

BYOK CLIs (`tdoc-publish` / `pull` / `unpublish` / `new`) and every skill
run also check origin/main and nag immediately when this checkout is
behind. `tdoc-doctor` reports the same as `.update` (not a missing_step).

```bash
bash "$SKILL_DIR/bin/tdoc-update" --check    # see what's new
bash "$SKILL_DIR/bin/tdoc-update"            # apply
bash "$SKILL_DIR/bin/tdoc-update" --yes      # apply + redeploy worker
```

If the user has not yet `git clone`'d (the skill dir is not a git checkout),
the script prints a clean instruction to re-clone.

### `/tdoc doctor` — health check, no changes

Prints a concise human health summary. Use this when the user reports a
problem; pass `--json` when an agent needs the full machine report.

```bash
bash "$SKILL_DIR/bin/tdoc-doctor"
bash "$SKILL_DIR/bin/tdoc-doctor" --json
```

