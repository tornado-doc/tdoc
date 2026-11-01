// Notification email (#772): a mention, a reply, a comment on your doc or an
// access request reaches your inbox, not only the bell. Stingy by design --
// one email per thread per cooldown, a daily cap, the permanent opt-out and
// a per-person switch -- because the sending domain's reputation is shared.
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

function mailEnv(mod, extra = {}) {
  const sent = [];
  const env = makeEnv(mod.CommentsStore, { EMAIL: { send: async (msg) => { sent.push(msg); } }, ...extra });
  return { env, sent };
}

async function seedDoc(env, slug, owner) {
  await env.META.put(`meta:${slug}`, JSON.stringify({
    slug, title: 'Launch plan', hosted: { github_login: owner }, versions: [{ n: 1, created: '2026-10-19T00:00:00Z' }],
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Launch plan</h1>');
  await env.META.put(`hosted-account:${owner}`, JSON.stringify({ account_id: `acct_${owner}`, github_login: owner, email: `${owner}@example.com` }));
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('notification email');

  const comment = (env, cookie, slug, text, extra = {}) => worker.fetch(req('/api/comments', {
    method: 'POST', cookie, body: { slug, version: 1, text, anchor: null, ...extra },
  }), env, {});

  await t('a comment on your doc emails you what the bell says, with a link to the comment', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'launch', 'alice');
    const r = await comment(env, await putSession(env, 'bob'), 'launch', 'Can we ship Friday?');
    assert(r.status === 200, `comment ${r.status}`);
    assert(sent.length === 1, `expected one email, got ${sent.length}`);
    const mail = sent[0];
    assert(mail.to === 'alice@example.com', mail.to);
    assert(mail.subject === 'bob commented on Launch plan', mail.subject);
    assert(mail.text.includes('> Can we ship Friday?'), mail.text);
    assert(/Open it: https:\/\/tdoc\.dev\/d\/launch\/v\/1\?comment=c_/.test(mail.text), mail.text);
    assert(mail.from.email === 'notifications@tdoc.dev', mail.from.email);
    assert(/\/email\/optout\?t=[a-f0-9]{32}/.test(mail.text), 'no unsubscribe link');
  });

  await t('an @email mention reaches that address, and never the person who wrote it', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'plan', 'carol');
    await comment(env, await putSession(env, 'carol'), 'plan', '@julie@example.com can you check this?');
    assert(sent.length === 1, `emails: ${JSON.stringify(sent.map((m) => m.to))}`);
    assert(sent[0].to === 'julie@example.com' && sent[0].subject === 'carol mentioned you on Launch plan', `${sent[0].to} / ${sent[0].subject}`);
  });

  await t('a busy thread is one email, not one per comment', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'busy', 'alice');
    const bob = await putSession(env, 'bob');
    for (const text of ['one', 'two', 'three']) await comment(env, bob, 'busy', text);
    assert(sent.length === 1, `expected 1 email, got ${sent.length}`);
  });

  await t('the HTML body escapes what a commenter typed', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'xss', 'alice');
    await comment(env, await putSession(env, 'bob'), 'xss', '<img src=x onerror=alert(1)>');
    assert(sent.length === 1, 'no email');
    assert(!sent[0].html.includes('<img'), 'raw HTML from a comment reached the email');
    assert(sent[0].html.includes('&lt;img'), 'comment text missing from the HTML body');
  });

  await t('turning email off in Notifications stops it; the server says whether email exists at all', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'quiet', 'alice');
    const alice = await putSession(env, 'alice');
    const before = await (await worker.fetch(req('/api/notifications/email', { cookie: alice }), env, {})).json();
    assert(before.available === true && before.on === true, JSON.stringify(before));
    const off = await (await worker.fetch(req('/api/notifications/email', { method: 'POST', cookie: alice, body: { on: false } }), env, {})).json();
    assert(off.on === false, JSON.stringify(off));
    await comment(env, await putSession(env, 'bob'), 'quiet', 'hello');
    assert(sent.length === 0, 'emailed after turning it off');
    const on = await (await worker.fetch(req('/api/notifications/email', { method: 'POST', cookie: alice, body: { on: true } }), env, {})).json();
    assert(on.on === true, JSON.stringify(on));
    const anon = await worker.fetch(req('/api/notifications/email'), env, {});
    assert(anon.status === 401, `anonymous ${anon.status}`);
  });

  await t('the unsubscribe link in an email silences every later one', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'optout', 'alice');
    const bob = await putSession(env, 'bob');
    await comment(env, bob, 'optout', 'first');
    const link = /\/email\/optout\?t=([a-f0-9]+)/.exec(sent[0].text);
    const page = await worker.fetch(req(`/email/optout?t=${link[1]}`), env, {});
    assert((await page.text()).includes('You are unsubscribed'), 'opt-out page did not confirm');
    await env.META.delete('notify-email-sent:alice@example.com:comment:optout');
    await comment(env, bob, 'optout', 'second');
    assert(sent.length === 1, 'emailed after unsubscribing');
  });

  await t('reactions never email', async () => {
    const { env, sent } = mailEnv(mod);
    await seedDoc(env, 'react', 'alice');
    const alice = await putSession(env, 'alice');
    const r = await comment(env, alice, 'react', 'my own note');
    const { id } = await r.json();
    await worker.fetch(req('/api/reactions', { method: 'POST', cookie: await putSession(env, 'bob'), body: { slug: 'react', version: 1, comment_id: id, emoji: '👍' } }), env, {});
    const inbox = JSON.parse(await env.META.get('inbox:alice') || '{"items":[]}');
    assert(inbox.items.some((i) => i.kind === 'reaction'), 'the reaction never reached the inbox, so this proves nothing');
    assert(sent.length === 0, `emails: ${sent.map((m) => m.subject).join(' | ')}`);
  });

  await t('no sender configured: no email, no error, and the switch is hidden', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'nomail', 'alice');
    const r = await comment(env, await putSession(env, 'bob'), 'nomail', 'hello');
    assert(r.status === 200, `comment ${r.status}`);
    const pref = await (await worker.fetch(req('/api/notifications/email', { cookie: await putSession(env, 'alice') }), env, {})).json();
    assert(pref.available === false, JSON.stringify(pref));
  });

  await t('a failing mail provider never fails the comment', async () => {
    const env = makeEnv(mod.CommentsStore, { EMAIL: { send: async () => { throw new Error('provider down'); } } });
    await seedDoc(env, 'down', 'alice');
    const r = await comment(env, await putSession(env, 'bob'), 'down', 'still saved');
    assert(r.status === 200, `comment ${r.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
