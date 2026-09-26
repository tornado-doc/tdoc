<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-square-dark.svg">
  <img src="assets/logo-square-light.svg" alt="tdoc" width="72">
</picture>

# tdoc

Agents draft. People comment. Agents revise.

[Website](https://tdoc.dev) · [Quick Start](#quick-start) · [Docs](docs/USAGE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md#reporting-a-vulnerability)

[![Tests](https://github.com/tornado-doc/tdoc/actions/workflows/test.yml/badge.svg)](https://github.com/tornado-doc/tdoc/actions/workflows/test.yml)

</div>

## About

tdoc is an open-source document workspace for people and their agents. Create
visual HTML documents with Claude Code or Codex, share them for review, and let
your agent turn the comments into the next version.

- **Create from a prompt** — proposals, reports and explainers with text, tables and diagrams.
- **Review in the document** — comment on a sentence, image or chart, with threads and replies.
- **Give feedback to your agent** — it reads comments, revises the document and reports what changed.
- **Keep each version** — share public, unlisted or private documents on tdoc.dev, or self-host.

## Quick Start

Use Claude Code or Codex on a computer with Bash, Node.js 18+, Python 3, curl
and Git. Reviewers only need a browser.

**1. Install tdoc**

Paste this into your agent:

```text
Install tdoc by following https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md
```

Normal use requires **no npm dependency installation, Playwright or Chromium**.
For the Claude Code plugin or a direct Codex install, see the [setup guide](docs/USAGE.md).

**2. Create a document**

Tell your agent what you want to make. In Claude Code:

```text
/tdoc new "A proposal for our customer onboarding, with a workflow diagram"
```

In Codex, ask it to use the tdoc skill to create the same document.

**3. Publish and share**

Ask your agent to publish it, or use `/tdoc publish <slug>` in Claude Code.
Approve the CLI connection in your browser when asked. Publishing uses
**tdoc.dev by default**, with no Cloudflare setup required.

Choose who can read and comment, then share the link with your reviewers.
See [sharing and storage](docs/USAGE.md#sharing-and-storage) for access defaults.

**4. Turn comments into the next version**

Ask your agent to revise from the feedback, or use `/tdoc edit <slug>` in
Claude Code. It reads the open comments, creates a new version and replies to
each comment. Publish the revision when it is ready.

## Self-hosting and development

Publish to your own Cloudflare or Vercel account using the
[hosting guide](docs/USAGE.md#hosting-targets). For local development and tests,
see [CONTRIBUTING.md](CONTRIBUTING.md).

Published documents live in remote storage; local previews are working copies.
The project rules are in [AGENTS.md](AGENTS.md).

## Contributing

Issues and pull requests are welcome. Start with the
[contribution guide](CONTRIBUTING.md), explore the [authoring rules](authoring/README.md),
or [open an issue](https://github.com/tornado-doc/tdoc/issues).
Report vulnerabilities through the [security policy](SECURITY.md#reporting-a-vulnerability).

## Observability

The skill does not run client-side usage telemetry. Hosted infrastructure logs
operational events; see [observability details](docs/OBSERVABILITY.md) for what
is collected and excluded.

## Credit

Originally inspired by [bdocs](https://x.com/jessepollak/status/2054313757543964857) by [Jesse Pollak](https://x.com/jessepollak). tdoc is an independent open-source project by [Tornado](https://github.com/tornado-doc) — created by [Serena Keyitan](https://github.com/serenakeyitan), maintained by [Serena Keyitan](https://github.com/serenakeyitan) and [Julie Shi](https://github.com/yayashuxue).

## License

AGPL v3, with a commercial licence available.

Use it, change it, run it, share it. The one thing the AGPL asks is that if
you modify tdoc and serve it to other people over a network, those people can
get your modified source.

If that does not fit — you want to embed tdoc in a closed-source product, or
run a modified version as a hosted service without publishing the changes —
see [COMMERCIAL.md](COMMERCIAL.md). Asking costs nothing, and often the answer
is that you did not need one.

tdoc was MIT through 2026-08-27 and Apache 2.0 until 2026-08-28; both notices
are kept in `LICENSE`. Vendored third-party code keeps its own terms.
