// Inbox click → doc/comment deep-link contract. #180
//
// Overlay UI is mostly un-runnable DOM, so this suite pins the wiring in
// source: destination URL, stopPropagation on the row, outside-click must
// not unpin overlay chrome, ?comment= expands the thread before buildCard
// and opens the phone drawer.
//
// Run with: node test/overlay-inbox.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8');

function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

console.log('overlay inbox (#180 notification deep-link)');

t('inboxTargetUrl is the only destination builder', () => {
  const open = sliceFn('openInboxTarget');
  assert(open.includes('inboxTargetUrl(row, { slug, version })'), 'openInboxTarget must use inboxTargetUrl');
  assert(open.includes('location.assign(href)'), 'other-doc clicks must navigate');
  assert(!/\/d\/\$\{encodeURIComponent\(destSlug\)\}/.test(open),
    'openInboxTarget still interpolates destSlug itself');
  assert(!open.includes("location.href = `/d/"), 'legacy location.href assignment came back');
});

t('inbox row click stops the document unpin handler from seeing it', () => {
  const write = sliceFn('writeInboxRows');
  assert(write.includes('e.stopPropagation'), 'row go() must stopPropagation');
  assert(/btn\.onclick = go/.test(write), 'row click must call go');
});

t('outside-click unpin ignores overlay chrome (inbox modal)', () => {
  const unpin = src.indexOf("Click outside an open pinned card");
  assert(unpin !== -1, 'unpin handler missing');
  const window = src.slice(unpin - 400, unpin + 200);
  assert(window.includes('if (isInUI(e.target)) return;'),
    'unpin handler must bail out for overlay UI clicks');
});

t('?comment= expands the thread before cards are built', () => {
  const refresh = sliceFn('refreshComments');
  const expandAt = refresh.indexOf('if (deepRoot) state.openReplyThreads.add(deepRoot)');
  const buildAt = refresh.indexOf('const card = buildCard(comment)');
  assert(expandAt !== -1, 'deep-link does not add the root to openReplyThreads');
  assert(buildAt !== -1, 'buildCard missing from refreshComments');
  assert(expandAt < buildAt, 'thread must be marked open before buildCard');
});

t('applyCommentDeepLink opens the phone drawer and the card', () => {
  const fn = sliceFn('applyCommentDeepLink');
  assert(fn.includes("commentLayer.classList.add('open')"), 'narrow mode must open the drawer');
  assert(fn.includes('setActiveComment(root)'), 'top-level comment must activate');
  assert(fn.includes('pinOpenCard(root)'), 'reply deep-link must pin the root card');
  assert(fn.includes('markInboxSeen(want)'), 'deep-link must mark the notification read');
});

t('deep-link reads ?comment= from the page URL', () => {
  const refresh = sliceFn('refreshComments');
  assert(refresh.includes("URLSearchParams(location.search).get('comment')"),
    'refreshComments must read location.search comment');
});

t('/me catalog still has the inbox and navigates via inboxTargetUrl', () => {
  assert(src.includes('const isCatalog = !!cfg.isCatalog'), 'catalog mode missing');
  const open = sliceFn('openInboxTarget');
  assert(open.includes('!isCatalog && herePath === destPath'),
    'catalog must not take the in-place path');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
