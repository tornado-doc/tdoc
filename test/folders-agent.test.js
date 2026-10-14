// Folders for agents: the CLI's hosted Bearer creates folders and files docs
// in My docs and in a team's shared folders, with the same rules as the
// browser. Runs worker.js in-process with fake bindings.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { loadWorker, makeEnv, req, issue, bootData } = require('./helpers/worker-harness.js');

// Workers KV as seen from an edge that cached a folder blob: after a put, the
// next `reads` gets of that key still return what was there before it.
function staleFolders(kv, reads) {
  const lag = new Map();
  const stale = (k) => /^(team-)?folders:/.test(k);
  const get = kv.get.bind(kv);
  const put = kv.put.bind(kv);
  kv.get = async (k) => {
    const l = lag.get(k);
    if (l && l.reads > 0) { l.reads -= 1; kv.gets.push(k); return l.prev; }
    return get(k);
  };
  kv.put = async (k, v, opts) => {
    if (stale(k)) lag.set(k, { prev: await kv.get(k), reads });
    if (lag.has(k)) lag.get(k).reads = reads;
    return put(k, v, opts);
  };
  kv.settle = () => lag.clear();
  kv.truth = async (k) => { const raw = await get(k); return raw ? JSON.parse(raw) : null; };
  return kv;
}

