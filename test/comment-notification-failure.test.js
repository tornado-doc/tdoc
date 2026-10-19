// A comment is the primary write. Its in-app notification is best effort: a
// Workers KV failure after the Durable Object commit must not return HTTP 500
// for words that were already saved.
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('comment notification failure isolation');

  await t('an inbox KV failure cannot turn a saved comment into HTTP 500', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'inbox-failure-doc';
    await env.META.put(`meta:${slug}`, JSON.stringify({
      slug,
      title: 'Inbox failure doc',
      github_login: 'alice',
      versions: [{ n: 1, created: '2026-10-18T00:00:00Z' }],
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Inbox failure doc</h1>');
    const cookie = await putSession(env, 'bob');
    env.META.failPutOnce.add('inbox:alice');

    const response = await worker.fetch(req('/api/comments', {
      method: 'POST',
      cookie,
      body: { slug, version: 1, text: 'This must survive the notification failure.', anchor: null },
    }), env, {});
    assert(response.status === 200, `expected 200, got ${response.status}: ${await response.text()}`);

    const read = await worker.fetch(req(`/api/comments?slug=${slug}&version=1`), env, {});
    assert(read.status === 200, `read-back failed with ${read.status}`);
    const comments = await read.json();
    assert(comments.length === 1 && comments[0].text === 'This must survive the notification failure.',
      `saved comment missing: ${JSON.stringify(comments)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
