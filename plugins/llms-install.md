# Installing the tdoc MCP server (for AI agents such as Cline)

tdoc is a hosted, remote MCP server. There is nothing to clone, build or run.

- URL: `https://tdoc.dev/mcp`
- Transport: Streamable HTTP
- Auth: OAuth 2.1 (dynamic client registration, PKCE). The user signs in to
  tdoc in the browser the first time a tool runs. No API key.

## Cline

Add this to `cline_mcp_settings.json` (or use **MCP Servers > Remote Servers**
with the same name and URL):

```json
{
  "mcpServers": {
    "tdoc": {
      "type": "streamableHttp",
      "url": "https://tdoc.dev/mcp"
    }
  }
}
```

Then authorize the server when Cline asks (OAuth in the browser).

If the client cannot do OAuth, an existing tdoc account token (`tdoc_...`)
works instead: add `"headers": {"Authorization": "Bearer tdoc_..."}` to the
entry.

## Check that it works

Ask: "List my tdoc documents." The `list_docs` tool should run and return the
user's documents (an empty list for a new account).

## Other apps

See `plugins/README.md` in this repository for Claude, ChatGPT, Codex,
Cursor, VS Code and Gemini CLI.
