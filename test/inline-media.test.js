// Video/audio pasted into a doc as base64 is refused at publish and browser
// save, with a message that says to link it instead (Julie, 2026-10-08).
// Images and small clips stay allowed.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const owner = await issue(worker, env, 'owner');
  const call = async (path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const b64 = (n) => 'A'.repeat(n);
  const doc = (inner) => `<!doctype html><html><head><title>x</title></head><body><p>Hello</p>${inner}</body></html>`;
  console.log('inline media');

  await t('a doc with a large base64 video is refused, with how to fix it', async () => {
    const html = doc(`<video controls src="data:video/mp4;base64,${b64(400 * 1024)}"></video>`);
    const r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'vid', version: 1, html } });
    assert(r.status === 413 && r.body.error === 'inline_media_too_large', `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert(/preload="none"/.test(r.body.message) && /link it/.test(r.body.message), r.body.message);
  });

  await t('several small clips that add up past the limit are refused too', async () => {
    const clip = `<audio src="data:audio/mpeg;base64,${b64(80 * 1024)}"></audio>`;
    const r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'aud', version: 1, html: doc(clip.repeat(3)) } });
    assert(r.status === 413, `status ${r.status}`);
  });

  await t('linked video, inline images and one short clip still publish', async () => {
    const html = doc(`<video src="https://cdn.example.com/a.mp4" preload="none" poster="https://cdn.example.com/a.jpg" controls></video>`
      + `<img src="data:image/png;base64,${b64(600 * 1024)}">`
      + `<audio src="data:audio/mpeg;base64,${b64(50 * 1024)}"></audio>`);
    const r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'ok', version: 1, html } });
    assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
