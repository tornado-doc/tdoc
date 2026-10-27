// A whole My docs folder into a team (POST /api/folders/move-to-team and
// `tdoc-folder move-to-team`): the subtree is made again in the team (merged
// into same-named folders), the caller's docs move and are filed, emptied
// personal folders go; bounded batches with `remaining`, idempotent re-runs,
// and safe under KV's stale folder reads. Runs worker.js in-process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { loadWorker, makeEnv, req, issue, bootData } = require('./helpers/worker-harness.js');
const { staleFolders } = require('./helpers/stale-kv.js');

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

// A local HTTP front for the CLI; `pick` chooses the isolate per request.
async function serve(env, pick) {
  const server = http.createServer((q, s) => {
    let b = '';
    q.on('data', (d) => { b += d; }).on('end', async () => {
      const u = new URL(q.url, 'https://tdoc.dev');
      const r = await pick(q.method, u.pathname).fetch(new Request(`https://tdoc.dev${u.pathname}${u.search}`, {
        method: q.method, headers: { authorization: q.headers.authorization || '', 'content-type': 'application/json' }, body: b || undefined,
      }), env, {});
      s.writeHead(r.status, { 'content-type': 'application/json' });
      s.end(await r.text());
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function cliHome(base, who) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-mvt-'));
  fs.mkdirSync(path.join(home, '.tdoc'));
  fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base, upload_token: who.token }));
  return home;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_DOCS: '500' });
  const call = async (p, opts = {}, w = worker, e = env) => {
    const r = await w.fetch(req(p, opts), e, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };
  const puts = [];
  const origPut = env.META.put.bind(env.META);
  env.META.put = async (k, ...rest) => { puts.push(k); return origPut(k, ...rest); };
  const SAME = { Origin: 'https://tdoc.dev' };
  const publish = (who, slug, e = env, w = worker) => call('/api/upload', { method: 'POST', token: who.token, body: { slug, version: 1, html: `<p>${slug}</p>` } }, w, e);
  const mkdir = (who, name, parent, team, e = env, w = worker) => call('/api/folders', { method: 'POST', token: who.token, body: { name, parent, team } }, w, e).then((r) => r.body.folder);
  const file = (who, slugs, folder, e = env, w = worker) => call('/api/folders/move', { method: 'POST', token: who.token, body: { slugs, folder } }, w, e);
  const meta = async (slug, e = env) => JSON.parse(await e.META.get(`meta:${slug}`));
  const move = (who, body, opts = {}) => call('/api/folders/move-to-team', { method: 'POST', token: opts.cookie ? '' : who.token, cookie: opts.cookie ? who.cookie : '', headers: opts.headers || {}, body }, opts.worker || worker, opts.env || env);

  console.log('move a My docs folder into a team');
  const pam = await issue(worker, env, 'pam');
  const oli = await issue(worker, env, 'oli');
  const out = await issue(worker, env, 'outsider');
  for (const slug of ['r-1', 'r-2', 'n-1', 'd-1', 'loose']) assert((await publish(pam, slug)).status === 200, `upload ${slug}`);
  assert((await publish(oli, 'oli-doc')).status === 200, 'upload oli-doc');

  const team = (await call('/api/teams', { method: 'POST', token: pam.token, body: { name: 'Acme' } })).body.team;
  const invite = (await call(`/api/team?id=${team.id}`, { cookie: pam.cookie })).body.team.invite_url.split('/').pop();
  assert((await call('/api/team/join', { method: 'POST', cookie: oli.cookie, body: { token: invite } })).status === 200, 'oli joins');
  // The team already has a "research" folder (another member's) with a doc.
  assert((await call('/api/team/move', { method: 'POST', token: oli.token, body: { team: team.id, slugs: ['oli-doc'] } })).status === 200, 'oli-doc into team');
  const existing = await mkdir(oli, 'research', null, team.id);
  await call('/api/folders/move', { method: 'POST', token: oli.token, body: { team: team.id, slugs: ['oli-doc'], folder: existing.id } });

  // My docs: Research / Notes / Deep, plus a sibling folder that stays.
  const research = await mkdir(pam, 'Research');
  const notes = await mkdir(pam, 'Notes', research.id);
  const deep = await mkdir(pam, 'Deep', notes.id);
  const other = await mkdir(pam, 'Other');
  await file(pam, ['r-1', 'r-2'], research.id);
  await file(pam, ['n-1'], notes.id);
  await file(pam, ['d-1'], deep.id);
  await file(pam, ['loose'], other.id);

  await t('refused: no team, a team the caller is not in, a cross-site cookie, a missing folder', async () => {
    const noTeam = await move(pam, { folder: research.id });
    assert(noTeam.status === 400 && noTeam.body.error === 'team_required', `no team ${noTeam.status}`);
    const outsider = await move(out, { folder: research.id, team: team.id });
    assert(outsider.status === 404 && outsider.body.error === 'team_not_found', `non-member ${outsider.status} ${JSON.stringify(outsider.body)}`);
    const xsite = await move(pam, { folder: research.id, team: team.id }, { cookie: true, headers: { Origin: 'https://evil.example' } });
    assert(xsite.status === 403, `cross-site cookie ${xsite.status}`);
    const missing = await move(pam, { folder: 'f_0000000000000_00000000', team: team.id });
    assert(missing.status === 404 && missing.body.error === 'folder_not_found', `missing folder ${missing.status}`);
    assert(!(await meta('r-1')).workspace_id, 'a refused call moved a doc');
  });

  let researchSnapshot = null;
  await t('cookie (same origin): subtree made in the team, merged into the same-named folder, docs moved and filed, empty folders gone', async () => {
    researchSnapshot = await env.META.get('folders:pam');
    puts.length = 0;
    const r = await move(pam, { folder: research.id, team: team.id }, { cookie: true, headers: SAME });
    assert(r.status === 200 && r.body.remaining === 0, `move ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.moved === 4 && r.body.skipped === 0 && r.body.removed_folders === 3 && r.body.kept_folders === 0, `counts ${JSON.stringify(r.body)}`);
    assert(r.body.folder === existing.id, 'did not merge into the existing "research"');
    assert(puts.filter((k) => k.startsWith('team-folders:')).length === 1, `team folder writes ${puts.filter((k) => k.startsWith('team-folders:')).length}`);
    assert(puts.filter((k) => k.startsWith('folders:')).length === 1, 'My docs folder writes');

    const tf = (await call(`/api/folders?team=${team.id}`, { token: pam.token })).body.folders;
    const tNotes = tf.find((f) => f.name === 'Notes');
    const tDeep = tf.find((f) => f.name === 'Deep');
    assert(tf.length === 3 && tNotes.parent === existing.id && tDeep.parent === tNotes.id, `team tree ${JSON.stringify(tf)}`);
    for (const [slug, fid] of [['r-1', existing.id], ['r-2', existing.id], ['n-1', tNotes.id], ['d-1', tDeep.id]]) {
      const m = await meta(slug);
      assert(m.workspace_id === team.id && m.team_folder === fid && m.access.team === true, `${slug}: ${JSON.stringify(m)}`);
    }
    const mine = (await call('/api/folders', { token: pam.token })).body;
    assert(mine.folders.length === 1 && mine.folders[0].id === other.id, `My docs folders ${JSON.stringify(mine.folders)}`);
    assert(JSON.stringify(mine.docs) === JSON.stringify({ loose: other.id }), `My docs filing ${JSON.stringify(mine.docs)}`);
    const boot = bootData(await (await call(`/me?team=${team.id}`, { cookie: oli.cookie })).r.text(), '__TDOC_APP_BOOT__');
    assert(boot.team_docs.find((d) => d.slug === 'd-1').folder === tDeep.id, 'teammate does not see d-1 in Deep');
    assert(!(await meta('loose')).workspace_id, 'a doc outside the folder moved');
  });

  await t('re-run after a lost My docs write: nothing moves twice, no duplicate folders, the folders still go', async () => {
    // As if the last call stamped every doc but died before saving My docs.
    await env.META.put('folders:pam', JSON.stringify({ ...JSON.parse(researchSnapshot), at: Date.now() + 1, w: 'restored' }));
    puts.length = 0;
    const r = await move(pam, { folder: research.id, team: team.id });
    assert(r.status === 200 && r.body.remaining === 0 && r.body.moved === 0, `re-run ${JSON.stringify(r.body)}`);
    assert(r.body.results.every((x) => x.status === 'already') && r.body.removed_folders === 3, `results ${JSON.stringify(r.body.results)}`);
    assert(!puts.some((k) => k.startsWith('meta:') || k.startsWith('team-folders:')), `re-run wrote ${puts.join(',')}`);
    assert((await call(`/api/folders?team=${team.id}`, { token: pam.token })).body.folders.length === 3, 'duplicate team folders');
    assert((await call('/api/folders', { token: pam.token })).body.folders.length === 1, 'folders not removed');
    const again = await move(pam, { folder: research.id, team: team.id });
    assert(again.status === 404 && again.body.error === 'folder_not_found', 'a finished move answers folder_not_found');
  });

  await t('a doc the caller does not own is skipped and reported; its folder (and parents) stay', async () => {
    const box = await mkdir(pam, 'Box');
    const inner = await mkdir(pam, 'Inner', box.id);
    const empty = await mkdir(pam, 'Empty', box.id);
    assert((await publish(pam, 'box-1')).status === 200, 'upload box-1');
    assert((await publish(oli, 'not-pams')).status === 200, 'upload not-pams');
    await file(pam, ['box-1'], box.id);
    // Should not happen through the API; planted to prove it is handled.
    const raw = JSON.parse(await env.META.get('folders:pam'));
    raw.docs['not-pams'] = inner.id;
    await env.META.put('folders:pam', JSON.stringify({ ...raw, at: Date.now() + 1, w: 'planted' }));
    const r = await move(pam, { folder: box.id, team: team.id });
    assert(r.status === 200 && r.body.moved === 1 && r.body.skipped === 1, `move ${JSON.stringify(r.body)}`);
    assert(r.body.results.find((x) => x.slug === 'not-pams').reason === 'not_owner', 'not reported');
    assert(!(await meta('not-pams')).workspace_id, 'moved a doc the caller does not own');
    const left = (await call('/api/folders', { token: pam.token })).body;
    const names = left.folders.map((f) => f.name).sort().join(',');
    assert(names === 'Box,Inner,Other' && left.docs['not-pams'] === inner.id && r.body.kept_folders === 2, `kept ${names} ${JSON.stringify(left.docs)}`);
    assert(!left.folders.some((f) => f.id === empty.id), 'the empty sibling folder stayed');
    assert((await meta('box-1')).team_folder === r.body.folder, 'box-1 not filed');
  });

  await t('cap: 50 docs a call with `remaining`; the CLI loops to the end and prints the team folder link', async () => {
    const bulk = await mkdir(pam, 'Bulk');
    const sub = await mkdir(pam, 'Sub', bulk.id);
    const slugs = Array.from({ length: 55 }, (_, i) => `bulk-${i}`);
    for (const slug of slugs) assert((await publish(pam, slug)).status === 200, `upload ${slug}`);
    await file(pam, slugs.slice(0, 40), bulk.id);
    await file(pam, slugs.slice(40), sub.id);
    const first = await move(pam, { folder: bulk.id, team: team.id });
    assert(first.status === 200 && first.body.moved === 50 && first.body.remaining === 5 && first.body.removed_folders === 0, `first batch ${JSON.stringify({ ...first.body, results: first.body.results.length })}`);
    assert((await call('/api/folders', { token: pam.token })).body.folders.some((f) => f.id === bulk.id), 'folder removed before the last batch');

    const server = await serve(env, () => worker);
    const home = cliHome(`http://127.0.0.1:${server.address().port}`, pam);
    try {
      const r = await runBin(path.join(__dirname, '..', 'bin', 'tdoc-folder'), ['move-to-team', 'Bulk', '--team', 'Acme'], { ...process.env, HOME: home });
      assert(r.status === 0, `cli ${r.status}\n${r.stderr}`);
      assert(/moved 5 docs from My docs \/ Bulk into team Acme/.test(r.stderr), `cli summary ${r.stderr}`);
      assert(r.stdout.trim().endsWith(`/me?team=${team.id}&folder=${first.body.folder}`), `cli link ${r.stdout}`);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    for (const slug of slugs) assert((await meta(slug)).workspace_id === team.id, `${slug} not moved`);
    const tSub = (await call(`/api/folders?team=${team.id}`, { token: pam.token })).body.folders.find((f) => f.name === 'Sub');
    assert((await meta('bulk-54')).team_folder === tSub.id, 'bulk-54 not in Sub');
    const left = (await call('/api/folders', { token: pam.token })).body.folders.map((f) => f.name);
    assert(!left.includes('Bulk') && !left.includes('Sub'), `Bulk left behind ${left}`);
  });

  // ---- stale KV: each call on another isolate, folder reads lagging ----
  console.log('move a folder into a team under stale KV reads (two isolates)');
  const workerB = (await loadWorker()).default;
  const senv = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_DOCS: '500' });
  staleFolders(senv.META, 1000);
  const kim = await issue(worker, senv, 'kim');
  const stm = (await call('/api/teams', { method: 'POST', token: kim.token, body: { name: 'Stale' } }, worker, senv)).body.team;
  const keep = await mkdir(kim, 'Keep me', null, stm.id, senv);
  senv.META.settle();
  const big = await mkdir(kim, 'Big', null, undefined, senv);
  senv.META.settle();
  const inner = await mkdir(kim, 'Inner', big.id, undefined, senv);
  senv.META.settle();
  const kslugs = Array.from({ length: 53 }, (_, i) => `k-${i}`);
  for (const slug of kslugs) assert((await publish(kim, slug, senv)).status === 200, `upload ${slug}`);
  await file(kim, kslugs.slice(0, 50), big.id, senv);
  senv.META.settle();
  await file(kim, kslugs.slice(50), inner.id, senv);
  senv.META.settle();

  await t('stale reads between batches: the hints from the last answer keep one copy of each folder and finish the move', async () => {
    const first = await move(kim, { folder: big.id, team: stm.id }, { env: senv });
    assert(first.status === 200 && first.body.remaining === 3, `first ${JSON.stringify({ ...first.body, results: first.body.results.length })}`);
    // Isolate B still reads both folder blobs as they were before that call.
    const done = first.body.results.filter((x) => x.status !== 'skipped').map((x) => x.slug);
    const second = await move(kim, { folder: big.id, team: stm.id, known: first.body.folders, done }, { env: senv, worker: workerB });
    assert(second.status === 200 && second.body.remaining === 0 && second.body.moved === 3 && second.body.removed_folders === 2, `second ${JSON.stringify(second.body)}`);
    assert(second.body.folder === first.body.folder, 'the second batch filed into another "Big"');
    const truth = await senv.META.truth(`team-folders:${stm.id}`);
    const names = truth.folders.map((f) => f.name).sort().join(',');
    assert(names === 'Big,Inner,Keep me', `team folders ${names}`);
    assert(truth.folders.some((f) => f.id === keep.id), 'an existing team folder was lost');
    const personal = await senv.META.truth('folders:kim');
    assert(personal.folders.length === 0 && Object.keys(personal.docs).length === 0, `My docs left ${JSON.stringify(personal)}`);
    const tInner = truth.folders.find((f) => f.name === 'Inner');
    for (const slug of kslugs) {
      const m = await meta(slug, senv);
      assert(m.workspace_id === stm.id && m.team_folder === (slug === 'k-52' || slug === 'k-51' || slug === 'k-50' ? tInner.id : first.body.folder), `${slug} ${m.team_folder}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
