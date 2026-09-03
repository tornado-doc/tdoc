// Widening the identity surface: an email-only person is a full participant.
//
// Phases 1–3 let someone sign in with an OIDC provider and publish — but the
// gates that decide who may COMMENT, who is on an allowlist, and who owns
// their own words all asked for a GitHub handle. An OIDC visitor could
// publish a doc and then not leave a single comment on it, which is the one
// thing tdoc exists for.
//
// The fix is an actor key: a GitHub identity keeps its bare handle (every
// comment, inbox entry and allowlist ever written uses that shape), an
// identity with no handle takes an `email:` prefix, and everything keyed on
// "who" uses that. These tests pin the properties that makes safe:
//
//   - the two namespaces cannot collide, in either direction;
//   - an email identity can comment, and owns only its own words;
//   - email invites work (D2) without breaking handle invites;
//   - a full address never renders where readers can see it;
//   - notifications and personal state reach email identities at all.
//
// Run with: node test/email-identity-surface.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// ---- unit slice: the key functions, in isolation -------------------------
const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
function sliceFn(name) {
  const start = workerSrc.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = workerSrc.indexOf('{', start), depth = 0;
  for (; i < workerSrc.length; i++) {
    if (workerSrc[i] === '{') depth++;
    else if (workerSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return workerSrc.slice(start, i);
}
const box = {};
vm.createContext(box);
vm.runInContext([
  'normalizeGithubLogin', 'normalizeEmail', 'sessionLogin', 'sessionPrincipal',
  'actorKey', 'actorDisplayName', 'normalizeActorKey', 'normalizeInvitee', 'isAllowlisted',
  'isOwnerSession', 'isDocOwnerSession', 'hostedGithubLogin', 'canCommentOnDoc',
  'canMutate',
].map(sliceFn).join('\n'), box);

const gh = { login: 'Alice' };
const em = { email: 'Alice@Example.com', name: 'Alice A' };

(async () => {
  console.log('email identity surface');

  await t('the two namespaces cannot collide, in either direction', () => {
    assert(box.actorKey(gh) === 'alice', box.actorKey(gh));
    assert(box.actorKey(em) === 'email:alice@example.com', box.actorKey(em));
    // A GitHub handle can never contain "@", so no handle can ever normalize
    // into the email namespace…
    assert(box.normalizeActorKey('email:alice@example.com') === 'email:alice@example.com');
    assert(box.normalizeGithubLogin('alice@example.com') === null,
      'a raw address must never pass as a handle');
    // …and an address can never be read as a handle even wearing the prefix.
    assert(box.normalizeActorKey('alice') === 'alice');
    assert(box.normalizeActorKey('email:not an email') === null, 'junk must not become a key');
    // A session offering both is a GitHub user who also has an email on file:
    // the handle wins, so their existing comments and inbox stay theirs.
    assert(box.actorKey({ login: 'Alice', email: 'other@example.com' }) === 'alice');
  });

  await t('a full address never renders where readers can see it', () => {
    assert(box.actorDisplayName(em) === 'Alice A', box.actorDisplayName(em));
    // With no display name, the local part — never the domain.
    const bare = box.actorDisplayName({ email: 'Alice@Example.com' });
    assert(bare === 'alice', bare);
    assert(!String(bare).includes('@'), 'an address leaked into a display name');
  });

  await t('an email identity may comment; commenting: off still wins', () => {
    const access = { commenting: 'signed_in', allowed_users: [] };
    assert(box.canCommentOnDoc(access, em, {}, {}) === true, 'email identity cannot comment');
    assert(box.canCommentOnDoc(access, {}, {}, {}) === false, 'anonymous may comment');
    assert(box.canCommentOnDoc({ commenting: 'off' }, em, {}, {}) === false, 'off must win');
  });

  await t('email invites work, and handle invites keep working', () => {
    const byEmail = { commenting: 'invited', allowed_users: ['alice@example.com'] };
    const byHandle = { commenting: 'invited', allowed_users: ['alice'] };
    // What the owner typed is an address, so an address is what matches —
    // not the prefixed actor key.
    assert(box.isAllowlisted(byEmail, em, {}, {}) === true, 'email invite did not match');
    assert(box.isAllowlisted(byHandle, gh, {}, {}) === true, 'handle invite regressed');
    // Crossed: neither identity may borrow the other's invite.
    assert(box.isAllowlisted(byHandle, em, {}, {}) === false, 'email session matched a handle invite');
    assert(box.isAllowlisted(byEmail, gh, {}, {}) === false, 'handle session matched an email invite');
  });

  await t('nobody edits words that are not theirs', () => {
    const mine = { author: { login: 'email:alice@example.com' } };
    const theirs = { author: { login: 'bob' } };
    assert(box.canMutate(mine, em, {}, {}) === true, 'author cannot edit their own comment');
    assert(box.canMutate(theirs, em, {}, {}) === false, 'email identity edited someone else');
    assert(box.canMutate(mine, { email: 'mallory@example.com' }, {}, {}) === false,
      'a different address edited the comment');
    assert(box.canMutate(mine, {}, {}, {}) === false, 'anonymous edited a comment');
    assert(box.canMutate({ author: { login: null } }, em, {}, {}) === false,
      'a legacy null-author record must stay unowned');
  });

  // ---- integration: the real routes, with fake bindings ------------------
  const mod = await loadWorker();
  const worker = mod.default;

  // A signed-in email identity, the shape the OIDC callback mints.
  async function emailSession(env, email, name) {
    const cookie = await putSession(env, 'placeholder');
    const sid = cookie.split('=')[1];
    env.META.map.set(`session:${sid}`, JSON.stringify({
      email, name, oidc: true, created: new Date().toISOString(),
    }));
    return `tdoc_sid=${sid}`;
  }

  async function publishDoc(env, slug, access) {
    const token = 'tdoc_admin_token';
    env.TDOC_UPLOAD_TOKEN = token;
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token,
      body: { slug, version: 1, html: '<h1>doc</h1>', meta: access ? { access } : undefined },
    }), env, {});
    assert(r.status === 200, `upload failed: ${r.status} ${await r.clone().text()}`);
  }

  await t('an email identity can post a comment, and it renders without the address', async () => {
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'talkable', { visibility: 'public', commenting: 'signed_in' });
    const cookie = await emailSession(env, 'writer@example.com', 'Writer');
    const post = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie,
      body: { slug: 'talkable', version: 1, text: 'first!', anchor: { kind: 'text', text: 'doc' } },
    }), env, {});
    const posted = await post.json();
    assert(post.status === 200, `comment rejected: ${post.status} ${JSON.stringify(posted)}`);
    assert(posted.author.login === 'email:writer@example.com', `author key: ${JSON.stringify(posted.author)}`);
    assert(posted.author.name === 'Writer', 'display name lost');
    // The address must not travel to readers in any rendered field.
    assert(!String(posted.author.name).includes('@'), 'address leaked into the rendered name');
  });

  await t('an email identity edits its own comment and not another', async () => {
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'editable', { visibility: 'public', commenting: 'signed_in' });
    const mine = await emailSession(env, 'mine@example.com', 'Mine');
    const other = await emailSession(env, 'other@example.com', 'Other');
    const posted = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: mine,
      body: { slug: 'editable', version: 1, text: 'mine', anchor: { kind: 'text', text: 'doc' } },
    }), env, {})).json();
    const byOther = await worker.fetch(req('/api/comments', {
      method: 'PATCH', cookie: other,
      body: { slug: 'editable', id: posted.id, text: 'hijacked' },
    }), env, {});
    assert(byOther.status === 403, `a stranger edited the comment: ${byOther.status}`);
    const byMe = await worker.fetch(req('/api/comments', {
      method: 'PATCH', cookie: mine,
      body: { slug: 'editable', id: posted.id, text: 'edited' },
    }), env, {});
    assert(byMe.status === 200, `author could not edit: ${byMe.status} ${await byMe.clone().text()}`);
  });

  await t('an email invite opens a private doc to exactly that address', async () => {
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'invited-doc', {
      visibility: 'private', commenting: 'invited', allowed_users: ['guest@example.com'],
    });
    const guest = await emailSession(env, 'guest@example.com', 'Guest');
    const stranger = await emailSession(env, 'stranger@example.com', 'Stranger');
    const okRead = await worker.fetch(req('/d/invited-doc/v/1', { cookie: guest }), env, {});
    assert(okRead.status === 200, `invited guest was denied: ${okRead.status}`);
    const noRead = await worker.fetch(req('/d/invited-doc/v/1', { cookie: stranger }), env, {});
    assert(noRead.status === 403, `an uninvited address got in: ${noRead.status}`);
    const body = await noRead.text();
    assert(!body.includes('stranger@example.com'), 'the denial page echoed the visitor address');
  });

  await t('notifications and personal state reach an email identity', async () => {
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'starrable', { visibility: 'public', commenting: 'signed_in' });
    const cookie = await emailSession(env, 'reader@example.com', 'Reader');
    const star = await worker.fetch(req('/api/star', {
      method: 'POST', cookie, body: { slug: 'starrable', starred: true },
    }), env, {});
    assert(star.status === 200, `star rejected: ${star.status} ${await star.clone().text()}`);
    // Keyed under the actor, which is what makes it findable again — before
    // this, normalizeGithubLogin turned the whole key into null and the write
    // silently went nowhere.
    const key = [...env.META.map.keys()].find((k) => k.startsWith('stars:'));
    assert(key === 'stars:email:reader@example.com', `star key: ${key}`);
  });

  await t('the OIDC-shaped session is a first-class citizen on every keyed route', async () => {
    // The scan's headline: after the single door landed, EVERY hosted session
    // is OIDC-shaped (no login) — so any surviving sessionLogin gate was dead
    // for all users, not an edge case. This drives each rescued route once.
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'everything', { visibility: 'public', commenting: 'signed_in' });
    const cookie = await emailSession(env, 'citizen@example.com', 'Citizen');

    // reactions: toggled under the actor key, and toggle-off works
    const posted = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie,
      body: { slug: 'everything', version: 1, text: 'hi', anchor: { kind: 'text', text: 'doc' } },
    }), env, {})).json();
    const r1 = await worker.fetch(req('/api/reactions', {
      method: 'POST', cookie, body: { slug: 'everything', comment_id: posted.id, emoji: '👍' },
    }), env, {});
    assert(r1.status === 200, `react: ${r1.status} ${await r1.clone().text()}`);
    const r2 = await (await worker.fetch(req('/api/reactions', {
      method: 'POST', cookie, body: { slug: 'everything', comment_id: posted.id, emoji: '👍' },
    }), env, {})).json();
    const count = ((r2.comment || r2).reactions || {})['👍'];
    assert(!count || (Array.isArray(count) ? count.length : count) === 0,
      `second toggle did not remove the reaction: ${JSON.stringify(r2).slice(0, 200)}`);

    // folders: gate passes and state lands under the actor key
    const f = await worker.fetch(req('/api/folders', {
      method: 'POST', cookie, body: { name: '研究' },
    }), env, {});
    assert(f.status === 200, `folder create: ${f.status} ${await f.clone().text()}`);
    assert(env.META.map.has('folders:email:citizen@example.com'),
      `folder state keyed wrong: ${[...env.META.map.keys()].filter(k => k.startsWith('folders'))}`);

    // recents: recorded on a plain doc read
    await worker.fetch(req('/d/everything/v/1', { cookie }), env, {});
    assert(env.META.map.has('recents:email:citizen@example.com'),
      'a visit was not recorded for the email actor');

    // create-from-scratch: reachable and lands on an email account
    const c = await worker.fetch(req('/api/doc/create', {
      method: 'POST', cookie, body: { title: 'Fresh Doc' },
    }), env, {});
    assert(c.status === 200, `create: ${c.status} ${await c.clone().text()}`);
  });

  await t("an email-owned doc's comments notify its owner, not the operator", async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'operator' });
    // Mint an email-account token through the real flow, then publish with it.
    const owner = await emailSession(env, 'owner2@example.com', 'Owner2');
    const sid = owner.split('=')[1];
    const sess = JSON.parse(env.META.map.get(`session:${sid}`));
    env.META.map.set(`session:${sid}`, JSON.stringify({ ...sess, idp: { provider: 'oidc', sub: 'user_owner2' } }));
    const start = await (await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: {} }), env, {})).json();
    await worker.fetch(req('/api/cli/pair/approve', { method: 'POST', cookie: owner, body: { user_code: start.user_code } }), env, {});
    const poll = await (await worker.fetch(req('/api/cli/pair/poll', {
      method: 'POST', body: { user_code: start.user_code, pair_secret: start.pair_secret },
    }), env, {})).json();
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: poll.token,
      body: { slug: 'email-owned', version: 1, html: '<h1>mine</h1>' },
    }), env, {});
    assert(up.status === 200, `upload: ${up.status}`);
    // A different signed-in person comments.
    const guest = await emailSession(env, 'guest2@example.com', 'Guest2');
    const post = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: guest,
      body: { slug: 'email-owned', version: 1, text: 'nice doc', anchor: { kind: 'text', text: 'mine' } },
    }), env, {});
    assert(post.status === 200, `comment: ${post.status} ${await post.clone().text()}`);
    assert(env.META.map.has('inbox:email:owner2@example.com'),
      `owner inbox missing: ${[...env.META.map.keys()].filter(k => k.startsWith('inbox'))}`);
    assert(!env.META.map.has('inbox:operator'),
      'the comment notified the worker operator instead of the doc owner');
  });

  await t('a browser-created doc by an email user routes comments to them', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'operator' });
    const cookie = await emailSession(env, 'creator@example.com', 'Creator');
    const made = await (await worker.fetch(req('/api/doc/create', {
      method: 'POST', cookie, body: { title: 'Browser Born' },
    }), env, {})).json();
    assert(made && made.slug, `create: ${JSON.stringify(made)}`);
    const guest = await emailSession(env, 'passerby@example.com', 'Passerby');
    const post = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: guest,
      body: { slug: made.slug, version: 1, text: 'hello', anchor: { kind: 'text', text: 'Browser' } },
    }), env, {});
    assert(post.status === 200, `comment: ${post.status} ${await post.clone().text()}`);
    assert(env.META.map.has('inbox:email:creator@example.com'),
      'the browser-created doc did not route to its email owner');
    assert(!env.META.map.has('inbox:operator'), 'operator was notified instead of the owner');
  });

  await t('mentioning an address on a private doc invites the bare address, readably', async () => {
    const env = makeEnv(mod.CommentsStore);
    await publishDoc(env, 'club', {
      visibility: 'private', commenting: 'invited', allowed_users: ['host@example.com'],
    });
    // Inviting-by-mention is an owner power; make host the doc's owner the
    // way the worker records one (canonical id on both sides).
    const meta = JSON.parse(env.META.map.get('meta:club'));
    meta.hosted = { account_id: 'acct_host0000', owner_key: 'email:host@example.com' };
    env.META.map.set('meta:club', JSON.stringify(meta));
    const host = await emailSession(env, 'host@example.com', 'Host');
    const hostSid = host.split('=')[1];
    const hs = JSON.parse(env.META.map.get(`session:${hostSid}`));
    env.META.map.set(`session:${hostSid}`, JSON.stringify({ ...hs, account_id: 'acct_host0000' }));
    const post = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: host,
      body: { slug: 'club', version: 1, text: 'come look @newbie@example.com', anchor: { kind: 'text', text: 'doc' } },
    }), env, {});
    assert(post.status === 200, `comment: ${post.status} ${await post.clone().text()}`);
    const after1 = JSON.parse(env.META.map.get('meta:club'));
    const allowed = (after1.access && after1.access.allowed_users) || [];
    assert(allowed.includes('newbie@example.com'),
      `invite not stored bare: ${JSON.stringify(allowed)}`);
    assert(!allowed.some((a) => String(a).startsWith('email:')),
      `a prefixed key leaked into the allowlist: ${JSON.stringify(allowed)}`);
    // The invited address can actually read the doc.
    const newbie = await emailSession(env, 'newbie@example.com', 'Newbie');
    const read = await worker.fetch(req('/d/club/v/1', { cookie: newbie }), env, {});
    assert(read.status === 200, `invited reader got ${read.status}`);
    // And mentioning them AGAIN does not burn another slot or block them.
    await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: host,
      body: { slug: 'club', version: 1, text: 'again @newbie@example.com', anchor: { kind: 'text', text: 'doc' } },
    }), env, {});
    const after = JSON.parse(env.META.map.get('meta:club')).access.allowed_users;
    assert(after.filter((a) => a === 'newbie@example.com').length === 1,
      `re-mention duplicated the invite: ${JSON.stringify(after)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
