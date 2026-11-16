// Folder names are unique among live siblings, on every path that makes or
// renames a folder: create answers the existing folder (case, whitespace and
// Unicode width aside), rename onto a taken name is a 409 the dialog shows,
// a folder in Trash does not block its name, and one restored from Trash
// next to a new twin comes back as "Name (2)". Two creates racing in one
// isolate (a double click) make one folder. Runs worker.js in-process.

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, opts = {}) => {
    const r = await worker.fetch(req(p, opts), env, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body };
  };
  const SAME = { Origin: 'https://tdoc.dev' };
  console.log('folder names: dedup and collisions');

  const julie = await issue(worker, env, 'julie');
  const make = (name, extra = {}) => call('/api/folders', { method: 'POST', token: julie.token, body: { name, ...extra } });
  const list = async () => (await call('/api/folders', { token: julie.token })).body.folders;
  const named = async (name) => (await list()).filter((f) => f.name.toLowerCase().replace(/\s+/g, ' ') === name.toLowerCase());

  let bench = null;
  await t('create by a name already there answers that folder, no second one (no existing_ok needed)', async () => {
    const first = await make('Raft Bench 0');
    assert(first.status === 200 && first.body.folder.id && !first.body.existed, `create ${first.status} ${JSON.stringify(first.body)}`);
    bench = first.body.folder;
    const again = await make('Raft Bench 0');
    assert(again.status === 200 && again.body.existed === true && again.body.folder.id === bench.id, `again ${again.status} ${JSON.stringify(again.body)}`);
    const legacy = await make('Raft Bench 0', { existing_ok: true });
    assert(legacy.status === 200 && legacy.body.folder.id === bench.id, 'existing_ok still answers the folder');
    assert((await named('raft bench 0')).length === 1, 'two folders listed');
  });

  await t('case, outer/inner whitespace, NBSP, tabs, zero-width and full-width variants all match it', async () => {
    for (const variant of ['raft bench 0', '  RAFT BENCH 0  ', 'Raft  Bench   0', 'Raft Bench 0', 'Raft\tBench 0', 'Raft Bench​ 0', 'Ｒａｆｔ Bench ０']) {
      const r = await make(variant);
      assert(r.status === 200 && r.body.existed === true && r.body.folder.id === bench.id, `${JSON.stringify(variant)} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert((await named('raft bench 0')).length === 1, 'a variant made a second folder');
  });

  await t('a new name is stored with its whitespace collapsed', async () => {
    const r = await make('  Q4   plans ');
    assert(r.status === 200 && r.body.folder.name === 'Q4 plans', JSON.stringify(r.body));
  });

  await t('the same name under another parent is a different folder', async () => {
    const sub = await make('Raft Bench 0', { parent: bench.id });
    assert(sub.status === 200 && !sub.body.existed && sub.body.folder.id !== bench.id && sub.body.folder.parent === bench.id, JSON.stringify(sub.body));
    const subAgain = await make('raft bench 0', { parent: bench.id });
    assert(subAgain.body.existed === true && subAgain.body.folder.id === sub.body.folder.id, 'nested dedup');
  });

  await t('two creates racing (double click) make one folder', async () => {
    // A slow KV write: without serializing, the second request reads the
    // tree while the first one's write is still in flight.
    const put = env.META.put;
    env.META.put = async (...args) => {
      if (/^folders:/.test(String(args[0]))) await new Promise((r) => setTimeout(r, 30));
      return put.apply(env.META, args);
    };
    let a, b;
    try { [a, b] = await Promise.all([make('Raced'), make('Raced')]); } finally { env.META.put = put; }
    assert(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
    assert(a.body.folder.id === b.body.folder.id, `two ids: ${a.body.folder.id} ${b.body.folder.id}`);
    assert((await named('raced')).length === 1, 'two folders after a race');
  });

  await t('rename onto a sibling\'s name (any variant) is 409 duplicate_name with a message; nothing changes', async () => {
    const other = (await make('Raft Bench 1')).body.folder;
    for (const variant of ['Raft Bench 0', 'raft  bench 0 ', 'RAFT BENCH 0']) {
      const r = await call('/api/folders', { method: 'PATCH', token: julie.token, body: { id: other.id, name: variant } });
      assert(r.status === 409 && r.body.error === 'duplicate_name', `${JSON.stringify(variant)} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert(/already here/.test(r.body.message) && r.body.folder.id === bench.id, `message ${JSON.stringify(r.body)}`);
    }
    assert((await list()).find((f) => f.id === other.id).name === 'Raft Bench 1', 'renamed anyway');
    const self = await call('/api/folders', { method: 'PATCH', token: julie.token, body: { id: other.id, name: 'RAFT BENCH 1' } });
    assert(self.status === 200 && self.body.folder.name === 'RAFT BENCH 1', `re-casing its own name ${self.status}`);
    const cookie = await call('/api/folders', { method: 'PATCH', cookie: julie.cookie, headers: SAME, body: { id: other.id, name: 'Raft Bench 0' } });
    assert(cookie.status === 409, `browser rename ${cookie.status}`);
  });

  await t('a folder in Trash does not block its name; restoring it beside the new one renames it', async () => {
    const old = (await make('Archive')).body.folder;
    const del = await call(`/api/folders?batch=1&id=${old.id}`, { method: 'DELETE', token: julie.token });
    assert(del.status === 200 && del.body.trashed, `delete ${del.status}`);
    const fresh = await make('archive');
    assert(fresh.status === 200 && !fresh.body.existed && fresh.body.folder.id !== old.id, `trashed name blocked ${JSON.stringify(fresh.body)}`);
    const renameTo = (await make('Spare')).body.folder;
    const del2 = await call(`/api/folders?batch=1&id=${renameTo.id}`, { method: 'DELETE', token: julie.token });
    assert(del2.status === 200, 'delete spare');
    const r = await call('/api/trash/restore', { method: 'POST', token: julie.token, body: { folder: old.id } });
    assert(r.status === 200, `restore ${r.status} ${JSON.stringify(r.body)}`);
    const folders = await list();
    const back = folders.find((f) => f.id === old.id);
    assert(back && back.name === 'Archive (2)', `restored as ${back && back.name}`);
    assert(folders.find((f) => f.id === fresh.body.folder.id).name === 'archive', 'the new folder kept its name');
    // A rename onto a name only Trash holds is fine.
    const free = await call('/api/folders', { method: 'PATCH', token: julie.token, body: { id: fresh.body.folder.id, name: 'Spare' } });
    assert(free.status === 200 && free.body.folder.name === 'Spare', `rename onto a trashed name ${free.status}`);
  });

  await t('team folders follow the same rules', async () => {
    const team = (await call('/api/teams', { method: 'POST', token: julie.token, body: { name: 'Bench team' } })).body.team;
    const a = await make('Runs', { team: team.id });
    const b = await make(' runs ', { team: team.id });
    assert(a.status === 200 && b.body.existed === true && b.body.folder.id === a.body.folder.id, `team dedup ${JSON.stringify(b.body)}`);
    const c = (await make('Other runs', { team: team.id })).body.folder;
    const r = await call('/api/folders', { method: 'PATCH', token: julie.token, body: { id: c.id, name: 'RUNS', team: team.id } });
    assert(r.status === 409 && r.body.error === 'duplicate_name', `team rename ${r.status}`);
  });

  await t('the shell disables Create while a save is pending and shows the clash under the name', async () => {
    const hub = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'docs-hub.jsx'), 'utf8');
    const dialog = hub.slice(hub.indexOf('function NameDialog('), hub.indexOf('function FolderShareDialog('));
    assert(/busyRef\.current\) return/.test(dialog) && /busy=\{busy\}/.test(dialog), 'NameDialog has no in-flight guard');
    assert(/role="alert"/.test(dialog) && /result\.error/.test(dialog), 'NameDialog shows no inline error');
    assert(/disabled=\{busy\}/.test(hub), 'HubDialog confirm is never disabled');
    const hook = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'hooks', 'use-docs-hub.js'), 'utf8');
    assert(/isFolderNameClash\(error\)/.test(hook) && /addFolderOnce\(items, created\)/.test(hook), 'saveFolder neither maps the 409 nor lists a folder once');
    const { addFolderOnce, isFolderNameClash } = await import(path.join(__dirname, '..', 'shell', 'src', 'docs-hub', 'folder-names.js'));
    const one = [{ id: 'f1', name: 'A', parent: '' }];
    assert(addFolderOnce(one, { id: 'f1', name: 'A' }) === one, 'a folder listed twice');
    assert(addFolderOnce(one, { id: 'f2', name: 'B' }).length === 2, 'a new folder not listed');
    assert(isFolderNameClash({ status: 409, body: { error: 'duplicate_name' } }) && !isFolderNameClash({ status: 400, body: { error: 'invalid_name' } }), 'clash check');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
