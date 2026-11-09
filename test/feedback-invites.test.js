// Feedback space invites from the widget (Julie, 2026-11-03): the owner
// shares from inside the widget; an invite is a signed, expiring id that
// adds the invitee to the space's allowed_users when they take it. Still no
// joining by a link to the space alone (#939).
//
//   - create / list / revoke: owner (team admin) only, by cookie from tdoc
//     or by the widget's own token for this space on its own origin
//   - a made-up or tampered id is refused; a used link, a withdrawn or an
//     expired invite, and one from before the space moved are void
//   - email invites wait for that address to sign in; a GitHub handle is
//     let in at once; both get a tdoc notification and an email
//   - the bookmarklet: Join (connect or token), the one-time prompt without
//     the link, Keep my own, the space switcher
//   - the SDK: the link is the site itself; connecting with it admits them
//   - the landing page for a site with no widget
// Run with: node test/feedback-invites.test.js

const { loadWorker, makeEnv, req, putSession, bootData } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const APP = 'http://localhost:3000';
const HOME = { Origin: 'https://tdoc.dev' };
const ID_RE = /^[a-f0-9]{32}\.[A-Za-z0-9_-]{22}$/;

(async () => {
  console.log('feedback invites: share from the widget');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, p, opts = {}) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  const emailSession = async (env, email) => {
    const sid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`session:${sid}`, JSON.stringify({ email, name: email.split('@')[0], avatar_url: '', created: new Date().toISOString() }));
    return `tdoc_sid=${sid}`;
  };
  const meta = async (env, slug) => JSON.parse(await env.META.get(`meta:${slug}`));
  // Julie owns a bookmarklet space for the app; bob and carol have their own.
  const world = async (extra = {}) => {
    const sent = [];
    const env = makeEnv(mod.CommentsStore, { EMAIL: { send: async (msg) => { sent.push(msg); } }, ...extra });
    const julie = await putSession(env, 'julie');
    const bob = await putSession(env, 'bob');
    const carol = await putSession(env, 'carol');
    const space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie, headers: HOME, body: { origin: APP } })).body;
    return { env, sent, julie, bob, carol, space };
  };
  const invite = (w, body, opts = {}) => call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, ...body }, ...opts });

  await t('the owner makes a one-time link; the space stays private and nobody is added yet', async () => {
    const w = await world();
    const r = await invite(w, {});
    assert(r.status === 201, `create: ${r.status} ${JSON.stringify(r.body)}`);
    assert(ID_RE.test(r.body.invite.id), `id shape ${r.body.invite.id}`);
    assert(r.body.invite.kind === 'link' && r.body.invite.status === 'pending', JSON.stringify(r.body.invite));
    // No SDK on the site: the link is the tdoc page that sets the bookmark up.
    assert(r.body.invite.link === `https://tdoc.dev/feedback/invite/${r.body.invite.id}`, r.body.invite.link);
    const again = await invite(w, {});
    assert(again.status === 200 && again.body.invite.id === r.body.invite.id, 'a second Copy link made a second invite');
    const m = await meta(w.env, w.space.slug);
    assert(m.access.visibility === 'private' && m.access.allowed_users.length === 0, JSON.stringify(m.access));
    const list = await call(w.env, `/api/feedback/invites?slug=${w.space.slug}`, { cookie: w.julie });
    assert(list.status === 200 && list.body.invites.length === 1 && list.body.host === 'localhost:3000' && list.body.site === false, JSON.stringify(list.body));
  });

  await t('only the owner manages invites: not an invitee, not a cross-site POST, not a token for another space', async () => {
    const w = await world();
    const bob = await call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.bob, headers: HOME, body: { slug: w.space.slug } });
    assert(bob.status === 403 && bob.body.error === 'not_owner', `non-owner: ${bob.status} ${JSON.stringify(bob.body)}`);
    const xsite = await invite(w, {}, { headers: { Origin: 'https://evil.example' } });
    assert(xsite.status === 403, `cross-site POST: ${xsite.status}`);
    const anon = await call(w.env, '/api/feedback/invites', { method: 'POST', headers: HOME, body: { slug: w.space.slug } });
    assert(anon.status === 401, `anonymous: ${anon.status}`);
    // Julie's token for another app's space cannot invite into this one.
    const other = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.julie, headers: HOME, body: { origin: 'http://localhost:5173' } })).body;
    const scoped = await call(w.env, '/api/feedback/invites', { method: 'POST', token: other.token, body: { slug: w.space.slug } });
    assert(scoped.status === 403 && scoped.body.error === 'feedback_token_scope', `other token: ${scoped.status} ${JSON.stringify(scoped.body)}`);
    // Bob's own widget token cannot invite into Julie's space.
    const bobs = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } })).body;
    const bobTok = await call(w.env, '/api/feedback/invites', { method: 'POST', token: bobs.token, body: { slug: w.space.slug } });
    assert(bobTok.status === 403, `bob's token: ${bobTok.status}`);
    // The owner's bookmarklet token on somebody else's site: not there (its
    // scripts can read it); Share opens tdoc's window instead.
    const foreign = await call(w.env, '/api/feedback/invites', { method: 'POST', token: w.space.token, body: { slug: w.space.slug } });
    assert(foreign.status === 403 && foreign.body.error === 'share_on_tdoc', `owner token on a foreign site: ${foreign.status} ${JSON.stringify(foreign.body)}`);
    assert(w.space.can_share === true && w.space.share_here === false, 'session does not say where to share');
    const foreignList = await call(w.env, `/api/feedback/invites?slug=${w.space.slug}`, { token: w.space.token });
    assert(foreignList.status === 403, `owner token list on a foreign site: ${foreignList.status}`);
    // On tdoc's own pages the widget shares in place.
    const home = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.julie, headers: HOME, body: { origin: 'https://tdoc.dev' } })).body;
    assert(home.share_here === true, 'share_here on tdoc');
    const mine = await call(w.env, '/api/feedback/invites', { method: 'POST', token: home.token, body: { slug: home.slug } });
    assert(mine.status === 201, `owner token on tdoc: ${mine.status} ${JSON.stringify(mine.body)}`);
    // The Share window: owner only.
    const win = await worker.fetch(req(`/feedback/share/${w.space.slug}`, { cookie: w.julie }), w.env, {});
    assert(win.status === 200 && bootData(await win.text(), '__TDOC_APP_BOOT__').page === 'feedback-share', `share window: ${win.status}`);
    const notMine = await worker.fetch(req(`/feedback/share/${w.space.slug}`, { cookie: w.bob }), w.env, {});
    assert(notMine.status === 403, `share window for bob: ${notMine.status}`);
  });

  await t('a made-up or tampered invite id is refused before anything is looked up', async () => {
    const w = await world();
    const r = await invite(w, {});
    const id = r.body.invite.id;
    const [raw, sig] = id.split('.');
    const tampered = `${raw.slice(0, -1)}${raw.endsWith('a') ? 'b' : 'a'}.${sig}`;
    const forged = `${'0'.repeat(32)}.${'A'.repeat(22)}`;
    // Swap the last character for one it is not: a fixed 'x' left the id
    // valid whenever the signature already ended in 'x' (1 run in 64).
    const badSig = `${raw}.${sig.slice(0, -1)}${sig.endsWith('x') ? 'y' : 'x'}`;
    for (const bad of [tampered, forged, 'nope', badSig]) {
      assert(bad !== id, `tampered id ${bad} equals the real one`);
      const info = await call(w.env, `/api/feedback/invite?id=${encodeURIComponent(bad)}`);
      assert(info.status === 404, `info for ${bad}: ${info.status}`);
      const join = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: bad } });
      assert(join.status === 404 && join.body.error === 'invite_not_found', `connect with ${bad}: ${join.status} ${JSON.stringify(join.body)}`);
    }
    const ok = await call(w.env, `/api/feedback/invite?id=${encodeURIComponent(id)}`);
    assert(ok.status === 200 && ok.body.inviter.name === 'julie' && ok.body.host === 'localhost:3000' && ok.body.status === 'pending', JSON.stringify(ok.body));
    assert(!JSON.stringify(ok.body).includes(w.space.slug), 'the public invite info names the space');
  });

  await t('Join through connect: the link adds the person, files their bookmarklet there, and works once', async () => {
    const w = await world();
    const id = (await invite(w, {})).body.invite.id;
    // Join is a click on tdoc's own page: a cross-site POST cannot take it.
    const xsite = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: { Origin: APP }, body: { origin: APP, invite: id } });
    assert(xsite.status === 403, `cross-site join: ${xsite.status}`);
    // For this site only.
    const wrong = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: 'http://localhost:5173', invite: id } });
    assert(wrong.status === 403 && wrong.body.error === 'invite_wrong_site', `other origin: ${wrong.status} ${JSON.stringify(wrong.body)}`);
    const joined = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: id } });
    assert(joined.status === 200 && joined.body.joined === true && joined.body.slug === w.space.slug, `join: ${joined.status} ${JSON.stringify(joined.body)}`);
    assert(/^fb_/.test(joined.body.token), 'no token');
    const m = await meta(w.env, w.space.slug);
    assert(m.access.allowed_users.includes('bob'), `bob not allowed: ${JSON.stringify(m.access)}`);
    const sess = await call(w.env, '/api/feedback/session', { token: joined.body.token });
    assert(sess.status === 200 && sess.body.slug === w.space.slug && sess.body.can_comment === true && sess.body.can_share === false, JSON.stringify(sess.body));
    // The next plain connect stays in the space joined.
    const again = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } });
    assert(again.body.slug === w.space.slug, 'bob was moved out of the space he joined');
    // Used: carol cannot take the same link.
    const carol = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.carol, headers: HOME, body: { origin: APP, invite: id } });
    assert(carol.status === 410 && carol.body.error === 'invite_used', `reuse: ${carol.status} ${JSON.stringify(carol.body)}`);
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.includes('carol'), 'carol got in on a used link');
    // The owner sees who used it.
    const list = await call(w.env, `/api/feedback/invites?slug=${w.space.slug}`, { cookie: w.julie });
    assert(list.body.invites[0].status === 'accepted' && list.body.invites[0].accepted_name === 'bob', JSON.stringify(list.body.invites));
  });

  await t('still no joining by the space link alone (#939)', async () => {
    const w = await world();
    const m = await meta(w.env, w.space.slug);
    m.access = { ...m.access, visibility: 'unlisted' };
    await w.env.META.put(`meta:${w.space.slug}`, JSON.stringify(m));
    const join = await call(w.env, '/api/feedback/join', { method: 'POST', cookie: w.bob, headers: HOME, body: { slug: w.space.slug } });
    assert(join.status === 403 && join.body.error === 'not_invited', `join: ${join.status}`);
    const bobs = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } })).body;
    const sw = await call(w.env, '/api/feedback/switch', { method: 'POST', token: bobs.token, body: { slug: w.space.slug } });
    assert(sw.status === 403 && sw.body.error === 'not_invited', `switch without an invite: ${sw.status} ${JSON.stringify(sw.body)}`);
  });

  await t('an email invite waits for that address; a notification and an email point at the invite link', async () => {
    const w = await world();
    const r = await invite(w, { invitee: 'Dana@Example.com' });
    assert(r.status === 201 && r.body.invite.kind === 'email' && r.body.invite.invitee === 'dana@example.com', JSON.stringify(r.body));
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.length, 'an address was let in before signing in');
    // Email: through the shared sender, with the link.
    assert(w.sent.length === 1 && w.sent[0].to === 'dana@example.com', `sent: ${JSON.stringify(w.sent.map((m) => m.to))}`);
    assert(w.sent[0].subject === 'julie invited you to comment on localhost:3000', w.sent[0].subject);
    assert(w.sent[0].text.includes(r.body.invite.link), 'email lacks the invite link');
    // tdoc notification, for whoever signs in with the address.
    const inbox = JSON.parse(await w.env.META.get('inbox:email:dana@example.com'));
    const row = inbox.items[0];
    assert(row.kind === 'feedback_invite' && row.link === r.body.invite.link && row.title === 'localhost:3000', JSON.stringify(row));
    // Someone else cannot take it.
    const bob = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: r.body.invite.id } });
    assert(bob.status === 403 && bob.body.error === 'invite_for_someone_else', `bob: ${bob.status} ${JSON.stringify(bob.body)}`);
    assert(!JSON.stringify(bob.body).includes('dana@example.com'), 'the refusal names the whole address');
    // Dana, signed in with that address, sees it and takes it.
    const dana = await emailSession(w.env, 'dana@example.com');
    const notes = await call(w.env, '/api/notifications', { cookie: dana });
    assert(notes.status === 200 && notes.body.items.some((i) => i.kind === 'feedback_invite' && i.link === r.body.invite.link), `notifications: ${JSON.stringify(notes.body)}`);
    const joined = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: dana, headers: HOME, body: { origin: APP, invite: r.body.invite.id } });
    assert(joined.status === 200 && joined.body.slug === w.space.slug, `dana: ${joined.status} ${JSON.stringify(joined.body)}`);
    assert((await meta(w.env, w.space.slug)).access.allowed_users.includes('dana@example.com'), 'address not added on accept');
  });

  await t('a GitHub handle is let in at once and told; inviting them again sends nothing new', async () => {
    const w = await world();
    const r = await invite(w, { invitee: '@Bob' });
    assert(r.status === 201 && r.body.invite.kind === 'login' && r.body.invite.invitee === 'bob', JSON.stringify(r.body));
    assert((await meta(w.env, w.space.slug)).access.allowed_users.includes('bob'), 'handle not let in');
    const inbox = JSON.parse(await w.env.META.get('inbox:bob'));
    assert(inbox.items[0].kind === 'feedback_invite' && inbox.items[0].actor.name === 'julie', JSON.stringify(inbox.items[0]));
    const again = await invite(w, { invitee: 'bob' });
    assert(again.status === 200 && again.body.invite.id === r.body.invite.id, 'a second invite for the same person');
    assert(JSON.parse(await w.env.META.get('inbox:bob')).items.length === 1, 'notified twice');
    const bad = await invite(w, { invitee: 'not an address!' });
    assert(bad.status === 400 && bad.body.error === 'invalid_invitee', `bad invitee: ${bad.status}`);
  });

  await t('the bookmarklet asks once without the link: Keep my own, then the switcher joins and goes back', async () => {
    const w = await world();
    await invite(w, { invitee: 'bob' });
    const bobs = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } })).body;
    assert(bobs.slug !== w.space.slug, 'bob was filed into the space without choosing');
    assert(bobs.invite_prompt && bobs.invite_prompt.slug === w.space.slug && bobs.invite_prompt.inviter === 'julie', `prompt: ${JSON.stringify(bobs.invite_prompt)}`);
    assert(bobs.spaces.length === 2 && bobs.spaces[0].mine && bobs.spaces[0].current && bobs.spaces[1].slug === w.space.slug, JSON.stringify(bobs.spaces));
    const kept = await call(w.env, '/api/feedback/invite/keep', { method: 'POST', token: bobs.token, body: { slug: w.space.slug } });
    assert(kept.status === 200 && kept.body.invite_prompt === null && kept.body.spaces.length === 2, JSON.stringify(kept.body));
    const sess = await call(w.env, '/api/feedback/session', { token: bobs.token });
    assert(sess.body.invite_prompt === null, 'asked again after Keep my own');
    // A page holding his token cannot file him there, even though he is
    // allowed in: joining is a click on tdoc. The switcher entry carries his
    // invite for the connect window.
    const pushed = await call(w.env, '/api/feedback/switch', { method: 'POST', token: bobs.token, body: { slug: w.space.slug } });
    assert(pushed.status === 403 && pushed.body.error === 'not_invited', `switch before joining: ${pushed.status} ${JSON.stringify(pushed.body)}`);
    const entry = kept.body.spaces.find((x) => x.slug === w.space.slug);
    assert(entry && /^[a-f0-9]{32}\./.test(entry.invite), `no invite on the entry: ${JSON.stringify(entry)}`);
    const there = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: entry.invite } });
    assert(there.status === 200 && there.body.slug === w.space.slug && there.body.joined, `join: ${there.status} ${JSON.stringify(there.body)}`);
    assert(there.body.spaces.find((x) => x.current).slug === w.space.slug, 'switcher does not mark the space');
    // The old token now names a space he left: the widget reconnects.
    const stale = await call(w.env, '/api/feedback/session', { token: bobs.token });
    assert(stale.status === 409 && stale.body.error === 'space_moved', `old token: ${stale.status}`);
    // Joined: the switcher goes back and forth with the token.
    const back = await call(w.env, '/api/feedback/switch', { method: 'POST', token: there.body.token, body: { own: true } });
    assert(back.status === 200 && back.body.slug === bobs.slug, `back: ${back.status} ${JSON.stringify(back.body)}`);
    const again = await call(w.env, '/api/feedback/switch', { method: 'POST', token: back.body.token, body: { slug: w.space.slug } });
    assert(again.status === 200 && again.body.slug === w.space.slug, `again: ${again.status} ${JSON.stringify(again.body)}`);
  });

  await t('no token takes an invite: a page holding one cannot file its person in another space', async () => {
    const w = await world();
    const id = (await invite(w, {})).body.invite.id;
    const bobs = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } })).body;
    const accept = await call(w.env, '/api/feedback/invite/accept', { method: 'POST', token: bobs.token, body: { id } });
    assert(accept.status === 403 && accept.body.error === 'feedback_token_scope', `token accept: ${accept.status} ${JSON.stringify(accept.body)}`);
    const join = await call(w.env, '/api/feedback/invite/join', { method: 'POST', token: bobs.token, body: { id } });
    assert(join.status === 403, `token join: ${join.status}`);
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.includes('bob'), 'bob got in');
    // An address invite not taken yet is listed, and is taken only in the connect window.
    const dana = await emailSession(w.env, 'dana@example.com');
    await invite(w, { invitee: 'dana@example.com' });
    const danas = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: dana, headers: HOME, body: { origin: APP } })).body;
    const entry = danas.spaces.find((x) => x.slug === w.space.slug);
    assert(entry && entry.invite, `dana's switcher: ${JSON.stringify(danas.spaces)}`);
    const sw = await call(w.env, '/api/feedback/switch', { method: 'POST', token: danas.token, body: { slug: w.space.slug } });
    assert(sw.status === 403, `dana switch by token: ${sw.status}`);
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.includes('dana@example.com'), 'switch took the invite');
  });

  await t('the invite page joins on tdoc (same-origin, signed in) and opens the site without the invite', async () => {
    const w = await world();
    const link = (await invite(w, {})).body.invite;
    const xsite = await call(w.env, '/api/feedback/invite/join', { method: 'POST', cookie: w.bob, headers: { Origin: APP }, body: { id: link.id } });
    assert(xsite.status === 403, `cross-site: ${xsite.status}`);
    const anon = await call(w.env, '/api/feedback/invite/join', { method: 'POST', headers: HOME, body: { id: link.id } });
    assert(anon.status === 401, `anonymous: ${anon.status}`);
    const ok = await call(w.env, '/api/feedback/invite/join', { method: 'POST', cookie: w.bob, headers: HOME, body: { id: link.id } });
    assert(ok.status === 200 && ok.body.site_url === `${APP}/`, `join: ${ok.status} ${JSON.stringify(ok.body)}`);
    assert((await meta(w.env, w.space.slug)).access.allowed_users.includes('bob'), 'bob not added');
    const next = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP } });
    assert(next.body.slug === w.space.slug, 'the bookmark does not connect to the space joined');
  });

  await t('removed in Share: the invite they took does not let them back in', async () => {
    const w = await world();
    const link = (await invite(w, {})).body.invite;
    await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: link.id } });
    await call(w.env, '/api/doc/access', { method: 'PATCH', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, access: { allowed_users: [] } } });
    const back = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: link.id } });
    assert(back.status === 410 && back.body.error === 'invite_revoked', `retake: ${back.status} ${JSON.stringify(back.body)}`);
    // Same for a handle invite.
    const handle = (await invite(w, { invitee: 'carol' })).body.invite;
    await call(w.env, '/api/doc/access', { method: 'PATCH', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, access: { allowed_users: [] } } });
    const carol = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.carol, headers: HOME, body: { origin: APP, invite: handle.id } });
    assert(carol.status === 410, `handle retake: ${carol.status} ${JSON.stringify(carol.body)}`);
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.length, 'someone got back in');
    // Invited again by the owner: a new invite that works.
    const re = await invite(w, { invitee: 'carol' });
    assert(re.status === 201 && re.body.invite.id !== handle.id, `re-invite: ${re.status} ${JSON.stringify(re.body)}`);
    const carol2 = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.carol, headers: HOME, body: { origin: APP, invite: re.body.invite.id } });
    assert(carol2.status === 200 && carol2.body.slug === w.space.slug, `after re-invite: ${carol2.status} ${JSON.stringify(carol2.body)}`);
  });

  await t('withdrawing an invite takes back what it gave; a withdrawn or expired one cannot be taken', async () => {
    const w = await world();
    const handle = (await invite(w, { invitee: 'bob' })).body.invite;
    const joined = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: handle.id } });
    assert(joined.status === 200, `bob joins: ${joined.status}`);
    const rev = await call(w.env, '/api/feedback/invites/revoke', { method: 'POST', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, id: handle.id } });
    assert(rev.status === 200, `revoke: ${rev.status} ${JSON.stringify(rev.body)}`);
    assert(!(await meta(w.env, w.space.slug)).access.allowed_users.includes('bob'), 'bob kept access');
    const sess = await call(w.env, '/api/feedback/session', { token: joined.body.token });
    assert(sess.status === 409 && sess.body.error === 'space_moved', `bob's widget after revoke: ${sess.status}`);
    const list = await call(w.env, `/api/feedback/invites?slug=${w.space.slug}`, { cookie: w.julie });
    assert(!list.body.invites.some((i) => i.id === handle.id), 'a withdrawn invite is still listed');
    // A withdrawn link.
    const link = (await invite(w, {})).body.invite;
    await call(w.env, '/api/feedback/invites/revoke', { method: 'POST', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, id: link.id } });
    const take = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.carol, headers: HOME, body: { origin: APP, invite: link.id } });
    assert(take.status === 410 && take.body.error === 'invite_revoked', `withdrawn link: ${take.status} ${JSON.stringify(take.body)}`);
    // An expired one.
    const old = (await invite(w, {})).body.invite;
    const raw = old.id.split('.')[0];
    const rec = JSON.parse(await w.env.META.get(`feedback:invite:${raw}`));
    rec.expires = new Date(Date.now() - 1000).toISOString();
    await w.env.META.put(`feedback:invite:${raw}`, JSON.stringify(rec));
    const late = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.carol, headers: HOME, body: { origin: APP, invite: old.id } });
    assert(late.status === 410 && late.body.error === 'invite_expired', `expired: ${late.status} ${JSON.stringify(late.body)}`);
    const info = await call(w.env, `/api/feedback/invite?id=${encodeURIComponent(old.id)}`);
    assert(info.body.status === 'expired', `info: ${JSON.stringify(info.body)}`);
    // Only the owner withdraws.
    const fresh = (await invite(w, {})).body.invite;
    const byBob = await call(w.env, '/api/feedback/invites/revoke', { method: 'POST', cookie: w.bob, headers: HOME, body: { slug: w.space.slug, id: fresh.id } });
    assert(byBob.status === 403, `bob revokes: ${byBob.status}`);
  });

  await t('an invite made before the space changed hands is void', async () => {
    const w = await world();
    const link = (await invite(w, {})).body.invite;
    const m = await meta(w.env, w.space.slug);
    m.hosted = { ...m.hosted, account_id: 'acct-someone-else', github_login: 'someone' };
    await w.env.META.put(`meta:${w.space.slug}`, JSON.stringify(m));
    const take = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob, headers: HOME, body: { origin: APP, invite: link.id } });
    assert(take.status === 410 && take.body.error === 'invite_revoked', `moved space: ${take.status} ${JSON.stringify(take.body)}`);
  });

  await t('SDK: the invite link is the site itself; connecting with it admits someone the space did not', async () => {
    const env = makeEnv(mod.CommentsStore);
    const julie = await putSession(env, 'julie');
    const bob = await putSession(env, 'bob');
    // A hosted account is needed to make a site space.
    await call(env, '/api/hosted/token', { method: 'POST', cookie: julie, body: { label: 'julie' } });
    const made = await call(env, '/api/feedback/spaces', { method: 'POST', cookie: julie, headers: HOME, body: { origins: ['https://app.example.com', APP] } });
    assert(made.status === 201, `space: ${made.status} ${JSON.stringify(made.body)}`);
    const slug = made.body.slug;
    const denied = await call(env, '/api/feedback/connect', { method: 'POST', cookie: bob, headers: HOME, body: { origin: 'https://app.example.com', space: slug } });
    assert(denied.status === 403 && denied.body.error === 'not_invited', `before: ${denied.status}`);
    const r = await call(env, '/api/feedback/invites', { method: 'POST', cookie: julie, headers: HOME, body: { slug } });
    assert(r.status === 201, `invite: ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.invite.link === `https://app.example.com/?tdoc_invite=${r.body.invite.id}`, r.body.invite.link);
    // Bookmarklet-style join (no space) on an SDK invite: refused.
    const wrong = await call(env, '/api/feedback/connect', { method: 'POST', cookie: bob, headers: HOME, body: { origin: 'https://app.example.com', invite: r.body.invite.id } });
    assert(wrong.status === 403 && wrong.body.error === 'invite_wrong_site', `no space: ${wrong.status}`);
    const ok = await call(env, '/api/feedback/connect', { method: 'POST', cookie: bob, headers: HOME, body: { origin: 'https://app.example.com', space: slug, invite: r.body.invite.id } });
    assert(ok.status === 200 && ok.body.site === true && ok.body.slug === slug && /^fb_/.test(ok.body.token), `sdk join: ${ok.status} ${JSON.stringify(ok.body)}`);
    assert((await meta(env, slug)).access.allowed_users.includes('bob'), 'bob not added');
    // The owner's site token manages invites too; a site token takes only its own space's.
    const owner = await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie, headers: HOME, body: { origin: APP, space: slug } });
    const listed = await call(env, `/api/feedback/invites?slug=${slug}`, { token: owner.body.token });
    assert(listed.status === 200 && listed.body.site === true, `site token list: ${listed.status} ${JSON.stringify(listed.body)}`);
    assert(owner.body.can_share === true && ok.body.can_share === false, 'can_share');
  });

  await t('the landing page: who, which site, the bookmark, and Open <site> with the invite; never a doc page', async () => {
    const w = await world();
    const link = (await invite(w, {})).body.invite;
    const page = await worker.fetch(req(`/feedback/invite/${link.id}`), w.env, {});
    assert(page.status === 200, `page: ${page.status}`);
    assert(page.headers.get('referrer-policy') === 'no-referrer', 'the invite can leak through Referer');
    const boot = bootData(await page.text(), '__TDOC_APP_BOOT__');
    assert(boot.page === 'feedback-invite' && boot.inviter === 'julie' && boot.host === 'localhost:3000', JSON.stringify(boot));
    // The site is often not the owner's: it never gets the invite.
    assert(boot.siteUrl === `${APP}/` && boot.site === false && boot.id === link.id, boot.siteUrl);
    assert(/^javascript:/.test(boot.bookmarklet), 'no bookmark');
    assert(!JSON.stringify(boot).includes(w.space.slug), 'the page names the space');
    for (const bad of ['nope', `${'0'.repeat(32)}.${'A'.repeat(22)}`]) {
      const r = await worker.fetch(req(`/feedback/invite/${bad}`), w.env, {});
      assert(r.status === 404, `bad invite page: ${r.status}`);
    }
    await call(w.env, '/api/feedback/invites/revoke', { method: 'POST', cookie: w.julie, headers: HOME, body: { slug: w.space.slug, id: link.id } });
    const gone = await worker.fetch(req(`/feedback/invite/${link.id}`), w.env, {});
    assert(gone.status === 404, `withdrawn invite page: ${gone.status}`);
  });

  await t('the connect window opened by Join says who invited them', async () => {
    const w = await world();
    const link = (await invite(w, {})).body.invite;
    const page = await worker.fetch(req(`/feedback/connect?origin=${encodeURIComponent(APP)}&invite=${encodeURIComponent(link.id)}`, { cookie: w.bob }), w.env, {});
    const boot = bootData(await page.text(), '__TDOC_APP_BOOT__');
    assert(boot.invite && boot.invite.id === link.id && boot.invite.inviter === 'julie' && boot.invite.status === 'pending', JSON.stringify(boot.invite));
    const bad = await worker.fetch(req(`/feedback/connect?origin=${encodeURIComponent(APP)}&invite=junk`, { cookie: w.bob }), w.env, {});
    const badBoot = bootData(await bad.text(), '__TDOC_APP_BOOT__');
    assert(badBoot.invite && badBoot.invite.status === 'missing' && !badBoot.invite.id, JSON.stringify(badBoot.invite));
  });

  await t('the invite routes are the only new doors a widget token opens', async () => {
    const w = await world();
    const r = await call(w.env, '/api/doc/access', { method: 'PATCH', token: w.space.token, body: { slug: w.space.slug, access: { visibility: 'public' } } });
    assert(r.status === 403 && r.body.error === 'feedback_token_scope', `token on access PATCH: ${r.status}`);
  });

  console.log(fail ? `\nFAIL — ${fail} failed, ${pass} passed` : `\nPASS — ${pass}`);
  process.exit(fail ? 1 : 0);
})();
