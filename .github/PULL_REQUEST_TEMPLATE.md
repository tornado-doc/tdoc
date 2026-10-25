<!-- Thanks for contributing to tdoc! Please fill this in — it's short. -->

## What & why

<!-- One or two sentences. Link the issue this addresses: "Fixes #123". -->

## Checklist

- [ ] `npm test` passes locally (offline suite).
- [ ] If I touched anything browser-facing (`server/overlay.js`, `server/server.js`)
      or the worker (`worker/worker.js`), I ran `npm run test:browser` with Playwright
      installed (`npm ci && npx playwright install chromium`).
- [ ] If I edited `SKILL.md`, I copied it to `skills/tdoc/SKILL.md` so the two
      stay in sync (`cp SKILL.md skills/tdoc/SKILL.md`). They must match — the
      plugin-mode install reads the copy.
- [ ] If I changed the version, I bumped `VERSION` **and** `.claude-plugin/plugin.json`
      together (the manifest test enforces this).

## UI review (skip if no UI change)

- [ ] Reused existing components instead of new ones (name them): `ui/` primitives,
      CommentCard / reply, composer agent pill + menu, handoff status line, comment-area.
- [ ] No new colors, borders or type sizes outside the `--td-*` tokens and existing classes.
- [ ] Same icons on desktop and phone (phone may hide labels, never swap the icon).
- [ ] Clicked through every changed control at 1440 and at 390/430 (WebKit + Chromium),
      including drawers, keyboard-open and overlap with other floating UI; screenshots attached.
- [ ] New or uncertain feature is behind a flag in `shell/src/feature-flags.js`.

## Security note

<!-- Required if you touched overlay.js / worker.js / bin/*. These run in
     readers' browsers or handle Cloudflare tokens. Briefly: what untrusted
     input does your change touch, and how did you make sure it can't inject
     script / leak a token / bypass auth? Write "n/a" if your change doesn't
     touch those paths. -->
