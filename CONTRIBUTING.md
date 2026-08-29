# Contributing

## Repo layout

`tdoc` is dual-shaped to support both install styles:

```
~/.claude/skills/tdoc/
├── SKILL.md                    ← canonical skill manifest (for `git clone` install)
├── .claude-plugin/
│   ├── plugin.json             ← plugin manifest (for `/plugin install` install)
│   └── marketplace.json        ← single-plugin marketplace (so `/plugin marketplace add tornado-doc/tdoc` works)
└── skills/tdoc/
    └── SKILL.md                ← MUST match root SKILL.md exactly (plugin-mode discovery)
```

**Important**: when you edit `SKILL.md` at the root, also copy it to `skills/tdoc/SKILL.md` (or vice versa). They must stay in sync. Run:

```bash
cp SKILL.md skills/tdoc/SKILL.md
```

before committing any change that touches `SKILL.md`. There is no automated hook for this yet — keep them in sync manually.

## Two install paths

We support two install paths and don't want either to break:

1. **Plain git clone** — `git clone https://github.com/tornado-doc/tdoc ~/.claude/skills/tdoc`. Claude Code finds `SKILL.md` at the root of `~/.claude/skills/tdoc/`. Simple, no plugin system needed.
2. **Claude Code plugin marketplace** — `/plugin marketplace add tornado-doc/tdoc` + `/plugin install tdoc@tornado-tdoc`. Claude Code reads `.claude-plugin/plugin.json` and discovers skills inside `skills/<name>/SKILL.md`.

Don't break either.

## Credit

When you add to the docs or write release notes, keep the credit prominent. `tdoc` is a community implementation, not an original idea.

## Tests

A single runner drives everything. Offline suites run by default; browser/network suites are gated.

```bash
npm test            # all offline suites — no network, no browser. Covers:
                    #   worker comment fold + cross-version history, anchor reconcile,
                    #   event-log convergence, security (injection/authz/CSRF/path-traversal),
                    #   P3 hardening (XSS escaping, corrupt-value resilience),
                    #   CLI resilience, comment ops, aid-stamp parsing, local API (hermetic)
npm run test:all    # also runs the gated suites:
                    #   ui.test.js / responsive.test.js  — real browser via Playwright
                    #       (default: local committed fixture; TDOC_TEST_URL=<url> for a live doc;
                    #        skip LOUDLY if Playwright isn't installed)
                    #   publish.test.js / onboarding.test.js — publish + doctor flows
                    #   TDOC_INTEGRATION=1 → real Cloudflare round-trip
```

Install the optional browser dep with `npm i -D playwright && npx playwright install chromium`.

`npm test` must be green before any commit to `main`.

## The provider UI is a React app — build it, then commit the build

The top bar, comment layer, dialogs, sign-in, and the `/me` Docs Hub live in
`shell/src` (React + Vite, headless primitives from `@base-ui/react` wrapped in
`shell/src/ui/`). Author HTML never sees React: it renders only inside the
sandboxed `/frame` iframe, where `server/frame-probe.js` is the sole script.

```bash
npm install              # once — React, Vite, and the Base UI primitives
npm run dev:shell        # Vite dev server for shell/src
npm run build:shell      # writes server/runtime/{manifest.json, shell.<hash>.js, shell.<hash>.css}
```

Chrome changes are checked **against the version they replace**, not by eye
alone. `test/visual/` holds two Playwright harnesses that run the old and new
implementation side by side on the same fixture doc and write composite
screenshots per scene (bar, menus, dialogs, comment card, dark mode, phone
drawer, owner Share panel, /me):

```bash
git worktree add /tmp/tdoc-main origin/main
node test/visual/local-compare.js  /tmp/cmp /tmp/tdoc-main .        # Local Studio
SKILL_DIR=/tmp/tdoc-main OUT_DIR=/tmp/wb-old node bin/tdoc-bundle   # hosted: bundle both
SKILL_DIR=$PWD          OUT_DIR=/tmp/wb-new node bin/tdoc-bundle
node test/visual/hosted-compare.mjs /tmp/cmp-hosted /tmp/wb-old/_worker.bundled.js /tmp/wb-new/_worker.bundled.js
```

The rule for a migration or restyle: match the old chrome where it can be
matched; where it cannot, the new one still has to look finished.

Both harnesses serve the real homepage — the newest `landing/tornado-doc/vN`
out of the checkout — so site chrome can be judged where it ships rather than
against the neutral fallback. PR previews seed it too, so the preview's `/` is
this branch's code carrying this branch's landing.

`server/runtime/` is **committed on purpose**: skill users run
`server/server.js` straight from the checkout and `bin/tdoc-bundle` embeds the
same bytes into the Worker — neither runs `npm install`. The Vite output is
content-hashed and deterministic, so after any edit under `shell/src` run
`npm run build:shell` and commit the result together with the source. CI's
`shell runtime` job rebuilds and fails on a byte diff. See `IMPLEMENTATION.md`
for the runtime boundary and component layers.

## Hard rule: run tests before every push

The skill ships JS that runs in users' browsers and a worker that runs on Cloudflare, both deployed on every `/tdoc publish`. Run `npm test` before pushing; for shell (`shell/src`, `server/frame-probe.js`) or worker changes also run the matching gated suite via `npm run test:all`. Doc-only changes still need a `grep` for stale references (counts, command names, version numbers).

## AGENTS.md

`AGENTS.md` only records what humans and agents have aligned on, and is intentionally kept short.

