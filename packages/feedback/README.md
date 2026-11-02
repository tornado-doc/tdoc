# @tdoc/feedback

Let visitors comment on any page of your site. Comments are pinned to the
element they are about, land in one tdoc space you own, and can be handed to
your AI agent to fix.

## 1. Get a space id

On [tdoc.dev](https://tdoc.dev): **My docs → Feedback → Add to your site**.
Enter your site's address. Who can comment is the space's Share settings,
the same as any tdoc doc: people you invite, anyone with the link who signs
in, or your team if the space is in a team.

Or let your agent do it: with tdoc connected over MCP (`https://tdoc.dev/mcp`),
the `create_feedback_space` tool takes your site's origins (and optionally a
team you are an admin of), makes a private space bound to them, and returns
the space id and the line below. Asked again for the same origin, it returns
the same space. From a terminal with the tdoc skill:
`tdoc-feedback init --site https://app.example.com --write index.html`
(or `--env` for `TDOC_FEEDBACK_SPACE=<slug>`). Both call
`POST https://tdoc.dev/api/feedback/spaces`.

## 2. Add it to your site

One line, no build step:

```html
<script src="https://tdoc.dev/feedback.js" data-tdoc-space="YOUR_SPACE_ID" async></script>
```

Or with npm:

```js
import { loadTdocFeedback } from '@tdoc/feedback';

const tdoc = await loadTdocFeedback({ space: 'YOUR_SPACE_ID' });
tdoc.on('comment', (c) => console.log('new comment', c));
document.querySelector('#feedback').onclick = () => tdoc.comment();
```

React:

```jsx
import { TdocFeedback } from '@tdoc/feedback/react';

<TdocFeedback space="YOUR_SPACE_ID" onReady={(tdoc) => {/* tdoc.open() … */}} />
```

## API

`open()`, `close()`, `toggle()`, `comment()` (start picking an element),
`disconnect()`, and `on('open' | 'close' | 'comment', fn)` which returns an
unsubscribe. The same object is available as `window.tdoc`.

The comment UI is served by tdoc, so it updates without a new package
release. This package only loads it.
