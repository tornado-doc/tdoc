# tdoc

**Create a document with your agent. Share it for review. Turn comments into the next version.**

tdoc is an open-source document workspace for people and their agents. Your
agent creates an HTML document with text, tables and diagrams; reviewers leave
comments on the exact passage or visual they mean. The agent reads that feedback,
revises the document and replies to each comment.

Use it for a proposal, research report, technical design or visual explainer —
anything that needs a readable document and a round of feedback.

[Get started](#get-started) · [How it works](#how-it-works) · [Self-host](#hosting-targets) · [Contribute](CONTRIBUTING.md)

## How it works

1. **Create.** Describe the document to Claude Code or Codex. The tdoc skill
   gives your agent the authoring rules and tools to build a local preview.
2. **Share.** Publish to [tdoc.dev](https://tdoc.dev) and choose who can read,
   comment and see previous versions.
3. **Review.** Readers comment on text, images, diagrams and code blocks in
   their browser. They do not need to install the skill.
4. **Revise.** Ask your agent to pull the comments and make the next version.
   It replies with applied, partial or needs-clarification status, keeping
   feedback and changes together.

In Claude Code:

```text
/tdoc new "A proposal for our customer onboarding, with a workflow diagram"
/tdoc publish <slug>

# After your reviewers leave comments:
/tdoc edit <slug>
/tdoc publish <slug>
```

In Codex, ask for the same workflow in plain language using the installed
[tdoc skill](SKILL.md).

## What you get

- **Visual documents.** HTML pages with charts, diagrams, tables and code.
  Supported Excalidraw figures can also be
  edited in the reader.
- **Comments tied to content.** Text selections and visual artifacts have
  their own threads, replies and reactions. If a revision removes a comment's
  target, the thread remains available to re-anchor.
- **A review loop your agent can use.** Feedback is available as structured
  data. With a connected agent, the reader's **Send to agent** action can
  hand off comments and show delivery status; otherwise, use the skill to
  pull them into your session.
- **Version history.** Each revision is a full snapshot. Earlier versions and
  their comments remain available, subject to the document's history permissions.
- **Control over sharing.** Public, unlisted and private documents, with
  separate controls for commenting and version history.
- **Hosted or self-hosted publishing.** Start on tdoc.dev, or use your own
  Cloudflare or Vercel infrastructure.

## Get started

Paste this into Claude Code or Codex:

```text
Install tdoc by following https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md
```

The agent installs the skill and checks the setup. Hosted publishing uses
**tdoc.dev by default**: approve the CLI connection in your browser when asked.
You do not need a Cloudflare account or a cloud dashboard.

**No npm dependency installation, Playwright or Chromium is required for normal
onboarding, creation, editing or publishing.** The reader assets are prebuilt.
Static HTML checks still run; user workflows do not launch a browser to audit
layout.

### Claude Code plugin

Run both commands in Claude Code:

```text
/plugin marketplace add tornado-doc/tdoc
/plugin install tdoc@tornado-tdoc
```

Then use `/tdoc onboard` for setup and `/tdoc new <prompt>` to create a document.

### Using tdoc with Codex

You can also install the skill directly:

```bash
git clone https://github.com/tornado-doc/tdoc ~/.codex/skills/tdoc
```

If it is already installed, update that checkout instead of cloning over it.
Ask Codex to read `~/.codex/skills/tdoc/SKILL.md` and set up tdoc, then describe
what you want to create or revise. Claude Code's slash-command syntax is not
required; both hosts use the same document, comment and publishing tools.

### Requirements

The local tools use **Bash, Node.js 18+, Python 3 and curl**. Git is needed for
the clone/update installation path. Python runs the HTML/template validation
used during creation; hosted publishing uses Node and curl.

Self-hosting additionally needs `jq` and the tools for your chosen provider:
Wrangler for Cloudflare, or the Vercel CLI for Vercel. See
[onboarding](ONBOARDING.md) for setup details.

## Commands

These are skill commands in Claude Code; in Codex, request the equivalent action
in plain language. The underlying tools live in [`bin/`](bin/).

| Command | Purpose |
|---|---|
| `/tdoc new <prompt>` | Create a document and open a local preview |
| `/tdoc edit <slug>` | Revise from open comments and reply to them |
| `/tdoc publish <slug>` | Upload a version and return its link |
| `/tdoc pull <slug>` | Fetch comments from the published document |
| `/tdoc fork <slug>` | Copy a document to a new slug |
| `/tdoc list` | List documents |
| `/tdoc unpublish <slug>` | Delete the published document, including versions and comments |
| `/tdoc onboard` | Set up the skill and publishing |
| `/tdoc doctor` | Check dependencies and publishing configuration |
| `/tdoc update` | Update the installed skill |

## Sharing and storage

Public and unlisted documents can be read by link without signing in. Private
documents restrict access to the owner and permitted readers. Commenting and
history access follow the document's own permissions; hosted commenters can
sign in with email, Google or GitHub.

For a new document, the CLI's default access policy is **unlisted, with
owner-only history**. A workflow can explicitly choose another policy, and
publishing a new version preserves existing access settings unless you change
them. Unlisted means readable by anyone with the link, not private.

Published documents and comments live in remote storage. Local previews under
`~/tdocs` are working copies: deleting one does not delete the published
document. See [AGENTS.md](AGENTS.md) for the project's source-of-truth rule.

## Hosting targets

| Target | Setup | Storage and operation |
|---|---|---|
| **tdoc.dev** — default | Sign in and approve the CLI connection | Managed by tdoc |
| **Cloudflare** | `--platform cloudflare`; your account, Wrangler and R2 | Your Worker, R2 and KV; comment writes serialized by a Durable Object |
| **Vercel** | `--platform vercel`; your account and Vercel CLI | Your Vercel Function, Blob and Upstash Redis |

The chosen target is saved for later publishes. For self-hosting, pass the
platform to the publish command, for example
`/tdoc publish --platform cloudflare <slug>`.

Vercel has different limits: uploads are capped at roughly 4.5 MB per document,
and concurrent comment writes are not serialized as they are on Cloudflare.
See [Vercel setup and limitations](vercel/README.md).

## Cost

Hosted tdoc is free for normal personal use, with account document limits.
Your agent or model usage is separate. Self-hosting uses your own provider
accounts and their usage limits and charges.

## Current boundaries

Document revisions are primarily agent-driven. tdoc does not yet provide
Google-Docs-style simultaneous text editing, inline accept/reject suggestions
or a track-changes view. Version snapshots and multiplayer commenting are
available today; editable Excalidraw figures are a separate capability.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, browser regressions and the
required build workflow, and [IMPLEMENTATION.md](IMPLEMENTATION.md) for the
reader architecture.

```bash
npm test  # offline logic and CLI tests; no npm install or browser needed
```

Playwright and Chromium are used for **development tests only**. Their setup
instructions are in the [contribution guide](CONTRIBUTING.md#tests).

Authoring rules and styles live in [`authoring/`](authoring/README.md). Report
bugs or propose improvements through [GitHub issues](https://github.com/tornado-doc/tdoc/issues).
For vulnerability reports, follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Observability

The skill does not run client-side usage telemetry. Hosted infrastructure logs
operational events, including onboarding and publishing, without adding
analytics prompts to installation. See [observability details](docs/OBSERVABILITY.md)
for event fields, exclusions and self-hosted behavior.

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
