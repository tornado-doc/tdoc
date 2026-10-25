// Trash, hardened after the security review of #815: a purge cut short
// cannot resurrect a thread, restoring cannot beat the docs quota, a folder
// delete that stopped half way strands nothing, every request stays inside
// the KV budget, a Trash read cannot turn into a mass purge, R2 is erased a
// page at a time, a write racing the delete cannot bring the doc back, an old
// CLI is told what changed, and the CLI can erase for good.
//
// Run with: node test/trash-hardening.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
// The worker logs product events on stdout; the cases' own lines go here.
const log = console.log.bind(console);
async function t(n, fn) {
  try { await fn(); log(`  ✓ ${n}`); pass++; } catch (e) { log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const DAY = 24 * 60 * 60 * 1000;
const SAME = { Origin: 'https://tdoc.dev' };

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const quiet = console.log;
  const fresh = async (extra = {}) => {
    const env = makeEnv(mod.CommentsStore, extra);
    const call = async (p, opts = {}) => {
      const r = await worker.fetch(req(p, opts), env, {});
      const text = await r.clone().text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { status: r.status, body, text };
    };
    const publish = (who, slug) => call('/api/upload', {
      method: 'POST', token: who.token,
      body: { slug, version: 1, html: `<h1>${slug}</h1><p>body of ${slug}</p>`, meta: { title: slug, access: { visibility: 'public' } } },
    });
    const live = (slug) => { const m = JSON.parse(env.META.map.get(`meta:${slug}`) || 'null'); return !!m && !m.trashed_at; };
    const trashed = (slug) => { const m = JSON.parse(env.META.map.get(`meta:${slug}`) || 'null'); return !!m && !!m.trashed_at; };
    const countKv = () => {
      const counter = { ops: 0 };
      for (const m of ['get', 'put', 'delete', 'list', 'getWithMetadata']) {
        const o = env.META[m].bind(env.META);
        env.META[m] = (...x) => { counter.ops += 1; return o(...x); };
      }
      return counter;
    };
    return { env, call, publish, live, trashed, countKv };
  };
  // Folder delete the way the clients do it: a batch per request.
  const deleteFolder = async (call, who, id, team = '') => {
    const calls = [];
    let after = '';
    for (;;) {
      const r = await call(`/api/folders?batch=1&id=${id}${team ? `&team=${team}` : ''}${after ? `&after=${after}` : ''}`, { method: 'DELETE', token: who.token });
      calls.push(r);
      if (r.status !== 200 || !r.body.remaining) return calls;
      after = r.body.after;
    }
  };
  log('trash hardening (#815 review)');
  console.log = () => {};

  await t('a purge cut short leaves the doc in Trash, and the next run finishes it: no thread survives a republish', async () => {
    const { env, call, publish, trashed } = await fresh();
    const a = await issue(worker, env, 'alice');
    const b = await issue(worker, env, 'bob');
    await publish(a, 'pp');
    await call('/api/comments', { method: 'POST', cookie: b.cookie, body: { slug: 'pp', version: 1, text: 'secret old comment', anchor: null } });
    await env.META.put('handoffs:pp', '[{"handoff_id":"h1"}]');
    await call('/api/doc?slug=pp', { method: 'DELETE', token: a.token });
    // The comments wipe dies (a subrequest limit) in the middle of the purge.
    const ns = env.COMMENTS; const get = ns.get.bind(ns); let armed = true;
    ns.get = (id) => {
      const stub = get(id);
      return { fetch: (u, o) => {
        if (armed && String(u).includes('/mutate') && o && String(o.body).includes('wipe')) { armed = false; throw new Error('subrequest limit'); }
        return stub.fetch(u, o);
      } };
    };
    let first;
    try { first = await call('/api/trash/purge', { method: 'POST', token: a.token, body: { slug: 'pp' } }); } catch (e) { first = { status: 'threw' }; }
    assert(first.status !== 200, `a failed purge said ok: ${first.status}`);
    assert(trashed('pp'), 'the record went before the purge finished');
    assert([...env.META.map.keys()].some((k) => k.startsWith('trashidx:') && k.endsWith(':pp')), 'the Trash marker went before the purge finished');
    await worker.scheduled({ scheduledTime: Date.now() + 31 * DAY }, env, {});
    assert(!env.META.map.has('meta:pp') && !env.META.map.has('handoffs:pp'), 'the next run did not finish the purge');
    assert(![...env.META.map.keys()].some((k) => k.endsWith(':pp') && k.startsWith('trashidx:')), 'marker left after a finished purge');
    assert((await publish(a, 'pp')).status === 200, 'republish');
    const comments = await call('/api/comments?slug=pp');
    assert(comments.status === 200 && !comments.text.includes('secret old comment'), `the old thread came back: ${comments.text.slice(0, 200)}`);
  });

  await t('a purge that stopped after the record went is finished by the scheduled run before its marker goes', async () => {
    const { env, call, publish } = await fresh();
    const a = await issue(worker, env, 'alice');
    await publish(a, 'half');
    await call('/api/doc?slug=half', { method: 'DELETE', token: a.token });
    // Releasing the slug fails: everything else is erased, the marker stays.
    const ns = env.COMMENTS; const get = ns.get.bind(ns); let armed = true;
    ns.get = (id) => {
      const stub = get(id);
      return { fetch: (u, o) => {
        if (armed && String(u).includes('/owner') && o && String(o.body).includes('release_owner')) { armed = false; return Promise.resolve(Response.json({ ok: false, status: 503, error: 'forced' })); }
        return stub.fetch(u, o);
      } };
    };
    const r = await call('/api/trash/purge', { method: 'POST', token: a.token, body: { slug: 'half' } });
    assert(r.status === 503, `release failure must surface: ${r.status}`);
    assert(!env.META.map.has('meta:half'), 'record kept');
    assert([...env.META.map.keys()].some((k) => k.startsWith('trashidx:') && k.endsWith(':half')), 'marker dropped before the purge finished');
    // A Trash read does not sweep it: only the run that finishes the purge does.
    await call('/api/trash', { token: a.token });
    assert([...env.META.map.keys()].some((k) => k.startsWith('trashidx:') && k.endsWith(':half')), 'a Trash read swept an unfinished purge');
    await worker.scheduled({ scheduledTime: Date.now() + 31 * DAY }, env, {});
    assert(![...env.META.map.keys()].some((k) => k.startsWith('trashidx:') && k.endsWith(':half')), 'marker left after the purge finished');
    assert(!env.COMMENTS.stateFor('half').storage.map.has('hostedOwner'), 'slug never released');
  });

  await t('Delete forever erases R2 a page at a time, not a call per file', async () => {
    const { env, call, publish } = await fresh();
    const a = await issue(worker, env, 'alice');
    await publish(a, 'many');
    for (let i = 0; i < 30; i++) await env.DOCS.put(`docs/many/v1/assets/a${i}.png`, 'x');
    await call('/api/doc?slug=many', { method: 'DELETE', token: a.token });
    let deletes = 0; const del = env.DOCS.delete.bind(env.DOCS);
    env.DOCS.delete = (k) => { deletes += 1; return del(k); };
    assert((await call('/api/trash/purge', { method: 'POST', token: a.token, body: { slug: 'many' } })).status === 200, 'purge');
    assert(deletes === 1, `R2 delete calls: ${deletes}`);
    assert(![...env.DOCS.map.keys()].some((k) => k.startsWith('docs/many/')), 'bytes left');
  });

  await t('restoring cannot go past the docs quota or a free team\'s limit, and says why', async () => {
    const { env, call, publish, live } = await fresh({ TDOC_HOSTED_MAX_DOCS: '2' });
    const a = await issue(worker, env, 'alice');
    await publish(a, 'q1'); await publish(a, 'q2');
    await call('/api/doc?slug=q1', { method: 'DELETE', token: a.token });
    await call('/api/doc?slug=q2', { method: 'DELETE', token: a.token });
    assert((await publish(a, 'q3')).status === 200 && (await publish(a, 'q4')).status === 200, 'Trash frees room');
    const r = await call('/api/trash/restore', { method: 'POST', token: a.token, body: { slug: 'q1' } });
    assert(r.status === 403 && r.body.error === 'quota_docs' && /limit/.test(r.body.message), `restore over quota: ${r.status} ${r.text}`);
    assert(!live('q1'), 'restored past the quota');
    // A folder restore counts all its docs at once.
    await call('/api/doc?slug=q4', { method: 'DELETE', token: a.token });
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'Box' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { folder: f.id, slugs: ['q3'] } });
    await deleteFolder(call, a, f.id);
    await publish(a, 'q5'); await publish(a, 'q6');
    const fr = await call('/api/trash/restore', { method: 'POST', token: a.token, body: { folder: f.id } });
    assert(fr.status === 403 && fr.body.error === 'quota_docs', `folder restore over quota: ${fr.status} ${fr.text}`);
    assert(!live('q3'), 'folder restored past the quota');
  });

  await t('a free team over its limit cannot get docs back from Trash', async () => {
    const { env, call, publish, live } = await fresh({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'p_m', STRIPE_PRICE_YEARLY: 'p_y', STRIPE_WEBHOOK_SECRET: 'whsec_x', TDOC_TEAM_FREE_DOCS: '1' });
    const a = await issue(worker, env, 'alice');
    const team = (await call('/api/teams', { method: 'POST', cookie: a.cookie, headers: SAME, body: { name: 'Acme' } })).body.team;
    await publish(a, 't1');
    await call('/api/team/move', { method: 'POST', token: a.token, body: { team: team.id, slugs: ['t1'] } });
    await call('/api/doc?slug=t1', { method: 'DELETE', token: a.token });
    await publish(a, 't2');
    const moved = await call('/api/team/move', { method: 'POST', token: a.token, body: { team: team.id, slugs: ['t2'] } });
    if (moved.status !== 200) throw new Error(`setup: team move ${moved.status} ${moved.text}`);
    const r = await call('/api/trash/restore', { method: 'POST', token: a.token, body: { slug: 't1' } });
    assert(r.status === 402 && r.body.error === 'team_plan_required', `team restore over limit: ${r.status} ${r.text}`);
    assert(!live('t1'), 'restored past the team limit');
  });

  await t('a folder delete that failed half way and was run again strands nothing: restore brings every doc back', async () => {
    const { env, call, publish, live } = await fresh();
    const a = await issue(worker, env, 'alice');
    for (const s of ['s1', 's2', 's3']) await publish(a, s);
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'F' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { folder: f.id, slugs: ['s1', 's2', 's3'] } });
    const put = env.META.put.bind(env.META); let armed = true;
    env.META.put = (k, ...x) => { if (armed && k === 'meta:s2') { armed = false; throw new Error('KV limit'); } return put(k, ...x); };
    try { await call(`/api/folders?batch=1&id=${f.id}`, { method: 'DELETE', token: a.token }); } catch {}
    const retry = await deleteFolder(call, a, f.id);
    assert(retry.at(-1).status === 200, `retry ${retry.at(-1).status}`);
    const list = (await call('/api/trash', { token: a.token })).body.items;
    assert(list.length === 1 && list[0].kind === 'folder' && list[0].doc_count === 3, `Trash after the retry: ${JSON.stringify(list)}`);
    assert((await call('/api/trash/restore', { method: 'POST', token: a.token, body: { folder: f.id } })).status === 200, 'restore');
    assert(['s1', 's2', 's3'].every(live), 'a doc stayed stranded in Trash');
    const me = (await call('/api/me', { token: a.token })).body;
    assert(['s1', 's2', 's3'].every((s) => me.docs.find((d) => d.slug === s)?.folder === f.id), 'docs not back in their folder');
  });

  await t('a 100-doc folder goes to Trash in batches that each stay inside the KV budget, then restores whole', async () => {
    const { env, call, publish, trashed, live, countKv } = await fresh({ TDOC_HOSTED_MAX_DOCS: '1000' });
    const a = await issue(worker, env, 'alice');
    const slugs = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, '0')}`);
    for (const s of slugs) await publish(a, s);
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'Big' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { folder: f.id, slugs } });
    const counter = countKv();
    const perCall = [];
    let after = '';
    for (;;) {
      counter.ops = 0;
      const r = await call(`/api/folders?batch=1&id=${f.id}${after ? `&after=${after}` : ''}`, { method: 'DELETE', token: a.token });
      perCall.push(counter.ops);
      assert(r.status === 200, `batch ${r.status} ${r.text}`);
      if (!r.body.remaining) break;
      after = r.body.after;
    }
    assert(perCall.length >= 3 && Math.max(...perCall) < 500, `KV ops per request: ${perCall.join(', ')}`);
    assert(slugs.every(trashed), 'not every doc went to Trash');
    const me = (await call('/api/me', { token: a.token })).body;
    assert(!me.folders.some((x) => x.id === f.id), 'folder left in the tree');
    const r = await call('/api/trash/restore', { method: 'POST', token: a.token, body: { folder: f.id } });
    assert(r.status === 200 && r.body.restored.length === 100 && slugs.every(live), `restore ${r.status} ${r.body && r.body.restored && r.body.restored.length}`);
  });

  await t('a team folder delete reads a bounded number of records per request, however big the team', async () => {
    const { env, call, publish, trashed, countKv } = await fresh({ TDOC_HOSTED_MAX_DOCS: '1000' });
    const a = await issue(worker, env, 'alice');
    const team = (await call('/api/teams', { method: 'POST', cookie: a.cookie, headers: SAME, body: { name: 'Big team' } })).body.team;
    const all = Array.from({ length: 150 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    for (const s of all) await publish(a, s);
    for (let i = 0; i < all.length; i += 100) await call('/api/team/move', { method: 'POST', token: a.token, body: { team: team.id, slugs: all.slice(i, i + 100) } });
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'Small', team: team.id } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { team: team.id, folder: f.id, slugs: ['t007', 't140'] } });
    const counter = countKv();
    const gets = [];
    const get = env.META.get; let metaReads = 0;
    env.META.get = (k, ...x) => { if (String(k).startsWith('meta:')) metaReads += 1; return get(k, ...x); };
    let after = '';
    for (;;) {
      metaReads = 0; counter.ops = 0;
      const r = await call(`/api/folders?batch=1&id=${f.id}&team=${team.id}${after ? `&after=${after}` : ''}`, { method: 'DELETE', token: a.token });
      assert(r.status === 200, `batch ${r.status} ${r.text}`);
      gets.push(metaReads);
      if (!r.body.remaining) break;
      after = r.body.after;
    }
    assert(Math.max(...gets) <= 100, `record reads per request: ${gets.join(', ')}`);
    assert(trashed('t007') && trashed('t140') && !trashed('t050'), 'wrong docs trashed');
  });

  await t('a Trash read erases at most a few expired docs and hides the rest for the scheduled purge', async () => {
    const { env, call, publish, countKv } = await fresh({ TDOC_HOSTED_MAX_DOCS: '1000' });
    const a = await issue(worker, env, 'alice');
    for (let i = 0; i < 30; i++) { await publish(a, `e${i}`); await call(`/api/doc?slug=e${i}`, { method: 'DELETE', token: a.token }); }
    for (let i = 0; i < 30; i++) {
      const m = JSON.parse(env.META.map.get(`meta:e${i}`));
      m.trashed_at = new Date(Date.now() - 31 * DAY).toISOString();
      env.META.map.set(`meta:e${i}`, JSON.stringify(m));
    }
    const counter = countKv();
    const r = await call('/api/trash', { token: a.token });
    const left = Array.from({ length: 30 }, (_, i) => `e${i}`).filter((s) => env.META.map.has(`meta:${s}`));
    assert(r.status === 200 && r.body.items.length === 0, `expired rows listed: ${r.body.items.length}`);
    assert(left.length === 20, `a Trash read purged ${30 - left.length} docs`);
    assert(counter.ops < 250, `KV ops for one Trash read: ${counter.ops}`);
  });

  await t('a write that read the doc before it went to Trash cannot bring it back', async () => {
    const { env, call, publish, trashed } = await fresh();
    const a = await issue(worker, env, 'alice');
    await publish(a, 'race');
    const before = env.META.map.get('meta:race');
    await call('/api/doc?slug=race', { method: 'DELETE', token: a.token });
    // The rename's own read of the record is the one from before the delete.
    const get = env.META.get.bind(env.META); let stale = 1;
    env.META.get = (k, ...x) => (k === 'meta:race' && stale-- > 0 ? Promise.resolve(before) : get(k, ...x));
    const r = await call('/api/doc/title', { method: 'PATCH', cookie: a.cookie, headers: SAME, body: { slug: 'race', title: 'Renamed' } });
    assert(r.status === 404, `a racing rename answered ${r.status}`);
    assert(trashed('race'), 'the racing write took the doc out of Trash');
  });

  await t('an old client deleting a folder is told what changed, and nothing is half done', async () => {
    const { env, call, publish, live } = await fresh();
    const a = await issue(worker, env, 'alice');
    await publish(a, 'kept');
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'Old' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { folder: f.id, slugs: ['kept'] } });
    const r = await call(`/api/folders?id=${f.id}`, { method: 'DELETE', token: a.token });
    assert(r.status === 409 && r.body.error === 'client_update_required' && /Trash/.test(r.body.message), `${r.status} ${r.text}`);
    assert(live('kept') && (await call('/api/me', { token: a.token })).body.folders.some((x) => x.id === f.id), 'an old client changed something');
  });

  await t('CLI: tdoc-delete --forever erases at once so the same slug publishes again; tdoc-folder delete batches', async () => {
    const { env, call, publish } = await fresh({ TDOC_HOSTED_MAX_DOCS: '1000' });
    const a = await issue(worker, env, 'alice');
    await publish(a, 'cli-doc');
    const slugs = Array.from({ length: 45 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    for (const s of slugs) await publish(a, s);
    const f = (await call('/api/folders', { method: 'POST', token: a.token, body: { name: 'Pile' } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: a.token, body: { folder: f.id, slugs } });
    const server = http.createServer((q, s) => {
      let b = '';
      q.on('data', (d) => { b += d; }).on('end', async () => {
        const r = await worker.fetch(new Request(`https://tdoc.dev${q.url}`, {
          method: q.method, headers: { authorization: q.headers.authorization || '', 'content-type': 'application/json' }, body: b || undefined,
        }), env, {});
        s.writeHead(r.status, { 'content-type': 'application/json' });
        s.end(await r.text());
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-trash-cli-'));
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base: `http://127.0.0.1:${server.address().port}`, upload_token: a.token }));
    const run = async (bin, args) => new Promise((resolve) => {
      const { spawn } = require('child_process');
      const child = spawn(path.join(__dirname, '..', 'bin', bin), args, { env: { ...process.env, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    try {
      const del = await run('tdoc-delete', ['cli-doc', '--published-only', '--forever']);
      assert(del.status === 0 && /Deleted cli-doc for good/.test(del.stdout), `--forever: ${del.status} ${del.stdout} ${del.stderr}`);
      assert(!env.META.map.has('meta:cli-doc'), 'not erased');
      assert((await publish(a, 'cli-doc')).status === 200, 'the slug did not publish again');
      const folder = await run('tdoc-folder', ['delete', 'Pile']);
      assert(folder.status === 0 && /Moved "Pile" and 45 doc\(s\) to Trash/.test(folder.stdout), `tdoc-folder delete: ${folder.status} ${folder.stdout} ${folder.stderr}`);
      assert(slugs.every((s) => JSON.parse(env.META.map.get(`meta:${s}`)).trashed_at), 'tdoc-folder stopped after one batch');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  console.log = quiet;
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
