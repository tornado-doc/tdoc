// Opt-in desktop alerts for the notification inbox. Nothing is asked of the
// browser until the person turns the switch on in Notifications; after that,
// a new comment, @-mention or reply raises one alert while any tdoc tab is
// open, and clicking it opens the comment. There is no push service: a closed
// browser hears nothing, and the switch's hint says so.

const PREF_KEY = 'tdoc.browserNotify';
const SEEN_KEY = 'tdoc.browserNotify.seen';
const SNOOZE_KEY = 'tdoc.browserNotify.snoozeUntil';
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
    // Immediate proof that permission works. This also exposes an OS-level
    // block (for example Chrome disabled in macOS Settings) before the person
    // waits for a real comment that never appears.
    try {
      new window.Notification('Browser notifications are on', {
        body: 'tdoc will alert you while a tdoc tab is open.',
        tag: 'tdoc-browser-notifications-ready',
        icon: '/tdoc_logo.png',
      });
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
