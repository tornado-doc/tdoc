// Provider-side onboarding telemetry: structured Worker logs, no client
// sender, no consent interruption, and no user/document identifiers.

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('provider observability');

  await t('the hosted funnel is observable without logging identities or content', async () => {
    const env = makeEnv(mod.CommentsStore);
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    let started, token;
    try {
      const startResponse = await worker.fetch(req('/api/cli/pair/start', {
        method: 'POST', body: { label: 'private-doc-title' },
      }), env, {});
      started = await startResponse.json();
      const cookie = await putSession(env, 'alice-private-login');
      await worker.fetch(req('/api/cli/pair/approve', {
        method: 'POST', cookie, body: { user_code: started.user_code },
      }), env, {});
      const pollResponse = await worker.fetch(req('/api/cli/pair/poll', {
        method: 'POST', body: {
          user_code: started.user_code,
          pair_secret: started.pair_secret,
        },
      }), env, {});
      token = await pollResponse.json();
      const upload = new Request('https://tdoc.dev/api/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          'x-tdoc-client': '1.2.3',
        },
        body: JSON.stringify({
          slug: 'private-observability-doc', version: 1,
          html: '<html><body><h1>secret document text</h1></body></html>',
          meta: { versions: [{ n: 1 }] },
        }),
      });
      const uploadResponse = await worker.fetch(upload, env, {});
      assert(uploadResponse.status === 200, `upload failed: ${await uploadResponse.text()}`);
    } finally {
      console.log = originalLog;
    }

    const events = lines
      .filter((line) => line.startsWith('{"type":"tdoc_product_event"'))
      .map((line) => JSON.parse(line));
    assert(events.map((event) => event.event).join(',') ===
      'onboarding_started,onboarding_approved,token_minted,publish_succeeded',
    `wrong funnel: ${JSON.stringify(events)}`);
    assert(events[3].first_publish === true && events[3].client_version === '1.2.3',
      `publish dimensions missing: ${JSON.stringify(events[3])}`);

    const allowed = new Set(['type', 'schema', 'event', 'auth_path', 'first_publish', 'client_version']);
    for (const event of events) {
      assert(Object.keys(event).every((key) => allowed.has(key)),
        `unexpected product-event field: ${JSON.stringify(event)}`);
    }
    const serialized = JSON.stringify(events);
    for (const secret of [started.user_code, started.pair_secret, token.token,
      token.account_id, 'alice-private-login', 'private-observability-doc',
      'secret document text', 'private-doc-title']) {
      assert(!serialized.includes(secret), `product events leaked ${secret}`);
    }
  });

  await t('product events enforce bounded provider-side allowlists', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const start = source.indexOf('const PRODUCT_EVENTS =');
    const end = source.indexOf('\n// Escape `</script>`', start);
    const helper = source.slice(start, end);
    assert(start >= 0 && end > start, 'productEvent helper missing');
    assert(helper.includes('PRODUCT_AUTH_PATHS') && helper.includes('^[0-9A-Za-z]'),
      'provider allowlists are missing');
    for (const forbidden of ['slug', 'account_id', 'login', 'email', 'token',
      'cookie', 'session_id', 'installation_id']) {
      assert(!new RegExp(`event\\.${forbidden}\\s*=`).test(helper),
        `productEvent can persist ${forbidden}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
