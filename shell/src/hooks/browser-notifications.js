// Opt-in desktop alerts for the notification inbox. Nothing is asked of the
// browser until the person turns the switch on in Notifications; after that,
// a new comment, @-mention or reply raises one alert, and clicking it opens
// the comment.
//
// Two ways an alert arrives. Where the browser has Web Push, turning the
// switch on also subscribes it (#771): the worker pushes each new row and
// /tdoc-sw.js shows it with no tdoc tab open. Where it does not (or the
// server has no push), the open tab raises the alert itself while polling.
// Never both: with push active the tab only records what it has seen.

import { dropPushSubscription, getPushKey, hasAccountSession, savePushSubscription } from '../document/api.js';

const PREF_KEY = 'tdoc.browserNotify';
const SEEN_KEY = 'tdoc.browserNotify.seen';
const SNOOZE_KEY = 'tdoc.browserNotify.snoozeUntil';
// The VAPID key this browser subscribed with; present = push is active.
const PUSH_KEY = 'tdoc.browserNotify.pushKey';
const SEEN_MAX = 200;
const ALERT_BURST_MAX = 3;
export const BROWSER_NOTIFICATION_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserNotificationPermission() {
  return browserNotificationsSupported() ? window.Notification.permission : 'unsupported';
}

export function browserNotificationsEnabled() {
  try {
    return browserNotificationPermission() === 'granted' && window.localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

// The soft ask appears only when notifications have something useful to do:
// a signed-in person is on a document with unread collaboration activity.
// Chrome's permission prompt is never opened until they choose Turn on.
export function browserNotificationPromptEligible(unread = 0) {
  if (!browserNotificationsSupported() || browserNotificationPermission() !== 'default' || Number(unread) < 1) return false;
  try { return Number(window.localStorage.getItem(SNOOZE_KEY) || 0) <= Date.now(); } catch { return true; }
}

export function snoozeBrowserNotificationPrompt() {
  try { window.localStorage.setItem(SNOOZE_KEY, String(Date.now() + BROWSER_NOTIFICATION_SNOOZE_MS)); } catch { /* private mode */ }
}

export function webPushSupported() {
  return typeof window !== 'undefined' && window.isSecureContext !== false
    && 'serviceWorker' in navigator && 'PushManager' in window && hasAccountSession();
}

// 'push' when alerts reach this browser with tdoc closed, else 'tab'.
export function browserNotificationMode() {
  try { return browserNotificationsEnabled() && window.localStorage.getItem(PUSH_KEY) ? 'push' : 'tab'; } catch { return 'tab'; }
}

function bytesFromB64url(value) {
  const raw = window.atob(String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '='));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

function b64urlBytes(buffer) {
  let raw = '';
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return window.btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Subscribe this browser (or re-confirm it) and hand the subscription to the
// server under the signed-in account. Idempotent, so it also runs on every
// page load with alerts on: that re-homes a browser after a sign-in as
// someone else and follows a rotated server key. False = tab alerts only.
export async function ensureWebPush() {
  if (!webPushSupported() || browserNotificationPermission() !== 'granted') return false;
  try {
    const { key } = await getPushKey();
    if (!key) throw new Error('no push key');
    await navigator.serviceWorker.register('/tdoc-sw.js', { scope: '/' });
    // subscribe() needs an ACTIVE worker; a first registration is still installing.
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const subscribedWith = subscription?.options?.applicationServerKey;
    if (subscription && subscribedWith && b64urlBytes(subscribedWith) !== key) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromB64url(key) });
    }
    await savePushSubscription(subscription.toJSON());
    window.localStorage.setItem(PUSH_KEY, key);
    return true;
  } catch {
    try { window.localStorage.removeItem(PUSH_KEY); } catch { /* private mode */ }
    return false;
  }
}

async function dropWebPush() {
  try { window.localStorage.removeItem(PUSH_KEY); } catch { /* private mode */ }
  if (!webPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = registration && await registration.pushManager.getSubscription();
    if (!subscription) return;
    await dropPushSubscription(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  } catch { /* nothing left to undo */ }
}

function loadSeen() {
  try { return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}

function saveSeen(seen) {
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX))); } catch { /* private mode */ }
}

// Remember these without alerting: turning the switch on must not replay
// the whole backlog as a burst of alerts.
export function markSeen(items) {
  const seen = loadSeen();
  for (const item of items || []) if (item && item.id) seen.add(eventKey(item));
  saveSeen(seen);
}

// One notification row aggregates a thread's unread events and keeps its id
// (a second reply bumps `count` and `at`), so the id alone would alert for
// the first reply and never again. The fingerprint is the event, not the row.
function eventKey(item) {
  return `${item.id}|${item.at || ''}|${Number(item.count) || 1}`;
}

// Returns the resulting state: 'granted' (on), 'denied' (blocked by the
// browser), 'default' (dismissed), 'unsupported'.
export async function setBrowserNotifications(on, currentItems = []) {
  if (!browserNotificationsSupported()) return 'unsupported';
  if (!on) {
    try { window.localStorage.removeItem(PREF_KEY); } catch { /* ignore */ }
    snoozeBrowserNotificationPrompt();
    await dropWebPush();
    return window.Notification.permission;
  }
  const permission = window.Notification.permission === 'granted'
    ? 'granted'
    : await window.Notification.requestPermission();
  if (permission === 'granted') {
    try {
      window.localStorage.setItem(PREF_KEY, '1');
      window.localStorage.removeItem(SNOOZE_KEY);
    } catch { /* ignore */ }
    markSeen(currentItems);
    const push = await ensureWebPush();
    // Immediate proof that permission works. This also exposes an OS-level
    // block (for example Chrome disabled in macOS Settings) before the person
    // waits for a real comment that never appears.
    const proof = {
      body: push ? 'tdoc will alert you even when no tdoc tab is open.' : 'tdoc will alert you while a tdoc tab is open.',
      tag: 'tdoc-browser-notifications-ready',
      icon: '/tdoc_logo.png',
    };
    try {
      if (push) (await navigator.serviceWorker.ready).showNotification('Browser notifications are on', proof);
      else new window.Notification('Browser notifications are on', proof);
    } catch { /* the settings hint explains service-worker-only browsers */ }
  } else {
    // A dismissed or denied browser prompt must not turn into repeated asks.
    snoozeBrowserNotificationPrompt();
  }
  return permission;
}

// Raise one alert per unread item not alerted before. `open(item)` runs when
// an alert is clicked.
export function alertNewNotifications(items, { label, open }) {
  if (!browserNotificationsEnabled()) return 0;
  // The service worker already showed these from the push.
  if (browserNotificationMode() === 'push') { markSeen(items); return 0; }
  const seen = loadSeen();
  let shown = 0;
  for (const item of items || []) {
    if (!item || item.read || !item.id || seen.has(eventKey(item))) continue;
    seen.add(eventKey(item));
    // A tab opened after a busy afternoon alerts for the newest few only.
    if (shown >= ALERT_BURST_MAX) continue;
    try {
      const alert = new window.Notification(label(item), {
        body: item.preview || '',
        tag: item.id,
        icon: '/tdoc_logo.png',
      });
      alert.onclick = () => {
        window.focus();
        alert.close();
        open(item);
      };
      shown += 1;
    } catch { /* some browsers only allow alerts from a service worker */ }
  }
  saveSeen(seen);
  return shown;
}
