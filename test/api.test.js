// API integration test against the local server.
// Run with: node test/api.test.js
//
// HERMETIC: spawns its own server with a throwaway TDOC_DIR and an ephemeral
// port (was: assumed an already-running server on :7878 and wrote into the real
// ~/tdocs, so it shared state with the user's actual docs and could collide).

const http = require('http');
const HOST = '127.0.0.1';
let PORT = 0; // assigned after the spawned server picks an ephemeral port
const SLUG = 'api-test-' + Date.now();

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: HOST, port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

// Pick a free ephemeral port so concurrent test runs don't collide on :7878.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function waitReady(port, ms = 5000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function probe() {
      const r = http.get({ host: HOST, port, path: '/api/ping' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => { if (Date.now() > deadline) reject(new Error('server not ready')); else setTimeout(probe, 100); });
    })();
  });
}

(async () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-api-'));
  PORT = await freePort();
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const hermetic = { ...process.env, TDOC_DIR: TMP_DIR, TDOC_PORT: String(PORT), TDOC_HOST: '127.0.0.1' };
  for (const k of Object.keys(hermetic)) {
    if (/^(GROK_|CLAUDE_|CLAUDECODE$|CODEX_|CURSOR_|COMPOSER_|GEMINI_|XAI_|TDOC_AGENT_)/.test(k)) delete hermetic[k];
  }
  const srv = spawn(process.execPath, [serverPath], {
    env: hermetic,
    stdio: 'ignore',
  });
  const shutdown = () => { try { srv.kill('SIGKILL'); } catch {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} };
  process.on('exit', shutdown);
  await waitReady(PORT);
  console.log(`testing local API at ${HOST}:${PORT} (hermetic, TDOC_DIR=${TMP_DIR})\n`);

  // Seed: create a doc directory + meta + empty comments (in the temp dir)
  const docDir = path.join(TMP_DIR, SLUG);
  fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), '<h1>api test</h1>');
  fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ title: 'api test', versions: [{ n: 1 }] }));
  fs.writeFileSync(path.join(docDir, 'comments.json'), '[]');

  let topId;
  let replyId;

  await t('POST /api/comments (top-level) returns 200 with id + replies:[] + reactions:{}', async () => {
    const r = await req('POST', '/api/comments', { slug: SLUG, version: 1, text: 'hello', anchor: null });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id) throw new Error('no id');
    if (!Array.isArray(r.body.replies)) throw new Error('replies not array');
    if (typeof r.body.reactions !== 'object') throw new Error('reactions not object');
    topId = r.body.id;
  });

  await t('POST /api/comments with parent_id creates a reply', async () => {
    const r = await req('POST', '/api/comments', { slug: SLUG, parent_id: topId, text: 'a reply' });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id || !r.body.id.startsWith('r_')) throw new Error(`reply id should start with r_, got ${r.body.id}`);
    replyId = r.body.id;
  });

  await t('GET /api/comments returns the top comment with reply nested in .replies', async () => {
    const r = await req('GET', `/api/comments?slug=${SLUG}`);
    const list = r.body;
    if (!Array.isArray(list) || list.length !== 1) throw new Error(`expected 1 top, got ${list?.length}`);
    if (!Array.isArray(list[0].replies) || list[0].replies.length !== 1) throw new Error('reply not nested');
    if (list[0].replies[0].id !== replyId) throw new Error('reply id mismatch');
  });

  await t('POST /api/comments with parent_id of a reply nests under that reply', async () => {
    const r = await req('POST', '/api/comments', { slug: SLUG, parent_id: replyId, text: 'a nested reply' });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.parent_id !== replyId) throw new Error(`nested parent_id ${r.body.parent_id}`);
    const after = await req('GET', `/api/comments?slug=${SLUG}`);
    const replies = after.body[0].replies || [];
    if (replies.length !== 2) throw new Error(`expected 2 replies, got ${replies.length}`);
    const nested = replies.find(x => x.id === r.body.id);
    if (!nested || nested.parent_id !== replyId) throw new Error('nested reply missing or wrong parent');
  });

  await t('POST /api/reactions adds 👍 to top comment', async () => {
    const r = await req('POST', '/api/reactions', { slug: SLUG, comment_id: topId, emoji: '👍' });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.reactions['👍']) throw new Error('reaction not stored');
  });

  await t('POST /api/reactions same emoji again removes it (toggle)', async () => {
    const r = await req('POST', '/api/reactions', { slug: SLUG, comment_id: topId, emoji: '👍' });
    if (r.body.reactions['👍']) throw new Error('reaction not removed on second toggle');
  });

  await t('POST /api/reactions on a reply works', async () => {
    const r = await req('POST', '/api/reactions', { slug: SLUG, comment_id: replyId, emoji: '🔥' });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.reactions['🔥']) throw new Error('reaction not stored on reply');
  });

  await t('POST /api/agent/reply preserves agent identity', async () => {
    const r = await req('POST', '/api/agent/reply', {
      slug: SLUG,
      parent_id: topId,
      text: 'Applied the requested edit.',
      status: 'applied',
      applied_in: 2,
      agent_login: 'codex-pm',
      agent_name: 'Codex PM',
    });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.author?.login !== 'codex-pm') throw new Error(`wrong agent login ${r.body.author?.login}`);
    if (r.body.author?.name !== 'Codex PM') throw new Error(`wrong agent name ${r.body.author?.name}`);
    const after = await req('GET', `/api/comments?slug=${SLUG}`);
    const c = after.body[0];
    if (c.agent_actor !== 'codex-pm') throw new Error(`wrong parent agent_actor ${c.agent_actor}`);
    if (!c.reactions['✅']?.includes('codex-pm')) throw new Error('agent verdict reaction did not use agent login');
  });

  await t('DELETE /api/comments?id=<reply-id> removes the reply, leaves top', async () => {
    const r = await req('DELETE', `/api/comments?slug=${SLUG}&id=${replyId}`);
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    const after = await req('GET', `/api/comments?slug=${SLUG}`);
    if (after.body.length !== 1) throw new Error('top comment was removed');
    if (after.body[0].replies.some(r => r.id === replyId)) throw new Error('reply not removed');
  });

  await t('DELETE /api/comments?id=<top-id> removes the top comment', async () => {
    const r = await req('DELETE', `/api/comments?slug=${SLUG}&id=${topId}`);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const after = await req('GET', `/api/comments?slug=${SLUG}`);
    if (after.body.length !== 0) throw new Error('top comment not removed');
  });

  // Cleanup: kill the spawned server + remove the temp dir.
  shutdown();

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
