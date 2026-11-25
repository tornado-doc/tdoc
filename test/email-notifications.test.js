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
    for (const login of ['olga', 'eve', 'mia', 'ned', 'pat', 'quin']) {
      who[login] = await issue(worker, env, login);
      const key = `hosted-account:${login}`;
      await env.META.put(key, JSON.stringify({ ...JSON.parse(await env.META.get(key) || '{}'), account_id: who[login].account_id, github_login: login, email: login === 'eve' ? 'eve@own.example' : `${login}@example.com` }));
    }
    await env.META.put(`session:${'d'.repeat(32)}`, JSON.stringify({ email: 'dave@hidden.example', name: 'dave', created: '2026-01-01T00:00:00Z' }));
    who.dave = { cookie: `tdoc_sid=${'d'.repeat(32)}` };
    const api = async (path, o = {}) => { const r = await worker.fetch(req(path, o), env, {}); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: r.status, text, body }; };
    const { team } = (await api('/api/teams', { method: 'POST', cookie: who.olga.cookie, body: { name: 'T' } })).body;
    for (const login of ['mia', 'ned', 'pat', 'quin']) await api('/api/team/join', { method: 'POST', cookie: who[login].cookie, body: { token: team.invite_url.split('/').pop() } });
    const teamKey = [...env.META.map.keys()].find((k) => { try { const v = JSON.parse(env.META.map.get(k)); return v && v.id === team.id && Array.isArray(v.members); } catch { return false; } });
    const rec = JSON.parse(env.META.map.get(teamKey));
    rec.members.push({ ...rec.members[1], key: `email:${TEAM}`, account_id: 'acct-tess' });
    await env.META.put(teamKey, JSON.stringify(rec), { metadata: env.META.metadata.get(teamKey) });
    const created = '2026-01-01T00:00:00Z';
    const doc = (slug, extra) => env.META.put(`meta:${slug}`, JSON.stringify({ slug, title: slug, created, versions: [{ n: 1, created }], hosted: { account_id: who.olga.account_id, github_login: 'olga' }, access: { visibility: 'public', commenting: 'signed_in', allowed_users: [INV] }, ...extra }));
    await doc('plain', {});
    await doc('teamed', { workspace_id: team.id, access: { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: [] } });
    await doc('open-team', { workspace_id: team.id, access: { visibility: 'public', team: true, commenting: 'signed_in', allowed_users: [] } });
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
    // What is cut off is a host's end, not the text after one.
    const tail = '，' + '然后继续'.repeat(60);
    for (const login of ['eve', 'olga']) await env.META.put(`inbox:${login}`, JSON.stringify({ items: [row('n1', 'agent_reply', `${'请看'.repeat(20)}@${INV}${tail}`.slice(0, 300)), row('n2', 'mention', `see @<${INV}> ok`), { ...row('n3', 'mention', `my own @${OTHER}`), actor: { login: 'eve', name: 'eve' } }, row('n4', 'agent_reply', pad(`@${INV},x`))] }));
    const [ce, co] = [await bell('eve'), await bell('olga')];
    assert(at(ce, 'n1').length === 300 - '@invited.example'.length && !hosts(at(ce, 'n1')), at(ce, 'n1'));
    assert(at(co, 'n1').length === 300 && at(co, 'n1').includes(`@${INV}`), at(co, 'n1'));
    assert(at(ce, 'n2') === 'see @<carol> ok' && at(co, 'n2') === `see @<${INV}> ok`, `${at(ce, 'n2')} / ${at(co, 'n2')}`);
    assert(at(ce, 'n3') === `my own @${OTHER}` && at(co, 'n3') === 'my own @bob', `own words: ${at(ce, 'n3')} / ${at(co, 'n3')}`);
    assert(at(ce, 'n4').endsWith(' @carol,') && at(co, 'n4').endsWith(` @${INV},x`), `${at(ce, 'n4').slice(-20)} / ${at(co, 'n4').slice(-30)}`);
    // Cut inside a host that is not ASCII; a handle and text stay.
    await env.META.put('inbox:eve', JSON.stringify({ items: [row('n1', 'agent_reply', pad('@zed@\u4f8b\u5b50')), row('n2', 'agent_reply', pad('@zed@b\u00fc')), row('n3', 'agent_reply', pad('@zed@one\u65e5')), row('n4', 'agent_reply', pad('@lee\u8bf7\u770b@eli\u7136\u540e'))] }));
    const cutRows = await bell('eve');
    for (const id of ['n1', 'n2', 'n3']) assert(at(cutRows, id).endsWith(' @zed'), `${id}: ${at(cutRows, id).slice(-12)}`);
    assert(at(cutRows, 'n4').endsWith('@eli\u7136\u540e'), at(cutRows, 'n4').slice(-12));
    // The handle's record is somebody else's account now: not their address.
    const handle = JSON.parse(await env.META.get('hosted-account:eve'));
    await env.META.put('hosted-account:eve', JSON.stringify({ ...handle, account_id: 'acct-somebody-else' }));
    await env.META.put(`session:${'e'.repeat(32)}`, JSON.stringify({ login: 'eve', name: 'eve', account_id: who.eve.account_id, created: new Date().toISOString() }));
    await env.META.put('inbox:eve', JSON.stringify({ items: [row('n1', 'mention', TEXT)] }));
    const other = await api('/api/notifications', { cookie: `tdoc_sid=${'e'.repeat(32)}` });
    assert(other.status === 200 && at(other, 'n1') === `@eve ask ${CUT}`, `${other.status} ${other.text.slice(0, 200)}`);
    // The doc's record cannot be read: nobody's but their own.
    const get = env.META.get;
    await bell('olga');
    env.META.get = function (k, ...a) { return k === 'meta:plain' ? Promise.reject(new Error('KV is down')) : get.call(this, k, ...a); };
    const down = await bell('olga');
    env.META.get = get;
    assert(!hosts(down.text), `unreadable doc: ${hosts(down.text)}`);
  });

  await t('email tags written against each other: each address is told, and nobody else', async () => {
    for (const visibility of ['public', 'private']) {
      const { env, sent, post, who } = await tagged();
      const bob = await issue(worker, env, 'bob');
      await env.META.put('hosted-account:bob', JSON.stringify({ ...JSON.parse(await env.META.get('hosted-account:bob') || '{}'), account_id: bob.account_id, github_login: 'bob', email: 'bob@elsewhere.example' }));
      const meta = JSON.parse(await env.META.get('meta:plain'));
      await env.META.put('meta:plain', JSON.stringify({ ...meta, access: { visibility, commenting: 'signed_in', allowed_users: [] } }));
      const r = await post('plain', 'olga', 'ask @ann@one.example,@bob@two.example，请看');
      assert(r.status === 200, `${r.status}`);
      assert(sent.map((m) => m.to).sort().join() === 'ann@one.example,bob@two.example', `${visibility}: mailed ${sent.map((m) => m.to)}`);
      const bells = [...env.META.map.keys()].filter((k) => k.startsWith('inbox:')).sort().join();
      assert(bells === 'inbox:email:ann@one.example,inbox:email:bob@two.example', `${visibility}: ${bells}`);
      const allowed = JSON.parse(await env.META.get('meta:plain')).access.allowed_users;
      assert(allowed.join() === (visibility === 'private' ? 'ann@one.example,bob@two.example' : ''), `${visibility}: invited ${allowed}`);
      assert(who.olga, 'owner');
    }
  });

  await t('an address with punctuation in it invites, mails and tells nobody by a part of it', async () => {
    const marks = [...'.!?,;:)]}>|/\'"&*~=#%^$+', '，', '。', '、', '！', '）', '…', '—', '‑', '·', '・', '”', '．'];
    const shapes = (m) => [`@john${m}@example.com`, `ask (@john${m}@example.com)`, `@lee @john${m}${m}@example.com`, `@john@exam${m}ple.com`, `@dana@one.example${m}@john${m}@example.com`];
    const { env, sent, post } = await tagged();
    const meta = JSON.parse(await env.META.get('meta:plain'));
    for (const login of ['john', 'example', 'exam', 'ple', 'one', 'com']) await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, email: `${login}@stranger.example` }));
    for (const mark of marks) for (const text of shapes(mark)) {
      await env.META.put('meta:plain', JSON.stringify({ ...meta, access: { visibility: 'private', commenting: 'signed_in', allowed_users: [] } }));
      for (const k of [...env.META.map.keys()]) if (k.startsWith('inbox:')) env.META.map.delete(k);
      sent.length = 0;
      const r = await post('plain', 'olga', text);
      assert(r.status === 200, `${text}: ${r.status}`);
      const allowed = JSON.parse(await env.META.get('meta:plain')).access.allowed_users;
      const told = [...env.META.map.keys()].filter((k) => k.startsWith('inbox:')).map((k) => k.slice(6));
      const fine = (k) => k === 'lee' || (k.includes('@') && text.includes(k.replace(/^email:/, '')));
      assert([...allowed, ...told].every(fine), `${text}: invited ${allowed}, told ${told}`);
      assert(sent.every((m) => !m.to.endsWith('@stranger.example')), `${text}: mailed ${sent.map((m) => m.to)}`);
    }
  });

  await t('on a private doc: a handle with text written on after it is invited and told; an address nobody can have fails nothing', async () => {
    const { env, sent, post } = await tagged();
    const meta = JSON.parse(await env.META.get('meta:plain'));
    for (const login of ['eli', 'gmail', 'lee', 'john', 'corp']) await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, email: `${login}@handle.example` }));
    const say = async (text) => {
      await env.META.put('meta:plain', JSON.stringify({ ...meta, access: { visibility: 'private', commenting: 'signed_in', allowed_users: [] } }));
      for (const k of [...env.META.map.keys()]) if (k.startsWith('inbox:')) env.META.map.delete(k);
      sent.length = 0;
      const r = await post('plain', 'olga', text);
      assert(r.status === 200 && r.body.text === text, `${text}: ${r.status} ${r.text}`);
      return { allowed: JSON.parse(await env.META.get('meta:plain')).access.allowed_users.join(), told: [...env.META.map.keys()].filter((k) => k.startsWith('inbox:')).join(), mailed: sent.map((m) => m.to).join() };
    };
    for (const text of ['@eli\u8fd9\u91cc\u6ca1\u95ee\u9898\u3002PR\u5df2\u5408\u5e76', '@eli\u770b\u8fc7\u4e86\u3002OK', '@eli\u8bf7\u770bREADME.md', '@eli\u8bf7\u770b\u4e00\u4e0b\u8fd9\u4e2a\u65b9\u6848\u3002\u53c2\u8003tdoc.dev', '@eli\u8fd9\u4e2a\u6539\u62103.5\u5427', '@eli\u770b\u4e0b\u7b2c2.3\u8282', '@eli\u3055\u3093\u3002OK\u3067\u3059', '@eli\ud655\uc778\ud574\uc8fc\uc138\uc694\u3002OK', '@eli\u3002OK', '@eli\u8fd9\u91cc\u6ca1\u95ee\u9898\u3002']) {
      const r = await say(text);
      assert(r.allowed === 'eli' && r.told === 'inbox:eli' && r.mailed === 'eli@handle.example', `${text}: ${JSON.stringify(r)}`);
    }
    for (const text of ['\u3042\u308a\u304c\u3068\u3046@lee@corp\uff61ok \u3067\u3059', '@john@gmail\uff61com', '@john.@gmail\uff61com', '@john@gmail\uff0ecom', '@example.com ok', '@john.@gmail.com ok']) {
      const r = await say(text);
      assert(!r.allowed && !r.told && !r.mailed, `${text}: ${JSON.stringify(r)}`);
    }
    const both = await say('@john@gmail\uff61com and @eli');
    assert(both.allowed === 'eli' && both.told === 'inbox:eli', JSON.stringify(both));
  });

  await t('a handle written like a part of an address is told when the doc knows it; nobody else is told, invited or blocked', async () => {
    const { env, sent, post, who } = await tagged();
    const known = async (login) => { who[login] = await issue(worker, env, login); await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: who[login].account_id, github_login: login, email: `${login}@handle.example` })); };
    for (const login of ['lee', 'eli', 'gmail', 'john', 'claude', 'uma']) await known(login);
    const base = Object.fromEntries(['plain', 'teamed', 'open-team'].map((slug) => [slug, JSON.parse(env.META.map.get(`meta:${slug}`))]));
    const say = async (slug, as, text, access, extra) => {
      await env.META.put(`meta:${slug}`, JSON.stringify({ ...base[slug], access: { ...base[slug].access, allowed_users: [], ...access } }));
      for (const k of [...env.META.map.keys()]) if (/^(?:inbox:|notify-email)/.test(k)) env.META.map.delete(k);
      sent.length = 0;
      const r = await post(slug, as, text, extra);
      assert(r.status === 200, `${text}: ${r.status} ${r.text}`);
      const o = r.body.mention_outcome;
      const told = [...env.META.map.keys()].filter((k) => k.startsWith('inbox:')).map((k) => k.slice(6)).filter((k) => k !== 'olga').sort().join();
      const mailed = sent.map((m) => m.to).filter((to) => to !== 'olga@example.com').sort().join();
      assert(mailed === told.split(',').filter(Boolean).map((k) => JSON.parse(env.META.map.get(`hosted-account:${k}`)).email).sort().join(), `${text}: told ${told}, mailed ${mailed}`);
      assert(!o.invited.length && !o.newcomers.length, `${text}: ${JSON.stringify(o)}`);
      assert(JSON.parse(env.META.map.get(`meta:${slug}`)).access.allowed_users.join() === ((access || {}).allowed_users || []).join(), `${text}: ${env.META.map.get(`meta:${slug}`)}`);
      return { told, blocked: o.blocked.join(), mentions: (r.body.mentions || []).join(), id: r.body.id };
    };
    const TEXT1 = '@lee，@eli。OK';
    const priv = { visibility: 'private' };
    // Invited: by login (either case), by an address of the same account.
    for (const text of [TEXT1, '@Lee，@ELI。pr已合并', '**@lee**，**@eli**。OK']) for (const as of ['olga', 'ned']) {
      const r = await say('plain', as, text, { ...priv, allowed_users: ['lee', 'eli@handle.example', 'ned'] });
      const want = as === 'olga' ? 'lee,eli' : 'lee'; // a guest reaches whom the list names by login
      assert(r.told === want.split(',').sort().join() && r.mentions === want && !r.blocked, `${as} ${text}: ${JSON.stringify(r)}`);
    }
    // Nobody here knows them: private, public, sign-in-required, and whatever
    // else they are a contact or a user of.
    await env.META.put('contacts:olga', JSON.stringify([{ login: 'gmail', name: 'g' }, { login: 'john', name: 'j' }]));
    await env.META.put('recents:gmail', '[1]');
    for (const text of ['@john，@gmail。com', '@john，@gmail。com请看', '@john请@gmail。com', '@john,@gmail.con', '@john!@gmail.com', '@gmail.com', '@john.@gmail｡com']) {
      for (const access of [priv, { visibility: 'public' }, { visibility: 'unlisted', signin_required: true }]) for (const as of access === priv ? ['olga'] : ['olga', 'eve']) {
        const r = await say('plain', as, text, access);
        assert(!r.told && !r.mentions && !r.blocked, `${access.visibility} ${as} ${text}: ${JSON.stringify(r)}`);
      }
    }
    // Somebody who wrote on it; not an agent, nor a name an upload carries.
    await post('plain', 'lee', 'one');
    const reply = (await post('plain', 'uma', 'two')).body.id;
    const record = (author, i) => env.COMMENTS.get(env.COMMENTS.idFromName('plain')).fetch('https://do/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'plain', op: { kind: 'create', slug: 'plain', id: `c_x${i}`, author, text: 'x', version: 1 } }) });
    await record({ login: 'john', name: 'john', imported: true }, 1);
    await record({ login: 'claude', name: 'Claude', kind: 'agent' }, 2);
    await record({ login: 'email:gmail@handle.example', name: 'g', imported: true }, 3);
    let r = await say('plain', 'eve', '@lee，@eli。OK @uma，@john。OK @claude，@gmail。OK', { visibility: 'public' });
    assert(r.told === 'lee,uma' && r.mentions === 'lee,uma', JSON.stringify(r));
    r = await say('plain', 'eve', 'x @lee，@gmail。OK', { visibility: 'public' }, { parent_id: reply });
    assert(r.told === 'lee,uma', `reply: ${JSON.stringify(r)}`);
    // They wrote on it, and can no longer read it.
    r = await say('plain', 'olga', '@lee，@uma。ok', priv);
    assert(!r.told && !r.mentions && !r.blocked, `removed: ${JSON.stringify(r)}`);
    // The writer is not told.
    r = await say('plain', 'lee', '@lee，@eli。OK', { ...priv, allowed_users: ['lee', 'eli'] });
    assert(r.told === 'eli' && r.mentions === 'eli', `writer: ${JSON.stringify(r)}`);
    // The team's members, not the byline nor another team's.
    for (const slug of ['teamed', 'open-team']) {
      r = await say(slug, 'ned', '@mia，@lee。OK @pat.ok', base[slug].access);
      assert(r.told === 'mia,pat' && r.mentions === 'mia,pat' && !r.blocked, `${slug}: ${JSON.stringify(r)}`);
    }
    // A team doc everybody reads, not shared with the team as such.
    r = await say('open-team', 'ned', '@mia，@john。OK', { ...base['open-team'].access, team: false });
    assert(r.told === 'mia', `team doc, public: ${JSON.stringify(r)}`);
    // Who wrote here under an address, named by the account's handle.
    await env.META.put(`account-group:${who.gmail.account_id}`, JSON.stringify({ canonical: who.gmail.account_id, ids: [who.gmail.account_id], actor_keys: ['gmail', 'email:g@own.example'] }));
    await record({ login: 'email:g@own.example', name: 'g' }, 4);
    r = await say('plain', 'olga', '@john，@gmail。OK', { visibility: 'public' });
    assert(r.told === 'gmail', `linked: ${JSON.stringify(r)}`);
    // Both kinds in one comment; the owner invites only the plain one.
    await env.META.put('meta:plain', JSON.stringify({ ...base.plain, access: { ...priv, commenting: 'signed_in', allowed_users: ['lee'] } }));
    const o = (await post('plain', 'olga', '@john @lee，@gmail。com')).body.mention_outcome;
    assert(o.notified.join() === 'john,lee' && o.invited.join() === 'john' && !o.blocked.length, JSON.stringify(o));
    assert(JSON.parse(env.META.map.get('meta:plain')).access.allowed_users.join() === 'lee,john', 'allowed');
  });

  await t('a poster who is not of the doc learns nothing from a weak handle about whom it knows, nor a guest beyond the logins listed', async () => {
    const { env, post, api, who } = await tagged();
    const names = ['ivo', 'adr', 'ali', 'cora', 'guest', 'zed', 'yan'];
    for (const login of names) {
      who[login] = await issue(worker, env, login);
      await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: who[login].account_id, github_login: login, email: `${login}@x.example` }));
    }
    await env.META.put(`account-group:${who.ali.account_id}`, JSON.stringify({ canonical: who.ali.account_id, ids: [who.ali.account_id], actor_keys: ['ali', 'email:ali@x.example'] }));
    const open = JSON.parse(env.META.map.get('meta:open-team'));
    const allowed = ['guest', 'ivo', 'adr@x.example'];
    const docs = { 'p-public': [0, { visibility: 'public' }], 'p-link': [0, { visibility: 'unlisted' }], 'p-signin': [0, { visibility: 'unlisted', signin_required: true }], 't-public': [1, { visibility: 'public', team: true }], 't-link': [1, { visibility: 'unlisted' }], 'p-private': [0, { visibility: 'private' }], 't-private': [1, { visibility: 'private', team: true }] };
    const record = (slug, author) => env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'create', slug, id: `c_${author.name}`, author, text: 'x', version: 1 } }) });
    const token = {};
    for (const [slug, [team, access]] of Object.entries(docs)) {
      await env.META.put(`meta:${slug}`, JSON.stringify({ ...open, slug, title: slug, ...(team ? {} : { workspace_id: undefined }), access: { commenting: 'signed_in', allowed_users: allowed, ...access } }));
      await record(slug, { login: 'email:ali@x.example', name: 'ali2', account_id: who.ali.account_id });
      await record(slug, { login: 'cora', name: 'cora', account_id: who.cora.account_id });
      for (const as of ['olga', 'mia', 'guest']) {
        token[`${as} ${slug}`] = `fb_${as.length}${slug.length}${[...`${as}${slug}`].map((c) => c.charCodeAt(0).toString(16)).join('')}`.padEnd(51, '0').slice(0, 51);
        await env.META.put(`feedback:token:${token[`${as} ${slug}`]}`, JSON.stringify({ sid: who[as].cookie.split('=')[1], slug, origin: 'https://app.example', created: '2026-01-01T00:00:00Z' }));
      }
    }
    // What the poster can see of it, with the name taken out: the answer, the
    // comment as stored, and what was read for it.
    const probe = async (slug, as, name, opts) => {
      const from = env.META.gets.length;
      const r = opts ? await api('/api/comments', { method: 'POST', ...opts, body: { slug, version: 1, text: `@${name}.ok`, anchor: null } }) : await post(slug, as, `@${name}.ok`);
      const reads = env.META.gets.slice(from);
      assert(r.status === 200, `${slug} ${as}: ${r.status} ${r.text}`);
      const seen = await api(`/api/comments?slug=${slug}&version=1`, opts || { cookie: who[as].cookie });
      const stored = seen.body.find((c) => c.id === r.body.id);
      assert(stored, 'stored');
      const blank = (x) => JSON.stringify(x).replace(new RegExp(`\\b${name}\\b`, 'g'), 'NAME').replace(/c_\d+_\w+/g, 'ID').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'AT').replace(/"(?:eid|id)":"[^"]*"/g, '');
      return { told: r.body.mention_outcome.notified.join(), all: blank([r.body, stored, reads.filter((k) => !/^(?:inbox|push-subs|notify)/.test(k)).length]) };
    };
    for (const slug of Object.keys(docs)) {
      const priv = slug.endsWith('private');
      const posters = priv ? [['guest']] : [['eve'], ['cora'], ['guest']];
      for (const as of ['olga', ...(slug === 't-private' ? ['mia'] : priv || slug === 'p-signin' ? ['guest'] : ['mia', 'guest'])]) posters.push([as, { token: token[`${as} ${slug}`] }]);
      for (const [as, opts] of posters) {
        await probe(slug, as, 'zed', opts); // warm
        const none = await probe(slug, as, 'zed', opts);
        assert(!none.told, `${slug} ${as}: zed`);
        // Whoever is on the team, invited by login or by address, or writing under an address.
        for (const name of ['pat', 'ivo', 'adr', 'ali', 'yan']) {
          const r = await probe(slug, as, name, opts);
          // A guest reaches the logins the sharing list holds, and no more.
          const listed = name === 'ivo' && as === 'guest' && !opts;
          if (listed) assert(r.told === 'ivo', `${slug} ${as} ivo: ${r.told}`);
          else assert(r.all === none.all, `${slug} ${as}${opts ? ' (feedback)' : ''} ${name}:\n${r.all}\n${none.all}`);
        }
        // Whom everybody sees here by that login.
        if (as !== 'cora') assert((await probe(slug, as, 'cora', opts)).told === (priv ? '' : 'cora'), `${slug} ${as}: cora`);
        if (as !== 'olga') assert((await probe(slug, as, 'olga', opts)).told === 'olga' || (slug === 't-private' && opts), `${slug} ${as}: olga`);
      }
    }
    // Those of the doc are told of everyone it knows.
    const want = { 'p-public': 'ivo adr ali', 'p-link': 'ivo adr ali', 'p-signin': 'ivo adr ali', 't-public': 'pat ivo adr ali', 't-link': 'pat ivo adr ali', 'p-private': 'ivo adr', 't-private': 'pat ivo adr' };
    for (const slug of Object.keys(docs)) for (const as of ['olga', 'guest', ...(slug.startsWith('t') ? ['mia'] : [])]) {
      const told = [];
      for (const name of ['pat', 'ivo', 'adr', 'ali', 'yan']) if ((await probe(slug, as, name)).told) told.push(name);
      assert(told.join(' ') === (as === 'guest' ? 'ivo' : want[slug]), `${slug} ${as}: ${told}`);
    }
  });

  await t('a guest on a private team doc reaches a member who wrote on it, not one who did not', async () => {
    const { env, post, who } = await tagged();
    who.guest = await issue(worker, env, 'guest');
    const meta = JSON.parse(env.META.map.get('meta:teamed'));
    await env.META.put('meta:teamed', JSON.stringify({ ...meta, access: { ...meta.access, allowed_users: ['guest'] } }));
    await post('teamed', 'pat', 'x');
    const r = await post('teamed', 'guest', '@pat\uff0c@mia\u3002OK @olga.ok');
    assert(r.status === 200 && r.body.mention_outcome.notified.join() === 'pat,olga', JSON.stringify(r.body.mention_outcome));
  });

  await t('what weak handles cost: no read for a comment without one, and a bounded few with', async () => {
    const { env, post } = await tagged();
    const reads = async (text) => { const from = env.META.gets.length; const r = await post('plain', 'olga', text); assert(r.status === 200, `${r.status}`); return env.META.gets.slice(from).length; };
    await reads('warm');
    const bare = await reads('a plain comment');
    const unknown = await reads('@no1，@no2。ok');
    const many = await reads(Array.from({ length: 400 }, (_, i) => `@z${i}.ok`).join(' '));
    console.log(`    reads: ${bare} with none, ${unknown} with two unknown, ${many} with 400`);
    // Telling them looks them up once: what a plain mention costs, at most.
    for (const text of ['@ned @pat @quin', '@ned，@pat，@quin。ok']) await reads(text);
    await post('plain', 'ned', 'x'); await post('plain', 'pat', 'x'); await post('plain', 'quin', 'x');
    const strong = await reads('@ned @pat @quin now');
    const weak = await reads('@ned，@pat.ok @quin.ok now');
    console.log(`    reads: ${strong} for three plain, ${weak} for three weak`);
    assert(weak <= strong, `${strong} ${weak}`);
    assert(unknown - bare <= 2 * 3 && many - bare <= 10 * 3, `${bare} ${unknown} ${many}`);
  });

  await t('a deleted account\'s address: the owner\'s email and bell hide it, as the doc page does', async () => {
    const hmac = (key, text) => require('crypto').createHmac('sha256', key).update(text).digest('hex');
    const { env, sent, post, api, who } = await tagged();
    const GONE = 'gone@invited.example';
    const meta = JSON.parse(await env.META.get('meta:plain'));
    await env.META.put('meta:plain', JSON.stringify({ ...meta, access: { ...meta.access, allowed_users: [INV, GONE] } }));
    await env.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid: hmac('tdoc-identity-kid\0x', 'kid').slice(0, 16) }));
    await env.META.put(`account-deleted-identity:${hmac('tdoc-deleted-identity-v1\0x', `email:${GONE}`)}`, JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }));
    const want = `ask @${INV}, @gone, or @gone ok`;
    const r = await post('plain', 'dave', `ask @${INV}, @${GONE}, or @${GONE} ok`);
    assert(r.status === 200, `${r.status}`);
    const mail = () => sent.find((m) => m.to === 'olga@example.com');
    assert(mail() && mail().text.includes(want) && mail().html.includes(want) && !both(mail()).includes('gone'), mail() && mail().text);
    const bell = () => api('/api/notifications', { cookie: who.olga.cookie });
    const rows = await bell();
    assert(rows.body.items.some((i) => i.preview === want) && !rows.text.includes(GONE), rows.text);
    // The check cannot be read: an email and the bell hide it all; their own stays.
    const { env: env2, sent: sent2, who: who2 } = await tagged();
    const worker2 = (await loadWorker()).default;
    await env2.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid: hmac('tdoc-identity-kid\0x', 'kid').slice(0, 16) }));
    const get = env2.META.get;
    env2.META.get = function (k, ...a) { return [].concat(k).some((x) => String(x).startsWith('account-deleted-identity:')) ? Promise.reject(new Error('KV is down')) : get.call(this, k, ...a); };
    const posted = await worker2.fetch(req('/api/comments', { method: 'POST', cookie: who2.dave.cookie, body: { slug: 'plain', version: 1, text: TEXT, anchor: null } }), env2, {});
    assert(posted.status === 200, `${posted.status}`);
    const to = (x) => sent2.find((m) => m.to === x);
    assert(!both(to('olga@example.com')) && both(to('eve@own.example')) === 'eve@own.example', `${both(to('olga@example.com'))} / ${both(to('eve@own.example'))}`);
    const down = await worker2.fetch(req('/api/notifications', { cookie: who2.olga.cookie }), env2, {});
    assert(down.status === 200 && !hosts(await down.text()), 'bell, check unreadable');
    const eve = await (await worker2.fetch(req('/api/notifications', { cookie: who2.eve.cookie }), env2, {})).text();
    assert(hosts(eve) === 'eve@own.example', `own: ${hosts(eve)}`);
  });

  await t('a notification about one\'s own words, and the name of who wrote it: a deleted account\'s address, or one that cannot be checked, is in neither', async () => {
    const hmac = (key, text) => require('crypto').createHmac('sha256', key).update(text).digest('hex');
    const GONE = 'gone@invited.example';
    const DAVE = 'dave@hidden.example';
    for (const down of [false, true]) {
      const { env, sent, who } = await tagged();
      const w = (await loadWorker()).default;
      const api = async (path, o) => { const r = await w.fetch(req(path, o), env, {}); assert(r.status === 200, `${path} ${r.status}`); return r.json(); };
      const meta = JSON.parse(await env.META.get('meta:plain'));
      await env.META.put('meta:plain', JSON.stringify({ ...meta, access: { ...meta.access, allowed_users: [DAVE, INV] } }));
      await env.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid: hmac('tdoc-identity-kid\0x', 'kid').slice(0, 16) }));
      await env.META.put(`account-deleted-identity:${hmac('tdoc-deleted-identity-v1\0x', `email:${GONE}`)}`, JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }));
      await env.META.put(`session:${'d'.repeat(32)}`, JSON.stringify({ email: DAVE, name: DAVE, created: '2026-01-01T00:00:00Z' }));
      const get = env.META.get;
      if (down) env.META.get = function (k, ...a) { return [].concat(k).some((x) => String(x).startsWith('account-deleted-identity:')) ? Promise.reject(new Error('KV is down')) : get.call(this, k, ...a); };
      await api('/api/comments', { method: 'POST', cookie: who.dave.cookie, body: { slug: 'plain', version: 1, text: 'hello', anchor: null } });
      const mail = sent.find((m) => m.to === 'olga@example.com');
      const said = mail.subject + mail.text + mail.html + JSON.stringify(mail.from);
      assert(said.includes('dave') && said.includes(DAVE) === !down, `${down}: ${mail.subject} ${mail.text}`);
      const row = { id: 'n1', kind: 'mention', group_key: 'n1', slug: 'plain', version: 1, comment_id: 'c', thread_id: 'c', actor: { login: 'olga', name: 'olga' }, preview: `ask @${GONE}, or @${INV} ok`, title: 'plain', at: new Date().toISOString(), read: false, count: 1 };
      await env.META.put('inbox:olga', JSON.stringify({ items: [row] }));
      const { items } = await api('/api/notifications', { cookie: who.olga.cookie });
      assert(items[0].preview === (down ? 'ask @gone, or @carol ok' : `ask @gone, or @${INV} ok`), `${down}: ${items[0].preview}`);
    }
  });

  await t('what the deletion checks of a notification cost', async () => {
    const hmac = (key, text) => require('crypto').createHmac('sha256', key).update(text).digest('hex');
    const { env, post, api, who } = await tagged();
    await env.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid: hmac('tdoc-identity-kid\0x', 'kid').slice(0, 16) }));
    let ops = 0;
    const get = env.META.get;
    env.META.get = function (k, ...a) { if ([].concat(k).some((x) => String(x).startsWith('account-deleted-identity:') || x === 'account-identity-key')) ops += 1; return get.call(this, k, ...a); };
    const count = async (fn) => { ops = 0; const r = await fn(); assert(r.status === 200, `${r.status}`); return ops; };
    const bare = await count(() => post('open-team', 'mia', '@olga @ned @pat @quin a'));
    const tags = await count(() => post('open-team', 'mia', `@olga @ned @pat @quin b @${TEAM} x`));
    const none = await count(() => api('/api/notifications?offset=0', { cookie: who.mia.cookie }));
    const bell = await count(() => api('/api/notifications', { cookie: who.ned.cookie }));
    console.log(`    deletion reads: ${bare} without a tag, ${tags} with one shown to four; bell ${bell}, with nothing to show ${none}`);
    assert(tags <= bare + 3, `${bare} -> ${tags}`);
    assert(bell <= 6, `bell ${bell}`);
  });

  await t('what telling people costs: one read of the doc\'s team, however many are told; none without a tag', async () => {
    const { env, sent, post, api, who } = await tagged();
    const reads = async (fn) => { const from = env.META.gets.length; const r = await fn(); assert(r.status === 200, `${r.status}`); return env.META.gets.slice(from); };
    const names = '@olga @ned @pat @quin';
    const bare = await reads(() => post('open-team', 'mia', `${names} a`));
    const tags = await reads(() => post('open-team', 'mia', `${names} b @${TEAM} @${OTHER} x`));
    const teamReads = (list) => list.filter((k) => /^team:/.test(k)).length;
    console.log(`    reads: ${bare.length} without a tag, ${tags.length} with; team records ${teamReads(bare)} and ${teamReads(tags)}`);
    const mailed = sent.filter((m) => m.text.includes(' b @tess@team.example ')).length;
    assert(mailed === 5, `mailed ${mailed}`);
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
