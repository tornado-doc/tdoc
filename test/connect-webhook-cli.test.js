// Registration secrets are local configuration, never chat output.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../bin/lib/connect-webhook.js');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-receiver-cli-'));
  const previous = { config: process.env.TDOC_CONFIG, dir: process.env.TDOC_RECEIVER_DIR, fetch: global.fetch, log: console.log };
  const lines = [];
  try {
    process.env.TDOC_CONFIG = path.join(dir, 'account.json');
    process.env.TDOC_RECEIVER_DIR = path.join(dir, 'receivers');
    fs.writeFileSync(process.env.TDOC_CONFIG, JSON.stringify({ base: 'https://tdoc.dev', upload_token: 'tdoc_test_only' }));
    console.log = text => lines.push(text);
    global.fetch = async (url, options) => {
      assert.equal(url.href, 'https://tdoc.dev/api/notify/webhook/register');
      assert.equal(options.headers.Authorization, 'Bearer tdoc_test_only');
      assert.equal(JSON.parse(options.body).url, 'https://bot.example/tasks');
      return new Response(JSON.stringify({ target: { agent_sub: 'wh_1234', provider: 'webhook' }, secret: 'whsec_TEST_ONLY' }));
    };
    await main(['--url', 'https://bot.example/tasks', '--label', 'Test bot']);
    const file = path.join(dir, 'receivers', 'wh_1234.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file)).signing_secret, 'whsec_TEST_ONLY');
    assert.ok(!lines.join('\n').includes('whsec_TEST_ONLY'));
    assert.ok(!lines.join('\n').includes('tdoc_test_only'));
    await assert.rejects(main(['--url', 'http://bot.example/tasks']), /HTTPS/);
    global.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(main(['--url', 'https://bot.example/tasks']), /503/);
  } finally {
    global.fetch = previous.fetch; console.log = previous.log;
    if (previous.config === undefined) delete process.env.TDOC_CONFIG; else process.env.TDOC_CONFIG = previous.config;
    if (previous.dir === undefined) delete process.env.TDOC_RECEIVER_DIR; else process.env.TDOC_RECEIVER_DIR = previous.dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ receiver registration keeps credentials private, uses the configured account, and reports failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
