# tdoc plugins for the remote MCP server

## Install tdoc in your AI app

MCP server URL: **`https://tdoc.dev/mcp`** (Streamable HTTP, OAuth sign-in on
first use; no API key to paste).

| App | One line |
| --- | --- |
| Claude Code | `claude plugin install tdoc-cloud --marketplace tornado-doc/tdoc` (in a session: `/plugin install tdoc-cloud --marketplace tornado-doc/tdoc`) |
| Claude Code, MCP only | `claude mcp add --transport http tdoc https://tdoc.dev/mcp` |
| claude.ai / Claude Desktop | **Customize > Connectors > Add custom connector**, URL `https://tdoc.dev/mcp` |
| Codex CLI | `codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc` |
| Codex CLI, MCP only | `codex mcp add tdoc --url https://tdoc.dev/mcp` |
| ChatGPT | **Plugins > + > Add custom MCP server**, URL `https://tdoc.dev/mcp` |
| Cursor | [`cursor://anysphere.cursor-deeplink/mcp/install?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9`](https://cursor.com/install-mcp?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9) |
| VS Code (Copilot) | `code --add-mcp '{"name":"tdoc","type":"http","url":"https://tdoc.dev/mcp"}'` |
| Gemini CLI | `git clone --depth 1 https://github.com/tornado-doc/tdoc && gemini extensions install ./tdoc/plugins/gemini` |

The older two-step Claude Code form also works:
`claude plugin marketplace add tornado-doc/tdoc`, then
`claude plugin install tdoc-cloud@tornado-tdoc`. The same marketplace also
lists `tdoc@tornado-tdoc`, the local CLI plugin (needs Bash and the `tdoc`
CLI). Install one of the two, not both: both carry a skill named `tdoc`.

Gemini CLI installs from the latest GitHub release, which must carry
`tdoc-gemini.tar.gz` (built by `sh plugins/pack.sh`) as its only asset.

`sh plugins/pack.sh` builds the upload files into `dist/plugins/`.

---

## About these packages

Each folder here installs the tdoc remote MCP server, `https://tdoc.dev/mcp`
(Streamable HTTP, OAuth 2.1 with dynamic client registration and PKCE). Hosts
that cannot do OAuth can send an existing tdoc account token as
`Authorization: Bearer tdoc_...`. No package here stores a token.

The skill file `skills/tdoc/SKILL.md` is the same in `claude/`, `codex/`,
`cursor/` and `gemini/`. Its `description` is copied verbatim from the repo's
`SKILL.md`. Edit one copy, then copy it to the others.

Version in every manifest: `0.9.0`, the content of `VERSION`.

Logos: Claude, Codex and Cursor require the logo path to be inside the plugin
folder (no `..`), so each plugin carries a copy of `assets/icon-512-v3.png` as
`assets/logo.png`. The Gemini and VS Code configs have no logo field.

Privacy policy: `https://tdoc.dev/privacy`, set as `privacyPolicyUrl` (Claude)
and `interface.privacyPolicyURL` (Codex). The Cursor, Gemini and VS Code
manifests document no privacy field.

Docs were read on 2026-10-28. "Verified" means the field or step appears in
the cited official page. "UNVERIFIED" means it does not, or the pages disagree.

---

## Claude (Claude Code, claude.ai, Claude Desktop, Cowork)

Files:

- `claude/.claude-plugin/plugin.json`
- `claude/.mcp.json`: `{"mcpServers": {"tdoc": {"type": "http", "url": "https://tdoc.dev/mcp"}}}`
- `claude/skills/tdoc/SKILL.md`
- `claude/assets/logo.png`

Install:

- claude.ai or the desktop app: zip the `claude/` folder, then go to
  **Customize > Plugins**, **Add > Upload plugin**. The plugin is saved to the
  account, so it also appears in Cowork and in Claude Code (run
  `/reload-plugins`). Then open the plugin's **Connectors** tab and connect
  `tdoc`.
- Claude Code, local test: `claude --plugin-dir plugins/claude`.
- Marketplace: the repo's `.claude-plugin/marketplace.json` (marketplace
  `tornado-tdoc`) lists this folder as `tdoc-cloud` and the repo root, the
  local CLI plugin, as `tdoc`. An entry's name must equal the `name` in the
  plugin's `plugin.json`, so this plugin's manifest name is `tdoc-cloud` and
  its skill shows as `/tdoc-cloud:tdoc`. Relative sources must start with
  `./`; the old `"github:tornado-doc/tdoc"` source of the `tdoc` entry failed
  `claude plugin validate` and made `claude plugin install tdoc@tornado-tdoc`
  fail with `Invalid string: must start with "./"`, so it is now `"./"`.
  Tested with Claude Code 2.1.310 in a throwaway `CLAUDE_CONFIG_DIR`:
  `claude plugin validate .` passes, both plugins install, and
  `claude plugin details tdoc-cloud` lists the `tdoc` skill and the `tdoc` MCP
  server. Sources: https://code.claude.com/docs/en/plugins/marketplace-reference.md
  ("Relative path ... Must start with `./`"; "`marketplace add` input:
  `owner/repo`"), https://code.claude.com/docs/en/plugin-marketplaces ("Keep
  the entry name and the manifest name the same"),
  https://code.claude.com/docs/en/plugins/publish.md (`--marketplace` one-step
  install, Claude Code 2.1.292+). A GitHub marketplace is cloned, so relative
  paths resolve against the repo.

