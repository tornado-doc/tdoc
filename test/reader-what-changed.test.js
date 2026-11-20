// See what changed, for a reader who may not list the history.
//   - history_visibility (owner by default) hides the LIST of versions, not
//     an earlier version: a reader with the link already opens /v/1. So the
//     boot tells any reader of the doc they may see what changed
//     (changesVisible), and the history endpoints stay closed to them.
//   - the compare is two /frame pages; both are behind the read gate, so a
//     viewer who may not read a private doc gets neither (and no boot).
//   - an agent's applied reply carries the version it changed (applied_in),
//     which the reply's "See changes" opens.
// Run with: node test/reader-what-changed.test.js
const assert = require('assert/strict');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');

const page = (line) => `<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1><p>${line}</p></body></html>`;

(async () => {
  console.log('Reader: see what changed');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, { waitUntil() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const frame = (slug, n, cookie) => call(`/d/${slug}/v/${n}/frame?tdoc_compare=1`, { cookie, headers: { 'Sec-Fetch-Dest': 'iframe' } });
  const owner = await issue(worker, env, 'julie');
  const reader = await issue(worker, env, 'reader');
  const stranger = await issue(worker, env, 'stranger');

  const publish = async (slug, access) => {
    for (const [n, line] of [[1, 'The trial lasts 7 days.'], [2, 'The trial lasts 14 days.']]) {
      const r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug, version: n, html: page(line), meta: { title: 'Plan', ...(access ? { access } : {}) } } });
      assert.equal(r.status, 200, r.text);
    }
  };

  const linkDoc = 'reader-changes-link';
  await publish(linkDoc, null);

  await t('a link doc whose history is the owner\'s: a reader may see what changed, not list the history', async () => {
    const m = JSON.parse(env.META.map.get(`meta:${linkDoc}`));
    assert.equal(m.access.history_visibility, 'owner');
    for (const cookie of [reader.cookie, undefined]) {
      const html = (await call(`/d/${linkDoc}/v/2`, { cookie })).text;
      assert.match(html, /"historyVisible":false/);
      assert.match(html, /"changesVisible":true/);
      assert.equal((await call(`/api/docs/${linkDoc}/history`, { cookie })).status, 403);
      assert.equal((await call(`/api/docs/${linkDoc}/history/summaries?rows=2-2`, { cookie })).status, 403);
    }
  });

  await t('the compare\'s two frames open for that reader: the earlier version is one they could already open', async () => {
    const before = await frame(linkDoc, 1, reader.cookie);
    const after = await frame(linkDoc, 2, reader.cookie);
    assert.equal(before.status, 200);
    assert.equal(after.status, 200);
    assert.match(before.text, /7 days/);
    assert.match(after.text, /14 days/);
    // The same version opens as a page for them: nothing new is exposed.
    assert.equal((await call(`/d/${linkDoc}/v/1`, { cookie: reader.cookie })).status, 200);
  });

  const privateDoc = 'reader-changes-private';
  await publish(privateDoc, { visibility: 'private', history_visibility: 'owner', commenting: 'invited', allowed_users: ['reader'] });

  await t('a private doc: an invited reader may see what changed; a stranger and a signed-out visitor get no frame and no boot', async () => {
    assert.match((await call(`/d/${privateDoc}/v/2`, { cookie: reader.cookie })).text, /"changesVisible":true/);
    assert.equal((await frame(privateDoc, 1, reader.cookie)).status, 200);
    for (const cookie of [stranger.cookie, undefined]) {
      const pageRes = await call(`/d/${privateDoc}/v/2`, { cookie });
      assert.notEqual(pageRes.status, 200);
      assert.doesNotMatch(pageRes.text, /changesVisible|14 days/);
      for (const n of [1, 2]) {
        const f = await frame(privateDoc, n, cookie);
        assert.notEqual(f.status, 200, `frame v${n} ${f.status}`);
        assert.doesNotMatch(f.text, /7 days|14 days/);
      }
      assert.notEqual((await call(`/api/docs/${privateDoc}/history`, { cookie })).status, 200);
    }
  });

  await t('the owner still lists the history (and may see what changed)', async () => {
    const html = (await call(`/d/${linkDoc}/v/2`, { cookie: owner.cookie })).text;
    assert.match(html, /"historyVisible":true/);
    assert.match(html, /"changesVisible":true/);
  });

  await t('an agent reply that applied the comment says in which version: applied_in on the reply', async () => {
    const slug = 'reader-changes-reply';
    let r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug, version: 1, html: page('The trial lasts 7 days.'), meta: { title: 'Plan' } } });
    assert.equal(r.status, 200, r.text);
    const c = await call('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug, version: 1, text: 'Make it 14 days', anchor: { kind: 'text', text: 'The trial lasts 7 days.' } } });
    assert.equal(c.status, 200, c.text);
    r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug, version: 2, html: page('The trial lasts 14 days.'), meta: { title: 'Plan' } } });
    assert.equal(r.status, 200, r.text);
    const posted = await call('/api/agent/reply', { method: 'POST', token: owner.token, body: { slug, parent_id: c.body.id, text: 'Changed to 14 days.', status: 'applied', applied_in: 2 } });
    assert.equal(posted.status, 200, posted.text);
    const list = await call(`/api/comments?slug=${slug}&version=2`, { cookie: reader.cookie });
    const thread = (list.body.comments || list.body).find((x) => x.id === c.body.id);
    const answer = thread.replies.find((x) => x.text === 'Changed to 14 days.');
    assert.equal(answer.agent_status, 'applied');
    assert.equal(answer.applied_in, 2);
    // A reply that is not an "applied" one names no version.
    const q = await call('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug, version: 2, text: 'And the price?', anchor: { kind: 'text', text: 'The trial lasts 14 days.' } } });
    await call('/api/agent/reply', { method: 'POST', token: owner.token, body: { slug, parent_id: q.body.id, text: 'Which price?', status: 'question' } });
    const again = await call(`/api/comments?slug=${slug}&version=2`, { cookie: reader.cookie });
    const asked = (again.body.comments || again.body).find((x) => x.id === q.body.id);
    assert.equal(asked.replies[0].applied_in, null);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
