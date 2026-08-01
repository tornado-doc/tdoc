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

## Hard rule: run tests before every push

The skill ships JS that runs in users' browsers and a worker that runs on Cloudflare, both deployed on every `/tdoc publish`. Run `npm test` before pushing; for overlay or worker changes also run the matching gated suite via `npm run test:all`. Doc-only changes still need a `grep` for stale references (counts, command names, version numbers).
