# Security Policy

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue.**

Use GitHub's [private vulnerability reporting](https://github.com/tornado-doc/tdoc/security/advisories/new)
(Security → Advisories → "Report a vulnerability"). That keeps the report
confidential until a fix is available.

You'll get an acknowledgement as soon as the maintainer sees it. tdoc is a
solo-maintained, agent-authored project, so please allow a little time — but a
real vulnerability will always take priority.

## What's in scope

tdoc has three components worth thinking about as an attacker would:

1. **The browser overlay** (`server/overlay.js`) is bundled into the worker at
   publish time and runs in **every reader's browser** on every published doc.
   It renders untrusted input (comment text, author names, avatars). A way to
   get script execution into a reader's page (stored XSS, an injection sink,
   an escaping bypass) is the highest-severity class here.
2. **The Cloudflare Worker** (`worker/worker.js`) accepts untrusted request
   bodies (comments, reactions, uploads) and gates writes behind an upload
   token + GitHub sign-in. Auth bypass, injection, or a way to corrupt/forge
   another author's comments are in scope.
3. **The CLIs** (`bin/tdoc-*`) read your Cloudflare OAuth token from disk and
   call the Cloudflare API with it. They run on your machine. A way to make a
   CLI leak the token, run unexpected commands, or write outside its expected
   paths is in scope.

## Trust model (so you know what tdoc does and doesn't do with your data)

- **Your Cloudflare token never leaves your machine except to Cloudflare.** The
  CLIs read it locally and send it only to `api.cloudflare.com`. The tdoc
  maintainer runs no central server and never sees your token or your docs.
- **You publish to your own Cloudflare Worker.** Your published docs live in
  your account, not a shared host.
- **Published docs require a one-time GitHub sign-in to comment** (Device Flow,
  scope `read:user`). Local docs comment anonymously with no auth.
- **Untrusted text is HTML-escaped on render** — comment bodies, author names,
  and avatar URLs — so a comment can't inject script into the page. (If you
  find a case where it can, that's exactly the kind of report this policy is
  for.)
- **No client-side usage telemetry runs from the skill.** Hosted operational
  events are emitted by the provider and exclude document/user identifiers;
  see the Observability section of the README.

## Out of scope

- Vulnerabilities in Cloudflare, GitHub, Node, or other upstream dependencies —
  report those to the respective project.
- Social-engineering, physical access, or anything requiring a
  already-compromised machine.

## Supported versions

tdoc ships from `main`; the latest tagged release is the supported version.
Fixes land on `main` and go out in the next release.
