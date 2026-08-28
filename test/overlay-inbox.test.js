const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const dialog = fs.readFileSync(path.join(root, 'shell/src/notifications-dialog.jsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'shell/src/hooks/use-notifications.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'shell/src/document-shell.jsx'), 'utf8');
const topBar = fs.readFileSync(path.join(root, 'shell/src/top-bar.jsx'), 'utf8');

console.log('React notifications and deep links');

t('notificationTarget is the single encoded destination builder', () => {
  assert(dialog.includes('export function notificationTarget'), 'destination builder missing');
  assert(dialog.includes('if (!item?.slug) return'), 'empty slug guard missing');
  assert(dialog.includes('encodeURIComponent(item.slug)'), 'slug encoding missing');
  assert(dialog.includes('encodeURIComponent(target)'), 'comment encoding missing');
  assert(topBar.includes('notificationTarget(item)'), 'TopBar bypasses destination builder');
});

t('opening Notifications loads rows and selecting one marks it read', () => {
  assert(topBar.includes('notifications.load()'), 'open does not load notifications');
  assert(topBar.includes('notifications.markRead(item)'), 'selection does not mark read');
  assert(hook.includes("markNotificationsRead([item.id])"), 'read API call missing');
});

t('same-document notifications re-arm the deep link without navigation', () => {
  assert(shell.includes('const sameDocument = item.slug === config.slug'), 'same-document comparison missing');
  assert(shell.includes("history.replaceState(null, '', target)"), 'URL is not updated in place');
  assert(shell.includes('setDeepTarget(commentId)'), 'deep-link state is not re-armed');
});

t('other-document notifications navigate to the canonical destination', () => {
  assert(shell.includes('location.href = target'), 'cross-document navigation missing');
});

t('polling pauses in hidden tabs and while the user is typing', () => {
  assert(hook.includes('document.hidden'), 'background-tab guard missing');
  assert(hook.includes("input, textarea, [contenteditable=\"true\"]"), 'typing guard missing');
  assert(hook.includes('30_000'), 'poll interval missing');
});

t('reply deep-links resolve to the parent and open the thread', () => {
  assert(shell.includes('comment.replies?.some'), 'reply-to-parent lookup missing');
  assert(shell.includes('expandReplies={deepReply}'), 'reply thread expansion missing');
});

t('identity menu shows unread state and notifications command', () => {
  assert(topBar.includes('tdoc-unread-dot'), 'unread dot missing');
  assert(topBar.includes('Notifications{notifications.unread'), 'unread menu label missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
