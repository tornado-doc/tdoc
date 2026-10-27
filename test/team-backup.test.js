// Customer-owned team backups: admin boundary, encrypted credentials,
// S3-compatible writes, queue retries, and move/delete tombstones.

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error && error.message ? error.message : error}`); fail++; }
}
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

async function sessionFor(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', account_id: `acct-${login}`, created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function seedDoc(env, slug, owner) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({
    title: slug, slug, created, versions: [{ n: 1, created, token: 'credential-fingerprint', client: 'internal-client' }],
    hosted: { account_id: `acct-${owner}`, github_login: owner },
    access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${slug}</h1>`);
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const sent = [];
  const env = makeEnv(mod.CommentsStore, {
    TDOC_UPLOAD_TOKEN: 'test-master-key-that-is-never-exported',
    BACKUP_QUEUE: { send: async (body) => { sent.push(body); } },
  });
  const alice = await sessionFor(env, 'alice');
  const bob = await sessionFor(env, 'bob');
  const call = async (path, opts = {}) => {
    const response = await worker.fetch(req(path, opts), env, {});
    let body = null;
    try { body = await response.clone().json(); } catch {}
    return { response, status: response.status, body };
  };
  const origin = { Origin: 'https://tdoc.dev' };
  let team;

  console.log('team data backup mirror');
  await t('creates a team and keeps backup configuration admin-only', async () => {
    const created = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'Acme', invites: ['bob'] } });
    assert(created.status === 200, `create ${created.status}`);
    team = created.body.team;
    const token = team.invite_url.split('/').pop();
    const joined = await call('/api/team/join', { method: 'POST', cookie: bob, body: { token } });
    assert(joined.status === 200, `join ${joined.status}`);
    const member = await call(`/api/team/backup?id=${team.id}`, { cookie: bob });
    assert(member.status === 403 && member.body.error === 'admin_required', `member ${member.status}`);
    const outsider = await call(`/api/team/backup?id=${team.id}`, { cookie: await sessionFor(env, 'mallory') });
    assert(outsider.status === 404, `outsider ${outsider.status}`);
    const csrf = await call('/api/team/backup', {
      method: 'PUT', cookie: alice, headers: { Origin: 'https://evil.example' },
      body: { id: team.id },
    });
    assert(csrf.status === 403, `cross-origin ${csrf.status}`);
  });

  await seedDoc(env, 'plan', 'alice');
  await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['plan'], team: team.id } });

  const remote = [];
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    remote.push({ url: String(input), init });
    return new Response('', { status: 200 });
  };

  try {
    await t('tests the destination, encrypts credentials, and queues a full copy', async () => {
      const bad = await call('/api/team/backup', {
        method: 'PUT', cookie: alice, headers: origin,
        body: { id: team.id, endpoint: 'http://unsafe.example', bucket: 'backup', region: 'auto', prefix: 'tdoc', access_key_id: 'key', secret_access_key: 'secret-secret' },
      });
      assert(bad.status === 400 && bad.body.error === 'invalid_backup_endpoint', `bad endpoint ${JSON.stringify(bad.body)}`);
      const saved = await call('/api/team/backup', {
        method: 'PUT', cookie: alice, headers: origin,
        body: {
          id: team.id, endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'acme-backup', region: 'auto', prefix: 'tdoc',
          access_key_id: 'ACCESS-KEY-1234', secret_access_key: 'super-secret-value',
        },
      });
      assert(saved.status === 200 && saved.body.backup.state === 'syncing', `save ${saved.status} ${JSON.stringify(saved.body)}`);
      assert(remote[0].url.includes(`/acme-backup/tdoc/${team.id}/connection.json`), remote[0].url);
      assert(String(remote[0].init.headers.Authorization).startsWith('AWS4-HMAC-SHA256 Credential=ACCESS-KEY-1234/'), 'missing SigV4');
      assert(sent.some((job) => job.kind === 'full' && job.team === team.id), 'full job missing');
      const raw = await env.META.get(`team-backup:${team.id}`);
      assert(!raw.includes('super-secret-value') && !raw.includes('ACCESS-KEY-1234'), `plaintext credential leaked: ${raw}`);
      const status = await call(`/api/team/backup?id=${team.id}`, { cookie: alice });
      assert(status.status === 200 && status.body.backup.access_key_hint === 'ACCE…1234', JSON.stringify(status.body));
      assert(!('credentials' in status.body.backup), 'credentials exposed');
    });

    await t('full sync writes team metadata and every document object', async () => {
      sent.length = 0;
      remote.length = 0;
      const consume = async (body) => {
        let acked = false;
        await worker.queue({ messages: [{ body, ack: () => { acked = true; }, retry: () => { throw new Error('unexpected retry'); } }] }, env);
        assert(acked, `job not acknowledged: ${JSON.stringify(body)}`);
      };
      await consume({ v: 1, kind: 'full', team: team.id });
      const doc = sent.shift();
      assert(doc && doc.kind === 'doc' && doc.slug === 'plan', `doc job ${JSON.stringify(doc)}`);
      await consume(doc);
      assert(remote.some((x) => x.url.endsWith('/docs/plan/meta.json')), 'doc meta missing');
      assert(remote.some((x) => x.url.endsWith('/docs/plan/comments.json')), 'comments missing');
      assert(remote.some((x) => x.url.endsWith('/docs/plan/v1/index.html')), 'doc bytes missing');
      assert(remote.some((x) => x.url.endsWith('/docs/plan/manifest.json')), 'doc manifest missing');
      const next = sent.shift();
      assert(next && next.kind === 'full' && next.index === 1, `completion job ${JSON.stringify(next)}`);
      await consume(next);
      assert(remote.some((x) => x.url.endsWith('/team.json')), 'team export missing');
      assert(remote.some((x) => x.url.endsWith('/folders.json')), 'folder export missing');
      assert(remote.some((x) => x.url.endsWith('/manifest.json')), 'root manifest missing');
      const textOf = (entry) => new TextDecoder().decode(entry.init.body);
      const teamExport = textOf(remote.find((x) => x.url.endsWith('/team.json')));
      assert(!teamExport.includes('invite_token') && !teamExport.includes('account_id'), `team secrets leaked: ${teamExport}`);
      const metaExport = textOf(remote.find((x) => x.url.endsWith('/docs/plan/meta.json')));
      assert(!metaExport.includes('credential-fingerprint') && !metaExport.includes('internal-client') && !metaExport.includes('acct-alice'), `internal metadata leaked: ${metaExport}`);
      const rootManifest = JSON.parse(textOf(remote.find((x) => /\/tdoc\/t_[a-f0-9]+\/manifest\.json$/.test(x.url))));
      assert(rootManifest.format === 'tdoc-portability-backup' && rootManifest.documents[0].slug === 'plan', JSON.stringify(rootManifest));
      const status = await call(`/api/team/backup?id=${team.id}`, { cookie: alice });
      assert(status.body.backup.state === 'active' && status.body.backup.initial_synced_at, JSON.stringify(status.body));
    });

    await t('a comment copies only comments and its manifest, not every old version', async () => {
      sent.length = 0;
      remote.length = 0;
      const comment = await call('/api/comments', {
        method: 'POST', cookie: alice,
        body: { slug: 'plan', version: 1, text: 'Please clarify this.', anchor: null },
      });
      assert(comment.status === 200, `${comment.status} ${JSON.stringify(comment.body)}`);
      const job = sent.shift();
      assert(job && job.kind === 'comments' && job.slug === 'plan', JSON.stringify(job));
      let acked = false;
      await worker.queue({ messages: [{ body: job, ack: () => { acked = true; }, retry: () => { throw new Error('unexpected retry'); } }] }, env);
      assert(acked, 'comment job not acknowledged');
      assert(remote.length === 2, `comment update made ${remote.length} remote writes`);
      assert(remote.some((x) => x.url.endsWith('/docs/plan/comments.json')), 'comments missing');
      assert(remote.some((x) => x.url.endsWith('/docs/plan/manifest.json')), 'manifest missing');
      assert(!remote.some((x) => x.url.endsWith('/docs/plan/v1/index.html')), 'old version recopied');
    });

    await t('Trash keeps the backup copy; the purge 30 days later sends the tombstone', async () => {
      await seedDoc(env, 'old-plan', 'alice');
      await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['old-plan'], team: team.id } });
      sent.length = 0;
      const trashed = await call('/api/doc?slug=old-plan', { method: 'DELETE', cookie: alice, headers: origin });
      assert(trashed.status === 200, `trash ${trashed.status} ${JSON.stringify(trashed.body)}`);
      assert(!sent.some((job) => job.slug === 'old-plan'), `moving to Trash touched the backup: ${JSON.stringify(sent)}`);
      const at = Date.parse(JSON.parse(await env.META.get('meta:old-plan')).trashed_at);
      await worker.scheduled({ scheduledTime: at + 31 * 24 * 60 * 60 * 1000 }, env, {});
      const tombstone = sent.find((job) => job.kind === 'deleted' && job.slug === 'old-plan');
      assert(tombstone && tombstone.team === team.id, `purge tombstone ${JSON.stringify(sent)}`);
    });

    await t('move-out produces a tombstone for the old team', async () => {
      sent.length = 0;
      const moved = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['plan'], team: null } });
      assert(moved.status === 200, `move ${moved.status}`);
      const tombstone = sent.find((job) => job.kind === 'deleted' && job.slug === 'plan');
      assert(tombstone && tombstone.team === team.id && tombstone.reason === 'moved', JSON.stringify(sent));
    });

    await t('destination errors stay off the publishing path and retry visibly', async () => {
      global.fetch = async () => new Response('temporary outage', { status: 503 });
      let retried = false;
      await worker.queue({ messages: [{
        body: { v: 1, kind: 'team', team: team.id },
        retry: () => { retried = true; }, ack: () => { throw new Error('failed job acknowledged'); },
      }] }, env);
      assert(retried, 'queue did not retry');
      const status = await call(`/api/team/backup?id=${team.id}`, { cookie: alice });
      assert(status.body.backup.state === 'error' && /destination_503/.test(status.body.backup.last_error), JSON.stringify(status.body));
    });

    await t('a queue outage is reported without losing the saved connection', async () => {
      const queue = env.BACKUP_QUEUE;
      env.BACKUP_QUEUE = { send: async () => { throw new Error('queue offline'); } };
      const sync = await call('/api/team/backup', { method: 'POST', cookie: alice, headers: origin, body: { id: team.id } });
      assert(sync.status === 503 && sync.body.error === 'backup_queue_failed', `${sync.status} ${JSON.stringify(sync.body)}`);
      const status = await call(`/api/team/backup?id=${team.id}`, { cookie: alice });
      assert(status.body.backup.enabled && status.body.backup.state === 'error', JSON.stringify(status.body));
      env.BACKUP_QUEUE = queue;
    });

    await t('manual resync is queued and turning off never deletes customer data', async () => {
      global.fetch = realFetch;
      sent.length = 0;
      const sync = await call('/api/team/backup', { method: 'POST', cookie: alice, headers: origin, body: { id: team.id } });
      assert(sync.status === 200 && sent.some((job) => job.kind === 'full'), `sync ${sync.status}`);
      const before = remote.length;
      const off = await call('/api/team/backup', { method: 'DELETE', cookie: alice, headers: origin, body: { id: team.id } });
      assert(off.status === 200 && off.body.backup.enabled === false, `off ${off.status}`);
      assert(remote.length === before, 'turning off touched the destination');
      const status = await call(`/api/team/backup?id=${team.id}`, { cookie: alice });
      assert(status.body.backup.enabled === false, JSON.stringify(status.body));
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n${fail ? `FAIL — ${fail}` : `PASS — ${pass}`} (${pass + fail} checks)`);
  if (fail) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
