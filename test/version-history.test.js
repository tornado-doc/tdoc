// Version history (shell flag versionHistory): the rows behind the history
// panel, read off the doc's own version records.
//   - consecutive saves by the same person or agent, each within 30 minutes
//     of the next, are one row; a different writer, a longer gap or a restore
//     starts a new one. Pages continue exactly where the last one ended.
//   - who: a person by login, an agent by its name and whose account it is.
//   - what changed: computed only when asked, a few per call, then cached.
//   - access: only people who may list the history (history_visibility, the
//     owner's token, team members); a private doc's stranger gets nothing.
//   - Restore: the owner's browser session saves an old version's bytes as a
//     new version; tokens, strangers and cross-origin posts are refused.
// Run with: node test/version-history.test.js
const assert = require('assert/strict');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');

const O = { Origin: 'https://tdoc.dev' };
const page = (sections) => `<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1>${
  Object.entries(sections).map(([h, ps]) => `<h2>${h}</h2>${ps.map((p) => `<p>${p}</p>`).join('')}`).join('')}</body></html>`;

(async () => {
  console.log('Version history');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, { waitUntil() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const julie = await issue(worker, env, 'julie');
  const min = await issue(worker, env, 'minchen');
  const stranger = await issue(worker, env, 'stranger');

  const v1 = { Goal: ['Launch the pricing page.'], Timeline: ['Review ends Nov 12.'], Risks: ['Customers may worry.'] };
  const v2 = { ...v1, Timeline: ['Review ends Nov 14.'] };
  const v3 = { ...v2, Risks: ['Customers keep their price.'] };
  const v4 = { ...v3, Goal: ['Launch the new pricing page.'], Risks: ['Customers keep their price.', 'Legal approves first.'] };
  const slug = 'history-plan';
  const upload = (n, sections) => call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: n, html: page(sections), meta: { title: 'Plan' } } });
  const save = (base, sections, who = julie) => call('/api/doc/versions', { method: 'POST', cookie: who.cookie, headers: O, body: { slug, baseVersion: base, html: page(sections) } });
  const meta = () => JSON.parse(env.META.map.get(`meta:${slug}`));
  const setCreated = async (times) => {
    const m = meta();
    for (const v of m.versions) if (times[v.n]) v.created = times[v.n];
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
  };
  const at = (minutes) => new Date(Date.parse('2026-11-08T09:00:00Z') + minutes * 60000).toISOString();

  await t('setup: two agent publishes, three browser saves', async () => {
    assert.equal((await upload(1, v1)).status, 200);
    assert.equal((await upload(2, v2)).status, 200);
    for (const [base, s] of [[2, v3], [3, v4], [4, { ...v4, Goal: ['Launch it.'] }]]) {
      const r = await save(base, s);
      assert.equal(r.status, 200, r.text);
    }
    // v1, v2 by the agent 10 minutes apart; v3, v4 by Julie 20 minutes apart;
    // v5 by Julie two hours later.
    await setCreated({ 1: at(0), 2: at(10), 3: at(60), 4: at(80), 5: at(200) });
    assert.equal(meta().versions.length, 5);
  });

  await t('rows: same writer within 30 minutes is one row; a longer gap or another writer starts a new one', async () => {
    const r = await call(`/api/docs/${slug}/history`, { cookie: julie.cookie });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.rows.map((x) => [x.from, x.to]), [[5, 5], [3, 4], [1, 2]]);
    assert.equal(r.body.latest_version, 5);
    assert.equal(r.body.next_before, null);
    const [newest, mid, first] = r.body.rows;
    assert.deepEqual(newest.who, { kind: 'person', name: 'julie', login: 'julie' });
    assert.equal(first.who.kind, 'agent');
    assert.equal(first.who.name, 'Agent');
    assert.equal(first.who.owner, 'julie');
    assert.equal(first.created_doc, true);
    assert.deepEqual(mid.saves.map((s) => s.n), [4, 3]);
    assert.equal(mid.created, at(80));
    assert.equal(mid.summary, null, 'nothing computed on a list');
    assert.ok(!('prompt' in mid) && !mid.saves.some((s) => 'prompt' in s), 'prompts stay out of the list');
  });

  await t('pages continue exactly where the last ended', async () => {
    const a = await call(`/api/docs/${slug}/history?limit=1`, { cookie: julie.cookie });
    assert.deepEqual(a.body.rows.map((x) => [x.from, x.to]), [[5, 5]]);
    assert.equal(a.body.next_before, 5);
    const b = await call(`/api/docs/${slug}/history?limit=1&before=5`, { cookie: julie.cookie });
    assert.deepEqual(b.body.rows.map((x) => [x.from, x.to]), [[3, 4]]);
    assert.equal(b.body.next_before, 3);
    const c = await call(`/api/docs/${slug}/history?limit=5&before=3`, { cookie: julie.cookie });
    assert.deepEqual(c.body.rows.map((x) => [x.from, x.to]), [[1, 2]]);
    assert.equal(c.body.next_before, null);
  });

  await t('what changed: sections and places, computed on request and cached', async () => {
    const r = await call(`/api/docs/${slug}/history/summaries?rows=3-4,1-2,5-5`, { cookie: julie.cookie });
    assert.equal(r.status, 200, r.text);
    // v2 -> v4: Goal changed, Risks rewritten and a paragraph added.
    assert.deepEqual(r.body.summaries['3-4'], { places: 2, sections: ['Goal', 'Risks'] });
    assert.deepEqual(r.body.summaries['5-5'], { places: 1, sections: ['Goal'] });
    // The first row is against nothing: everything is new.
    assert.equal(r.body.summaries['1-2'].places, 1);
    const cached = JSON.parse(env.META.map.get(`history-summary:${slug}`));
    assert.deepEqual(cached.rows['3-4'], r.body.summaries['3-4']);
    const listed = await call(`/api/docs/${slug}/history`, { cookie: julie.cookie });
    assert.deepEqual(listed.body.rows[1].summary, { places: 2, sections: ['Goal', 'Risks'] });
    // From the cache: no version bytes are read again.
    const gets = env.DOCS.map.size;
    const realGet = env.DOCS.get.bind(env.DOCS);
    let reads = 0;
    env.DOCS.get = (...args) => { reads++; return realGet(...args); };
    await call(`/api/docs/${slug}/history/summaries?rows=3-4`, { cookie: julie.cookie });
    env.DOCS.get = realGet;
    assert.equal(reads, 0);
    assert.equal(env.DOCS.map.size, gets);
    const bad = await call(`/api/docs/${slug}/history/summaries?rows=4-3,9-9,x`, { cookie: julie.cookie });
    assert.deepEqual(bad.body.summaries, {});
  });

  await t('access: a reader of a link doc whose history is the owner\'s gets nothing; public history is anyone\'s', async () => {
    const r = await call(`/api/docs/${slug}/history`, { cookie: stranger.cookie });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.error, 'history_hidden');
    assert.equal((await call(`/api/docs/${slug}/history/summaries?rows=3-4`, { cookie: stranger.cookie })).status, 403);
    assert.equal((await call(`/api/docs/${slug}/history`)).status, 403);
    // The boot says the same: no list, no panel.
    const html = (await call(`/d/${slug}/v/5`, { cookie: stranger.cookie })).text;
    assert.match(html, /"historyVisible":false/);
    assert.match((await call(`/d/${slug}/v/5`, { cookie: julie.cookie })).text, /"historyVisible":true/);
    const m = meta();
    m.access = { ...(m.access || {}), visibility: 'unlisted', history_visibility: 'public' };
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
    assert.equal((await call(`/api/docs/${slug}/history`, { cookie: stranger.cookie })).status, 200);
    m.access = { ...m.access, visibility: 'private', history_visibility: 'public', allowed_users: [] };
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
    const priv = await call(`/api/docs/${slug}/history`, { cookie: stranger.cookie });
    assert.notEqual(priv.status, 200, 'a private doc stays private');
    assert.ok(!/Goal|julie/.test(priv.text));
    m.access = { ...m.access, visibility: 'unlisted', history_visibility: 'owner' };
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
  });

  await t('restore: refused to strangers, tokens, other origins and the latest version', async () => {
    const r1 = await call(`/api/docs/${slug}/versions/2/restore`, { method: 'POST', cookie: stranger.cookie, headers: O });
    assert.ok([401, 403].includes(r1.status), r1.text);
    const r2 = await call(`/api/docs/${slug}/versions/2/restore`, { method: 'POST', token: julie.token, headers: O });
    assert.equal(r2.status, 403, r2.text);
    const r3 = await call(`/api/docs/${slug}/versions/2/restore`, { method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://evil.example' } });
    assert.equal(r3.status, 403, r3.text);
    const r4 = await call(`/api/docs/${slug}/versions/5/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r4.status, 409, r4.text);
    const r5 = await call(`/api/docs/${slug}/versions/42/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r5.status, 404, r5.text);
    assert.equal(meta().versions.length, 5);
  });

  await t('restore: the owner saves v2\'s bytes as v6, a row of its own', async () => {
    const r = await call(`/api/docs/${slug}/versions/2/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.version, 6);
    const v = meta().versions.find((x) => x.n === 6);
    assert.equal(v.restored_from, 2);
    assert.equal(v.author, 'julie');
    assert.equal(v.source, 'browser');
    const restored = await env.DOCS.get(`docs/${slug}/v6/index.html`);
    assert.match(await restored.text(), /Review ends Nov 14\./);
    assert.ok(!/Legal approves/.test(await (await env.DOCS.get(`docs/${slug}/v6/index.html`)).text()));
    await setCreated({ 6: at(205) });
    const list = await call(`/api/docs/${slug}/history`, { cookie: julie.cookie });
    assert.deepEqual(list.body.rows.map((x) => [x.from, x.to]), [[6, 6], [5, 5], [3, 4], [1, 2]]);
    assert.equal(list.body.rows[0].restored_from, 2);
  });

  await t('restore keeps an old version\'s widgets', async () => {
    const wslug = 'history-widgets';
    const html = (n, label) => `<!doctype html><html><body><h1>W</h1><iframe src="/d/${wslug}/v/${n}/widget/chart/index.html"></iframe><p>${label}</p></body></html>`;
    assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: wslug, version: 1, html: html(1, 'one'), meta: { title: 'W' } } })).status, 200);
    await env.DOCS.put(`docs/${wslug}/v1/widgets/chart/index.html`, '<p>chart v1</p>');
    const s2 = await call('/api/doc/versions', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: wslug, baseVersion: 1, html: html(1, 'two') } });
    assert.equal(s2.status, 200, s2.text);
    await env.DOCS.put(`docs/${wslug}/v2/widgets/chart/index.html`, '<p>chart v2</p>');
    const r = await call(`/api/docs/${wslug}/versions/1/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r.status, 200, r.text);
    const bytes = await (await env.DOCS.get(`docs/${wslug}/v3/index.html`)).text();
    assert.match(bytes, new RegExp(`/d/${wslug}/v/3/widget/chart`));
    assert.match(bytes, /<p>one<\/p>/);
    assert.equal(await (await env.DOCS.get(`docs/${wslug}/v3/widgets/chart/index.html`)).text(), '<p>chart v1</p>');
  });

  await t('a team member lists the team doc\'s history and may restore; before joining they could not', async () => {
    const tslug = 'history-team';
    assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: tslug, version: 1, html: page(v1), meta: { title: 'T' } } })).status, 200);
    assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: tslug, version: 2, html: page(v2), meta: { title: 'T' } } })).status, 200);
    assert.equal((await call(`/api/docs/${tslug}/history`, { cookie: min.cookie })).status, 403);
    const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: O, body: { name: 'Pricing' } })).body.team;
    const joined = await call('/api/team/join', { method: 'POST', cookie: min.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert.ok(joined.status < 300, joined.text);
    const moved = await call('/api/team/move', { method: 'POST', cookie: julie.cookie, headers: O, body: { team: team.id, slugs: [tslug] } });
    assert.ok(moved.status < 300, moved.text);
    const r = await call(`/api/docs/${tslug}/history`, { cookie: min.cookie });
    assert.equal(r.status, 200, r.text);
    assert.match((await call(`/d/${tslug}/v/2`, { cookie: min.cookie })).text, /"historyVisible":true/);
    const back = await call(`/api/docs/${tslug}/versions/1/restore`, { method: 'POST', cookie: min.cookie, headers: O });
    assert.equal(back.status, 200, back.text);
    assert.equal(JSON.parse(env.META.map.get(`meta:${tslug}`)).versions.find((v) => v.n === 3).author, 'minchen');
  });

  await t('a client\'s version record cannot claim a restore or a suggestion', async () => {
    const r = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'history-claims', version: 1, html: page(v1), meta: { title: 'C', versions: [{ n: 1, created: at(0), restored_from: 1, suggested_by: 'x' }] } } });
    assert.equal(r.status, 200, r.text);
    const v = JSON.parse(env.META.map.get('meta:history-claims')).versions[0];
    assert.equal(v.restored_from, undefined);
    assert.equal(v.suggested_by, undefined);
  });

  await t('summaries: only the list\'s own rows; arbitrary or many pairs are refused and write nothing', async () => {
    const rows = (await call(`/api/docs/${slug}/history`, { cookie: julie.cookie })).body.rows.map((x) => `${x.from}-${x.to}`);
    const realPut = env.META.put.bind(env.META);
    const puts = [];
    env.META.put = (k, ...rest) => { puts.push(k); return realPut(k, ...rest); };
    const realGet = env.DOCS.get.bind(env.DOCS);
    let reads = 0;
    env.DOCS.get = (...args) => { reads++; return realGet(...args); };
    try {
      // Real version numbers, but pairs no row has: nothing read, nothing cached.
      const many = [];
      for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) if (!rows.includes(`${a}-${b}`)) many.push(`${a}-${b}`);
      const r = await call(`/api/docs/${slug}/history/summaries?rows=${many.join(',')}`, { cookie: julie.cookie });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.summaries, {});
      assert.equal(reads, 0);
      assert.deepEqual(puts, []);
      // Cached rows only: still no write.
      const again = await call(`/api/docs/${slug}/history/summaries?rows=3-4,3-4,3-4`, { cookie: julie.cookie });
      assert.deepEqual(Object.keys(again.body.summaries), ['3-4']);
      assert.deepEqual(puts, []);
    } finally { env.META.put = realPut; env.DOCS.get = realGet; }
    const cached = JSON.parse(env.META.map.get(`history-summary:${slug}`)).rows;
    assert.ok(Object.keys(cached).every((id) => rows.includes(id)), Object.keys(cached).join(','));
  });

  await t('summaries: a row that fails is not tried again on every call', async () => {
    const fslug = 'history-fails';
    for (const [n, s] of [[1, v1], [2, v2]]) {
      assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: fslug, version: n, html: page(s), meta: { title: 'F' } } })).status, 200);
    }
    const m = JSON.parse(env.META.map.get(`meta:${fslug}`));
    m.versions[0].created = at(0); m.versions[1].created = at(300);
    await env.META.put(`meta:${fslug}`, JSON.stringify(m));
    await env.DOCS.delete(`docs/${fslug}/v2/index.html`);
    const realGet = env.DOCS.get.bind(env.DOCS);
    let reads = 0;
    env.DOCS.get = (...args) => { reads++; return realGet(...args); };
    try {
      const a = await call(`/api/docs/${fslug}/history/summaries?rows=2-2`, { cookie: julie.cookie });
      assert.deepEqual(a.body.summaries, {});
      assert.ok(reads > 0);
      reads = 0;
      const b = await call(`/api/docs/${fslug}/history/summaries?rows=2-2`, { cookie: julie.cookie });
      assert.deepEqual(b.body.summaries, {});
      assert.equal(reads, 0, 'the failure is remembered for a while');
    } finally { env.DOCS.get = realGet; }
    assert.equal(env.META.map.get(`history-summary:${fslug}`), undefined, 'a failure is not cached as a summary');
  });

  await t('summaries: a reader who is not signed in computes new ones only under a per-doc limit', async () => {
    const m = meta();
    m.access = { ...(m.access || {}), visibility: 'unlisted', history_visibility: 'public' };
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
    try {
      let computed = 0;
      for (let i = 0; i < 15; i++) {
        await env.META.delete(`history-summary:${slug}`);
        const r = await call(`/api/docs/${slug}/history/summaries?rows=5-5`);
        assert.equal(r.status, 200, r.text);
        if (r.body.summaries['5-5']) computed++;
      }
      assert.ok(computed >= 1 && computed <= 10, `computed ${computed}`);
      // Signed in: not limited.
      await env.META.delete(`history-summary:${slug}`);
      const signed = await call(`/api/docs/${slug}/history/summaries?rows=5-5`, { cookie: stranger.cookie });
      assert.ok(signed.body.summaries['5-5']);
    } finally {
      m.access = { ...m.access, history_visibility: 'owner' };
      await env.META.put(`meta:${slug}`, JSON.stringify(m));
    }
  });

  await t('summaries: a blank doc\'s 1-1 is not cached, and the first real save clears the cache', async () => {
    const made = await call('/api/doc/create', { method: 'POST', cookie: julie.cookie, headers: O, body: {} });
    assert.equal(made.status, 200, made.text);
    const bslug = made.body.slug;
    const first = await call(`/api/docs/${bslug}/history/summaries?rows=1-1`, { cookie: julie.cookie });
    assert.equal(first.status, 200, first.text);
    assert.ok(first.body.summaries['1-1']);
    assert.equal(env.META.map.get(`history-summary:${bslug}`), undefined, 'the scaffold\'s summary is not cached');
    // Even an entry cached before this rule goes with the overwrite.
    await env.META.put(`history-summary:${bslug}`, JSON.stringify({ rows: { '1-1': { places: 0, sections: [] } } }));
    // R2's etag condition, which the replacement writes under (FakeR2 does not model it).
    const realGet = env.DOCS.get.bind(env.DOCS), realPut = env.DOCS.put.bind(env.DOCS);
    env.DOCS.get = async (...args) => { const o = await realGet(...args); return o && { ...o, etag: 'scaffold' }; };
    env.DOCS.put = (k, v, opts) => realPut(k, v, opts && opts.onlyIf && opts.onlyIf.etagMatches === 'scaffold' ? { ...opts, onlyIf: undefined } : opts);
    let saved;
    try {
      saved = await call('/api/doc/versions', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: bslug, baseVersion: 1, html: page({ Written: ['Now it says something.'] }) } });
    } finally { env.DOCS.get = realGet; env.DOCS.put = realPut; }
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.version, 1, 'the first save replaced the scaffold');
    assert.equal(env.META.map.get(`history-summary:${bslug}`), undefined);
    const after = await call(`/api/docs/${bslug}/history/summaries?rows=1-1`, { cookie: julie.cookie });
    assert.deepEqual(after.body.summaries['1-1'].sections, ['Written']);
    assert.deepEqual(JSON.parse(env.META.map.get(`history-summary:${bslug}`)).rows['1-1'], after.body.summaries['1-1']);
  });

  await t('public history: a reader who is not signed in sees "Someone" and "Agent", never names', async () => {
    const m = meta();
    m.access = { ...(m.access || {}), visibility: 'unlisted', history_visibility: 'public' };
    await env.META.put(`meta:${slug}`, JSON.stringify(m));
    try {
      const anon = await call(`/api/docs/${slug}/history`);
      assert.equal(anon.status, 200, anon.text);
      for (const row of anon.body.rows) {
        if (row.who.kind === 'person') assert.deepEqual(row.who, { kind: 'person', name: 'Someone', login: null });
        else assert.deepEqual(row.who, { kind: 'agent', name: 'Agent', owner: null });
      }
      assert.ok(!/julie/.test(anon.text), anon.text);
      const signed = await call(`/api/docs/${slug}/history`, { cookie: stranger.cookie });
      assert.ok(signed.body.rows.some((r) => r.who.name === 'julie'));
    } finally {
      m.access = { ...m.access, history_visibility: 'owner' };
      await env.META.put(`meta:${slug}`, JSON.stringify(m));
    }
  });

  await t('restore: a team member who cannot read the private doc may not restore it', async () => {
    const tslug = 'history-team';
    const m = JSON.parse(env.META.map.get(`meta:${tslug}`));
    const count = m.versions.length;
    m.access = { ...(m.access || {}), visibility: 'private', team: false, allowed_users: [] };
    await env.META.put(`meta:${tslug}`, JSON.stringify(m));
    const r = await call(`/api/docs/${tslug}/versions/1/restore`, { method: 'POST', cookie: min.cookie, headers: O });
    assert.equal(r.status, 403, r.text);
    assert.equal(JSON.parse(env.META.map.get(`meta:${tslug}`)).versions.length, count);
    // The owner still may.
    const own = await call(`/api/docs/${tslug}/versions/1/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(own.status, 200, own.text);
  });

  await t('restore: refuses bytes the browser save would refuse (provider markup)', async () => {
    const pslug = 'history-provider';
    for (const [n, s] of [[1, v1], [2, v2]]) {
      assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: pslug, version: n, html: page(s), meta: { title: 'P' } } })).status, 200);
    }
    await env.DOCS.put(`docs/${pslug}/v1/index.html`, '<!doctype html><html><body><h1>P</h1><script id="tdoc-frame-probe" data-tdoc-provider>1</script></body></html>');
    const r = await call(`/api/docs/${pslug}/versions/1/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, 'provider_markup_forbidden');
    await env.DOCS.put(`docs/${pslug}/v1/index.html`, '<p>not a document</p>');
    const r2 = await call(`/api/docs/${pslug}/versions/1/restore`, { method: 'POST', cookie: julie.cookie, headers: O });
    assert.equal(r2.body.error, 'invalid_document_html');
    assert.equal(JSON.parse(env.META.map.get(`meta:${pslug}`)).versions.length, 2);
  });

  await t('an upload\'s extra version records do not show as the owner\'s', async () => {
    const xslug = 'history-extra';
    const r = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: xslug, version: 3, html: page(v1), meta: { title: 'X', versions: [{ n: 1, created: at(0) }, { n: 2, created: at(100) }, { n: 3, created: at(500) }] } } });
    assert.equal(r.status, 200, r.text);
    // v1 and v2 were never uploaded: records the client made up.
    const recs = JSON.parse(env.META.map.get(`meta:${xslug}`)).versions;
    assert.ok(recs.filter((v) => v.n < 3).every((v) => v.by), 'attributed to the uploading credential');
    const list = await call(`/api/docs/${xslug}/history`, { cookie: julie.cookie });
    assert.ok(list.body.rows.some((x) => x.from === 1), JSON.stringify(list.body.rows));
    assert.ok(!list.body.rows.some((x) => x.who.kind === 'person'), 'no row reads as the owner herself');
  });

  await t('the purge clears the cached summaries (deleteDocEverywhere)', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const body = src.slice(src.indexOf('async function deleteDocEverywhere'), src.indexOf('async function deleteDocEverywhere') + 6000);
    assert.match(body, /env\.META\.delete\(historySummaryKey\(slug\)\)/);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
