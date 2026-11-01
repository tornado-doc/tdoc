const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const dialog = fs.readFileSync(path.join(root, 'shell/src/notifications-dialog.jsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'shell/src/hooks/use-notifications.js'), 'utf8');
const browserAlerts = fs.readFileSync(path.join(root, 'shell/src/hooks/browser-notifications.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'shell/src/document-shell.jsx'), 'utf8');
const topBar = fs.readFileSync(path.join(root, 'shell/src/top-bar.jsx'), 'utf8');
const text = fs.readFileSync(path.join(root, 'shell/src/notification-text.js'), 'utf8');
const pushWorker = fs.readFileSync(path.join(root, 'shell/src/push-sw.js'), 'utf8');

console.log('React notifications and deep links');

t('notificationTarget is the single encoded destination builder', () => {
  assert(text.includes('export function notificationTarget'), 'destination builder missing');
  assert(text.includes('if (!item?.slug) return'), 'empty slug guard missing');
  assert(text.includes('encodeURIComponent(item.slug)'), 'slug encoding missing');
  assert(text.includes('encodeURIComponent(target)'), 'comment encoding missing');
  assert(topBar.includes('notificationTarget(item)'), 'TopBar bypasses destination builder');
  // The push service worker opens the same place a dialog row does.
  assert(pushWorker.includes("import { notificationLabel, notificationTarget } from './notification-text.js'"), 'push worker bypasses destination builder');
});

t('opening Notifications loads rows and selecting one marks it read', () => {
  assert(topBar.includes('notifications.load()'), 'open does not load notifications');
  assert(topBar.includes('notifications.markRead(item)'), 'selection does not mark read');
  assert(hook.includes("markNotificationsRead([item.id])"), 'read API call missing');
});

t('same-document notifications re-arm the deep link without navigation', () => {
  assert(shell.includes("const sameDocument = item.kind !== 'team_join_request' && item.slug === config.slug"), 'same-document comparison missing or team requests treated as comment links');
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

t('the document soft ask waits for unread value, requests permission only on click, and snoozes seven days', () => {
  assert(browserAlerts.includes("browserNotificationPermission() !== 'default'"), 'soft ask is not permission-gated');
  assert(browserAlerts.includes('Number(unread) < 1'), 'soft ask appears without collaboration activity');
  assert(browserAlerts.includes('7 * 24 * 60 * 60 * 1000'), 'seven-day quiet period missing');
  assert(dialog.includes('onClick={enable}>Turn on'), 'soft ask does not wait for a click');
  assert(dialog.includes("notifications.dismissAlertsPrompt()"), 'Not now does not snooze');
  assert(shell.includes('notificationPrompt={!config.isLanding}'), 'soft ask is not scoped to document pages');
});

t('approval sends a proof alert and says plainly whether a tab must stay open', () => {
  assert(browserAlerts.includes("new window.Notification('Browser notifications are on'"), 'tab proof alert missing');
  assert(browserAlerts.includes(".showNotification('Browser notifications are on'"), 'push proof alert missing');
  assert(dialog.includes('Keep a tdoc tab open for alerts.'), 'success state hides the open-tab limit');
  assert(dialog.includes('even with tdoc closed'), 'soft ask hides that push reaches a closed tdoc');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
