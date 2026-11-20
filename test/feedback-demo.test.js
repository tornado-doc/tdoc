// Try it on this page (feedback/src/demo.js): the widget's demo mode turns on
// only on tdoc's own /feedback (or landing) page, loaded from that same
// origin, and its answers never leave the tab.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');

(async () => {
  // No bundler in the offline job: the module as a data URL.
  const src = fs.readFileSync(path.join(__dirname, '..', 'feedback/src/demo.js'), 'utf8');
  const { demoAllowed, createDemoBackend, demoSession, DEMO_STORAGE_KEY } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  let pass = 0;
  const t = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };
  console.log('feedback demo mode');

  await t('on: tdoc\'s own /feedback and landing, the script from the same origin', () => {
    for (const [scriptSrc, href] of [
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/feedback'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/feedback#try'],
      ['https://tdoc.dev/feedback.js?b=1', 'https://tdoc.dev/feedback/'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/'],
      ['https://pr-12-tdoc-preview.example.workers.dev/feedback.js', 'https://pr-12-tdoc-preview.example.workers.dev/feedback'],
      ['http://127.0.0.1:8787/feedback.js', 'http://127.0.0.1:8787/feedback'],
    ]) assert.equal(demoAllowed({ scriptSrc, href }), true, `${scriptSrc} on ${href}`);
  });

  await t('off: any other site, even loading tdoc.dev/feedback.js with data-tdoc-demo', () => {
    for (const [scriptSrc, href] of [
      ['https://tdoc.dev/feedback.js', 'https://app.example.com/feedback'],
      ['https://tdoc.dev/feedback.js', 'https://app.example.com/'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev.evil.com/feedback'],
      ['https://tdoc.dev/feedback.js', 'http://tdoc.dev/feedback'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev:8443/feedback'],
      ['https://tdoc.dev/feedback.js', 'https://sub.tdoc.dev/feedback'],
      ['https://evil.com/feedback.js', 'https://tdoc.dev/feedback'],
    ]) assert.equal(demoAllowed({ scriptSrc, href }), false, `${scriptSrc} on ${href}`);
  });

  await t('off: other tdoc pages, no script address (an inline copy, a global), junk', () => {
    for (const [scriptSrc, href] of [
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/d/some-doc'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/feedback/share/space'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/feedback/connect?origin=x'],
      ['https://tdoc.dev/feedback.js', 'https://tdoc.dev/me'],
      ['', 'https://tdoc.dev/feedback'],
      [undefined, 'https://tdoc.dev/feedback'],
      ['https://tdoc.dev/feedback.js', ''],
      ['not a url', 'https://tdoc.dev/feedback'],
      ['https://tdoc.dev/feedback.js', 'javascript:alert(1)'],
      ['data:text/javascript,1', 'data:text/html,<p>'],
    ]) assert.equal(demoAllowed({ scriptSrc, href }), false, `${scriptSrc} on ${href}`);
    assert.equal(demoAllowed(), false);
  });

  await t('the demo session has no agent, share or own-agent door', () => {
    const s = demoSession();
    assert.equal(s.demo, true);
    for (const key of ['notify', 'own_agent', 'can_share', 'share_here']) assert.equal(s[key], false, key);
  });

  await t('the backend answers from the tab: post, reply, react, resolve, delete; kept in storage', async () => {
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    // No network: a call that reached fetch would throw here.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network used'); };
    try {
      const b = createDemoBackend({ storage });
      const json = async (r) => ({ status: r.status, body: await r.json() });
      const post = (body) => b.fetch('https://tdoc.dev/api/comments', { method: 'POST', body: JSON.stringify(body) }).then(json);
      const made = await post({ slug: 'x', version: 1, text: '  Fix this  ', anchor: { kind: 'product', url: 'https://tdoc.dev/feedback' } });
      assert.equal(made.status, 200);
      assert.equal(made.body.text, 'Fix this');
      assert.equal((await post({ text: '   ' })).status, 400);
      const reply = await post({ text: 'And this', parent_id: made.body.id });
      assert.equal(reply.body.thread_id, made.body.id);
      await b.fetch('/api/reactions', { method: 'POST', body: JSON.stringify({ comment_id: made.body.id, emoji: '👍' }) });
      await b.fetch('/api/comments', { method: 'PATCH', body: JSON.stringify({ id: made.body.id, resolved: true }) });
      let list = (await json(await b.fetch(`https://tdoc.dev/api/comments?slug=x&version=1`))).body;
      assert.equal(list.length, 1);
      assert.equal(list[0].status, 'applied');
      assert.deepEqual(list[0].reactions, { '👍': ['you'] });
      assert.equal(list[0].replies.length, 1);
      // Kept for this tab: a new backend on the same storage sees it.
      assert.equal(JSON.parse(store.get(DEMO_STORAGE_KEY)).length, 1);
      list = (await json(await createDemoBackend({ storage }).fetch('/api/comments?slug=x&version=1'))).body;
      assert.equal(list[0].text, 'Fix this');
      await b.fetch(`/api/comments?slug=x&version=1&id=${made.body.id}`, { method: 'DELETE' });
      assert.equal((await json(await b.fetch('/api/comments?slug=x'))).body.length, 0);
      // Agents, share, invites, connect: refused locally, never sent.
      for (const p of ['/api/notify/handoff', '/api/notify/targets', '/api/feedback/connect/claim', '/api/feedback/invite?id=1', '/api/feedback/switch', '/api/me/agents']) {
        assert.equal((await b.fetch(`https://tdoc.dev${p}`, { method: 'POST', body: '{}' })).status, 404, p);
      }
    } finally { globalThis.fetch = realFetch; }
  });

  await t('the widget turns demo on only through demoAllowed, and has no URL switch', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'feedback/src/main.jsx'), 'utf8');
    assert.match(main, /hasAttribute\('data-tdoc-demo'\)[\s\S]{0,200}demoAllowed\(\{ scriptSrc: own\.src, href: location\.href \}\)/);
    assert.doesNotMatch(main, /searchParams\.get\(['"][^'"]*demo/i, 'a URL parameter turns the demo on');
    assert.doesNotMatch(main, /window\.__TDOC_DEMO/i, 'a page global turns the demo on');
    // Every request the widget makes goes through the demo's fetch.
    assert.match(main, /setApiTransport\(\{\s*base,\s*\.\.\.\(demo \? \{ fetch: demo\.fetch \} : \{\}\)/);
    assert.match(main, /const response = await net\(`\$\{base\}\$\{pathname\}`/);
    assert.match(main, /function connect\(\{ invite = null \} = \{\}\) \{\s*\/\/[^\n]*\n\s*if \(demo\)/);
  });

  console.log(`\n${pass} passed, 0 failed.`);
})().catch((error) => { console.error(error); process.exit(1); });
