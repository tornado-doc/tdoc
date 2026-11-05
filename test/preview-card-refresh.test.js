// Automatic cards drawn from an older template (the green ones before #832) are
// redrawn by the hub's lazy fill and the admin backfill. The working card stays
// until the new PNG exists; authored cards and screenshots are never touched.
const assert = require('node:assert/strict');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

(async () => {
  const worker = await loadWorker({ previewRenderer: true });
  const env = makeEnv(worker.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-test-token' });
  const background = [];
  const queued = [];
  env.PREVIEW_QUEUE = { async send(job) { queued.push(job); } };
  const call = async (path, opts = {}) => {
    const response = await worker.default.fetch(req(path, opts), env, { waitUntil(task) { background.push(task); } });
    await Promise.all(background.splice(0));
    return response;
  };
  const runQueue = async () => {
    while (queued.length) {
      const job = queued.shift();
      await worker.default.queue({ messages: [{ body: job, ack() {}, retry() {} }] }, env);
    }
  };
  const record = async (slug) => JSON.parse(await env.META.get(`meta:${slug}`));
  const html = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Body of ${title}.</p></body></html>`;
  const OLD = 'aaaaaaaaaaaa';
  const oldUrl = (slug, version = 1) => `/d/${slug}/preview/v${version}-${OLD}.png`;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

  // A doc as #820..#832 stored it: the flags are there, the template number is
  // not. `card` overrides fields; a field set to undefined is left out.
  const seed = async (slug, { version = 1, card = {}, owner = null, team = null } = {}) => {
    const versions = Array.from({ length: version }, (_, i) => ({ n: i + 1, created: `2026-01-0${i + 1}T00:00:00.000Z` }));
    const preview = JSON.parse(JSON.stringify({
      excerpt: `Body of ${slug}.`, image: oldUrl(slug, version), image_v: version, image_hash: OLD,
      image_source_custom: false, image_custom: false, ...card,
    }));
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title: slug, created: versions[0].created, access: { visibility: 'public' }, versions, preview,
      ...(owner ? { hosted: { account_id: owner.account_id, owner_key: `github:${owner.login}` }, github_login: owner.login } : {}),
      ...(team ? { workspace_id: team } : {}),
    }));
    await env.DOCS.put(`docs/${slug}/v${version}/index.html`, html(slug));
    await env.DOCS.put(`docs/${slug}/v${version}/preview-${OLD}.png`, png);
    // The hub lists from these once a facet is built; publish keeps them.
    if (owner) await env.META.put(team ? `docidx:w:${team}:${slug}` : `docidx:p:${owner.account_id}:${slug}`, '1');
  };
  const backfill = async (body) => {
    const response = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { limit: 10, ...body } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const rendered = async (slug, version = 1) => (await env.DOCS.list({ prefix: `docs/${slug}/v${version}/preview-` })).objects.map((o) => o.key);
  const reset = async () => { for (const key of [...env.META.map.keys()]) if (key.startsWith('meta:')) await env.META.delete(key); };

  // ---- admin backfill ----
  await seed('green');
  await seed('green-legacy', { card: { image_source_custom: undefined, image_custom: undefined } });
  await seed('authored', { card: { image_source_custom: true, image_custom: true } });
  await seed('authored-pending', { card: { image_source_custom: true, image_custom: false } });
  await seed('authored-carried', { card: { image_source_custom: undefined, image_custom: true } });
  await seed('shot', { card: { image_source: 'screenshot' } });
  await seed('current', { card: { image_template: 2 } });
  const untouched = ['authored', 'authored-pending', 'authored-carried', 'shot', 'current'];
  const before = Object.fromEntries(await Promise.all(untouched.map(async (slug) => [slug, await env.META.get(`meta:${slug}`)])));
  const greenBefore = await env.META.get('meta:green');

  const dry = await backfill({});
  assert.equal(dry.dry_run, true);
  assert.equal(dry.eligible, 2, 'dry run counts only the two automatic cards without a marker');
  assert.equal(dry.updated + dry.queued, 0);
  assert.equal(await env.META.get('meta:green'), greenBefore, 'dry run writes no record');
  assert.equal(queued.length, 0, 'dry run queues nothing');
  assert.deepEqual(await rendered('green'), [`docs/green/v1/preview-${OLD}.png`], 'dry run stores nothing');

  const applied = await backfill({ apply: true });
  assert.equal(applied.eligible, 2);
  assert.equal(applied.queued, 2);
  assert.equal(applied.failed, 0);
  assert.equal(queued.length, 2);
  // The window while the PNG renders: nothing has moved.
  assert.equal((await record('green')).preview.image, oldUrl('green'), 'the old card stays until the new PNG exists');
  const during = await call('/d/green/v/1');
  assert.ok((await during.text()).includes(`https://tdoc.dev${oldUrl('green')}`), 'OG tag keeps a working image while rendering');
  assert.equal((await call(oldUrl('green'))).status, 200);
  // Applying again before the job ran queues nothing new.
  assert.equal((await backfill({ apply: true })).queued, 2);
  assert.equal(queued.length, 2, 'a pending card is not queued twice');
  await runQueue();

  for (const slug of ['green', 'green-legacy']) {
    const { preview, versions } = await record(slug);
    assert.equal(preview.image_template, 2);
    assert.notEqual(preview.image_hash, OLD);
    const source = await (await env.DOCS.get(`docs/${slug}/v1/preview-${preview.image_hash}.svg`)).text();
    assert.ok(source.includes('<rect width="1200" height="630" fill="#ffffff"/>'), 'drawn from the white template');
    assert.equal(preview.image_source_custom, false);
    assert.equal(preview.image_custom, false);
    assert.equal(preview.excerpt, `Body of ${slug}.`);
    assert.equal(versions.length, 1, 'a refresh creates no version');
    const card = await call(preview.image);
    assert.equal(card.status, 200);
    assert.ok(Buffer.from(await card.arrayBuffer()).length > 5_000, 'the new image is a real render');
    assert.equal((await call(oldUrl(slug))).status, 200, 'a link preview still holding the old URL keeps working');
  }
  for (const slug of untouched) assert.equal(await env.META.get(`meta:${slug}`), before[slug], `${slug} untouched by backfill`);
  assert.equal((await backfill({})).eligible, 0, 'the dry run reports nothing left');

  // An authored card from an older version is carried, not replaced by the
  // automatic one (the backfill used to build without existingPreview).
  await seed('authored-old', { version: 2, card: { image: oldUrl('authored-old', 1), image_v: 1, image_source_custom: false, image_custom: true } });
  await env.DOCS.put(`docs/authored-old/v1/preview-${OLD}.png`, png);
  await backfill({ apply: true });
  const carried = (await record('authored-old')).preview;
  assert.equal(carried.image, oldUrl('authored-old', 2));
  assert.equal(carried.image_custom, true);
  assert.equal(carried.image_template, undefined);
  await runQueue();

  // ---- a failed render ----
  await seed('doomed');
  assert.equal((await backfill({ apply: true })).queued, 1);
  const doomedJob = queued[0];
  await env.DOCS.delete(`docs/doomed/v1/preview-${doomedJob.hash}.svg`);
  const retries = [];
  await worker.default.queue({ messages: [{ body: queued.shift(), attempts: 3, ack() {}, retry() { retries.push(1); } }] }, env);
  assert.equal(retries.length, 1);
  const doomed = (await record('doomed')).preview;
  assert.equal(doomed.image, oldUrl('doomed'), 'a failed refresh keeps the working card');
  assert.ok(doomed.image_fill_failed_at);
  assert.equal(doomed.image_template, undefined);
  assert.equal((await call(oldUrl('doomed'))).status, 200);
  assert.equal((await backfill({})).eligible, 1, 'it still counts as remaining');

  // A job that lost the race to a publish or an authored card changes nothing.
  await seed('raced');
  await backfill({ apply: true });
  const racedRecord = await record('raced');
  racedRecord.preview = { ...racedRecord.preview, image_source_custom: true };
  await env.META.put('meta:raced', JSON.stringify(racedRecord));
  const racedBefore = await env.META.get('meta:raced');
  await runQueue();
  assert.equal(await env.META.get('meta:raced'), racedBefore, 'the job does not replace a card chosen meanwhile');

  // A card that is already the current look only needs its marker: no render.
  await reset();
  await seed('white');
  await backfill({ apply: true });
  const whiteHash = queued[0].hash;
  await runQueue();
  await seed('white');
  await env.DOCS.put(`docs/white/v1/preview-${whiteHash}.png`, png);
  const whiteOut = await backfill({ apply: true });
  assert.equal(whiteOut.updated, 1);
  assert.equal(queued.length, 0);
  assert.equal((await record('white')).preview.image_hash, whiteHash);

  // ---- the hub's lazy fill ----
  await reset();
  const ann = await issue(worker.default, env, 'ann');
  const me = () => call('/api/me', { token: ann.token });
  // 8 stale docs: one load takes the cap, the next load the rest.
  for (let i = 0; i < 8; i++) await seed(`mine-${i}`, { owner: ann });
  await seed('mine-authored', { owner: ann, card: { image_source_custom: true, image_custom: true } });
  await seed('mine-shot', { owner: ann, card: { image_source: 'screenshot' } });
  await seed('mine-current', { owner: ann, card: { image_template: 2 } });
  const authoredBefore = await env.META.get('meta:mine-authored');
  const shotBefore = await env.META.get('meta:mine-shot');
  const currentBefore = await env.META.get('meta:mine-current');
  const rowsBefore = (await (await me()).json()).docs;
  assert.equal(rowsBefore.length, 11);
  assert.equal(queued.length, 6, 'the per-load cap holds');
  const firstBatch = queued.map((job) => job.slug);
  await me();
  assert.equal(queued.length, 6, 'a reload does not queue the same docs twice');
  assert.deepEqual(queued.map((job) => job.slug), firstBatch);
  await runQueue();
  await me();
  assert.equal(queued.length, 2, 'the next load moves on to the rest');
  await runQueue();
  await me();
  assert.equal(queued.length, 0, 'a current-template card is not queued again');
  const rowsAfter = (await (await me()).json()).docs;
  assert.deepEqual(rowsAfter.map((row) => [row.slug, row.updated, row.latest]), rowsBefore.map((row) => [row.slug, row.updated, row.latest]),
    'a refresh changes neither updated, the hub order nor the version');
  assert.notEqual(rowsAfter.find((row) => row.slug === 'mine-0').image, rowsBefore.find((row) => row.slug === 'mine-0').image);
  assert.equal(await env.META.get('meta:mine-authored'), authoredBefore, 'an authored card is untouched by the lazy fill');
  assert.equal(await env.META.get('meta:mine-shot'), shotBefore, 'a screenshot is untouched by the lazy fill');
  assert.equal(await env.META.get('meta:mine-current'), currentBefore);

  // A doc that keeps failing steps aside instead of holding a slot forever.
  for (let i = 0; i < 6; i++) await seed(`fail-${i}`, { owner: ann });
  for (let i = 0; i < 6; i++) await env.DOCS.delete(`docs/fail-${i}/v1/index.html`);
  await seed('behind', { owner: ann });
  await me();
  const stamped = (await record('fail-0')).preview;
  assert.equal(stamped.image, oldUrl('fail-0'), 'no HTML to draw from: the working card stays');
  assert.ok(stamped.image_fill_failed_at);
  const stamps = await Promise.all(Array.from({ length: 6 }, async (_, i) => (await record(`fail-${i}`)).preview.image_fill_failed_at));
  await me();
  assert.deepEqual(queued.map((job) => job.slug), ['behind'], 'failing docs do not block the docs behind them');
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, async (_, i) => (await record(`fail-${i}`)).preview.image_fill_failed_at)), stamps,
    'and a reload does not retry them');
  await runQueue();
  // After the retry window it gets another chance.
  const aged = await record('fail-0');
  aged.preview.image_fill_failed_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await env.META.put('meta:fail-0', JSON.stringify(aged));
  await env.DOCS.put('docs/fail-0/v1/index.html', html('fail-0'));
  await me();
  assert.deepEqual(queued.map((job) => job.slug), ['fail-0'], 'retried after the window');
  await runQueue();
  const recovered = (await record('fail-0')).preview;
  assert.equal(recovered.image_template, 2);
  assert.equal(recovered.image_fill_failed_at, undefined);

  // ---- team hub ----
  const team = (await (await call('/api/teams', { method: 'POST', token: ann.token, body: { name: 'Card team' } })).json()).team;
  await seed('team-green', { owner: ann, team: team.id });
  await seed('team-authored', { owner: ann, team: team.id, card: { image_source_custom: true, image_custom: true } });
  const teamAuthored = await env.META.get('meta:team-authored');
  const teamUpdated = (await (await me()).json()).team_docs.find((row) => row.slug === 'team-green').updated;
  assert.deepEqual(queued.map((job) => job.slug), ['team-green'], 'a team doc gets the same fill');
  await runQueue();
  const teamRows = (await (await me()).json()).team_docs;
  assert.equal((await record('team-green')).preview.image_template, 2);
  assert.equal(teamRows.find((row) => row.slug === 'team-green').updated, teamUpdated);
  assert.equal(await env.META.get('meta:team-authored'), teamAuthored);

  // A viewer outside the team never triggers a write.
  const ben = await issue(worker.default, env, 'ben');
  await seed('anns-other', { owner: ann });
  await call('/api/me', { token: ben.token });
  await call('/d/anns-other/v/1');
  assert.equal(queued.length, 0, 'neither a stranger\'s hub nor a page view queues a card');

  // ---- older versions ----
  await seed('two-versions', { version: 2, owner: ann });
  await env.DOCS.put('docs/two-versions/v1/index.html', html('two-versions'));
  await me();
  await runQueue();
  const latestCard = (await record('two-versions')).preview;
  assert.equal(latestCard.image_v, 2);
  assert.ok((await (await call('/d/two-versions/v/1')).text()).includes('https://tdoc.dev/tdoc_logo-v2.png'),
    'an older version shares the logo, never a card of its own');

  console.log('✓ stale automatic cards refresh without losing a working card; authored cards, screenshots and doc order are untouched');
})().catch((error) => { console.error(error); process.exit(1); });
