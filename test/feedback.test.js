// Product feedback (#564): the feedback token door, the space a connect
// creates, and the two ways in (bookmarklet page, one-line install).
//
// Driven through the in-process worker: a cookie session connects from an
// app origin, gets a token, and that token — with no cookie — reads and
// writes the comments of exactly one doc.
// Run with: node test/feedback.test.js

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ROOT = path.join(__dirname, '..');
const APP = 'http://localhost:3000';

(async () => {
  console.log('product feedback: token door, space, entry points');
  const mod = await loadWorker();
  const worker = mod.default;

  async function connect(env, cookie, body = {}) {
    const r = await worker.fetch(req('/api/feedback/connect', { method: 'POST', cookie, body: { origin: APP, ...body } }), env, {});
    return { status: r.status, body: await r.json() };
  }

  await t('connect needs a signed-in cookie and a real browser origin', async () => {
    const env = makeEnv(mod.CommentsStore);
    const anon = await worker.fetch(req('/api/feedback/connect', { method: 'POST', body: { origin: APP } }), env, {});
    assert(anon.status === 401, `anonymous connect: ${anon.status}`);
    const cookie = await putSession(env, 'julie');
    for (const origin of ['localhost:3000', 'http://localhost:3000/dashboard', 'file:///tmp', 'javascript:1']) {
      const r = await connect(env, cookie, { origin });
      assert(r.status === 400 && r.body.error === 'invalid_origin', `${origin}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  await t('first connect creates an unlisted, sign-in-to-comment space named after the app', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const r = await connect(env, cookie);
    assert(r.status === 200, `connect: ${r.status} ${JSON.stringify(r.body)}`);
    assert(/^fb_[a-f0-9]{48}$/.test(r.body.token), `token shape ${r.body.token}`);
    assert(r.body.version === 1 && r.body.doc_url === `https://tdoc.dev/d/${r.body.slug}/v/1`, 'doc_url/version');
    assert(r.body.identity.login === 'julie', 'identity is the cookie session');
    assert(r.body.is_owner === true, 'the creator owns the space');
    const meta = JSON.parse(await env.META.get(`meta:${r.body.slug}`));
    assert(meta.title === 'Feedback · localhost:3000', `title ${meta.title}`);
    assert(meta.created_from === 'feedback' && meta.feedback.origin === APP, 'meta names the app');
    assert(meta.access.visibility === 'unlisted' && meta.access.commenting === 'signed_in', `access ${JSON.stringify(meta.access)}`);
    assert(meta.hosted && meta.hosted.github_login === 'julie', 'hosted ownership stamped');
    const html = await (await env.DOCS.get(`docs/${r.body.slug}/v1/index.html`)).text();
    assert(html.includes('Feedback · localhost:3000') && html.includes('/feedback.js'), 'space doc explains itself');

    // Feedback spaces stay off My docs — share is from the app float.
    const me = await worker.fetch(req('/me', { cookie }), env, {});
    assert(me.status === 200, `/me: ${me.status}`);
    const boot = /window\.__TDOC_APP_BOOT__\s*=\s*(\{[\s\S]*?\});/.exec(await me.text());
    assert(boot, '/me boot missing');
    const data = JSON.parse(boot[1]);
    assert(Array.isArray(data.docs) && !data.docs.some((d) => d.slug === r.body.slug), 'feedback space listed in My docs');
  });

  await t('the same person connecting the same app again reuses the space; another app gets its own', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const a = await connect(env, cookie);
    const b = await connect(env, cookie);
    assert(a.body.slug === b.body.slug, 'space was not reused');
    assert(a.body.token !== b.body.token, 'a connect mints a fresh token');
    const other = await connect(env, cookie, { origin: 'http://localhost:5173' });
    assert(other.body.slug !== a.body.slug, 'different app shares a space');
  });

  await t('a deleted space is recreated rather than pointed at', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const a = await connect(env, cookie);
    await env.META.delete(`meta:${a.body.slug}`);
    const b = await connect(env, cookie);
    assert(b.status === 200 && b.body.slug !== a.body.slug, 'dangling index was followed');
  });

  await t('"use an existing doc" needs a doc this person may comment on', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    await env.META.put('meta:private-plan', JSON.stringify({
      title: 'Plan', versions: [{ n: 1 }], hosted: { github_login: 'bob' },
      access: { visibility: 'private', commenting: 'invited', allowed_users: [] },
    }));
    await env.DOCS.put('docs/private-plan/v1/index.html', '<h1>plan</h1>');
    const denied = await connect(env, cookie, { slug: 'private-plan' });
    assert(denied.status === 403, `stranger got ${denied.status}`);
    await env.META.put('meta:open-plan', JSON.stringify({
      title: 'Open', versions: [{ n: 1 }, { n: 2 }], hosted: { github_login: 'bob' },
      access: { visibility: 'unlisted', commenting: 'signed_in' },
    }));
    const okr = await connect(env, cookie, { slug: 'open-plan' });
    assert(okr.status === 200 && okr.body.slug === 'open-plan' && okr.body.version === 2, `existing doc: ${okr.status} ${JSON.stringify(okr.body)}`);
    // And it is now what this app connects to.
    const again = await connect(env, cookie);
    assert(again.body.slug === 'open-plan', 'choice was not remembered for the app');
  });

  await t('the token, with no cookie, reads and writes that doc\'s comments as the person', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const { body: session } = await connect(env, cookie);
    const token = session.token;
    const me = await worker.fetch(req('/api/feedback/session', { token }), env, {});
    const meBody = await me.json();
    assert(me.status === 200 && meBody.slug === session.slug && meBody.can_comment === true, `session: ${me.status} ${JSON.stringify(meBody)}`);
    const anchor = { kind: 'product', url: `${APP}/dashboard`, selector: '#invite', tag: 'button', text: 'Send invite' };
    const post = await worker.fetch(req('/api/comments', { method: 'POST', token, body: { slug: session.slug, version: 1, text: 'Button does nothing', anchor } }), env, {});
    assert(post.status === 200, `post: ${post.status} ${await post.text()}`);
    const list = await worker.fetch(req(`/api/comments?slug=${session.slug}&version=1`, { token }), env, {});
    const comments = await list.json();
    assert(list.status === 200 && comments.length === 1, `list: ${list.status} ${JSON.stringify(comments)}`);
    assert(comments[0].author.login === 'julie', 'not attributed to the session');
    assert(comments[0].anchor.kind === 'product' && comments[0].anchor.selector === '#invite', 'product anchor lost');
    const mentions = await worker.fetch(req(`/api/mentions?slug=${session.slug}`, { token }), env, {});
    const mBody = await mentions.json();
    assert(mentions.status === 200 && mBody.identity.login === 'julie' && mBody.is_owner === true, `mentions: ${mentions.status} ${JSON.stringify(mBody)}`);
    const react = await worker.fetch(req('/api/reactions', { method: 'POST', token, body: { slug: session.slug, version: 1, comment_id: comments[0].id, emoji: '👍' } }), env, {});
    assert(react.status === 200, `react: ${react.status}`);
    const resolve = await worker.fetch(req('/api/comments', { method: 'PATCH', token, body: { slug: session.slug, version: 1, id: comments[0].id, resolved: true } }), env, {});
    assert(resolve.status === 200, `resolve: ${resolve.status} ${await resolve.text()}`);
  });

  await t('the token opens one doc and nothing else', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const { body: session } = await connect(env, cookie);
    const { body: other } = await connect(env, cookie, { origin: 'http://localhost:5173' });
    const token = session.token;
    const cross = await worker.fetch(req(`/api/comments?slug=${other.slug}&version=1`, { token }), env, {});
    assert(cross.status === 403 && (await cross.json()).error === 'feedback_token_scope', `other doc read: ${cross.status}`);
    const crossPost = await worker.fetch(req('/api/comments', { method: 'POST', token, body: { slug: other.slug, version: 1, text: 'nope' } }), env, {});
    assert(crossPost.status === 403, `other doc write: ${crossPost.status}`);
    const crossMentions = await worker.fetch(req(`/api/mentions?slug=${other.slug}`, { token }), env, {});
    assert(crossMentions.status === 403, `other doc mentions: ${crossMentions.status}`);
    // Not a general credential: the account's own routes stay shut.
    for (const [pathname, method, body] of [
      ['/api/doc/create', 'POST', {}],
      ['/api/doc/access', 'PATCH', { slug: session.slug, access: { visibility: 'public' } }],
      [`/api/doc?slug=${session.slug}`, 'DELETE', null],
      ['/api/hosted/token', 'POST', { label: 'x' }],
      ['/api/feedback/connect', 'POST', { origin: APP }],
      ['/me', 'GET', null],
    ]) {
      const r = await worker.fetch(req(pathname, { method, token, body }), env, {});
      assert(r.status === 403, `${method} ${pathname} with a feedback token: ${r.status}`);
    }
  });

  await t('a token nobody minted, or whose session is gone, is anonymous', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'julie');
    const { body: session } = await connect(env, cookie);
    const fake = `fb_${'0'.repeat(48)}`;
    const r = await worker.fetch(req('/api/feedback/session', { token: fake }), env, {});
    assert(r.status === 401, `unknown token: ${r.status}`);
    // The session behind the token signed out.
    const sid = cookie.split('=')[1];
    await env.META.delete(`session:${sid}`);
    const gone = await worker.fetch(req('/api/feedback/session', { token: session.token }), env, {});
    assert(gone.status === 401, `dead session: ${gone.status}`);
  });

  await t('/feedback offers the bookmarklet and the one line; /feedback/connect is the popup', async () => {
    const env = makeEnv(mod.CommentsStore);
    const page = await worker.fetch(req('/feedback'), env, {});
    const html = await page.text();
    assert(page.status === 200 && html.includes('href="javascript:') && html.includes('https://tdoc.dev/feedback.js'), 'bookmarklet missing');
    assert(html.includes('&lt;script src="https://tdoc.dev/feedback.js"&gt;'), 'one-line install missing');
    assert(/Content-Security-Policy/.test([...page.headers.keys()].join(',')) === false || page.headers.get('Content-Security-Policy').includes('nonce-'), 'page CSP is not nonced');

    const anon = await worker.fetch(req(`/feedback/connect?origin=${encodeURIComponent(APP)}`), env, {});
    const anonHtml = await anon.text();
    assert(anon.status === 200 && anonHtml.includes('Sign in') && !anonHtml.includes('id="connect"'), 'anonymous popup should ask to sign in');
    const cookie = await putSession(env, 'julie');
    const signed = await worker.fetch(req(`/feedback/connect?origin=${encodeURIComponent(APP)}`, { cookie }), env, {});
    const signedHtml = await signed.text();
    assert(signed.status === 200 && signedHtml.includes('id="connect"') && signedHtml.includes('localhost:3000'), 'signed-in popup should offer Connect');
    assert(signedHtml.includes("postMessage({ type: 'tdoc-feedback-connected'"), 'popup does not hand the token back');
    const bad = await worker.fetch(req('/feedback/connect?origin=nope'), env, {});
    assert(bad.status === 400, `bad origin: ${bad.status}`);
  });

  await t('/feedback.js is served cross-origin; the bundle is built from feedback/src', async () => {
    const env = makeEnv(mod.CommentsStore);
    const r = await worker.fetch(req('/feedback.js'), env, {});
    assert(r.status === 200 && r.headers.get('Access-Control-Allow-Origin') === '*', 'no CORS on the client');
    assert((r.headers.get('Content-Type') || '').startsWith('text/javascript'), 'wrong type');
    const built = fs.readFileSync(path.join(ROOT, 'server/runtime/feedback.js'), 'utf8');
    assert(built.includes('tdoc-feedback-root') && built.includes('tdoc-feedback-connected') && built.includes('/api/feedback/session'), 'built client is stale');
    const source = fs.readFileSync(path.join(ROOT, 'feedback/src/main.jsx'), 'utf8');
    assert(source.includes("from '../../shell/src/document/comment-card.jsx'") && source.includes("from '../../server/chrome.css?inline'"), 'client stopped sharing the shell UI');
    assert(!source.includes('chrome.runtime'), 'client still depends on a browser extension');
    const bundle = fs.readFileSync(path.join(ROOT, 'bin/tdoc-bundle'), 'utf8');
    assert(bundle.includes('__TDOC_FEEDBACK_JS__'), 'tdoc-bundle does not inline the client');
  });

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
