// A feedback space takes replies, not versions: an agent's fix lands on the app.
// A version published to one would replace the page behind "Open as a document"
// and the list's title, with nobody asked. For everyone, not only dev mode.
//   - refused: /api/upload with any token (an account's, the provider's), every
//     MCP tool that publishes (update_doc, edit_doc, create_upload, commit_upload),
//     propose_edits, a token's rename or preview card, and tdoc AI's suggestions
//     and accepting them. What people see does not change.
//   - not touched: creating a space, comments, replies, an agent's reply,
//     handing a comment to an agent, a person's save or rename in the browser, a
//     duplicate (a doc of its own), publishing to any other doc.
// Run with: node test/feedback-space-no-versions.test.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');

const HTML = (t) => `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1><p>Words.</p></body></html>`;
const O = { Origin: 'https://tdoc.dev' };
const ORIGIN = 'https://app.example.com';
const ERROR = 'feedback_space_no_versions';

(async () => {
  console.log('Feedback space: replies, not versions');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_REMOTE_MCP: '1', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test', TDOC_DATA_MIRROR_KEY: 'test-secret' });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, { waitUntil() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const julie = await issue(worker, env, 'julie');
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: O, body: { origin: ORIGIN } })).body;
  const anchor = { kind: 'product', url: `${ORIGIN}/me`, selector: '#x', tag: 'p', text: 'Something.' };
  const before = async () => ({
    meta: await env.META.get(`meta:${space.slug}`),
    page: (await call(`/d/${space.slug}/raw`, { cookie: julie.cookie })).text,
  });
  const unchanged = async (was) => {
    const now = await before();
    assert.equal(now.meta, was.meta, 'the space\'s record changed');
    assert.equal(now.page, was.page, 'the page behind the space changed');
    assert.equal(JSON.parse(now.meta).versions.length, 1);
  };
  const mcp = async (name, args) => {
    const r = await call('/mcp', { method: 'POST', token: julie.token, headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    const body = r.body || JSON.parse(/data: (.*)/.exec(r.text)[1]);
    const result = body.result;
    return { result, text: JSON.stringify(result) };
  };

  await t('creation makes a space, as ever', async () => {
    assert.ok(space.slug);
    const meta = JSON.parse(await env.META.get(`meta:${space.slug}`));
    assert.equal(meta.created_from, 'feedback');
    assert.equal(meta.versions.length, 1);
    const site = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: ['https://other.example.com'] } });
    assert.ok(site.status === 200 || site.status === 201, site.text);
    assert.ok(site.body.slug, site.text);
    assert.equal(JSON.parse(await env.META.get(`meta:${site.body.slug}`)).created_from, 'feedback');
  });

  await t('/api/upload refuses an agent\'s version, with a code and a message; the space is untouched', async () => {
    const was = await before();
    const r = await call('/api/upload', { method: 'POST', token: julie.token, headers: { 'X-Tdoc-Agent': 'local/mac/mac_claude' }, body: { slug: space.slug, version: 2, html: HTML('Replaced'), meta: { title: 'Replaced' } } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, ERROR);
    assert.match(r.body.message, /takes replies, not versions/);
    await unchanged(was);
  });

  await t('the same version number, or a provider token: refused too', async () => {
    const was = await before();
    const same = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: space.slug, version: 1, html: HTML('Replaced') } });
    assert.equal(same.status, 409, same.text);
    assert.equal(same.body.error, ERROR);
    env.TDOC_UPLOAD_TOKEN = 'provider-token';
    const admin = await call('/api/upload', { method: 'POST', token: 'provider-token', body: { slug: space.slug, version: 1, html: HTML('Replaced'), replace: true } });
    delete env.TDOC_UPLOAD_TOKEN;
    assert.equal(admin.status, 409, admin.text);
    assert.equal(admin.body.error, ERROR);
    await unchanged(was);
  });

  await t('someone with no write access still hears what they heard before', async () => {
    const other = await issue(worker, env, 'other');
    const r = await call('/api/upload', { method: 'POST', token: other.token, body: { slug: space.slug, version: 2, html: HTML('Replaced') } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.error, 'not_doc_owner', r.text);
  });

  await t('MCP update_doc and edit_doc refuse, and say what to do instead', async () => {
    const was = await before();
    for (const [name, args] of [
      ['update_doc', { slug: space.slug, html: HTML('Replaced') }],
      ['edit_doc', { slug: space.slug, edits: [{ find: 'Product feedback left on', replace: 'Replaced' }] }],
    ]) {
      const { result, text } = await mcp(name, args);
      assert.equal(result.isError, true, `${name}: ${text}`);
      assert.match(text, new RegExp(ERROR), `${name}: ${text}`);
      assert.match(text, /takes replies, not versions/, `${name}: ${text}`);
      assert.match(text, /reply_to_comment/, `${name}: ${text}`);
      assert.match(text, /status applied/, `${name}: ${text}`);
    }
    await unchanged(was);
  });

  await t('MCP create_upload to a space refuses before anything is sent', async () => {
    const was = await before();
    const { result, text } = await mcp('create_upload', { slug: space.slug, files: [{ name: 'index.html', size: 10, type: 'text/html' }] });
    assert.equal(result.isError, true, text);
    assert.match(text, new RegExp(ERROR), text);
    await unchanged(was);
  });

  await t('MCP commit_upload refuses at the end too', async () => {
    // An upload started on a doc that is a space by the time it commits.
    await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'late-space', version: 1, html: HTML('One'), meta: { title: 'One' } } });
    const body = HTML('Replaced');
    const made = await mcp('create_upload', { slug: 'late-space', files: [{ name: 'index.html', size: body.length, type: 'text/html' }] });
    assert.notEqual(made.result.isError, true, made.text);
    const url = /https:\/\/tdoc\.dev\/[^\s"\\]+/.exec(made.text);
    assert.ok(url, made.text);
    const put = await worker.fetch(new Request(url[0], { method: 'PUT', body, headers: { 'content-length': String(body.length) } }), env, { waitUntil() {} });
    assert.ok(put.ok, `PUT ${put.status}`);
    const meta = JSON.parse(await env.META.get('meta:late-space'));
    await env.META.put('meta:late-space', JSON.stringify({ ...meta, created_from: 'feedback', feedback: { origin: 'https://late.example.com' } }));
    const { result, text } = await mcp('commit_upload', { upload_id: made.result.structuredContent.upload_id });
    assert.equal(result.isError, true, text);
    assert.match(text, new RegExp(ERROR), text);
    assert.equal(JSON.parse(await env.META.get('meta:late-space')).versions.length, 1);
  });

  await t('a token cannot rename a space or change its card; a person can rename it', async () => {
    const was = await before();
    const byToken = await call('/api/doc/title', { method: 'PATCH', token: julie.token, body: { slug: space.slug, title: 'Replaced' } });
    assert.equal(byToken.status, 409, byToken.text);
    assert.equal(byToken.body.error, ERROR);
    const card = await call(`/api/docs/${space.slug}/preview`, { method: 'POST', token: julie.token, body: { preview_png: 'x' } });
    assert.equal(card.status, 409, card.text);
    assert.equal(card.body.error, ERROR);
    await unchanged(was);
    const byPerson = await call('/api/doc/title', { method: 'PATCH', cookie: julie.cookie, headers: O, body: { slug: space.slug, title: 'Renamed by a person' } });
    assert.equal(byPerson.status, 200, byPerson.text);
    assert.equal(JSON.parse(await env.META.get(`meta:${space.slug}`)).title, 'Renamed by a person');
    await call('/api/doc/title', { method: 'PATCH', cookie: julie.cookie, headers: O, body: { slug: space.slug, title: JSON.parse(was.meta).title } });
  });

  await t('dev mode finds no suggestion path on a space: no canSuggest, no reply_as, no tdoc AI edit, no accept', async () => {
    env.TDOC_PREVIEW = '1';
    try {
      const page = await call(`/d/${space.slug}/v/1?doc=1`, { cookie: julie.cookie });
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /canSuggest\W+true/, 'the document page of a space offers suggestions');
      const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'For reply_as', anchor } });
      await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'mac', clis: ['claude'] } });
      const handed = await call('/api/notify/handoff', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: space.slug, comment_ids: [c.body.id], reply_as: 'suggestions', recipient: { provider: 'local', server_id: 'mac', agent_sub: 'mac_claude' } } });
      assert.equal(handed.status, 200, handed.text);
      assert.equal(JSON.parse(await env.META.get(`handoffs:${space.slug}`)).some((h) => h.reply_as), false, 'a handoff asks for suggestions on a space');
      const ai = await call(`/api/docs/${space.slug}/suggest`, { method: 'POST', cookie: julie.cookie, headers: O, body: { instruction: 'x' } });
      assert.equal(ai.status, 409, ai.text);
      assert.equal(ai.body.error, ERROR);
      const accept = await call(`/api/docs/${space.slug}/suggestions/s_x/accept`, { method: 'POST', cookie: julie.cookie, headers: O, body: {} });
      assert.equal(accept.status, 409, accept.text);
      assert.equal(accept.body.error, ERROR);
      // A plain doc in the same mode still can.
      await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'still-suggests', version: 1, html: HTML('One'), meta: { title: 'One' } } });
      const plain = await call('/d/still-suggests', { cookie: julie.cookie });
      assert.match(plain.text, /canSuggest\W+true/);
    } finally { delete env.TDOC_PREVIEW; }
  });

  await t('an answer-only question on a space hears the answer lock, not "fix the site"', async () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'worker/worker.js'), 'utf8'),
      /answerLockRefusal\(env, auth\.actor, slug\) : null;\s*if \(answering\) return answering;\s*const spaceRefusal/);
  });

  await t('propose_edits refuses: there is no review on a space', async () => {
    const was = await before();
    // A route only dev mode (or a preview) can reach; for it the refusal is the same.
    env.TDOC_PREVIEW = '1';
    const r = await call(`/api/docs/${space.slug}/suggestions`, { method: 'POST', token: julie.token, body: { edits: [{ find: 'Product feedback', replace: 'Replaced' }] } });
    delete env.TDOC_PREVIEW;
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, ERROR);
    await unchanged(was);
  });

  let threadId = null;
  await t('comments, replies and an agent\'s reply all still work', async () => {
    const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'The chart is empty', anchor } });
    assert.equal(c.status, 200, c.text);
    threadId = c.body.id;
    const reply = await call('/api/comments', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: space.slug, version: 1, text: 'Which chart?', parent_id: threadId } });
    assert.equal(reply.status, 200, reply.text);
    await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'mac', clis: ['claude'] } });
    const handed = await call('/api/notify/handoff', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: space.slug, comment_ids: [threadId], recipient: { provider: 'local', server_id: 'mac', agent_sub: 'mac_claude' } } });
    assert.equal(handed.status, 200, handed.text);
    // The agent fixed the app and says so: applied, with no version in sight.
    const answered = await call('/api/agent/reply', { method: 'POST', token: julie.token, body: { slug: space.slug, parent_id: threadId, text: 'Fixed on the site.', status: 'applied', agent_login: 'claude', agent_name: 'claude' } });
    assert.equal(answered.status, 200, answered.text);
    const list = await call(`/api/comments?slug=${space.slug}`, { cookie: julie.cookie });
    const thread = (list.body.comments || list.body).find((x) => x.id === threadId);
    assert.equal(thread.replies.length, 2);
    assert.equal(thread.replies[1].agent_status, 'applied');
    assert.equal(thread.status, 'applied');
  });

  await t('MCP reply_to_comment still works on a space', async () => {
    const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'Another', anchor } });
    const { result, text } = await mcp('reply_to_comment', { slug: space.slug, comment_id: c.body.id, text: 'On it.', status: 'answered' });
    assert.notEqual(result.isError, true, text);
  });

  await t('a person\'s save in the browser editor (Open as a document) still works', async () => {
    const r = await call('/api/doc/versions', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: space.slug, baseVersion: 1, html: HTML('Saved by a person') } });
    assert.equal(r.status, 200, r.text);
    const meta = JSON.parse(await env.META.get(`meta:${space.slug}`));
    assert.equal(meta.versions.at(-1).source, 'browser');
    assert.equal(meta.created_from, 'feedback', 'it stopped being a space');
  });

  await t('any other doc publishes as ever, a duplicate of a space included', async () => {
    const first = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'plain-doc', version: 1, html: HTML('One'), meta: { title: 'One' } } });
    assert.equal(first.status, 200, first.text);
    const next = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'plain-doc', version: 2, html: HTML('Two'), meta: { title: 'Two' } } });
    assert.equal(next.status, 200, next.text);
    const copy = await call('/api/doc/duplicate', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: space.slug, version: 1 } });
    assert.equal(copy.status, 200, copy.text);
    assert.notEqual(JSON.parse(await env.META.get(`meta:${copy.body.slug}`)).created_from, 'feedback');
    const onCopy = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: copy.body.slug, version: 2, html: HTML('Copy v2') } });
    assert.equal(onCopy.status, 200, onCopy.text);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
