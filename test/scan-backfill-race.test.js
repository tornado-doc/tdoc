// A background scan must never write back a record it read: KV has no
// compare-and-set, and a read can be a minute stale in another location, so
// a scan that re-saves what it read can land after the owner's own change
// and undo it. Both walks below used to do exactly that for records from
// before their index existed (reported in review of #908):
//
//   - scanDocIndex (My docs / quota count while a facet is being built)
//     put a pre-index doc's meta back with its new index. If the owner made
//     the doc private in between, the public record came back.
//   - the "teams that invited me" walk re-saved a pre-index team. If an
//     admin withdrew an invite in between, the invite came back.
//   - a member's GET of the team's agents re-saved the team it read to drop
//     an expired setup code, with the same effect.
//
// Each test parks the scan between its read and where its write used to be,
// lets the owner change the record, then checks the change survived.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function sessionFor(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', account_id: `acct-${login}`, created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

// The first time `key` is read while `armed`, hand the reader the value as
// it was, but run `during` (the owner's write) before the reader gets it --
// the interleaving a stale or slow scan sees.
function interleaveRead(env, key, during) {
  const orig = env.META.get.bind(env.META);
  let fired = false;
  env.META.get = async (k, ...rest) => {
    const v = await orig(k, ...rest);
    if (k === key && !fired) {
      fired = true;
      await during();
    }
    return v;
  };
  return { restore: () => { env.META.get = orig; }, fired: () => fired };
}

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
  console.log('background scans never write back what they read');

  await t('a doc made private while the index scan holds its old public record stays private', async () => {
    const own = await issue(worker, env, 'own');
    const up = await call('/api/upload', { method: 'POST', token: own.token, body: { slug: 'leg', version: 1, html: '<p>secret plan</p>' } });
    assert(up.status === 200, `upload ${up.status}`);
    const pub = await call('/api/doc/access', { method: 'PATCH', token: own.token, body: { slug: 'leg', access: { visibility: 'public' } } });
    assert(pub.status === 200, `make public ${pub.status} ${JSON.stringify(pub.body)}`);
    // From before the index: the same record with no KV metadata.
    const raw = await env.META.get('meta:leg');
    await env.META.put('meta:leg', raw);
    assert(!env.META.metadata.has('meta:leg') && JSON.parse(raw).access.visibility === 'public', 'precondition');
    const open = await worker.fetch(req('/d/leg/v/1/raw'), env, {});
    assert(open.status === 200 && (await open.text()).includes('secret plan'), `precondition: public doc not readable (${open.status})`);

    // A newcomer's first My docs scans the platform (their facet is not
    // built). While the scan holds the public record, the owner makes the
    // doc private.
    const hook = interleaveRead(env, 'meta:leg', async () => {
      const r = await call('/api/doc/access', { method: 'PATCH', token: own.token, body: { slug: 'leg', access: { visibility: 'private' } } });
      assert(r.status === 200, `make private ${r.status}`);
    });
    try {
      const late = await issue(worker, env, 'late');
      const me = await call('/api/me', { token: late.token });
      assert(me.status === 200, `My docs ${me.status}`);
    } finally { hook.restore(); }
    assert(hook.fired(), 'the scan never read the legacy record');

    const stored = JSON.parse(await env.META.get('meta:leg'));
    assert(stored.access.visibility === 'private', `the scan put the old record back: visibility ${stored.access.visibility}`);
    const anon = await worker.fetch(req('/d/leg/v/1/raw'), env, {});
    const text = await anon.text();
    assert(!text.includes('secret plan'), `an anonymous reader can read the doc again (${anon.status})`);
  });

  await t('a doc the scan reads is never written by it, so a legacy record keeps no stale copy', async () => {
    const own = await issue(worker, env, 'own2');
    await call('/api/upload', { method: 'POST', token: own.token, body: { slug: 'leg2', version: 1, html: '<p>x</p>' } });
    const raw = await env.META.get('meta:leg2');
    await env.META.put('meta:leg2', raw);
    const puts = [];
    const orig = env.META.put.bind(env.META);
    env.META.put = async (k, ...rest) => { if (k.startsWith('meta:')) puts.push(k); return orig(k, ...rest); };
    try {
      const late = await issue(worker, env, 'late2');
      await call('/api/me', { token: late.token });
    } finally { env.META.put = orig; }
    assert(!puts.length, `a read-only My docs wrote doc records: ${puts.join(', ')}`);
    // The owner's next real write gives it its index.
    await call('/api/doc/title', { method: 'PATCH', token: own.token, body: { slug: 'leg2', title: 'Renamed' } });
    const md = env.META.metadata.get('meta:leg2');
    assert(md && md.v === 1 && md.t === 'Renamed', `not indexed by the owner's write: ${JSON.stringify(md)}`);
  });

  await t('an invite withdrawn while the team walk holds the old pre-index team stays withdrawn', async () => {
    const alice = await sessionFor(env, 'alice');
    const dave = await sessionFor(env, 'dave');
    const id = 't_00000000000000aa';
    const team = {
      id, name: 'Legacy crew', created: '2026-01-01T00:00:00Z', created_by: 'acct-alice',
      members: [{ account_id: 'acct-alice', key: 'alice', name: 'alice', role: 'admin', joined: '2026-01-01T00:00:00Z' }],
      invites: ['dave', 'erin'],
    };
    // From before the invite index: no metadata, no markers, not built.
    await env.META.put(`team:${id}`, JSON.stringify(team));
    await env.META.delete('tinv:built');
    assert(!env.META.metadata.has(`team:${id}`), 'precondition');

    const hook = interleaveRead(env, `team:${id}`, async () => {
      const r = await call('/api/team', { method: 'PATCH', cookie: alice, headers: { Origin: 'https://tdoc.dev' }, body: { id, invites: ['dave'] } });
      assert(r.status === 200, `withdraw ${r.status} ${JSON.stringify(r.body)}`);
    });
    try {
      const r = await call('/me', { cookie: dave });
      assert(r.status === 200, `/me ${r.status}`);
    } finally { hook.restore(); }
    assert(hook.fired(), 'the walk never read the legacy team');

    const stored = JSON.parse(await env.META.get(`team:${id}`));
    assert(JSON.stringify(stored.invites) === '["dave"]', `the walk put the withdrawn invite back: ${JSON.stringify(stored.invites)}`);
  });

  await t('a member opening the team\'s agents does not save the team, so an admin\'s concurrent removal sticks', async () => {
    const alice = await sessionFor(env, 'alice');
    const bob = await sessionFor(env, 'bob');
    const id = 't_00000000000000bb';
    const team = {
      id, name: 'Agents crew', created: '2026-01-01T00:00:00Z', created_by: 'acct-alice',
      members: [
        { account_id: 'acct-alice', key: 'alice', name: 'alice', role: 'admin', joined: '2026-01-01T00:00:00Z' },
        { account_id: 'acct-bob', key: 'bob', name: 'bob', role: 'member', joined: '2026-01-01T00:00:00Z' },
      ],
      invites: ['erin'],
      // A setup command that expired unused: a read drops it from the list.
      agents: [{ id: 'ta_00000000000000ee', name: 'never', setup_hash: 'x', setup_expires: '2026-01-02T00:00:00Z' }],
    };
    await env.META.put(`team:${id}`, JSON.stringify(team));
    const hook = interleaveRead(env, `team:${id}`, async () => {
      const r = await call('/api/team', { method: 'PATCH', cookie: alice, headers: { Origin: 'https://tdoc.dev' }, body: { id, invites: [] } });
      assert(r.status === 200, `withdraw ${r.status} ${JSON.stringify(r.body)}`);
    });
    try {
      const r = await call(`/api/team/agents?id=${id}`, { cookie: bob });
      assert(r.status === 200 && !JSON.stringify(r.body).includes('ta_00000000000000ee'), `agents ${r.status} ${JSON.stringify(r.body)}`);
    } finally { hook.restore(); }
    assert(hook.fired(), 'the GET never read the team');
    const stored = JSON.parse(await env.META.get(`team:${id}`));
    assert(JSON.stringify(stored.invites) === '[]', `a member's GET put the withdrawn invite back: ${JSON.stringify(stored.invites)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
