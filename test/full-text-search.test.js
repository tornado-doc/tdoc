// Full-text search (Julie, 2026-10-25: "hundreds of docs and I can't find
// them"). Title, body text and comments of every doc the viewer's hub lists,
// Chinese and English, ranked, with a marked passage per result -- and never
// a word of a doc the viewer cannot read.
//
// The index is SQLite FTS5 in a Durable Object; here node:sqlite stands in
// for the Durable Object's storage.sql (test/search-workerd.test.js runs the
// same code against workerd's real SQLite). Needs Node 22+.
//
// Run with: node test/full-text-search.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const SAME = { Origin: 'https://tdoc.dev' };

(async () => {
  try { require('node:sqlite'); } catch {
    console.log('full-text search: SKIP (node:sqlite needs Node 22+)');
    return;
  }
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-secret-token', TDOC_SEARCH_CACHE_MS: '0' });
  const waits = [];
  const ctx = { waitUntil(p) { waits.push(Promise.resolve(p).catch(() => {})); } };
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.clone().text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text, r };
  };
  const settle = async () => {
    while (waits.length) await Promise.all(waits.splice(0));
    await env.COMMENTS.runAlarms();
  };
  const searchStoreIds = () => [...env.COMMENTS.states.keys()].filter((id) => String(id).startsWith('__tdoc-search__:'));
  const dropFromIndex = async (slug) => {
    for (const id of searchStoreIds()) {
      await env.COMMENTS.get(id).fetch('https://do/search', { method: 'POST', body: JSON.stringify({ slug: id, op: { kind: 'remove', slug } }) });
    }
  };
  const publish = (who, slug, html, { version = 1, title = `Title ${slug}`, access = { visibility: 'private' } } = {}) => call('/api/upload', {
    method: 'POST', token: who.token,
    body: { slug, version, html, meta: { title, access } },
  });
  const search = (who, q, space = '') => call(`/api/search?q=${encodeURIComponent(q)}${space ? `&space=${encodeURIComponent(space)}` : ''}`, { cookie: who.cookie });
  const slugs = (r) => (r.body && r.body.results || []).map((x) => x.slug);
  const hitText = (result) => result.snippet.filter((s) => s.hit).map((s) => s.text.toLowerCase());

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const carol = await issue(worker, env, 'carol');

  console.log('full-text search: body, comments, CJK, ranking, access');

  assert((await publish(alice, 'roadmap', '<h1>Roadmap</h1><p>We plan to ship full-text search tonight, then polish the hub.</p>', { title: 'Q3 roadmap' })).status === 200, 'publish roadmap');
  assert((await publish(alice, 'zh-report', '<h1>季度报告</h1><p>本季度收入增长稳定，新产品用户反馈良好。下一步：扩大团队。</p>', { title: '季度报告' })).status === 200, 'publish zh');
  assert((await publish(alice, 'search-notes', '<h1>Search notes</h1><p>Notes on search ranking.</p>', { title: 'Search notes' })).status === 200, 'publish notes');
  assert((await publish(alice, 'xss-doc', '<p>Before &lt;img src=x onerror=alert(1)&gt; payloadword &amp; after</p><script>secretscript()</script>', { title: 'Escapes <b>' })).status === 200, 'publish xss');
  assert((await publish(bob, 'bob-secret', '<p>Bob private: full-text search launch codes payloadword 收入增长</p>', { title: 'Bob secret' })).status === 200, 'publish bob');
  await settle();

  await t('signed out: 401; one character: no query', async () => {
    const anon = await call('/api/search?q=roadmap');
    assert(anon.status === 401, `anon ${anon.status}`);
    const short = await search(alice, 'r');
    assert(short.status === 200 && short.body.results.length === 0, `short ${short.status} ${short.text}`);
  });

  await t('English: body text is found, with the matching passage marked', async () => {
    const r = await search(alice, 'full-text');
    assert(r.status === 200, `${r.status} ${r.text}`);
    assert(slugs(r).join() === 'roadmap', `results ${slugs(r)}`);
    const hit = r.body.results[0];
    assert(hit.where === 'body' && hitText(hit).includes('full-text'), `snippet ${JSON.stringify(hit.snippet)}`);
    assert(hit.title === 'Q3 roadmap' && hit.updated, `row ${JSON.stringify(hit)}`);
    const caseless = await search(alice, 'FULL-TEXT SEARCH');
    assert(slugs(caseless).join() === 'roadmap', `case-insensitive ${slugs(caseless)}`);
  });

  await t('Chinese: a phrase and a two-character word are both found', async () => {
    const phrase = await search(alice, '收入增长');
    assert(slugs(phrase).join() === 'zh-report', `phrase ${slugs(phrase)}`);
    assert(hitText(phrase.body.results[0]).includes('收入增长'), `marked ${JSON.stringify(phrase.body.results[0].snippet)}`);
    const word = await search(alice, '收入');
    assert(slugs(word).join() === 'zh-report', `two chars ${slugs(word)}`);
    const mixed = await search(alice, '团队 扩大');
    assert(slugs(mixed).join() === 'zh-report', `two terms ${slugs(mixed)}`);
    const longAndShort = await search(alice, '收入增长 团队');
    assert(slugs(longAndShort).join() === 'zh-report', `a long and a short term ${slugs(longAndShort)}`);
    assert(!slugs(await search(alice, '收入增长 火箭')).length, 'every term must match');
  });

  await t('ranking: a title match comes before a body match', async () => {
    const r = await search(alice, 'search');
    assert(slugs(r).join() === 'search-notes,roadmap', `order ${slugs(r)}`);
    assert(r.body.results[0].title_marks.some((s) => s.hit && s.text === 'Search'), 'title marked');
  });

  await t("another person's private doc is never returned, not even its title", async () => {
    for (const q of ['launch codes', 'Bob secret', '收入增长', 'payloadword']) {
      const r = await search(alice, q, 'all');
      assert(!slugs(r).includes('bob-secret'), `${q}: leaked ${slugs(r)}`);
      const payload = JSON.stringify(r.body.results);
      assert(!payload.includes('launch codes') && !payload.includes('Bob private') && !payload.includes('Bob secret'), `${q}: text leaked`);
    }
    const own = await search(bob, 'launch codes');
    assert(slugs(own).join() === 'bob-secret', `bob finds his own: ${slugs(own)}`);
  });

  await t('doc text comes back as text segments, never markup', async () => {
    const r = await search(alice, 'payloadword');
    assert(slugs(r).join() === 'xss-doc', `results ${slugs(r)}`);
    const hit = r.body.results[0];
    assert(Array.isArray(hit.snippet) && hit.snippet.every((s) => typeof s.text === 'string' && typeof s.hit === 'boolean'), 'segments');
    const joined = hit.snippet.map((s) => s.text).join('');
    assert(joined.includes('<img src=x onerror=alert(1)>'), `decoded text kept as text: ${joined}`);
    assert(!joined.includes('secretscript'), 'script bodies are not indexed');
    assert(!/<mark|&lt;/.test(r.text), 'no server-side markup in the payload');
    assert(hit.title_marks.map((s) => s.text).join('') === 'Escapes <b>', 'title is text too');
  });

  await t('a new version replaces the old text', async () => {
    assert((await publish(alice, 'roadmap', '<p>Now we ship semantic answers instead.</p>', { version: 2, title: 'Q3 roadmap' })).status === 200, 'v2');
    await settle();
    assert(slugs(await search(alice, 'semantic answers')).join() === 'roadmap', 'new text found');
    assert(!slugs(await search(alice, 'full-text')).includes('roadmap'), 'old text gone');
  });

  await t('a browser save is indexed like a publish', async () => {
    const r = await call('/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'search-notes', baseVersion: 1, html: '<!doctype html><html><head><title>x</title></head><body><h1>Search notes</h1><p>Browser edited paragraph zebrafish. Notes on search ranking.</p></body></html>' } });
    assert(r.status === 200, `save ${r.status} ${r.text.slice(0, 200)}`);
    await settle();
    assert(slugs(await search(alice, 'zebrafish')).join() === 'search-notes', 'saved text found');
  });

  let commentId = '';
  await t('comments: created, edited and deleted text follows the thread', async () => {
    const posted = await call('/api/comments', { method: 'POST', cookie: alice.cookie, body: { slug: 'zh-report', version: 1, text: 'Check the marmalade budget line', anchor: null } });
    assert(posted.status === 200, `comment ${posted.status} ${posted.text}`);
    commentId = posted.body.comment ? posted.body.comment.id : posted.body.id;
    await settle();
    const found = await search(alice, 'marmalade');
    assert(slugs(found).join() === 'zh-report' && found.body.results[0].where === 'comments', `comment search ${found.text}`);
    const edited = await call('/api/comments', { method: 'PATCH', cookie: alice.cookie, body: { slug: 'zh-report', id: commentId, text: 'Check the quokka budget line' } });
    assert(edited.status === 200, `edit ${edited.status} ${edited.text}`);
    await settle();
    assert(!slugs(await search(alice, 'marmalade')).length, 'old comment text gone');
    assert(slugs(await search(alice, 'quokka')).join() === 'zh-report', 'edited text found');
    const del = await call(`/api/comments?slug=zh-report&id=${commentId}`, { method: 'DELETE', cookie: alice.cookie });
    assert(del.status === 200, `delete ${del.status} ${del.text}`);
    await settle();
    assert(!slugs(await search(alice, 'quokka')).length, 'deleted comment gone');
  });

  await t('Trash takes a doc out at once; restore brings it back; purge erases it', async () => {
    const del = await call('/api/doc?slug=search-notes', { method: 'DELETE', cookie: alice.cookie, headers: SAME });
    assert(del.status === 200, `trash ${del.status}`);
    assert(!slugs(await search(alice, 'ranking')).includes('search-notes'), 'trashed doc returned');
    const restored = await call('/api/trash/restore', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'search-notes' } });
    assert(restored.status === 200, `restore ${restored.status} ${restored.text}`);
    await settle();
    assert(slugs(await search(alice, 'Search notes')).includes('search-notes'), 'restored doc back');
    await call('/api/doc?slug=search-notes', { method: 'DELETE', cookie: alice.cookie, headers: SAME });
    const purged = await call('/api/trash/purge', { method: 'POST', cookie: alice.cookie, headers: SAME, body: { slug: 'search-notes' } });
    assert(purged.status === 200, `purge ${purged.status} ${purged.text}`);
    for (const id of searchStoreIds()) {
      const sql = env.COMMENTS.stateFor(id).storage.sql;
      assert(!sql.exec("SELECT 1 FROM search_docs WHERE slug = 'search-notes'").toArray().length, `purged doc still indexed in ${id}`);
    }
  });

  await t('team docs: members find them in the team space, outsiders never', async () => {
    const created = await call('/api/teams', { method: 'POST', cookie: carol.cookie, body: { name: 'Acme' } });
    assert(created.status === 200, `team ${created.status} ${created.text}`);
    const team = created.body.team;
    const token = team.invite_url.split('/').pop();
    assert((await call('/api/team/join', { method: 'POST', cookie: alice.cookie, body: { token } })).status === 200, 'alice joins');
    assert((await publish(carol, 'acme-plan', '<p>The capybara migration plan.</p>', { title: 'Acme plan' })).status === 200, 'carol publishes');
    const moved = await call('/api/team/move', { method: 'POST', cookie: carol.cookie, body: { slugs: ['acme-plan'], team: team.id } });
    assert(moved.status === 200, `move ${moved.status} ${moved.text}`);
    await settle();
    const member = await search(alice, 'capybara', team.id);
    assert(slugs(member).join() === 'acme-plan', `member ${member.text}`);
    assert(member.body.results[0].workspace_id === team.id, 'scoped to the team');
    assert(!slugs(await search(alice, 'capybara')).length, 'My docs space does not list team docs');
    assert(slugs(await search(alice, 'capybara', 'all')).join() === 'acme-plan', 'all spaces');
    assert(!slugs(await search(bob, 'capybara', 'all')).length, 'outsider found a team doc');
    assert(!slugs(await search(bob, 'capybara', team.id)).length, 'outsider naming the team found a team doc');
  });

  await t('a link-shared doc is searchable only once it is in the viewer\'s hub', async () => {
    assert((await publish(bob, 'bob-link', '<p>Shared wombat itinerary.</p>', { title: 'Bob link', access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] } })).status === 200, 'publish link doc');
    await settle();
    assert(!slugs(await search(alice, 'wombat', 'all')).length, 'link doc found before alice ever had it');
    const star = await call('/api/star', { method: 'POST', cookie: alice.cookie, body: { slug: 'bob-link', starred: true } });
    assert(star.status === 200, `star ${star.status} ${star.text}`);
    const r = await search(alice, 'wombat');
    assert(slugs(r).join() === 'bob-link', `after star ${r.text}`);
    // Bob makes it private again: the stale index row must not leak it.
    const priv = await call('/api/doc/access', { method: 'PATCH', token: bob.token, body: { slug: 'bob-link', access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] } } });
    assert(priv.status === 200, `private ${priv.status} ${priv.text}`);
    assert(!slugs(await search(alice, 'wombat', 'all')).length, 'a doc made private still answered');
  });

  await t('docs published before search are indexed when the hub lists them', async () => {
    // Published, then dropped from the index: what every doc published
    // before this shipped looks like to the store.
    assert((await publish(alice, 'legacy-doc', '<p>An old okapi census.</p>', { title: 'Legacy doc' })).status === 200, 'publish legacy');
    await settle();
    await dropFromIndex('legacy-doc');
    const hub = await call('/api/me', { cookie: alice.cookie });
    assert(hub.status === 200, 'hub');
    assert(!slugs(await search(alice, 'okapi')).length, 'removed from the index');
    await settle();
    assert(slugs(await search(alice, 'okapi')).join() === 'legacy-doc', 'the hub listing queued it');
    await dropFromIndex('legacy-doc');
    const before = await search(alice, 'okapi');
    assert(!slugs(before).length, 'not indexed yet');
    assert(before.body.indexing >= 1, `search reports indexing ${before.text}`);
    await settle();
    assert(slugs(await search(alice, 'okapi')).join() === 'legacy-doc', 'indexed after the store ran');
  });

  await t('admin bulk reindex: admin only, dry-run by default', async () => {
    const denied = await call('/api/admin/search/reindex', { method: 'POST', token: alice.token, body: { apply: true } });
    assert(denied.status === 403, `non-admin ${denied.status}`);
    const dry = await call('/api/admin/search/reindex', { method: 'POST', token: 'admin-secret-token', body: {} });
    assert(dry.status === 200 && dry.body.dry_run === true && dry.body.queued === 0 && dry.body.scanned > 0, `dry ${dry.text}`);
    const apply = await call('/api/admin/search/reindex', { method: 'POST', token: 'admin-secret-token', body: { apply: true } });
    assert(apply.status === 200 && apply.body.queued >= 1 && apply.body.scanned >= apply.body.queued, `apply ${apply.text}`);
    await settle();
    const stats = await call('/api/admin/search/reindex', { method: 'POST', token: 'admin-secret-token', body: {} });
    assert(stats.body.pending === 0, `queue drained ${stats.text}`);
    assert(slugs(await search(alice, '收入增长')).join() === 'zh-report', 'still searchable after a full reindex');
  });

  // ---- security review of #835 ----
  const searchStates = () => searchStoreIds().map((id) => [id, env.COMMENTS.stateFor(id)]);
  const indexedIn = (slug) => searchStates().filter(([, state]) => {
    const sql = state.storage.sql;
    try { return sql.exec('SELECT 1 FROM search_docs WHERE slug = ?', slug).toArray().length > 0; } catch { return false; }
  }).map(([id]) => id);
  const pendingTotal = () => searchStates().reduce((n, [, state]) => {
    try { return n + Number(state.storage.sql.exec('SELECT count(*) AS n FROM search_pending').toArray()[0].n); } catch { return n; }
  }, 0);

  await t('H1: a crafted doc cannot stall the store (linear stripping, capped input)', async () => {
    const crafted = [
      ['crafted-script', '<p>craftedscript marker</p>' + '<script'.repeat(80000)],
      ['crafted-noscript', '<p>craftednoscript marker</p>' + '<noscript'.repeat(40000)],
      ['crafted-comment', '<p>craftedcomment marker</p>' + '<!--'.repeat(140000)],
      ['crafted-head', '<p>craftedhead marker</p>' + '<head <style <template '.repeat(24000)],
    ];
    // Published small, then the stored bytes replaced: the crafted markup
    // goes straight to the indexer (the publish path is not what is tested).
    for (const [slug, html] of crafted) {
      const r = await publish(alice, slug, '<p>placeholder</p>');
      assert(r.status === 200, `publish ${slug} ${r.status} ${r.text.slice(0, 200)}`);
    }
    await settle();
    for (const [slug, html] of crafted) {
      await env.DOCS.put(`docs/${slug}/v1/index.html`, html);
      await dropFromIndex(slug);
    }
    await search(alice, 'queue them');
    const started = Date.now();
    await settle();
    const ms = Date.now() - started;
    assert(ms < 3000, `indexing crafted docs took ${ms}ms`);
    for (const [slug] of crafted) {
      const word = `crafted${slug.split('-')[1]}`;
      assert(slugs(await search(alice, word)).join() === slug, `${slug} text before the crafted tail is searchable`);
    }
  });

  await t('H1: the attempt is recorded before the doc is read', async () => {
    const get = env.DOCS.get.bind(env.DOCS);
    let seen = null;
    env.DOCS.get = async (key, opts) => {
      if (key.startsWith('docs/attempt-doc/')) {
        for (const [, state] of searchStates()) {
          const row = state.storage.sql.exec("SELECT tries, at FROM search_pending WHERE slug = 'attempt-doc'").toArray()[0];
          if (row) seen = row;
        }
      }
      return get(key, opts);
    };
    try {
      assert((await publish(alice, 'attempt-doc', '<p>attempt words</p>')).status === 200, 'publish');
      await settle();
    } finally { env.DOCS.get = get; }
    assert(seen && Number(seen.tries) === 1, `pending row while reading: ${JSON.stringify(seen)}`);
    assert(slugs(await search(alice, 'attempt words')).join() === 'attempt-doc', 'indexed');
  });

  await t('H1: one alarm run is bounded by bytes, not only doc count', async () => {
    const big = (i) => `<p>bulkdoc${i} ` + 'lorem ipsum dolor sit amet '.repeat(26000) + '</p>';
    for (let i = 0; i < 5; i++) assert((await publish(alice, `bulk-${i}`, big(i))).status === 200, `publish bulk-${i}`);
    while (waits.length) await Promise.all(waits.splice(0));
    await env.COMMENTS.runAlarms(1);
    const done = [0, 1, 2, 3, 4].filter((i) => indexedIn(`bulk-${i}`).length).length;
    assert(done >= 1 && done < 5, `one run indexed ${done} of 5 ~700KB docs`);
    await settle();
    assert([0, 1, 2, 3, 4].every((i) => indexedIn(`bulk-${i}`).length), 'all indexed eventually');
  });

  await t('L1: giving up on a doc clears its stale text and does not loop', async () => {
    assert((await publish(alice, 'flaky', '<p>oldflaky words</p>')).status === 200, 'v1');
    await settle();
    assert(slugs(await search(alice, 'oldflaky')).join() === 'flaky', 'v1 indexed');
    const get = env.DOCS.get.bind(env.DOCS);
    let reads = 0;
    env.DOCS.get = async (key, opts) => {
      if (key.startsWith('docs/flaky/v2/')) { reads++; throw new Error('R2 down'); }
      return get(key, opts);
    };
    try {
      assert((await publish(alice, 'flaky', '<p>newflaky words</p>', { version: 2, title: 'Title flaky' })).status === 200, 'v2');
      await settle();
      assert(!slugs(await search(alice, 'oldflaky')).length, 'stale v1 text still searchable after giving up');
      const before = reads;
      await call('/api/me', { cookie: alice.cookie });
      await search(alice, 'anything here');
      await settle();
      assert(reads === before, `a given-up version was retried (${reads - before} reads)`);
    } finally { env.DOCS.get = get; }
    assert((await publish(alice, 'flaky', '<p>thirdflaky words</p>', { version: 3, title: 'Title flaky' })).status === 200, 'v3');
    await settle();
    assert(slugs(await search(alice, 'thirdflaky')).join() === 'flaky', 'a new version is tried again');
  });

  await t('M1: search never returns a commenter-mentioned email address', async () => {
    assert((await publish(bob, 'bob-public', '<p>Public notes on the heron survey.</p>', { title: 'Heron survey', access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] } })).status === 200, 'publish');
    const c = await call('/api/comments', { method: 'POST', cookie: carol.cookie, body: { slug: 'bob-public', version: 1, text: 'Ask @dana.secret@example.com or mail dana.secret@example.com about herons', anchor: null } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    assert((await call('/api/star', { method: 'POST', cookie: alice.cookie, body: { slug: 'bob-public', starred: true } })).status === 200, 'star');
    await settle();
    for (const q of ['example.com', 'dana.secret', 'herons', 'secret@']) {
      const r = await search(alice, q, 'all');
      assert(!JSON.stringify(r.body.results).includes('@example.com'), `${q}: an address came back ${JSON.stringify(r.body.results)}`);
    }
    assert(slugs(await search(alice, 'herons', 'all')).join() === 'bob-public', 'the comment is still searchable');
  });

  await t('M2: wiping all comments takes their text out of search', async () => {
    const c = await call('/api/comments', { method: 'POST', cookie: alice.cookie, body: { slug: 'zh-report', version: 1, text: 'wipeme narwhal note', anchor: null } });
    assert(c.status === 200, `comment ${c.status}`);
    await settle();
    assert(slugs(await search(alice, 'narwhal')).join() === 'zh-report', 'comment indexed');
    const wiped = await call('/api/comments?slug=zh-report&all=1', { method: 'DELETE', token: alice.token });
    assert(wiped.status === 200, `wipe ${wiped.status} ${wiped.text}`);
    await settle();
    assert(!slugs(await search(alice, 'narwhal')).length, 'wiped comment still searchable');
  });

  await t('M3: a slow search store never holds up a save or a comment', async () => {
    const realGet = env.COMMENTS.get.bind(env.COMMENTS);
    env.COMMENTS.get = (id) => {
      const stub = realGet(id);
      if (!String(id).startsWith('__tdoc-search__')) return stub;
      return { fetch: async (...args) => { await new Promise((r) => setTimeout(r, 3000)); return stub.fetch(...args); } };
    };
    try {
      let started = Date.now();
      assert((await publish(alice, 'slow-store', '<p>slow store words</p>')).status === 200, 'publish');
      const publishMs = Date.now() - started;
      started = Date.now();
      const c = await call('/api/comments', { method: 'POST', cookie: alice.cookie, body: { slug: 'slow-store', version: 1, text: 'quick', anchor: null } });
      const commentMs = Date.now() - started;
      assert(c.status === 200, 'comment');
      assert(publishMs < 1500 && commentMs < 1500, `publish ${publishMs}ms, comment ${commentMs}ms`);
    } finally { env.COMMENTS.get = realGet; }
    await new Promise((r) => setTimeout(r, 3100));
    await settle();
  });

  await t('M4: one store per owner scope; a move to a team moves the index entry', async () => {
    const aliceStores = indexedIn('zh-report');
    assert(aliceStores.length === 1 && aliceStores[0] !== '__tdoc-search__' && /^__tdoc-search__:p:/.test(aliceStores[0]), `zh-report in ${aliceStores}`);
    const team = indexedIn('acme-plan');
    assert(team.length === 1 && /^__tdoc-search__:w:/.test(team[0]), `acme-plan in ${team}`);
    assert(indexedIn('bob-secret').every((id) => !aliceStores.includes(id)), 'bob shares a store with alice');
  });

  await t('L2: only a reserved search store answers search ops', async () => {
    const r = await env.COMMENTS.get('roadmap').fetch('https://do/search', { method: 'POST', body: JSON.stringify({ slug: 'roadmap', op: { kind: 'stats' } }) });
    const body = await r.json();
    assert(!body.ok, `a doc's store answered: ${JSON.stringify(body)}`);
  });

  await t('rate limit: 60 searches a minute per person, then 429', async () => {
    let limited = null;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await search(carol, `capybara ${i}`);
      if (r.status === 429) limited = { i, r };
      else assert(r.status === 200, `search ${i}: ${r.status}`);
    }
    assert(limited && limited.i >= 50, `limited at ${limited && limited.i}`);
    assert(limited.r.r.headers.get('retry-after'), 'Retry-After');
    const other = await search(bob, 'launch codes');
    assert(other.status === 200, 'another person is not limited');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
