const assert = require('assert/strict');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
(async () => {
  const mod = await loadWorker(); const worker = mod.default;
  const call = async (env, path, options = {}) => { const r = await worker.fetch(req(path, options), env, {}); return { status: r.status, body: await r.json().catch(() => null) }; };
  const practice = (env, who) => call(env, '/api/onboarding/practice', { method: 'POST', cookie: who.cookie, headers: { Origin: 'https://tdoc.dev' }, body: { mode: 'manual', product: 'chatgpt' } });

  // A PR preview: no Durable Object, its own KV. The tutorial doc can be made.
  const preview = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_HOSTED_ACCOUNTS: '1', TDOC_PREVIEW: '1' });
  delete preview.COMMENTS;
  const owner = await issue(worker, preview, 'preview-owner'); const other = await issue(worker, preview, 'preview-other');
  const made = await practice(preview, owner);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(await preview.META.get(`preview-owner:${made.body.slug}`), owner.account_id, 'ownership lives in the preview KV');
  const comment = await call(preview, '/api/comments', { method: 'POST', cookie: owner.cookie, headers: { Origin: 'https://tdoc.dev' }, body: { slug: made.body.slug, version: 1, text: 'Make this shorter.' } });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  assert.notEqual((await practice(preview, other)).body?.slug, made.body.slug, 'another account never gets this doc');

  // Anywhere else, a missing Durable Object still refuses rather than guessing.
  const broken = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_HOSTED_ACCOUNTS: '1' });
  delete broken.COMMENTS;
  const someone = await issue(worker, broken, 'no-store');
  assert.equal((await practice(broken, someone)).status, 503);
  console.log('✓ a PR preview keeps doc ownership in its own KV; production still requires the Durable Object');
})().catch(e => { console.error(e); process.exit(1); });