`claude plugin validate plugins/claude` passes. `privacyPolicyUrl` is
`https://tdoc.dev/privacy`.

Verified:

- Manifest at `.claude-plugin/plugin.json`; `name`, `displayName`, `version`,
  `description`, `author` (object), `homepage`, `repository` (string),
  `license`, `keywords`, `icon` (path inside the plugin).
  https://code.claude.com/docs/en/plugins-reference
- `.mcp.json` at the plugin root is loaded by default. A `url` entry needs
  `"type": "http"`: an entry with a `url` and no `type` is read as stdio and
  skipped. https://code.claude.com/docs/en/mcp
- Skills at `skills/<name>/SKILL.md`. https://code.claude.com/docs/en/plugins-reference
- Plugins work in chat, Cowork and Claude Code; MCP connectors work in all
  three; upload as `.zip`. https://claude.com/docs/plugins/overview
- Claude's OAuth redirect URIs: `https://claude.ai/api/mcp/auth_callback`
  (web, desktop, mobile, Cowork) and a loopback `http://localhost:<port>/callback`
  or `http://127.0.0.1:<port>/callback` on any port (Claude Code); tdoc
  accepts http loopback as `127.0.0.1`, `[::1]` or `localhost`. Claude
  prefers CIMD only when the authorization server metadata advertises
  `client_id_metadata_document_supported: true` and `none` in
  `token_endpoint_auth_methods_supported`. Otherwise it uses DCR.
  https://claude.com/docs/connectors/building/authentication

### Claude custom connector (no plugin)

Free, Pro and Max (Free: one custom connector):

