// Web push (#771): browser notifications used to come only from an open tdoc
// tab. Now a comment pushes to every browser the recipient turned alerts on
// in. These drive the real routes, capture the request the worker sends to
// the push service, and open it the way a browser would (RFC 8291 decrypt,
// RFC 8292 VAPID signature) -- an independent implementation, so a wrong
// byte in the worker's encoding fails here instead of on a real phone.
const { webcrypto } = require('crypto');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

const subtle = webcrypto.subtle;
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// A browser's side of a subscription: its ECDH key pair and auth secret.
async function fakeBrowser(endpoint) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = webcrypto.getRandomValues(new Uint8Array(16));
  return {
    pair, pub, auth,
    subscription: { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } },
    async open(body) {
      const salt = body.slice(0, 16);
      const idlen = body[20];
      const asPublic = body.slice(21, 21 + idlen);
      const sealed = body.slice(21 + idlen);
      const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256));
      const te = new TextEncoder();
      const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), pub, asPublic), 32);
      const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
      const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, sealed));
      assert(plain[plain.length - 1] === 2, 'last-record delimiter missing');
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

async function verifyVapid(header, endpoint, serverKey) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || '');
  assert(m, `not a VAPID header: ${header}`);
  assert(m[2] === serverKey, 'k= is not the key the browser subscribed with');
  const [h, c, s] = m[1].split('.');
  const pub = unb64u(m[2]);
  const key = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)) }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(s), new TextEncoder().encode(`${h}.${c}`));
  assert(ok, 'VAPID signature does not verify against k=');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert(claims.aud === new URL(endpoint).origin, `aud ${claims.aud}`);
  assert(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, `exp ${claims.exp}`);
  assert(/^(mailto:|https:)/.test(claims.sub), `sub ${claims.sub}`);
}

