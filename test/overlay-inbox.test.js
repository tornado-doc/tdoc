// Inbox click → doc/comment deep-link contract. #180
//
// The inbox lives in the shell client script (server/shell.js) now. Chrome UI
// is mostly un-runnable DOM, so this suite pins the wiring in source:
// destination URL builder, stopPropagation on the row, consume-once deep-link
// re-arming for same-doc clicks, and mark-read on open.
//
// Run with: node test/overlay-inbox.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'shell.js'), 'utf8');

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

console.log('shell inbox (#180 notification deep-link)');

t('inboxTargetUrl is the only destination builder', () => {
  const open = sliceFn('openInboxTarget');
  assert(open.includes('inboxTargetUrl(row)'), 'openInboxTarget must use inboxTargetUrl');
  assert(open.includes('location.assign(href)'), 'other-doc clicks must navigate');
  assert(!open.includes('/d/'), 'openInboxTarget must not build /d/ URLs itself');
});

t('inboxTargetUrl never emits /d/undefined and encodes its parts', () => {
  const fn = sliceFn('inboxTargetUrl');
  assert(fn.includes("if (!destSlug) return ''"), 'empty slug must return empty, never /d/undefined');
  assert(fn.includes('encodeURIComponent(destSlug)'), 'slug must be encoded');
  assert(fn.includes('encodeURIComponent(target)'), 'comment id must be encoded');
});

t('inbox row click stops the document unpin handler from seeing it', () => {
  const write = sliceFn('writeInboxRows');
  assert(write.includes('e.stopPropagation'), 'row click must stopPropagation');
  assert(write.includes('openInboxTarget(row)'), 'row click must open the target');
  assert(write.includes('closeAuxModal()'), 'row click must close the panel');
});

t('same-doc inbox click re-arms the consume-once deep link in place', () => {
  const open = sliceFn('openInboxTarget');
  assert(open.includes('deepLinkDone = false'), 'same-doc must re-arm the consumed deep link');
  assert(open.includes('history.replaceState'), 'same-doc must update the URL without navigation');
  assert(open.includes('!cfg.isCatalog && location.pathname === destPath'),
    'catalog must not take the in-place path');
});

t('opening a comment card marks its notification read', () => {
  const openCard = sliceFn('openCard');
  assert(openCard.includes('markInboxSeen(id)'), 'openCard must mark the notification read');
  const seen = sliceFn('markInboxSeen');
  assert(seen.includes("'/api/notifications/read'"), 'mark-read must hit the notifications API');
  assert(seen.includes("credentials:'same-origin'") || seen.includes("credentials: 'same-origin'"),
    'mark-read must send the session cookie');
});

t('inbox poll is fingerprint-diffed and paused while typing or hidden', () => {
  const tick = sliceFn('tickInbox');
  assert(tick.includes('document.hidden'), 'poll must not run in background tabs');
  assert(tick.includes("textarea:focus"), 'poll must not run while typing');
  assert(tick.includes('inboxFingerprint'), 'poll must diff payloads before repainting');
  assert(tick.includes('loadComments()'), 'a changed inbox refreshes comments');
});

t('reply deep-links expand the thread when the card opens', () => {
  const deep = sliceFn('tryDeepLink');
  assert(deep.includes("classList.add('open')"), 'reply deep-link must expand .tdoc-replies');
});

t('deep-link reads ?comment= from the page URL, consume-once', () => {
  const cap = sliceFn('captureDeepLink');
  assert(cap.includes("URLSearchParams(location.search).get('comment')"),
    'captureDeepLink must read location.search comment');
  assert(cap.includes('deepLinkDone'), 'deep link must be consume-once (no re-fire after posts)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