1. Go to **Customize > Connectors** (https://claude.ai/customize/connectors).
2. Click **Add custom connector**.
3. Enter the MCP server URL `https://tdoc.dev/mcp`.
4. Optionally enter OAuth credentials. Leave them blank for tdoc.
5. Click **Add**.

Team and Enterprise: an Owner goes to **Organization settings > Connectors**,
selects **Add**, then **Custom** (type **Web** if asked), enters the URL, and
clicks **Add**. Members then open **Customize > Connectors**, find the
connector with the **Custom** label, and click **Connect**.

If the dialog asks for **OAuth client**: **Use Claude's published identity**
needs CIMD on our server; **Register automatically** uses DCR. tdoc supports
DCR, so pick **Register automatically** unless CIMD is advertised.

Source: https://claude.com/docs/connectors/custom/remote-mcp (Verified).

Prefilled link:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=tdoc&connectorUrl=https%3A%2F%2Ftdoc.dev%2Fmcp
```

UNVERIFIED: this link format is not on the remote-mcp page above. A web
search summary attributes it to Claude's connector docs
(https://claude.com/docs/connectors/building/directory-vs-custom), but I
could not open that page to confirm it. Test the link while signed in before
publishing it.

---

## OpenAI Codex and ChatGPT

Files (portable Agent Plugins layout):

- `codex/plugin.json`: root manifest with `$schema`, OpenAI settings under
  `extensions["com.openai"].interface`
- `codex/mcp.json`: `{"mcpServers": {"tdoc": {"type": "streamable-http", "url": "https://tdoc.dev/mcp"}}}`
- `codex/skills/tdoc/SKILL.md`
- `codex/assets/logo.png`

There is no `.codex-plugin/plugin.json`. OpenAI's packaging guide prefers a
root `plugin.json` and uses `.codex-plugin/plugin.json` only as a fallback
when root `extensions.com.openai` is absent.

Install:

- Repo marketplace: `.agents/plugins/marketplace.json` at the repo root
  (marketplace `tornado-tdoc`, one entry `tdoc` with source
  `./plugins/codex`, `policy.installation: AVAILABLE`,
  `policy.authentication: ON_INSTALL`, `category: Productivity`). Codex also
  reads `.claude-plugin/marketplace.json` as a legacy marketplace; with both
  present it used `.agents/plugins/marketplace.json` (codex-cli 0.160.1,
  throwaway `CODEX_HOME`: `codex plugin marketplace add ./`, then
  `codex plugin add tdoc@tornado-tdoc` installed 0.9.0 and `codex mcp list`
  showed `tdoc  https://tdoc.dev/mcp  Not logged in`).
- Codex CLI: `codex plugin marketplace add tornado-doc/tdoc`, then
  `codex plugin add tdoc@tornado-tdoc` or `/plugins` in a session. Start a new
  session to load it.
- ChatGPT: open the **Plugins** tab, find the plugin, select the plus button.
  For a personal marketplace (`~/.agents/plugins/marketplace.json`), restart
  the ChatGPT desktop app after changes.

Tested with codex-cli 0.160.1 in a throwaway `CODEX_HOME`: the marketplace
was added, the plugin installed as version 0.9.0, and `tdoc:tdoc` appeared in
the session's skill list with the full description. Sign-in through Codex was
not tested (it needs a browser). `https://tdoc.dev/mcp` answers an
unauthenticated `initialize` with 401 and serves RFC 9728 metadata at
`/.well-known/oauth-protected-resource`. Both JSON files pass the Agent
Plugins 1.0.0 JSON schemas.

Verified (https://developers.openai.com/plugins/build/plugins, reached from
https://developers.openai.com/codex/plugins, which now redirects to
https://learn.chatgpt.com/docs/plugins):

- Root `plugin.json` with
  `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`;
  `name`, `version`, `description`, `author` (`name`/`email`/`url`),
  `homepage`, `repository`, `license`, `keywords`, `extensions`.
  Schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- `mcp.json` at the root with `$schema` and `type: "streamable-http"`.
  Schema: https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
- Skills found in root `skills/`; assets under `./assets/`.
- `interface` keys used: `displayName`, `shortDescription`,
  `longDescription`, `developerName`, `category`, `capabilities`,
  `websiteURL`, `privacyPolicyURL` (`https://tdoc.dev/privacy`),
  `defaultPrompt` (array), `composerIcon`, `logo`.
- Marketplace locations, entry shape, `codex plugin marketplace add`.

UNVERIFIED or omitted:

- `interface.category` (`"Productivity"`) and `interface.capabilities`
  (`["Read", "Write"]`) copy the doc's example. The allowed values are not listed.
- OAuth block: OpenAI's guide says to declare auth under
  `mcpServers.<name>.extensions["com.openai"].auth` (for DCR:
  `{"type": "oauth", "client": {"mode": "dcr"}}`). The Agent Plugins MCP schema
  has `additionalProperties: false` on a streamable-http server and rejects
  that key. It is left out, so the file stays schema-valid. The Codex binary
  contains MCP OAuth metadata discovery, but whether ChatGPT discovers OAuth
  without the block is not confirmed. If sign-in does not start, add the block.
- `termsOfServiceURL`, `brandColor`, `screenshots`, `apps` (`.app.json`) are
  omitted: no tdoc terms page exists yet, and `.app.json` has no documented
  schema.
- `policy.authentication`: only `ON_INSTALL` appears in the docs.

### ChatGPT custom MCP server (no plugin)

Current steps (https://developers.openai.com/plugins/deploy/connect-chatgpt, Verified):

1. Go to ChatGPT **Plugins** (https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Enter a name (`tdoc`) and description.
4. Under **Connection**, enter `https://tdoc.dev/mcp`.
5. Configure authentication (OAuth), review the risk warning, and select
   **I understand and want to continue**.
6. Select **Create as a plugin**, review the discovered tools, install it.
7. In a new conversation, type `@` and select the plugin.

Developer mode: the current flow does not mention it. A search summary of
OpenAI's help center (https://help.openai.com/en/articles/12584461) says you
no longer need to turn on Developer Mode first. The older beta flow (a
workspace admin turns on Developer mode, then **Apps > Create**) is outdated.
I could not open the help article (HTTP 403), so this is UNVERIFIED.

Plans: UNVERIFIED. Search summaries of the help article name Business and
Enterprise/Edu: on Business only admins and owners publish plugins for custom
MCP servers, and on Enterprise/Edu admins can grant members permission
through RBAC. Plus and Pro could not be confirmed.

ChatGPT OAuth redirect URI: `https://chatgpt.com/connector/oauth/{callback_id}`,
shown on the app management page; the legacy
`https://chatgpt.com/connector_platform_oauth_redirect` is kept for apps
already published. From search results citing
https://developers.openai.com/apps-sdk/build/auth (UNVERIFIED: page not
opened). Both are https, so our redirect rule accepts them.

---

## Cursor

Files:

- `cursor/.cursor-plugin/plugin.json`
- `cursor/mcp.json`: `{"mcpServers": {"tdoc": {"url": "https://tdoc.dev/mcp"}}}`
- `cursor/skills/tdoc/SKILL.md`
- `cursor/assets/logo.png`

Install:

- Plugin, local test: copy `cursor/` to `~/.cursor/plugins/local/tdoc`, then
  restart Cursor or run **Developer: Reload Window**. Marketplace: push to a
  public repo and submit at https://cursor.com/marketplace/publish (manual
  review).
  The repo root's `.cursor-plugin/marketplace.json` lists this folder as
  `tdoc`, which is how Cursor finds a plugin in a subfolder of a multi-plugin
  repo (https://cursor.com/docs/reference/plugins). Not tested in Cursor. After listing: **Customize**, find the plugin, **Install**.
- MCP server only, deeplink:

  ```
  cursor://anysphere.cursor-deeplink/mcp/install?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9
  ```

  `config` is base64 of `{"url":"https://tdoc.dev/mcp"}`.
- Web link, for places that cannot link `cursor://`:

  ```
  https://cursor.com/install-mcp?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9
  ```

  `https://cursor.com/en/install-mcp?...` answers with a 308 redirect to this
  URL, which returns 200. UNVERIFIED: the current install-links page documents
  only the `cursor://` form.
- Or paste `cursor/mcp.json` into `.cursor/mcp.json` (project) or
  `~/.cursor/mcp.json` (global).

Verified:

- `.cursor-plugin/plugin.json`; only `name` is required; `description`,
  `version`, `author` (`name`, `email` only), `homepage`, `repository`,
  `license`, `keywords`, `logo` (relative path in the repo, or an absolute
  URL); `mcp.json` and `skills/<name>/SKILL.md` (frontmatter `name`,
  `description`) are found by default. No `..` in paths.
  https://cursor.com/docs/plugins, https://cursor.com/docs/reference/plugins
- Remote server shape `{"mcpServers": {"name": {"url": ...}}}`; the transport
  is inferred from `url`, with no `type`. https://cursor.com/docs/mcp
- Deeplink format and base64 of the JSON-stringified server config (the
  example encodes only the inner config; the name goes in `name=`).
  https://cursor.com/docs/mcp/install-links

Cursor OAuth redirect URIs (Verified, https://cursor.com/docs/mcp, "Static
redirect URL"):

- Desktop app: `http://localhost:8787/callback`
- Web and Cursor Agents: `https://www.cursor.com/agents/mcp/oauth/callback`

With DCR, the desktop app registers both and may send the web callback, which
hands sign-in back to the desktop app. tdoc accepts both: http loopback as
`127.0.0.1`, `[::1]` or `localhost` (any port), and the https callback. Cursor uses authorization code + PKCE, reads
RFC 9728 protected resource metadata, and registers as a public client.

---

## Gemini CLI

Files:

- `gemini/gemini-extension.json`: `name`, `version`, `description`,
  `mcpServers.tdoc.httpUrl`, `contextFileName: "GEMINI.md"`
- `gemini/GEMINI.md`: short context pointing at the tools
- `gemini/skills/tdoc/SKILL.md`

Install: `gemini extensions install` takes a GitHub repo URL or a local path,
with the manifest at the root. There is no documented subdirectory flag, so
install from a checkout, `gemini extensions install ./plugins/gemini`, or link
it for development with `gemini extensions link ./plugins/gemini`. Tested
with gemini-cli 0.66.0 in a throwaway `HOME`: the local install asks to trust
the folder, then `gemini extensions list` shows `tdoc (0.9.0)` with the `tdoc`
MCP server, `GEMINI.md` and the `tdoc` skill. Install by URL
(`https://github.com/tornado-doc/tdoc`) fails today: no `gemini-extension.json`
at the repo root.

Install by URL can work without moving files: gemini-cli first downloads the
repo's **Latest** GitHub release and, when that release has exactly one asset
whose name has no `darwin`/`linux`/`win32`, installs that archive (the
manifest at its root, or inside one folder). Read in the gemini-cli 0.66.0
bundle (`findReleaseAsset`, `downloadFromGitHubRelease`) and in
https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/releasing.md;
not tested end to end. So attaching `dist/plugins/tdoc-gemini.tar.gz` (from
`plugins/pack.sh`) as the only asset of each release makes
`gemini extensions install https://github.com/tornado-doc/tdoc` work.

Verified:

- Manifest fields `name`, `version`, `description`, `mcpServers`,
  `contextFileName`; agent skills in `skills/<name>/SKILL.md`; install
  command. https://geminicli.com/docs/extensions/reference/
- `httpUrl` is Streamable HTTP; `url` is SSE. OAuth is discovered on a 401,
  with dynamic client registration. The default redirect URI is
  `http://localhost:<random-port>/oauth/callback` (gemini-cli 0.66.0,
  `getRedirectUri`); tdoc accepts http loopback on `localhost` too, any port.
  `gemini mcp add` writes project settings by default and refuses in a folder
  Gemini does not trust yet; add `--scope user`.
  https://geminicli.com/docs/tools/mcp-server/

Note: the extension reference page carries a banner saying Gemini CLI was
replaced by Antigravity CLI for unpaid and Google One users on 2026-06-18.
Whether Antigravity CLI loads Gemini extensions was not checked.

---

## VS Code (GitHub Copilot agent mode)

File: `vscode/mcp.json`. Copy it to `.vscode/mcp.json` in a workspace, or
add the server to the user profile.

```json
{ "servers": { "tdoc": { "type": "http", "url": "https://tdoc.dev/mcp" } } }
```

Install link (the JSON with `name` inside, JSON-stringified, then URL-encoded):

```
vscode:mcp/install?%7B%22name%22%3A%22tdoc%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Ftdoc.dev%2Fmcp%22%7D
```

Insiders: replace `vscode:` with `vscode-insiders:`. Command line:

```
code --add-mcp '{"name":"tdoc","type":"http","url":"https://tdoc.dev/mcp"}'
```

Verified:

- `servers` / `type: "http"` / `url`; the portable alternative `.mcp.json`
  at the workspace root uses `mcpServers` with the same entry; `code --add-mcp`.
  https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- `vscode:mcp/install?{json-configuration}` built with
  `encodeURIComponent(JSON.stringify(obj))`, with `name` in the object.
  https://code.visualstudio.com/api/extension-guides/ai/mcp
- OAuth: VS Code tries DCR first, then falls back to client credentials.
  Redirect URIs to allow: `http://127.0.0.1:33418` and
  `https://vscode.dev/redirect`. Both are accepted by our rule.
  https://code.visualstudio.com/api/extension-guides/ai/mcp

UNVERIFIED: GitHub Markdown does not link `vscode:` URLs. Third-party READMEs
use an `https://insiders.vscode.dev/redirect/mcp/install?name=...&config=...`
wrapper, which Microsoft does not document. It is not used here. The
"use MCP servers" page
(https://code.visualstudio.com/docs/copilot/customization/mcp-servers) says the
guided flow labels workspace `.vscode/mcp.json` as deprecated. The
configuration reference does not say so. Both forms are listed above.
