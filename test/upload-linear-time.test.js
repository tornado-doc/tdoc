// Malformed markup must not make an agent publish block the Worker. Exercise
// the real upload route, including aid stamping and shell preview extraction.
const assert = require('node:assert/strict');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const owner = await issue(worker, env, 'upload-perf');
  const upload = (slug, html) => worker.fetch(req('/api/upload', {
    method: 'POST', token: owner.token, body: { slug, version: 1, html },
  }), env, {});

  // Warm route initialization and the JIT before measuring document work.
  assert.equal((await upload('warm-up', '<h1>Warm up</h1><p>Text</p>')).status, 200);

  for (const [kind, opener] of [
    ['script', '<script'],
    ['comment', '<!--'],
    ['heading', '<h1'],
  ]) {
    const html = '<section>' + opener.repeat(Math.ceil(1.5 * 1024 * 1024 / opener.length)) + '</section>';
    const request = req('/api/upload', {
      method: 'POST', token: owner.token, body: { slug: `linear-${kind}`, version: 1, html },
    });
    const start = process.cpuUsage();
    const response = await worker.fetch(request, env, {});
    const cpu = process.cpuUsage(start);
    const elapsedMs = (cpu.user + cpu.system) / 1000;
    assert.equal(response.status, 200, `${kind} upload: ${await response.text()}`);
    assert.ok(elapsedMs < 200, `${kind} upload took ${elapsedMs.toFixed(1)} ms CPU for 1.5 MB`);
    console.log(`  ✓ ${kind}: 1.5 MB uploaded in ${elapsedMs.toFixed(1)} ms CPU`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
