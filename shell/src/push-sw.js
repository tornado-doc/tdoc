// The push service worker (#771), served at /tdoc-sw.js with scope `/`.
//
// It does two things and nothing else: show a pushed notification row, and
// open the comment when the alert is clicked. There is deliberately no
// `fetch` handler -- a root-scoped worker that intercepted requests would sit
// between every tdoc page and the network, and nothing here needs that.

import { notificationLabel, notificationTarget } from './notification-text.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let item = null;
  try { item = event.data ? event.data.json().item : null; } catch { item = null; }
  event.waitUntil((async () => {
    // An open tab refreshes its bell now instead of at the next poll.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'tdoc-push' });
    // Every push must show something (userVisibleOnly), even one we cannot read.
    if (!item || !item.slug) {
      return self.registration.showNotification('tdoc', { body: 'You have a new notification.', icon: '/tdoc_logo.png', tag: 'tdoc-push' });
    }
    return self.registration.showNotification(notificationLabel(item), {
      body: item.preview || '',
      // The same tag as the in-tab alert: one event is one alert.
      tag: item.id,
      icon: '/tdoc_logo.png',
      data: { url: notificationTarget(item) },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find((client) => client.url === url);
    if (same) return same.focus();
    return self.clients.openWindow(url);
  })());
});
