// My docs rows (step 1 of the /me redesign): each row says what it is (doc /
// sheet / slides), who can open it, and what is unread on it; Recent and
// Starred say when; the setup checklist only on Docs while there are fewer
// than three docs. The words come from shell/src/docs-hub/row-meta.js; the
// fields from /api/me, driven through worker.js with fake bindings. The
// activity is read from the person's own records once per load -- never a
// comment or read-state read per row.
// Run with: node test/me-rows.test.js

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const SHEET = '<h1>Budget</h1><table data-tdoc-sheet data-name="Costs"><thead><tr><th data-key="a">Item</th></tr></thead><tbody><tr data-row="1"><td>Rent</td></tr></tbody></table>';
const DECK = '<section class="slide" data-tdoc-slide><h1>Launch</h1></section><section class="slide" data-tdoc-slide><p>Two</p></section>';
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../shell/src/docs-hub/row-meta.js'), 'utf8');
  const m = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

  console.log('My docs rows: words');
  const now = Date.parse('2026-11-10T12:00:00Z');
  const before = (s) => new Date(now - s * 1000).toISOString();

  await t('relative dates: just now, minutes, hours, days, then the date', async () => {
    eq(m.relativeTime(before(20), now), 'just now');
    eq(m.relativeTime(before(5 * 60), now), '5m ago');
    eq(m.relativeTime(before(3 * 3600), now), '3h ago');
    eq(m.relativeTime(before(2 * 86400), now), '2d ago');
    eq(m.relativeTime('2026-10-01T09:00:00Z', now), 'Oct 1');
    eq(m.relativeTime('2025-03-04T09:00:00Z', now), 'Mar 4, 2025');
    // A clock a little ahead is not "in 3 minutes".
    eq(m.relativeTime(new Date(now + 90e3).toISOString(), now), 'just now');
  });

  await t('Recent / Starred: "visited 3h ago", and never a bare "visited" [the bug]', async () => {
    eq(m.datedLabel('visited', before(3 * 3600), now), 'visited 3h ago');
    eq(m.datedLabel('starred', before(2 * 86400), now), 'starred 2d ago');
    for (const missing of [undefined, null, '', 'not a date']) eq(m.datedLabel('visited', missing, now), '', `for ${missing}`);
    assert(m.absoluteTime('2026-11-08T09:05:00Z').includes('2026'), 'the hover title names the full date');
  });

  await t('type: doc, sheet or slides, with a label', async () => {
    eq(['doc', 'sheet', 'slides', undefined, 'feedback'].map((doc_type) => m.docTypeLabel(m.docTypeOf({ doc_type }))), ['Doc', 'Sheet', 'Slides', 'Doc', 'Doc']);
  });

  await t('sharing: only you / N people / team / link / public; nothing for somebody else\'s doc', async () => {
    eq(m.sharingText({ sharing: 'private' }).short, 'Only you');
    eq(m.sharingText({ sharing: 'people', shared_with: 1 }).short, '1 person');
    eq(m.sharingText({ sharing: 'people', shared_with: 3 }).short, '3 people');
    eq(m.sharingText({ sharing: 'team' }).short, 'Team');
    eq(m.sharingText({ sharing: 'team', shared_with: 2 }).short, 'Team + 2 people');
    eq(m.sharingText({ sharing: 'link' }).short, 'Link');
    assert(/anyone with the link/i.test(m.sharingText({ sharing: 'link' }).long), 'link spelled out for the label');
    eq(m.sharingText({ sharing: 'public' }).short, 'Public');
    eq(m.sharingText({}), null);
    eq(m.sharingText({ sharing: 'something-else' }), null);
  });

  await t('activity: unread comments and agent replies, or nothing', async () => {
    eq(m.activityText({}), null);
    eq(m.activityText({ activity: { comments: 0, agent: 0 } }), null);
    eq(m.activityText({ activity: { comments: 2 } }).label, '2 new comments');
    eq(m.activityText({ activity: { comments: 1, agent: 1 } }).label, '1 new comment, 1 agent reply');
    eq(m.activityText({ activity: { agent: 3 } }).label, '3 agent replies');
  });

  await t('setup checklist: Docs tab only, and only below three docs', async () => {
    for (const view of ['recent', 'starred', 'comments', 'trash', 'settings']) {
      eq(m.onboardingChecklistShown({ view, docCount: 0 }), false, `shown on ${view}`);
    }
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 0 }), true);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 2 }), true);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 3 }), false);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 24 }), false);
    eq(m.ONBOARDING_MAX_DOCS, 3);
  });

  await t('the hub mounts the checklist through that rule, not on every tab', async () => {
    const hub = fs.readFileSync(path.join(__dirname, '../shell/src/docs-hub.jsx'), 'utf8');
    const mounts = hub.match(/<OnboardingChecklist\b/g) || [];
    eq(mounts.length, 1, 'one mount');
    assert(/onboardingChecklistShown\(\{ view, docCount: hub\.docs\.length \}\) \? <OnboardingChecklist/.test(hub), 'mount is not gated by onboardingChecklistShown');
  });

  console.log('My docs rows: /api/me fields');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}, ctx = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, ctx);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  async function seed() {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await putSession(env, 'owner');
    for (const [slug, html] of [['q-sheet', SHEET], ['q-deck', DECK], ['q-doc', PROSE], ['q-private', PROSE]]) {
      const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug, version: 1, html } });
      assert(up.status === 200, `upload ${slug}: ${up.status} ${up.text}`);
    }
    const access = async (slug, patch) => {
      const r = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug, access: patch } });
      assert(r.status === 200, `access ${slug}: ${r.status} ${r.text}`);
    };
    await access('q-sheet', { visibility: 'private', allowed_users: ['bob'] });
    await access('q-deck', { visibility: 'public' });
    await access('q-doc', { visibility: 'unlisted' });
    await access('q-private', { visibility: 'private' });
    // Somebody else's doc, opened and starred by owner.
    const bobTok = await issue(worker, env, 'bob');
    const bobUp = await call(env, '/api/upload', { method: 'POST', token: bobTok.token, body: { slug: 'bobs-doc', version: 1, html: PROSE } });
    assert(bobUp.status === 200, `bob upload ${bobUp.status}`);
    await env.META.put('recents:owner', JSON.stringify({ items: [{ slug: 'bobs-doc', at: '2026-11-09T08:00:00.000Z' }, { slug: 'q-doc', at: '2026-11-08T08:00:00.000Z' }] }));
    await env.META.put('stars:owner', JSON.stringify({ items: [{ slug: 'q-deck', at: '2026-11-07T08:00:00.000Z' }] }));
    return { env, token: tok.token, owner };
  }
  const me = async (env, cookie, ctx) => (await call(env, '/api/me', { cookie }, ctx)).body;
  const row = (list, slug) => (list || []).find((r) => r.slug === slug);

  const fixture = await seed();

  await t('publishing stamps the type on the meta: sheet, slides, doc', async () => {
    const kinds = {};
    for (const slug of ['q-sheet', 'q-deck', 'q-doc']) kinds[slug] = JSON.parse(await fixture.env.META.get(`meta:${slug}`)).preview.kind;
    eq(kinds, { 'q-sheet': 'sheet', 'q-deck': 'slides', 'q-doc': 'doc' });
  });

  await t('rows carry doc_type and, on your own docs, the sharing state', async () => {
    const data = await me(fixture.env, fixture.owner);
    const pick = (slug) => { const r = row(data.docs, slug); return [r.doc_type, r.sharing, r.shared_with]; };
    eq(pick('q-sheet'), ['sheet', 'people', 1]);
    eq(pick('q-deck'), ['slides', 'public', undefined]);
    eq(pick('q-doc'), ['doc', 'link', undefined]);
    eq(pick('q-private'), ['doc', 'private', undefined]);
    // Pinning still learns the visibility from the same row.
    eq(row(data.docs, 'q-sheet').visibility, 'private');
  });

  await t('Recent and Starred rows keep their date (publicRow used to drop it) [the bug]', async () => {
    const data = await me(fixture.env, fixture.owner);
    eq(row(data.recent, 'bobs-doc').at, '2026-11-09T08:00:00.000Z');
    eq(row(data.recent, 'q-doc').at, '2026-11-08T08:00:00.000Z');
    eq(row(data.starred, 'q-deck').at, '2026-11-07T08:00:00.000Z');
  });

  await t('somebody else\'s doc says nothing about who it is shared with', async () => {
    const data = await me(fixture.env, fixture.owner);
    const bobs = row(data.recent, 'bobs-doc');
    assert(bobs && !('sharing' in bobs) && !('shared_with' in bobs) && !('visibility' in bobs), `leaked: ${JSON.stringify(bobs)}`);
    eq(row(data.recent, 'q-doc').sharing, 'link', 'your own doc in Recent says it');
  });

  await t('unread comments on a row come from the bell; reading them in the bell clears the row', async () => {
    const { env, owner } = fixture;
    const reader = await putSession(env, 'reader');
    const c = await call(env, '/api/comments', { method: 'POST', cookie: reader, body: { slug: 'q-doc', version: 1, text: 'is this final?', anchor: { kind: 'text', text: 'A sentence' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    let data = await me(env, owner);
    eq(row(data.docs, 'q-doc').activity, { comments: 1, agent: 0 });
    eq(row(data.recent, 'q-doc').activity, { comments: 1, agent: 0 }, 'the same doc in Recent');
    assert(!('activity' in row(data.docs, 'q-deck')), 'a quiet doc has no activity field');
    const read = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { all: true } });
    assert(read.status === 200, `read ${read.status}`);
    data = await me(env, owner);
    assert(!('activity' in row(data.docs, 'q-doc')), `still unread: ${JSON.stringify(row(data.docs, 'q-doc'))}`);
  });

  await t('an agent reply to your comment shows on the row until you open the thread (thread-seen)', async () => {
    const { env, owner, token } = fixture;
    const c = await call(env, '/api/comments', { method: 'POST', cookie: owner, body: { slug: 'q-deck', version: 1, text: 'tighten slide two', anchor: { kind: 'text', text: 'Two' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    const reply = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'q-deck', parent_id: c.body.id, text: 'Which part?', status: 'question', agent_login: 'claude' } });
    assert(reply.status === 200 && reply.body.id, `reply ${reply.status} ${reply.text}`);
    let data = await me(env, owner);
    eq(row(data.docs, 'q-deck').activity, { comments: 0, agent: 1 });
    eq(row(data.starred, 'q-deck').activity, { comments: 0, agent: 1 }, 'the same doc in Starred');
    // An older mark does not clear it.
    const stamp = Date.parse(reply.body.created);
    await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-deck', seen: { [c.body.id]: stamp - 1000 } } });
    eq(row((await me(env, owner)).docs, 'q-deck').activity, { comments: 0, agent: 1 }, 'cleared by an older mark');
    // Opening the thread marks it seen up to the reply: the row goes quiet.
    const seen = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-deck', seen: { [c.body.id]: stamp } } });
    assert(seen.status === 200, `seen ${seen.status} ${seen.text}`);
    data = await me(env, owner);
    assert(!('activity' in row(data.docs, 'q-deck')), `still unread: ${JSON.stringify(row(data.docs, 'q-deck'))}`);
    eq(await env.META.get('agent-unread:owner'), null, 'the empty record is removed');
  });

  await t('a thread already seen on another device clears the row on the next mark', async () => {
    const { env, owner, token } = fixture;
    const c = await call(env, '/api/comments', { method: 'POST', cookie: owner, body: { slug: 'q-doc', version: 1, text: 'second thought', anchor: { kind: 'text', text: 'A sentence' } } });
    const reply = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'q-doc', parent_id: c.body.id, text: 'Done.', status: 'answered', agent_login: 'claude' } });
    assert(reply.status === 200, `reply ${reply.status}`);
    const stamp = Date.parse(reply.body.created);
    // The server already holds the mark (made on another device), and the
    // note lands after it -- it is written after the reply, off the request.
    const first = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-doc', seen: { [c.body.id]: stamp } } });
    assert(first.status === 200 && first.body.seen[c.body.id] === stamp, `first mark ${first.status} ${first.text}`);
    await env.META.put('agent-unread:owner', JSON.stringify({ items: [{ slug: 'q-doc', thread: c.body.id, at: reply.body.created }] }));
    eq(row((await me(env, owner)).docs, 'q-doc').activity, { comments: 0, agent: 1 });
    const again = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-doc', seen: { [c.body.id]: stamp } } });
    assert(again.status === 200, `seen ${again.status} ${again.text}`);
    assert(!('activity' in row((await me(env, owner)).docs, 'q-doc')), 'not cleared by a mark the server already had');
  });

  await t('no per-row reads: one inbox and one agent record per load, never a read-state key', async () => {
    const { env, owner } = fixture;
    env.META.gets.length = 0;
    await me(env, owner);
    const gets = env.META.gets;
    eq(gets.filter((k) => k.startsWith('thread-seen:')).length, 0, 'read-state reads');
    eq(gets.filter((k) => k.startsWith('inbox:')).length, 1, 'inbox reads');
    eq(gets.filter((k) => k.startsWith('agent-unread:')).length, 1, 'agent record reads');
    // Search and the Feedback tab show no badges and pay nothing for them.
    env.META.gets.length = 0;
    await call(env, '/api/me/feedback', { cookie: owner });
    eq(env.META.gets.filter((k) => k.startsWith('inbox:') || k.startsWith('agent-unread:')).length, 0, '/api/me/feedback read the activity');
  });

  await t('docs published before the type was stamped get it on a hub load, a few at a time', async () => {
    const { env, owner } = fixture;
    for (const slug of ['q-sheet', 'q-deck']) {
      const meta = JSON.parse(await env.META.get(`meta:${slug}`));
      delete meta.preview.kind;
      await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    }
    const waits = [];
    const first = await me(env, owner, { waitUntil: (p) => waits.push(p) });
    eq(row(first.docs, 'q-sheet').doc_type, 'doc', 'unknown reads as a doc until filled');
    await Promise.all(waits);
    eq(JSON.parse(await env.META.get('meta:q-sheet')).preview.kind, 'sheet');
    eq(JSON.parse(await env.META.get('meta:q-deck')).preview.kind, 'slides');
    const second = await me(env, owner);
    eq([row(second.docs, 'q-sheet').doc_type, row(second.docs, 'q-deck').doc_type], ['sheet', 'slides']);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
