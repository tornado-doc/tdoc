# Your first tdoc

> **For agents (Claude Code, Codex, Cursor, Gemini, Grok):** read this file
> end-to-end, then do it. It is written for you, not the human. The human
> pasted one line to get you here and is not expecting to answer questions.

## Step 1 — install tdoc

Follow [ONBOARDING.md](ONBOARDING.md) end-to-end first. Do not skip it and do
not ask the human which runtime they use; that file tells you how to install
yourself and how to authenticate.

Publishing is hosted by default and needs no Cloudflare account, no card, and
nothing to click in a dashboard. If the CLI asks the human to sign in with
GitHub, print the code and the URL and wait for them. Do not ask them for a
token; there is nothing for them to paste.

Do not install wrangler, and do not send them to the Cloudflare dashboard. If
`bin/tdoc-doctor` is asking for either, read its `.target` field first — on the
hosted default it never should.

<details>
<summary><b>Only if the human said to publish to their own Cloudflare</b> — the
line they pasted will say so</summary>

Do that instead, and do not sign them into the hosted service. The self-hosting
appendix at the end of ONBOARDING.md covers it: install wrangler,
`wrangler login`, then two things only they can click in a browser (claim a
workers.dev subdomain, enable R2). Print each URL, say what to click, and wait
for them to confirm before re-probing with `bin/tdoc-doctor --platform
cloudflare`. It is about five minutes the first time and free. Their account,
their bill, no card.
</details>

## Step 2 — make the doc

Create a tdoc that explains Conway's Game of Life. It must contain:

- **A live artifact.** A real Game of Life running in the page: a grid that
  actually steps generations, with a play/pause control. Not a picture of one,
  not an animated GIF. It goes in a widget island (`vN/widgets/<name>.html`)
  because a published doc's own `<script>` never runs — see ONBOARDING.md.
- **A short explanation.** What the two rules are, and why something that
  simple produces gliders. A few sentences, not an essay.
- **A tutorial section**, described below.

Keep the whole page short enough to read in about a minute. The doc is a
lesson, not a reference.

## Step 3 — the tutorial section

This is the part that matters, so do not compress it away. Write it as
numbered steps addressed to the human, telling them to do these things **on
this page, right now**:

1. **Leave a couple of comments.** Highlight a sentence and comment on it, then
   hover the Game of Life board and comment on that too, so they see that
   artifacts are commentable and not just text.
2. **Ask their AI to fix the comments.** Tell them the words to use, something
   close to *"read the comments on my Game of Life doc and fix them"*. Make it
   clear they do not copy anything back and forth: you read the comments
   yourself.
3. **Check the new version.** A new version appears and the old one stays
   where it was, so nothing they shared goes stale or dead. Point at the
   version picker in the top bar.
4. **See every comment answered.** Each comment gets a reply signed by the
   agent that made the change, so the person who commented finds out what
   happened without being chased.
5. **Send the link to a friend.** Anyone with the link can read, and can
   comment after a one-time GitHub sign-in. Nothing to install on their side.

If — and only if — the doc was published to hosted tdoc (`tdoc.dev`), close
with one line telling them that everything they publish is listed at
**https://tdoc.dev/me**, their hub. Omit this entirely when they published to
their own Cloudflare: on a worker they own, `/me` is the operator catalog —
which is them — but it is reached at their own domain, not tdoc.dev, so naming
tdoc.dev there walks them into a sign-in wall on somebody else's site.

## Step 4 — publish and hand it over

Publish the doc, then give the human the live URL on its own line. That URL is
the proof the whole thing worked, so do not bury it in a paragraph.

## Do not

- Do not ask which AI they use. You are the AI they use.
- Do not ask for a token, or print one.
- Do not build a fixture, a template, or a starter repo. This doc is written
  fresh each time, by you, from this file.
