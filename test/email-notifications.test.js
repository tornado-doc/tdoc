// Notification email (#772): a mention, a reply, a comment on your doc or an
// access request reaches your inbox, not only the bell. Stingy by design --
// one email per thread per cooldown, a daily cap, the permanent opt-out and
// a per-person switch -- because the sending domain's reputation is shared.
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

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
    assert(/Open it: https:\/\/tdoc\.dev\/d\/launch\?comment=c_/.test(mail.text), mail.text);
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

  // ── mention tags in a notification, per recipient ──
  const INV = 'carol@invited.example';
  const OTHER = 'bob@other.example';
  const TEAM = 'tess@team.example';
  const TEXT = `@eve ask @${INV}, @${OTHER} (@${TEAM}) and @eve@own.example now`;
  const CUT = '@carol, @bob (@tess) and @eve now';
  // Olga's doc, with Carol invited, and a team doc; Eve reads both as anybody
  // (Mia is on the team). `sent`: the mail.
  async function tagged() {
    const { env, sent } = mailEnv(mod, { TDOC_EMAIL_ALIAS_SECRET: 'x' });
    const who = {};
    for (const login of ['olga', 'eve', 'mia']) {
      who[login] = await issue(worker, env, login);
      const key = `hosted-account:${login}`;
      await env.META.put(key, JSON.stringify({ ...JSON.parse(await env.META.get(key) || '{}'), account_id: who[login].account_id, github_login: login, email: login === 'eve' ? 'eve@own.example' : `${login}@example.com` }));
    }
    await env.META.put(`session:${'d'.repeat(32)}`, JSON.stringify({ email: 'dave@hidden.example', name: 'dave', created: '2026-01-01T00:00:00Z' }));
    who.dave = { cookie: `tdoc_sid=${'d'.repeat(32)}` };
    const api = async (path, o = {}) => { const r = await worker.fetch(req(path, o), env, {}); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: r.status, text, body }; };
    const { team } = (await api('/api/teams', { method: 'POST', cookie: who.olga.cookie, body: { name: 'T' } })).body;
    await api('/api/team/join', { method: 'POST', cookie: who.mia.cookie, body: { token: team.invite_url.split('/').pop() } });
    const teamKey = [...env.META.map.keys()].find((k) => { try { const v = JSON.parse(env.META.map.get(k)); return v && v.id === team.id && Array.isArray(v.members); } catch { return false; } });
    const rec = JSON.parse(env.META.map.get(teamKey));
    rec.members.push({ ...rec.members[1], key: `email:${TEAM}`, account_id: 'acct-tess' });
    await env.META.put(teamKey, JSON.stringify(rec), { metadata: env.META.metadata.get(teamKey) });
    const created = '2026-01-01T00:00:00Z';
    const doc = (slug, extra) => env.META.put(`meta:${slug}`, JSON.stringify({ slug, title: slug, created, versions: [{ n: 1, created }], hosted: { account_id: who.olga.account_id, github_login: 'olga' }, access: { visibility: 'public', commenting: 'signed_in', allowed_users: [INV] }, ...extra }));
    await doc('plain', {});
    await doc('teamed', { workspace_id: team.id, access: { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: [] } });
    return { env, sent, who, api, post: (slug, as, text, extra = {}) => api('/api/comments', { method: 'POST', cookie: who[as].cookie, body: { slug, version: 1, text, anchor: null, ...extra } }) };
  }
  const hosts = (text, own = '') => [...new Set(String(text).match(/[a-z]+@(?:invited|other|team|own|hidden)\.example/g) || [])].filter((x) => x !== own).sort().join(' ');
  const both = (m) => { const h = hosts(m.html); assert(hosts(m.text) === h, `text ${hosts(m.text)}, html ${h}`); assert(!hosts(m.subject + JSON.stringify(m.from) + JSON.stringify(m.headers || {})), `subject ${m.subject}`); return h; };

  await t('a comment\'s mention tags: each person\'s email reads as the doc page does for them', async () => {
    const { sent, post } = await tagged();
    const r = await post('plain', 'dave', TEXT);
    assert(r.status === 200, `comment ${r.status}`);
    const mail = (to) => { const m = sent.find((x) => x.to === to); assert(m, `no mail to ${to}: ${sent.map((x) => x.to)}`); return m; };
    assert(both(mail('olga@example.com')) === INV, `owner: ${both(mail('olga@example.com'))}`);
    assert(mail('olga@example.com').text.includes(`@${INV}, @bob (@tess) and`), mail('olga@example.com').text);
    assert(both(mail('eve@own.example')) === 'eve@own.example', `a reader: ${both(mail('eve@own.example'))}`);
    assert(mail('eve@own.example').text.includes('> @eve ask @carol, @bob (@tess) and @eve@own.example now'), mail('eve@own.example').text);
    assert(both(mail(OTHER)) === OTHER && both(mail(INV)) === INV, `by address: ${both(mail(OTHER))} / ${both(mail(INV))}`);
  });

  await t('a reply, and a team doc: the same; the bell too, stored rows included', async () => {
    const { env, sent, post, api, who } = await tagged();
    const first = (await post('plain', 'eve', 'first')).body;
    sent.length = 0;
    await post('plain', 'dave', TEXT.slice(5), { parent_id: first.id });
    const reply = sent.find((m) => m.to === 'eve@own.example' && /replied/.test(m.subject));
    assert(reply && both(reply) === 'eve@own.example', `reply: ${reply && both(reply)}`);
    sent.length = 0;
    await post('teamed', 'mia', TEXT.slice(5));
    const owner = sent.find((m) => m.to === 'olga@example.com');
    assert(owner && both(owner) === TEAM, `a team member: ${owner && both(owner)}`);
    const bell = async (as) => { const r = await api('/api/notifications', { cookie: who[as].cookie }); assert(r.status === 200, `bell ${r.status}`); return r; };
    const eve = await bell('eve');
    assert(eve.body.items.length && hosts(eve.text) === 'eve@own.example', `eve: ${hosts(eve.text)}`);
    const unread = await api('/api/notifications?filter=unread', { cookie: who.eve.cookie });
    assert(unread.body.items.length && hosts(unread.text) === 'eve@own.example', `unread: ${hosts(unread.text)}`);
    const olga = (await bell('olga')).body.items;
    assert(hosts(olga.find((i) => i.slug === 'teamed').preview) === TEAM, `olga, team doc: ${JSON.stringify(olga)}`);
    // A row as it was stored before, one of them cut to its length.
    const now = new Date().toISOString();
    const row = (id, kind, preview) => ({ id, kind, group_key: id, slug: 'plain', version: 1, comment_id: first.id, thread_id: first.id, actor: { login: 'claude', kind: 'agent', name: 'Claude' }, preview, title: 'plain', at: now, read: false, count: 1 });
    const pad = (tail) => `${'y'.repeat(299 - tail.length)} ${tail}`;
    for (const login of ['eve', 'olga']) {
      await env.META.put(`inbox:${login}`, JSON.stringify({ items: [row('n1', 'mention', TEXT), row('n2', 'agent_reply', pad('@zed@oth')), row('n3', 'agent_reply', pad(`@${OTHER}`)), row('n4', 'agent_reply', pad(`@${INV}`)), row('n5', 'agent_reply', 'short @lee@x')] }));
    }
    const at = (r, id) => r.body.items.find((i) => i.id === id).preview;
    const e = await bell('eve');
    assert(at(e, 'n1') === `@eve ask ${CUT.replace('@eve now', '@eve@own.example now')}`, at(e, 'n1'));
    assert(at(e, 'n2').endsWith(' @zed') && at(e, 'n3').endsWith(' @bob') && at(e, 'n4').endsWith(' @carol') && at(e, 'n5') === 'short @lee@x', `${at(e, 'n2').slice(-12)} ${at(e, 'n3').slice(-12)}`);
    const o = await bell('olga');
    assert(at(o, 'n1').includes(`@${INV}, @bob (@tess)`) && at(o, 'n4').endsWith(` @${INV}`) && at(o, 'n3').endsWith(' @bob'), at(o, 'n1'));
    // The doc's record cannot be read: nobody's but their own.
    const get = env.META.get;
    await bell('olga');
    env.META.get = function (k, ...a) { return k === 'meta:plain' ? Promise.reject(new Error('KV is down')) : get.call(this, k, ...a); };
    const down = await bell('olga');
    env.META.get = get;
    assert(!hosts(down.text), `unreadable doc: ${hosts(down.text)}`);
  });

  await t('what telling people costs: one read of the doc\'s team, however many are told; none without a tag', async () => {
    const { env, post, api, who } = await tagged();
    const reads = async (fn) => { const from = env.META.gets.length; const r = await fn(); assert(r.status === 200, `${r.status}`); return env.META.gets.slice(from); };
    const names = '@olga @mia @tess';
    const bare = await reads(() => post('teamed', 'mia', `${names} a`));
    const tags = await reads(() => post('teamed', 'mia', `${names} b @${TEAM} @${OTHER}`));
    const teamReads = (list) => list.filter((k) => /^team:/.test(k)).length;
    console.log(`    reads: ${bare.length} without a tag, ${tags.length} with; team records ${teamReads(bare)} and ${teamReads(tags)}`);
    assert(teamReads(tags) <= teamReads(bare) + 1, `team reads ${teamReads(bare)} -> ${teamReads(tags)}`);
    // A page of the bell: a doc's record once, and only a doc with a tag.
    const now = new Date().toISOString();
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'mention', group_key: `n${i}`, slug: i % 2 ? 'plain' : 'teamed', version: 1, comment_id: 'c', thread_id: 'c', actor: null, preview: TEXT, title: 'x', at: now, read: true, count: 1 }));
    await env.META.put('inbox:olga', JSON.stringify({ items }));
    const page = () => api('/api/notifications', { cookie: who.olga.cookie });
    await reads(page);
    const warm = await reads(page);
    assert(warm.filter((k) => k === 'meta:plain').length <= 2 && teamReads(warm) <= 2, `bell reads ${warm}`);
    await env.META.put('inbox:olga', JSON.stringify({ items: items.map((i) => ({ ...i, preview: 'no tag' })) }));
    await reads(page);
    const none = await reads(page);
    assert(none.length <= warm.length - 3, `bell reads ${none.length} without tags, ${warm.length} with`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
