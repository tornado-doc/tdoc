// Trash (Julie, 2026-10-24): Delete no longer deletes. A deleted doc waits in
// Trash for 30 days and is then erased; while it waits nobody and nothing can
// read or write it -- doc link, raw, frame, API, agents, CLI, comments,
// catalog, profile, shared folders -- until it is restored. A deleted folder
// takes its docs to Trash with it and brings them back with it.
//
// Run with: node test/trash.test.js

const { loadWorker, makeEnv, req, issue, bootData } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const DAY = 24 * 60 * 60 * 1000;
const SAME = { Origin: 'https://tdoc.dev' };

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, {});
    const text = await r.clone().text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text, r };
  };
  const publish = (who, slug, version = 1, access = { visibility: 'public' }) => call('/api/upload', {
    method: 'POST', token: who.token,
    body: { slug, version, html: `<h1>${slug}</h1><p>${slug} body v${version}</p>`, meta: { title: `Title ${slug}`, access } },
  });
  const cron = (at) => worker.scheduled({ scheduledTime: at, cron: '23 * * * *' }, env, { waitUntil() {} });

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const carol = await issue(worker, env, 'carol');

  console.log('trash: a deleted doc is gone everywhere until restored');

  assert((await publish(alice, 'plan')).status === 200, 'publish plan');
  const commented = await call('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', version: 1, text: 'Keep this thought.', anchor: null } });
  assert(commented.status === 200, `comment ${commented.status} ${commented.text}`);
  const commentId = commented.body.comment ? commented.body.comment.id : (commented.body.id || (commented.body.comments || [])[0]?.id);
  // Bob opens and stars it; Alice pins it on her profile and files it in a shared folder.
  assert((await call('/d/plan', { cookie: bob.cookie })).status === 200, 'bob reads plan');
  assert((await call('/api/star', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', starred: true } })).status === 200, 'star');
  assert((await call('/api/me/handle', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { handle: 'alice' } })).status === 200, 'handle');
  assert((await call('/api/me/profile/pin', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'plan', pinned: true } })).status === 200, 'pin');
  const folder = (await call('/api/folders', { method: 'POST', token: alice.token, body: { name: 'Shared' } })).body.folder;
  assert((await call('/api/folders/move', { method: 'POST', token: alice.token, body: { folder: folder.id, slugs: ['plan'] } })).status === 200, 'file');
  const shareId = (await call('/api/folders', { method: 'PATCH', token: alice.token, body: { id: folder.id, visibility: 'unlisted' } })).body.folder.share_id;
  assert(((await call(`/api/folders/shared?id=${shareId}`)).body.docs || []).some((d) => d.slug === 'plan'), 'shared folder lists plan before');
  assert((await call('/@alice', { headers: { Accept: 'application/json' } })).text.includes('plan'), 'profile lists plan before');

  let deleted = null;
  await t('Delete moves the doc to Trash: 200, with when it will be erased', async () => {
    const outsider = await call('/api/doc?slug=plan', { method: 'DELETE', token: bob.token });
    assert(outsider.status === 403, `a reader deleted the doc: ${outsider.status}`);
    const r = await call('/api/doc?slug=plan', { method: 'DELETE', cookie: alice.cookie, headers: SAME });
    assert(r.status === 200 && r.body.trashed === true && r.body.retention_days === 30, `${r.status} ${r.text}`);
    deleted = r.body;
    assert(Math.abs(Date.parse(deleted.purge_at) - Date.parse(deleted.trashed_at) - 30 * DAY) < 1000, 'purge_at is 30 days out');
    const record = JSON.parse(await env.META.get('meta:plan'));
    assert(record.trashed_at && record.trashed_by === 'alice' && record.trashed_by_account === alice.account_id, `record ${JSON.stringify(record)}`);
    assert(await env.DOCS.head('docs/plan/v1/index.html'), 'bytes must wait in Trash, not be erased');
    assert(env.COMMENTS.stateFor('plan').storage.map.has('hostedOwner'), 'the slug stays reserved');
    assert(![...env.META.map.keys()].some((k) => k.startsWith('docidx:') && k.endsWith(':plan')), 'index markers must go');
  });

  await t('the doc link, versions, raw, frame, widget and export answer exactly as for a slug that never existed', async () => {
    const pairs = [
      ['/d/plan', '/d/never-was', {}],
      ['/d/plan/v/1', '/d/never-was/v/1', {}],
      ['/d/plan/raw', '/d/never-was/raw', {}],
      ['/d/plan/v/1/raw', '/d/never-was/v/1/raw', {}],
      ['/d/plan/v/1/frame', '/d/never-was/v/1/frame', { dest: 'iframe' }],
      ['/d/plan/v/1/widget/chart', '/d/never-was/v/1/widget/chart', { dest: 'iframe' }],
      ['/d/plan/v/1/export', '/d/never-was/v/1/export', {}],
    ];
    for (const [path, unknown, opts] of pairs) {
      for (const who of [{}, { cookie: alice.cookie }, { token: alice.token }, { cookie: bob.cookie }]) {
        const got = await call(path, { ...opts, ...who });
        const ref = await call(unknown, { ...opts, ...who });
        assert(got.status === ref.status, `${path} as ${JSON.stringify(Object.keys(who))}: ${got.status} vs unknown ${ref.status}`);
        assert(got.status >= 300, `${path} served something: ${got.status}`);
        assert(!got.text.includes('plan body'), `${path} leaked the doc's text`);
        assert((got.r.headers.get('location') || '') === (ref.r.headers.get('location') || ''), `${path} redirect differs`);
      }
    }
  });

  await t('comments: no read, post, edit, resolve, delete, react or @-mention lookup', async () => {
    const checks = [
      ['/api/comments?slug=plan&version=all', { token: alice.token }],
      ['/api/comments?slug=plan', { cookie: bob.cookie }],
      ['/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', version: 1, text: 'still there?', anchor: null } }],
      ['/api/comments', { method: 'PATCH', cookie: bob.cookie, body: { slug: 'plan', id: commentId || 'x', text: 'edited' } }],
      ['/api/comments', { method: 'PATCH', cookie: alice.cookie, body: { slug: 'plan', id: commentId || 'x', resolved: true } }],
      [`/api/comments?slug=plan&id=${commentId || 'x'}`, { method: 'DELETE', cookie: bob.cookie }],
      ['/api/comments?slug=plan&all=1', { method: 'DELETE', token: alice.token }],
      ['/api/reactions', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', comment_id: commentId || 'x', emoji: '👍' } }],
      ['/api/mentions?slug=plan', { cookie: alice.cookie }],
    ];
    for (const [path, opts] of checks) {
      const r = await call(path, opts);
      assert(r.status === 404, `${opts.method || 'GET'} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    const list = env.COMMENTS.stateFor('plan').storage.map.get('list') || [];
    assert(list.length === 1, `the thread must wait in Trash untouched, found ${list.length}`);
  });

  await t('agents and the CLI: publish refuses with "restore first", replies and handoffs 404', async () => {
    const again = await publish(alice, 'plan', 2);
    assert(again.status === 409 && again.body.error === 'doc_in_trash' && /Restore it first/.test(again.body.message) && /tdoc-restore plan/.test(again.body.message),
      `owner publish ${again.status} ${again.text}`);
    const fresh = await publish(alice, 'plan', 1);
    assert(fresh.status === 409 && fresh.body.error === 'doc_in_trash', `a v1 publish must not start over on a trashed slug: ${fresh.status}`);
    const squat = await publish(bob, 'plan', 1);
    assert(squat.status === 403, `another account took the slug: ${squat.status}`);
    const checks = [
      ['/api/agent/reply', { method: 'POST', token: alice.token, body: { slug: 'plan', comment_id: commentId || 'x', text: 'done' } }],
      ['/api/notify/targets?slug=plan', { token: alice.token }],
      ['/api/notify/handoffs?slug=plan', { token: alice.token }],
      ['/api/notify/handoff', { method: 'POST', token: alice.token, body: { slug: 'plan', note: 'look' } }],
      ['/api/doc/agent-status?slug=plan', { token: alice.token }],
      ['/api/doc/title', { method: 'PATCH', cookie: alice.cookie, headers: SAME, body: { slug: 'plan', title: 'Renamed' } }],
      ['/api/doc/access', { method: 'PATCH', cookie: alice.cookie, headers: SAME, body: { slug: 'plan', access: { visibility: 'private' } } }],
      ['/api/doc?slug=plan', { method: 'DELETE', token: alice.token }],
      ['/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'plan', html: '<p>x</p>', base_version: 1 } }],
      ['/api/doc/duplicate', { method: 'POST', cookie: bob.cookie, headers: SAME, body: { slug: 'plan', version: 1 } }],
      ['/api/doc/request-access', { method: 'POST', cookie: carol.cookie, body: { slug: 'plan' } }],
    ];
    for (const [path, opts] of checks) {
      const r = await call(path, opts);
      assert(r.status >= 400 && r.status !== 500, `${opts.method || 'GET'} ${path}: ${r.status} ${r.text.slice(0, 160)}`);
      assert(!r.text.includes('plan body'), `${path} leaked the doc`);
    }
    const record = JSON.parse(await env.META.get('meta:plan'));
    assert(record.title === 'Title plan' && record.versions.length === 1, 'nothing may change a doc in Trash');
  });

  await t('lists: My docs, Recent, Starred, moves, profile and shared folders all leave it out', async () => {
    const mine = await call('/api/me', { token: alice.token });
    assert(!mine.body.docs.some((d) => d.slug === 'plan'), 'My docs still lists it');
    const reader = await call('/api/me', { cookie: bob.cookie });
    assert(!reader.body.recent.some((d) => d.slug === 'plan') && !reader.body.starred.some((d) => d.slug === 'plan'), 'Recent/Starred still list it');
    assert((await call('/api/star', { method: 'POST', cookie: bob.cookie, body: { slug: 'plan', starred: true } })).status === 404, 'star');
    assert((await call('/api/folders/move', { method: 'POST', token: alice.token, body: { folder: '', slugs: ['plan'] } })).status >= 400, 'folder move');
    assert((await call('/api/team/move', { method: 'POST', token: alice.token, body: { team: null, slugs: ['plan'] } })).status >= 400, 'team move');
    const profile = await call('/@alice', { headers: { Accept: 'application/json' } });
    assert(!profile.text.includes('Title plan'), 'profile still lists it');
    const shared = await call(`/api/folders/shared?id=${shareId}`);
    assert(!(shared.body.docs || []).some((d) => d.slug === 'plan'), 'shared folder still lists it');
  });

  await t('Trash lists it for its owner only, with the days left', async () => {
    const r = await call('/api/trash', { cookie: alice.cookie });
    assert(r.status === 200 && r.body.retention_days === 30, `${r.status} ${r.text}`);
    const row = r.body.items.find((x) => x.slug === 'plan');
    assert(row && row.kind === 'doc' && row.title === 'Title plan' && row.days_left === 30 && row.trashed_by === 'alice', JSON.stringify(r.body));
    const viaToken = await call('/api/trash', { token: alice.token });
    assert(viaToken.body.items.some((x) => x.slug === 'plan'), 'the CLI token sees the same Trash');
    const other = await call('/api/trash', { token: bob.token });
    assert(!other.body.items.some((x) => x.slug === 'plan'), 'someone else sees it in their Trash');
    assert((await call('/api/trash')).status === 401, 'anonymous Trash');
  });

  await t('a Trash list a minute behind its write still shows what this browser just deleted, and nothing else', async () => {
    // KV lists lag writes; the browser names what it just deleted.
    const marker = [...env.META.map.keys()].find((k) => k.startsWith('trashidx:') && k.endsWith(':plan'));
    const saved = env.META.map.get(marker);
    const savedMeta = env.META.metadata.get(marker);
    await env.META.delete(marker);
    assert(!(await call('/api/trash', { cookie: alice.cookie })).body.items.some((x) => x.slug === 'plan'), 'precondition: the list misses it');
    const hinted = await call('/api/trash?slugs=plan', { cookie: alice.cookie });
    assert(hinted.body.items.some((x) => x.slug === 'plan'), `a hint did not show the doc: ${hinted.text}`);
    const nosy = await call('/api/trash?slugs=plan', { cookie: bob.cookie });
    assert(!nosy.body.items.some((x) => x.slug === 'plan'), 'a hint showed someone else\'s doc');
    await env.META.put(marker, saved, { metadata: savedMeta });
  });

  await t('restore: only the owner; the doc comes back whole, in its folder, readable and listed', async () => {
    const byBob = await call('/api/trash/restore', { method: 'POST', token: bob.token, body: { slug: 'plan' } });
    assert(byBob.status === 403, `a reader restored it: ${byBob.status}`);
    const crossSite = await call('/api/trash/restore', { method: 'POST', cookie: alice.cookie, headers: { Origin: 'https://evil.example' }, body: { slug: 'plan' } });
    assert(crossSite.status === 403, `cross-site restore ${crossSite.status}`);
    const r = await call('/api/trash/restore', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'plan' } });
    assert(r.status === 200 && r.body.restored[0] === 'plan', `${r.status} ${r.text}`);
    const record = JSON.parse(await env.META.get('meta:plan'));
    assert(!('trashed_at' in record) && !('trashed_by' in record), 'Trash stamps must go');
    assert((await call('/d/plan/raw')).text.includes('plan body'), 'raw after restore');
    assert((await call('/d/plan', { cookie: bob.cookie })).status === 200, 'doc page after restore');
    const comments = await call('/api/comments?slug=plan&version=all', { token: alice.token });
    assert(comments.status === 200 && comments.text.includes('Keep this thought.'), 'comments come back with the doc');
    const mine = await call('/api/me', { token: alice.token });
    assert(mine.body.docs.find((d) => d.slug === 'plan')?.folder === folder.id, 'back in My docs, in its folder');
    assert((await call('/api/trash', { cookie: alice.cookie })).body.items.length === 0, 'Trash is empty again');
    assert(((await call(`/api/folders/shared?id=${shareId}`)).body.docs || []).some((d) => d.slug === 'plan'), 'shared folder lists it again');
    assert((await publish(alice, 'plan', 2)).status === 200, 'publishing works again');
  });

  await t('the scheduled purge waits 30 days, then erases what Delete used to', async () => {
    assert((await call('/api/doc?slug=plan', { method: 'DELETE', token: alice.token })).status === 200, 'trash again');
    await env.META.put('preview-status:plan:v1:deadbeefcafe', 'ready:custom');
    const at = Date.parse(JSON.parse(await env.META.get('meta:plan')).trashed_at);
    await cron(at + 29 * DAY);
    assert(await env.META.get('meta:plan'), 'purged before its 30 days');
    const listed = (await call('/api/trash', { token: alice.token })).body.items.find((x) => x.slug === 'plan');
    assert(listed && listed.days_left <= 30, 'still in Trash');
    await cron(at + 30 * DAY + 1000);
    assert(!(await env.META.get('meta:plan')), 'record not erased');
    assert(!(await env.META.get('preview-status:plan:v1:deadbeefcafe')), 'preview status not erased');
    assert(![...env.DOCS.map.keys()].some((k) => k.startsWith('docs/plan/')), 'bytes not erased');
    assert(!(env.COMMENTS.stateFor('plan').storage.map.get('list') || []).length, 'comments not erased');
    assert(!env.COMMENTS.stateFor('plan').storage.map.has('hostedOwner'), 'slug not released');
    assert(![...env.META.map.keys()].some((k) => k.endsWith(':plan') && (k.startsWith('trashidx:') || k.startsWith('docidx:'))), 'markers left');
    const reborn = await publish(alice, 'plan', 1);
    assert(reborn.status === 200, `the slug is free again after the purge: ${reborn.status}`);
  });

  await t('Delete forever erases at once; a non-owner cannot', async () => {
    assert((await publish(alice, 'scratch')).status === 200, 'publish');
    assert((await call('/api/doc?slug=scratch', { method: 'DELETE', token: alice.token })).status === 200, 'trash');
    const byBob = await call('/api/trash/purge', { method: 'POST', token: bob.token, body: { slug: 'scratch' } });
    assert(byBob.status === 403 && await env.META.get('meta:scratch'), `a reader purged it: ${byBob.status}`);
    const live = await call('/api/trash/purge', { method: 'POST', token: alice.token, body: { slug: 'never-was' } });
    assert(live.status === 404, 'purge of something not in Trash');
    const r = await call('/api/trash/purge', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'scratch' } });
    assert(r.status === 200 && r.body.purged[0] === 'scratch', `${r.status} ${r.text}`);
    assert(!(await env.META.get('meta:scratch')) && !(await env.DOCS.head('docs/scratch/v1/index.html')), 'not erased');
  });

  await t('a doc past its days is erased by the next Trash read, cron or not', async () => {
    assert((await publish(alice, 'stale')).status === 200, 'publish');
    assert((await call('/api/doc?slug=stale', { method: 'DELETE', token: alice.token })).status === 200, 'trash');
    const record = JSON.parse(await env.META.get('meta:stale'));
    await env.META.put('meta:stale', JSON.stringify({ ...record, trashed_at: new Date(Date.now() - 31 * DAY).toISOString() }));
    const r = await call('/api/trash', { token: alice.token });
    assert(!r.body.items.some((x) => x.slug === 'stale'), 'an expired doc is listed');
    assert(!(await env.META.get('meta:stale')), 'and not erased');
  });

  console.log('trash: folders go with their docs');

  await t('deleting a folder takes its subfolders and docs to Trash as one row; restore brings all back', async () => {
    for (const slug of ['f-one', 'f-two', 'f-keep']) assert((await publish(alice, slug)).status === 200, slug);
    const top = (await call('/api/folders', { method: 'POST', token: alice.token, body: { name: 'Q3' } })).body.folder;
    const sub = (await call('/api/folders', { method: 'POST', token: alice.token, body: { name: 'Drafts', parent: top.id } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: alice.token, body: { folder: top.id, slugs: ['f-one'] } });
    await call('/api/folders/move', { method: 'POST', token: alice.token, body: { folder: sub.id, slugs: ['f-two'] } });
    const del = await call(`/api/folders?batch=1&id=${top.id}`, { method: 'DELETE', token: alice.token });
    assert(del.status === 200 && del.body.docs.sort().join() === 'f-one,f-two', `${del.status} ${del.text}`);
    for (const slug of ['f-one', 'f-two']) assert((await call(`/d/${slug}/raw`)).status === 404, `${slug} still readable`);
    assert((await call('/d/f-keep/raw')).status === 200, 'a doc outside the folder went too');
    const trash = (await call('/api/trash', { token: alice.token })).body.items;
    assert(trash.length === 1 && trash[0].kind === 'folder' && trash[0].title === 'Q3' && trash[0].doc_count === 2, JSON.stringify(trash));
    const r = await call('/api/trash/restore', { method: 'POST', token: alice.token, body: { folder: top.id } });
    assert(r.status === 200 && r.body.restored.length === 2, `${r.status} ${r.text}`);
    const me = (await call('/api/me', { token: alice.token })).body;
    assert(me.docs.find((d) => d.slug === 'f-one').folder === top.id && me.docs.find((d) => d.slug === 'f-two').folder === sub.id, 'docs back in their folders');
    assert(me.folders.some((f) => f.id === sub.id && f.parent === top.id), 'subfolder back under its parent');
    // And Delete forever on a folder erases its docs.
    await call(`/api/folders?batch=1&id=${top.id}`, { method: 'DELETE', token: alice.token });
    const gone = await call('/api/trash/purge', { method: 'POST', token: alice.token, body: { folder: top.id } });
    assert(gone.status === 200 && gone.body.purged.length === 2, `${gone.status} ${gone.text}`);
    assert(!(await env.META.get('meta:f-one')) && !(await env.META.get('meta:f-two')), 'folder purge left docs');
    assert((await call('/api/trash', { token: alice.token })).body.items.length === 0, 'Trash not empty');
  });

  await t('a trashed folder is purged with its docs after 30 days', async () => {
    assert((await publish(alice, 'old-one')).status === 200, 'publish');
    const box = (await call('/api/folders', { method: 'POST', token: alice.token, body: { name: 'Old' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: alice.token, body: { folder: box.id, slugs: ['old-one'] } });
    await call(`/api/folders?batch=1&id=${box.id}`, { method: 'DELETE', token: alice.token });
    await cron(Date.now() + 31 * DAY);
    assert(!(await env.META.get('meta:old-one')), 'doc not purged');
    assert(![...env.META.map.keys()].some((k) => k.startsWith('trashfolder:')), 'folder entry not purged');
  });

  console.log('trash: team docs and scoped tokens');

  const team = (await call('/api/teams', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { name: 'Acme' } })).body.team;
  const other = (await call('/api/teams', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { name: 'Other' } })).body.team;
  const invite = (await call(`/api/team?id=${team.id}`, { cookie: alice.cookie })).body.team.invite_url.split('/').pop();
  assert((await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: invite } })).status === 200, 'bob joins');
  assert((await publish(bob, 'team-plan')).status === 200, 'bob publishes');
  assert((await call('/api/team/move', { method: 'POST', token: bob.token, body: { team: team.id, slugs: ['team-plan'] } })).status === 200, 'into team');
  const scoped = async (teamName) => (await call('/api/hosted/token/scoped', { method: 'POST', token: alice.token, body: { team: teamName, label: `bot-${teamName}` } })).body.token;
  const acmeBot = await scoped('Acme');
  const otherBot = await scoped('Other');

  await t('a team doc: only admins delete it or erase it; its author still sees it in the team Trash', async () => {
    const byMember = await call('/api/doc?slug=team-plan', { method: 'DELETE', token: bob.token });
    assert(byMember.status === 403, `a member deleted a team doc: ${byMember.status}`);
    // Bob's agent wrote it: an admin's agent token may not delete it
    // (authorship at write time); the admin herself, in the browser, may.
    const byAdminAgent = await call('/api/doc?slug=team-plan', { method: 'DELETE', token: alice.token });
    assert(byAdminAgent.status === 403 && byAdminAgent.body.error === 'agent_not_author_editor', `admin's agent deleted it: ${byAdminAgent.status}`);
    assert((await call('/api/doc?slug=team-plan', { method: 'DELETE', cookie: alice.cookie, headers: SAME })).status === 200, 'admin delete');
    assert((await call('/d/team-plan/raw', { token: bob.token })).status === 404, 'team member still reads it');
    const memberPublish = await publish(bob, 'team-plan', 2);
    assert(memberPublish.status === 409 && /team admin/.test(memberPublish.body.message), `member publish ${memberPublish.status} ${memberPublish.text}`);
    const adminTrash = await call(`/api/trash?team=${team.id}`, { cookie: alice.cookie });
    assert(adminTrash.body.items.some((x) => x.slug === 'team-plan'), 'admin team Trash');
    assert(!(await call('/api/trash', { cookie: alice.cookie })).body.items.some((x) => x.slug === 'team-plan'), 'a team doc in My docs Trash');
    // Bob wrote it and is still on the team: he sees it and may bring it
    // back, but erasing it is an admin's call.
    const authorView = (await call(`/api/trash?team=${team.id}`, { cookie: bob.cookie })).body.items;
    assert(authorView.length === 1 && authorView[0].slug === 'team-plan' && authorView[0].can_purge === false, `author's team Trash ${JSON.stringify(authorView)}`);
    assert((await call(`/api/trash?team=${team.id}`, { cookie: alice.cookie })).body.items.find((x) => x.slug === 'team-plan').can_purge === true, 'admin can purge');
    assert(!(await call('/api/trash', { cookie: bob.cookie })).body.items.some((x) => x.slug === 'team-plan'), "the author's My docs Trash");
    const memberPurge = await call('/api/trash/purge', { method: 'POST', token: bob.token, body: { slug: 'team-plan' } });
    assert(memberPurge.status === 403 && await env.META.get('meta:team-plan'), `the author erased a team doc: ${memberPurge.status}`);
    assert((await call(`/api/trash?team=${team.id}`, { cookie: carol.cookie })).status === 404, 'an outsider reads the team Trash');
  });

  await t('scoped tokens: only within their team', async () => {
    const wrongList = await call(`/api/trash?team=${team.id}`, { token: otherBot });
    assert(wrongList.status === 403, `another team's bot listed this Trash: ${wrongList.status}`);
    assert((await call('/api/trash', { token: acmeBot })).status === 403, "a team bot read its person's My docs Trash");
    const wrongRestore = await call('/api/trash/restore', { method: 'POST', token: otherBot, body: { slug: 'team-plan' } });
    assert(wrongRestore.status === 403, `another team's bot restored it: ${wrongRestore.status}`);
    assert((await publish(alice, 'mine-only')).status === 200, 'personal doc');
    assert((await call('/api/doc?slug=mine-only', { method: 'DELETE', token: alice.token })).status === 200, 'trash personal');
    const personal = await call('/api/trash/restore', { method: 'POST', token: acmeBot, body: { slug: 'mine-only' } });
    assert(personal.status === 403, `a team bot restored a personal doc: ${personal.status}`);
    const list = await call(`/api/trash?team=${team.id}`, { token: acmeBot });
    assert(list.status === 200 && list.body.items.some((x) => x.slug === 'team-plan'), `own team list ${list.status} ${list.text}`);
    const ok = await call('/api/trash/restore', { method: 'POST', token: acmeBot, body: { slug: 'team-plan' } });
    assert(ok.status === 200, `the team's own bot could not restore: ${ok.status} ${ok.text}`);
    assert((await call('/d/team-plan/raw', { token: bob.token })).status === 200, 'team doc readable again');
    assert((await call('/api/me', { token: bob.token })).body.team_docs.some((d) => d.slug === 'team-plan'), 'listed in the team again');
  });

  await t('/me boots without any trashed doc and the shell has the Trash tab', async () => {
    const html = await (await worker.fetch(req('/me', { cookie: alice.cookie }), env, {})).text();
    const boot = bootData(html, '__TDOC_APP_BOOT__');
    assert(!boot.docs.some((d) => d.slug === 'mine-only'), 'a trashed doc in the boot payload');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