// Capture what the worker sends to push services; answer with `status`.
function capturePushes(status = () => 201) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url ? input.url : input);
    if (/fcm\.googleapis\.com|push\.apple\.com|mozilla\.com/.test(u)) {
      sent.push({ url: u, headers: init.headers, body: new Uint8Array(init.body) });
      return new Response(null, { status: status(u) });
    }
    return real(input, init);
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function seedDoc(env, slug, owner) {
  await env.META.put(`meta:${slug}`, JSON.stringify({
    slug, title: 'Launch plan', hosted: { github_login: owner }, versions: [{ n: 1, created: '2026-10-19T00:00:00Z' }],
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Launch plan</h1>');
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('web push');

  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

  await t('a comment on your doc reaches your subscribed browser, readable only by it', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'launch', 'alice');
    const alice = await putSession(env, 'alice');
    const { key } = await (await worker.fetch(req('/api/push/key'), env, {})).json();
    assert(unb64u(key).length === 65, 'server key is not a raw P-256 point');
    const browser = await fakeBrowser(ENDPOINT);
    const sub = await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: browser.subscription } }), env, {});
    assert(sub.status === 200, `subscribe ${sub.status}`);

    const cap = capturePushes();
    try {
      const bob = await putSession(env, 'bob');
      const r = await worker.fetch(req('/api/comments', { method: 'POST', cookie: bob, body: { slug: 'launch', version: 1, text: 'Can we ship Friday?', anchor: null } }), env, {});
      assert(r.status === 200, `comment ${r.status}`);
    } finally { cap.restore(); }

    assert(cap.sent.length === 1, `expected one push, got ${cap.sent.length}`);
    const push = cap.sent[0];
    assert(push.url === ENDPOINT, push.url);
    assert(push.headers['Content-Encoding'] === 'aes128gcm', 'wrong content encoding');
    assert(Number(push.headers.TTL) > 0, 'TTL missing');
    await verifyVapid(push.headers.Authorization, ENDPOINT, key);
    assert(!new TextDecoder().decode(push.body).includes('Friday'), 'payload is not encrypted');
    const { item } = await browser.open(push.body);
    assert(item.kind === 'comment' && item.slug === 'launch' && item.preview === 'Can we ship Friday?', JSON.stringify(item));
    assert(item.title === 'Launch plan' && item.comment_id, JSON.stringify(item));
  });

  await t('a mention addressed to your email reaches the browser you subscribed as your handle', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'plan', 'carol');
    const sid = 'ab'.repeat(16);
    await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', email: 'julie@example.com', name: 'Julie', created: new Date().toISOString() }));
    const browser = await fakeBrowser(ENDPOINT);
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: `tdoc_sid=${sid}`, body: { subscription: browser.subscription } }), env, {});
    assert(await env.META.get('push-subs:email:julie@example.com'), 'not stored under the email key');

    const cap = capturePushes();
    try {
      const carol = await putSession(env, 'carol');
      await worker.fetch(req('/api/comments', { method: 'POST', cookie: carol, body: { slug: 'plan', version: 1, text: '@julie@example.com can you check this?', anchor: null } }), env, {});
    } finally { cap.restore(); }
    const mentions = [];
    for (const p of cap.sent) mentions.push((await browser.open(p.body)).item.kind);
    assert(mentions.includes('mention'), `pushes: ${JSON.stringify(mentions)}`);
  });

  await t('a browser the push service says is gone is forgotten', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'gone', 'alice');
    const alice = await putSession(env, 'alice');
    const browser = await fakeBrowser(ENDPOINT);
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: browser.subscription } }), env, {});
    const cap = capturePushes(() => 410);
    try {
      const bob = await putSession(env, 'bob');
      await worker.fetch(req('/api/comments', { method: 'POST', cookie: bob, body: { slug: 'gone', version: 1, text: 'hello', anchor: null } }), env, {});
    } finally { cap.restore(); }
    assert(cap.sent.length === 1, 'no push attempted');
    assert(!(await env.META.get('push-subs:alice')), 'dead subscription kept');
  });

  await t('a push failure never fails the comment', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'flaky', 'alice');
    const alice = await putSession(env, 'alice');
    const browser = await fakeBrowser(ENDPOINT);
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: browser.subscription } }), env, {});
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('fcm.googleapis.com')) throw new Error('network down');
      return real(input, init);
    };
    try {
      const bob = await putSession(env, 'bob');
      const r = await worker.fetch(req('/api/comments', { method: 'POST', cookie: bob, body: { slug: 'flaky', version: 1, text: 'still saved', anchor: null } }), env, {});
      assert(r.status === 200, `comment ${r.status}`);
    } finally { globalThis.fetch = real; }
    assert(await env.META.get('push-subs:alice'), 'a transient failure dropped the subscription');
  });

  await t('only real push services are accepted as endpoints', async () => {
    const env = makeEnv(mod.CommentsStore);
    const alice = await putSession(env, 'alice');
    const browser = await fakeBrowser(ENDPOINT);
    for (const endpoint of ['https://evil.example/collect', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://169.254.169.254/latest']) {
      const r = await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: { ...browser.subscription, endpoint } } }), env, {});
      assert(r.status === 400, `${endpoint} accepted (${r.status})`);
    }
    const bad = await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: { endpoint: ENDPOINT, keys: { p256dh: 'AAAA', auth: 'AAAA' } } } }), env, {});
    assert(bad.status === 400, 'malformed keys accepted');
    const anon = await worker.fetch(req('/api/push/subscribe', { method: 'POST', body: { subscription: browser.subscription } }), env, {});
    assert(anon.status === 401, `anonymous subscribe ${anon.status}`);
  });

  await t('a browser handed to another account stops alerting the first', async () => {
    const env = makeEnv(mod.CommentsStore);
    const browser = await fakeBrowser(ENDPOINT);
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: await putSession(env, 'alice'), body: { subscription: browser.subscription } }), env, {});
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: await putSession(env, 'bob'), body: { subscription: browser.subscription } }), env, {});
    assert(!(await env.META.get('push-subs:alice')), 'alice still pushed to bob\'s browser');
    assert(await env.META.get('push-subs:bob'), 'bob not subscribed');
  });

  await t('turning alerts off forgets the browser', async () => {
    const env = makeEnv(mod.CommentsStore);
    const alice = await putSession(env, 'alice');
    const browser = await fakeBrowser(ENDPOINT);
    await worker.fetch(req('/api/push/subscribe', { method: 'POST', cookie: alice, body: { subscription: browser.subscription } }), env, {});
    const r = await worker.fetch(req('/api/push/unsubscribe', { method: 'POST', cookie: alice, body: { endpoint: ENDPOINT } }), env, {});
    assert(r.status === 200, `unsubscribe ${r.status}`);
    assert(!(await env.META.get('push-subs:alice')), 'subscription kept');
  });

  await t('the server key is stable across requests and the service worker is served at the root', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await (await worker.fetch(req('/api/push/key'), env, {})).json();
    const b = await (await worker.fetch(req('/api/push/key'), env, {})).json();
    assert(a.key && a.key === b.key, 'key changed between requests');
    const sw = await worker.fetch(req('/tdoc-sw.js'), env, {});
    assert(sw.status === 200, `sw ${sw.status}`);
    assert(sw.headers.get('Service-Worker-Allowed') === '/', 'scope header missing');
    assert(/javascript/.test(sw.headers.get('Content-Type')), sw.headers.get('Content-Type'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
