// The push service worker as shipped (server/runtime/tdoc-sw.js), run in a VM
// with a fake ServiceWorkerGlobalScope. A browser cannot be made to click an
// OS notification, so this is where the click path is proven.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'runtime', 'tdoc-sw.js'), 'utf8');

function boot(windows = []) {
  const handlers = {};
  const log = { shown: [], opened: [], focused: [], posted: [], skipped: 0, claimed: 0 };
  const self = {
    location: { origin: 'https://tdoc.dev' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { log.skipped++; },
    registration: { showNotification: async (title, opts) => { log.shown.push({ title, ...opts }); } },
    clients: {
      claim: async () => { log.claimed++; },
      matchAll: async () => windows.map((w) => ({
        url: w,
        focus: async () => { log.focused.push(w); },
        postMessage: (m) => log.posted.push(m),
      })),
      openWindow: async (u) => { log.opened.push(u); },
    },
  };
  vm.runInNewContext(source, { self, URL, console });
  async function fire(type, event) {
    const waits = [];
    handlers[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }
  return { handlers, log, fire };
}

const item = { id: 'n_1', kind: 'mention', slug: 'q3 plan', version: 2, comment_id: 'c_9', actor: { name: 'Claire' }, title: 'Q3 plan', preview: 'Check the numbers' };

(async () => {
  console.log('push service worker');

  await t('only push, notificationclick and lifecycle are handled: no fetch interception', async () => {
    const { handlers } = boot();
    assert(!handlers.fetch, 'a root-scoped fetch handler would sit in front of every tdoc page');
    for (const type of ['install', 'activate', 'push', 'notificationclick']) assert(handlers[type], `${type} missing`);
  });

  await t('a push shows the row the way the bell says it, and tells open tabs to refresh', async () => {
    const { log, fire } = boot(['https://tdoc.dev/me']);
    await fire('push', { data: { json: () => ({ v: 1, item }) } });
    assert(log.shown.length === 1, `shown ${log.shown.length}`);
    const n = log.shown[0];
    assert(n.title === 'Claire mentioned you on Q3 plan', n.title);
    assert(n.body === 'Check the numbers' && n.tag === 'n_1', JSON.stringify(n));
    assert(n.data.url === '/d/q3%20plan/v/2?comment=c_9', n.data.url);
    assert(log.posted.some((m) => m.type === 'tdoc-push'), 'open tab not told');
  });

  await t('an unreadable push still shows something (userVisibleOnly)', async () => {
    const { log, fire } = boot();
    await fire('push', { data: { json: () => { throw new Error('bad'); } } });
    assert(log.shown.length === 1 && log.shown[0].title === 'tdoc', JSON.stringify(log.shown));
  });

  await t('clicking opens the comment in a new window', async () => {
    const { log, fire } = boot(['https://tdoc.dev/me']);
    let closed = false;
    await fire('notificationclick', { notification: { data: { url: '/d/q3%20plan/v/2?comment=c_9' }, close: () => { closed = true; } } });
    assert(closed, 'notification not closed');
    assert(log.opened[0] === 'https://tdoc.dev/d/q3%20plan/v/2?comment=c_9', JSON.stringify(log.opened));
  });

  await t('clicking focuses the tab already on that comment instead of opening another', async () => {
    const target = 'https://tdoc.dev/d/q3%20plan/v/2?comment=c_9';
    const { log, fire } = boot([target]);
    await fire('notificationclick', { notification: { data: { url: '/d/q3%20plan/v/2?comment=c_9' }, close: () => {} } });
    assert(log.focused[0] === target && log.opened.length === 0, JSON.stringify(log));
  });

  await t('install and activate take over without waiting for old tabs', async () => {
    const { log, fire } = boot();
    await fire('install', {});
    await fire('activate', {});
    assert(log.skipped === 1 && log.claimed === 1, JSON.stringify(log));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