function runBin(bin, args, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };
  const writes = () => env.META.__writes || 0;
  const origPut = env.META.put.bind(env.META);
  env.META.put = async (...args) => { env.META.__writes = writes() + 1; return origPut(...args); };
  const publish = (who, slug) => call('/api/upload', { method: 'POST', token: who.token, body: { slug, version: 1, html: `<p>${slug}</p>` } });
  const SAME = { Origin: 'https://tdoc.dev' };
  console.log('folders for agents (Bearer, My docs + team)');

  const zed = await issue(worker, env, 'zed');
  const amy = await issue(worker, env, 'amy');
  const out = await issue(worker, env, 'outsider');
  for (const [who, slug] of [[zed, 'daily-1'], [zed, 'daily-2'], [amy, 'amy-doc'], [zed, 'team-daily'], [amy, 'amy-team']]) {
    const up = await publish(who, slug);
    assert(up.status === 200, `upload ${slug} ${up.status} ${JSON.stringify(up.body)}`);
  }

  let daily = null;
  await t('the token makes a My docs folder; the same name again returns it without a write', async () => {
    const made = await call('/api/folders', { method: 'POST', token: zed.token, body: { name: '日报 Daily reports' } });
    assert(made.status === 200 && made.body.folder.id, `create ${made.status} ${JSON.stringify(made.body)}`);
    daily = made.body.folder;
    const before = writes();
    const again = await call('/api/folders', { method: 'POST', token: zed.token, body: { name: '日报 daily REPORTS', existing_ok: true } });
    assert(again.status === 200 && again.body.existed === true && again.body.folder.id === daily.id, `existing_ok ${JSON.stringify(again.body)}`);
    assert(writes() === before, 'existing_ok wrote to KV');
    const dup = await call('/api/folders', { method: 'POST', token: zed.token, body: { name: '日报 Daily reports' } });
    assert(dup.status === 400 && dup.body.error === 'duplicate_name', `dup ${dup.status}`);
    const sub = await call('/api/folders', { method: 'POST', token: zed.token, body: { name: '2026', parent: daily.id } });
    assert(sub.status === 200 && sub.body.folder.parent === daily.id, 'nested folder');
  });

  await t('the token files its own docs; re-filing changes nothing; others\' docs and team docs are refused', async () => {
    const moved = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { slugs: ['daily-1', 'daily-2'], folder: daily.id } });
    assert(moved.status === 200 && moved.body.changed === 2, `move ${moved.status} ${JSON.stringify(moved.body)}`);
    const before = writes();
    const again = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { slugs: ['daily-1'], folder: daily.id } });
    assert(again.status === 200 && again.body.changed === 0 && writes() === before, 'idempotent re-file wrote');
    const foreign = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { slugs: ['amy-doc'], folder: daily.id } });
    assert(foreign.status === 403 && foreign.body.error === 'not_owner', `foreign ${foreign.status}`);
    const list = await call('/api/folders', { token: zed.token });
    assert(list.status === 200 && list.body.docs['daily-1'] === daily.id && list.body.folders.length === 2, `list ${JSON.stringify(list.body)}`);
    const me = await call('/api/me', { token: zed.token });
    assert(me.body.docs.find((d) => d.slug === 'daily-2').folder === daily.id, 'My docs does not show the folder');
    const amyList = await call('/api/folders', { token: amy.token });
    assert(amyList.body.folders.length === 0, 'folders leaked across accounts');
  });

  await t('anonymous is refused; a cookie from another origin is refused, from this origin works', async () => {
    const anon = await call('/api/folders', { method: 'POST', body: { name: 'x' } });
    assert(anon.status === 401, `anon ${anon.status}`);
    const bad = await call('/api/folders', { method: 'POST', cookie: zed.cookie, headers: { Origin: 'https://evil.example' }, body: { name: 'x' } });
    assert(bad.status === 403, `cross-site cookie ${bad.status}`);
    const ok = await call('/api/folders', { method: 'POST', cookie: zed.cookie, headers: SAME, body: { name: 'From the web' } });
    assert(ok.status === 200, `same-origin cookie ${ok.status} ${JSON.stringify(ok.body)}`);
  });

  let team = null;
  await t('team folders: members make and list them; outsiders see nothing', async () => {
    team = (await call('/api/teams', { method: 'POST', token: zed.token, body: { name: 'BeFreed' } })).body.team;
    const detail = (await call(`/api/team?id=${team.id}`, { cookie: zed.cookie })).body.team;
    const token = detail.invite_url.split('/').pop();
    const joined = await call('/api/team/join', { method: 'POST', cookie: amy.cookie, body: { token } });
    assert(joined.status === 200, `amy join ${joined.status}`);
    for (const [who, slug] of [[zed, 'team-daily'], [amy, 'amy-team']]) {
      const moved = await call('/api/team/move', { method: 'POST', token: who.token, body: { team: team.id, slugs: [slug] } });
      assert(moved.status === 200, `team move ${slug} ${moved.status}`);
    }
    const made = await call('/api/folders', { method: 'POST', token: amy.token, body: { name: 'Daily reports', team: team.id } });
    assert(made.status === 200 && made.body.folder.can_manage === true, `member create ${made.status} ${JSON.stringify(made.body)}`);
    const again = await call('/api/folders', { method: 'POST', token: zed.token, body: { name: 'daily reports', team: team.id, existing_ok: true } });
    assert(again.body.existed === true && again.body.folder.id === made.body.folder.id, 'team existing_ok');
    const list = await call(`/api/folders?team=${team.id}`, { token: zed.token });
    assert(list.status === 200 && list.body.folders.length === 1 && list.body.team.name === 'BeFreed', `team list ${JSON.stringify(list.body)}`);
    const personal = await call('/api/folders', { token: amy.token });
    assert(!personal.body.folders.some((f) => f.name === 'Daily reports'), 'team folder leaked into My docs');
    const outsider = await call(`/api/folders?team=${team.id}`, { token: out.token });
    assert(outsider.status === 404, `outsider list ${outsider.status}`);
    const outsiderMake = await call('/api/folders', { method: 'POST', token: out.token, body: { name: 'x', team: team.id } });
    assert(outsiderMake.status === 404, `outsider create ${outsiderMake.status}`);
  });

  await t('team docs are filed by their author or an admin; the doc must be in the team', async () => {
    const folder = (await call(`/api/folders?team=${team.id}`, { token: zed.token })).body.folders[0];
    const own = await call('/api/folders/move', { method: 'POST', token: amy.token, body: { team: team.id, folder: folder.id, slugs: ['amy-team'] } });
    assert(own.status === 200 && own.body.changed === 1, `author files ${own.status} ${JSON.stringify(own.body)}`);
    const before = writes();
    const again = await call('/api/folders/move', { method: 'POST', token: amy.token, body: { team: team.id, folder: folder.id, slugs: ['amy-team'] } });
    assert(again.body.changed === 0 && writes() === before, 'idempotent team re-file wrote');
    const notHers = await call('/api/folders/move', { method: 'POST', token: amy.token, body: { team: team.id, folder: folder.id, slugs: ['team-daily'] } });
    assert(notHers.status === 403 && notHers.body.error === 'not_owner', `member filed another's doc ${notHers.status}`);
    const admin = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { team: team.id, folder: folder.id, slugs: ['team-daily'] } });
    assert(admin.status === 200, `admin files ${admin.status}`);
    const notInTeam = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { team: team.id, folder: folder.id, slugs: ['daily-1'] } });
    assert(notInTeam.status === 409 && notInTeam.body.error === 'doc_not_in_team', `personal doc into team folder ${notInTeam.status}`);
    const asPersonal = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { folder: daily.id, slugs: ['team-daily'] } });
    assert(asPersonal.status === 409 && asPersonal.body.error === 'doc_in_team' && asPersonal.body.team === team.id, `team doc into My docs folder ${asPersonal.status}`);
    const meta = JSON.parse(await env.META.get('meta:team-daily'));
    assert(meta.team_folder === folder.id && meta.workspace_id === team.id, 'folder not stamped on the doc');
    const boot = bootData(await (await call('/me', { cookie: amy.cookie })).r.text(), '__TDOC_APP_BOOT__');
    assert((boot.team_folders[team.id] || []).some((f) => f.id === folder.id), `boot team_folders ${JSON.stringify(boot.team_folders)}`);
    const row = boot.team_docs.find((d) => d.slug === 'amy-team');
    assert(row && row.folder === folder.id && row.can_file === true, `team doc row ${JSON.stringify(row)}`);
    assert(boot.team_docs.find((d) => d.slug === 'team-daily').can_file === false, 'amy may not file zed\'s doc');
  });

  await t('team folder rename/delete: maker or admin only; no sharing; deleted folder\'s docs move up', async () => {
    const parent = (await call(`/api/folders?team=${team.id}`, { token: zed.token })).body.folders[0];
    const child = (await call('/api/folders', { method: 'POST', token: zed.token, body: { name: '2026', parent: parent.id, team: team.id } })).body.folder;
    const filed = await call('/api/folders/move', { method: 'POST', token: zed.token, body: { team: team.id, folder: child.id, slugs: ['team-daily'] } });
    assert(filed.status === 200, 'file into child');
    const notMaker = await call('/api/folders', { method: 'PATCH', token: amy.token, body: { id: child.id, name: 'nope', team: team.id } });
    assert(notMaker.status === 403 && notMaker.body.error === 'not_folder_owner', `member renamed admin's folder ${notMaker.status}`);
    const share = await call('/api/folders', { method: 'PATCH', token: zed.token, body: { id: child.id, visibility: 'unlisted', team: team.id } });
    assert(share.status === 400 && share.body.error === 'team_folder_not_shareable', `team folder shared ${share.status}`);
    const renamed = await call('/api/folders', { method: 'PATCH', token: amy.token, body: { id: parent.id, name: '日报', team: team.id } });
    assert(renamed.status === 200 && renamed.body.folder.name === '日报', `maker rename ${renamed.status}`);
    const noDel = await call(`/api/folders?id=${child.id}&team=${team.id}`, { method: 'DELETE', token: amy.token });
    assert(noDel.status === 403, `member deleted admin's folder ${noDel.status}`);
    const before = writes();
    const del = await call(`/api/folders?id=${child.id}&team=${team.id}`, { method: 'DELETE', token: zed.token });
    assert(del.status === 200 && writes() === before + 1, `admin delete ${del.status}, writes ${writes() - before}`);
    const boot = bootData(await (await call('/me', { cookie: zed.cookie })).r.text(), '__TDOC_APP_BOOT__');
    assert(boot.team_docs.find((d) => d.slug === 'team-daily').folder === parent.id, 'doc did not move up to the parent');
  });

  await t('leaving the team takes the team folder off the doc', async () => {
    const back = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: null, slugs: ['team-daily'] } });
    assert(back.status === 200, `move out ${back.status}`);
    const meta = JSON.parse(await env.META.get('meta:team-daily'));
    assert(!meta.workspace_id && !('team_folder' in meta), `team folder left behind ${JSON.stringify(meta)}`);
  });

  // ---- stale KV (edge-cached reads) ----
  // Two isolates of the worker share one KV whose folder reads lag writes:
  // `A` takes the folder creates, `B` everything else, so B never sees A's
  // write through its own memory -- the cross-edge case the CLI hit.
  console.log('folders under stale KV reads (two isolates)');
  const workerB = (await loadWorker()).default;
  const senv = makeEnv(mod.CommentsStore);
  staleFolders(senv.META, 1000);
  const onA = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), senv, {});
    return { status: r.status, body: await r.json() };
  };
  const onB = async (path, opts = {}) => {
    const r = await workerB.fetch(req(path, opts), senv, {});
    return { status: r.status, body: await r.json() };
  };
  const kim = await issue(worker, senv, 'kim');
  const lee = await issue(worker, senv, 'lee');
  for (const slug of ['kim-1', 'kim-2', 'kim-3', 'kim-t1', 'kim-t2']) {
    const up = await onA('/api/upload', { method: 'POST', token: kim.token, body: { slug, version: 1, html: `<p>${slug}</p>` } });
    assert(up.status === 200, `upload ${slug} ${up.status}`);
  }

  await t('stale read: create then move elsewhere fails without the folder def, files with it, and keeps the folder', async () => {
    const older = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Older' } })).body.folder;
    senv.META.settle();
    const made = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: '日报', existing_ok: true } })).body.folder;
    const bare = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { slugs: ['kim-1'], folder: made.id } });
    assert(bare.status === 404 && bare.body.error === 'folder_not_found', `the bug no longer reproduces? ${bare.status}`);
    const def = { id: made.id, name: made.name, parent: null };
    const moved = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { slugs: ['kim-1'], folder: made.id, folder_def: def } });
    assert(moved.status === 200 && moved.body.folder === made.id && moved.body.changed === 1, `move with def ${moved.status} ${JSON.stringify(moved.body)}`);
    const truth = await senv.META.truth('folders:kim');
    assert(truth.folders.some((f) => f.id === made.id) && truth.folders.some((f) => f.id === older.id), `folder lost ${JSON.stringify(truth)}`);
    assert(truth.docs['kim-1'] === made.id, 'doc not filed');
    // Someone else's folder id, or an old one, is not taken on the client's word.
    const old = { id: `f_${Date.now() - 10 * 60 * 1000}_0123abcd`, name: 'Ghost', parent: null };
    const ghost = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { slugs: ['kim-2'], folder: old.id, folder_def: old } });
    assert(ghost.status === 404 && ghost.body.error === 'folder_not_found', `old def resurrected ${ghost.status}`);
    const forged = { id: `f_${Date.now()}_0123abcd`, name: '', parent: null };
    const bad = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { slugs: ['kim-2'], folder: forged.id, folder_def: forged } });
    assert(bad.status === 404, `invalid def accepted ${bad.status}`);
  });

  await t('stale read: a create that cannot see a fresh folder neither duplicates nor drops it when told about it', async () => {
    senv.META.settle();
    const first = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Weekly', existing_ok: true } })).body.folder;
    const known = [{ id: first.id, name: first.name, parent: null }];
    const again = await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'weekly', existing_ok: true, known } });
    assert(again.status === 200 && again.body.existed === true && again.body.folder.id === first.id, `re-create ${JSON.stringify(again.body)}`);
    const other = await onB('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Monthly', existing_ok: true, known } });
    assert(other.status === 200 && !other.body.existed, `other create ${other.status}`);
    const names = (await senv.META.truth('folders:kim')).folders.map((f) => f.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(['Monthly', 'Older', 'Weekly', '日报']), `folders ${names}`);
  });

  await t('same isolate: a move right after a create reads its own write', async () => {
    senv.META.settle();
    const made = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Same edge' } })).body.folder;
    const moved = await onA('/api/folders/move', { method: 'POST', token: kim.token, body: { slugs: ['kim-3'], folder: made.id } });
    assert(moved.status === 200, `same-isolate move ${moved.status} ${JSON.stringify(moved.body)}`);
  });

  await t('team: a twin made by racing creates is filed into, not duplicated', async () => {
    senv.META.settle();
    const tm = (await onA('/api/teams', { method: 'POST', token: kim.token, body: { name: 'Racers' } })).body.team;
    const a = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Daily', team: tm.id } })).body.folder;
    senv.META.settle();
    const b = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Elsewhere', team: tm.id } })).body.folder;
    // B still reads the tree with Daily but not Elsewhere; a def of a fresh
    // same-named "Daily" (another run's) resolves to the one B sees.
    const twin = { id: `f_${Date.now()}_00ff00ff`, name: 'daily', parent: null };
    for (const slug of ['kim-t1']) await onA('/api/team/move', { method: 'POST', token: kim.token, body: { team: tm.id, slugs: [slug] } });
    const moved = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { team: tm.id, slugs: ['kim-t1'], folder: twin.id, folder_def: twin } });
    assert(moved.status === 200 && moved.body.folder === a.id, `twin ${JSON.stringify(moved.body)}`);
    const fresh = await onB('/api/folders/move', { method: 'POST', token: kim.token, body: { team: tm.id, slugs: ['kim-t1'], folder: b.id, folder_def: { id: b.id, name: b.name, parent: null } } });
    assert(fresh.status === 200 && fresh.body.folder === b.id, `fresh team folder ${JSON.stringify(fresh.body)}`);
    const outsider = await onB('/api/folders/move', { method: 'POST', token: lee.token, body: { team: tm.id, slugs: ['kim-t1'], folder: b.id, folder_def: { id: b.id, name: b.name } } });
    assert(outsider.status === 404 && outsider.body.error === 'team_not_found', `outsider ${outsider.status}`);
  });

  await t('CLI: two rapid tdoc-move --folder runs under stale reads make one folder, file both docs, lose none', async () => {
    senv.META.settle();
    const tm = (await onA('/api/teams', { method: 'POST', token: kim.token, body: { name: 'BeFreed' } })).body.team;
    const keep = (await onA('/api/folders', { method: 'POST', token: kim.token, body: { name: 'Keep me', team: tm.id } })).body.folder;
    senv.META.settle();
    // Creates alternate between two more isolates, so the second run's
    // create (if any) cannot see the first's through isolate memory either.
    const creators = [(await loadWorker()).default, (await loadWorker()).default];
    let creates = 0;
    const server = http.createServer((q, s) => {
      let b = '';
      q.on('data', (d) => { b += d; }).on('end', async () => {
        const u = new URL(q.url, 'https://tdoc.dev');
        const w = q.method === 'POST' && u.pathname === '/api/folders' ? creators[creates++ % 2] : workerB;
        const r = await w.fetch(new Request(`https://tdoc.dev${u.pathname}${u.search}`, {
          method: q.method, headers: { authorization: q.headers.authorization || '', 'content-type': 'application/json' }, body: b || undefined,
        }), senv, {});
        s.writeHead(r.status, { 'content-type': 'application/json' });
        s.end(await r.text());
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-stale-'));
    try {
      fs.mkdirSync(path.join(home, '.tdoc'));
      fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base: `http://127.0.0.1:${server.address().port}`, upload_token: kim.token }));
      const env = { ...process.env, HOME: home, TDOC_FOLDER_RETRY_DELAY: '0' };
      const bin = path.join(__dirname, '..', 'bin', 'tdoc-move');
      for (const slug of ['kim-t2', 'kim-2']) {
        const r = await runBin(bin, ['--team', 'BeFreed', '--folder', '日报', slug], env);
        assert(r.status === 0, `tdoc-move ${slug}: ${r.status}\n${r.stderr}`);
      }
      const truth = await senv.META.truth(`team-folders:${tm.id}`);
      const daily = truth.folders.filter((f) => f.name === '日报');
      assert(daily.length === 1, `expected one 日报, got ${JSON.stringify(truth.folders)}`);
      assert(truth.folders.some((f) => f.id === keep.id), 'an existing folder was lost');
      for (const slug of ['kim-t2', 'kim-2']) {
        const meta = JSON.parse(await senv.META.get(`meta:${slug}`));
        assert(meta.workspace_id === tm.id && meta.team_folder === daily[0].id, `${slug} not filed: ${JSON.stringify(meta)}`);
      }
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
