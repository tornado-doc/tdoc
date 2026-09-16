# tdoc Feedback browser extension

tdoc Feedback brings the existing tdoc review loop onto a live product. Enter
comment mode, point at any UI element, and leave a normal tdoc thread anchored
to that element. The plugin does not create a second feedback backend:

- comments, replies, resolution, `@mentions`, notifications, and storage use
  the existing tdoc comment APIs;
- the extension bundles the same React `CommentComposer` and `CommentCard`
  used by the document shell, with `server/chrome.css` as the style source;
- sign-in and access rules come from the connected tdoc;
- product anchors reuse the probe model (`kind`, selector, label/text, rect,
  viewport), extended with the live page URL;
- agents receive the comments through the normal `tdoc pull` workflow.

Screenshots are intentionally not part of the first storage contract. They are
useful diagnostic context, but the durable object is the tdoc thread and its
probe anchor. Screenshot attachments can be added later without forking the
comment system.

## Install the prototype

1. Publish or choose one tdoc for the app. Set that document's access the way
   the project should work (private, invited reviewers, or link access).
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select this `extensions/feedback` directory.
3. Open the extension's **Details → Extension options** and paste the full
   project tdoc URL, for example `https://tdoc.dev/d/my-app-feedback/v/1`.
4. Open any HTTP(S) app, click the extension, press `Alt+Shift+F`, or tap the
   Option/Alt key twice. Click an element and comment. If needed, the plugin
   sends you through the existing tdoc sign-in.
5. The app's agent pulls the same slug with normal tdoc tooling. Product
   comments arrive as `kind: "product"` anchors containing the page URL and
   selector, alongside the ordinary thread/reply/mention history.

This unpacked build is for product validation. Chrome Web Store packaging and
per-origin project mapping should follow after the interaction is approved.

After changing the shared comment UI or extension source, rebuild the checked-in
content script from the repository root with `npm run build:feedback`.

## Why a backing tdoc?

A tdoc is the feedback project's identity and policy boundary. Reusing it
means there is one inbox, one permission model, one notification path, and one
agent-readable history whether feedback was left on a document or in the app.
