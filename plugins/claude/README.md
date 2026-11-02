# tdoc Cloud

Write documents as HTML on [tdoc.dev](https://tdoc.dev), share a link, and
revise them from the comments readers leave on text and visuals.

This plugin connects Claude to the tdoc remote MCP server,
`https://tdoc.dev/mcp`, and adds the `tdoc` skill, which tells Claude when and
how to use it. Sign in with your tdoc account the first time a tool runs
(OAuth). Nothing is installed on your computer and no token is stored in the
plugin.

## What Claude can do with it

- Read tdoc's writing guide and house style (`get_writing_guide`)
- Create a document and return its link (`create_doc`)
- Publish a new version of a document (`update_doc`), or edit it in place
  with exact find/replace (`edit_doc`)
- Publish a document and its local images from files through signed upload
  URLs (`create_upload`, `commit_upload`)
- Read a document, or list yours (`get_doc`, `list_docs`)
- Read comments, reply to them, mark them handled (`get_comments`,
  `reply_to_comment`, `resolve_comment`)
- Answer a reader's question about a document (`answer_question`)
- Change who can open a document (`share_doc`)
- Set up product feedback on a website: a private comment space and the one
  `<script>` line to embed (`create_feedback_space`)

New documents are private until you share them.

## Install

- claude.ai, Claude Desktop, Cowork: add **tdoc** from the directory, or add a
  custom connector with the URL `https://tdoc.dev/mcp`.
- Claude Code: `claude plugin install tdoc-cloud --marketplace tornado-doc/tdoc`

## Example prompts

- "Use tdoc to write a one-page summary of this discussion."
- "Read all comments on my tdoc and fix them."

## Support

Issues: https://github.com/tornado-doc/tdoc/issues

## Privacy

Privacy policy: https://tdoc.dev/privacy

## License

AGPL-3.0-or-later. Source: https://github.com/tornado-doc/tdoc
