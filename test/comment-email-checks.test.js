// Which addresses a comment payload shows (redactCommentEmails: the doc page,
// the team feed, every other comment route). An address the reader may see is
// shown only once its deletion check has been read: a check that cannot be
// read hides it, for that response only. All of a payload's shown addresses
// are checked, in a few KV operations, and long strings cost linear time.
// Runs worker.js in-process with fake bindings (helpers/worker-harness.js).
// Run with: node test/comment-email-checks.test.js

const { createHmac } = require('crypto');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const SECRET = 'test-alias-secret';
const PIN = 'account-identity-key';
const TOMB = 'account-deleted-identity:';
const hmacHex = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const tombKey = (email) => TOMB + hmacHex(`tdoc-deleted-identity-v1\0${SECRET}`, `email:${email}`);
const isTomb = (k) => String(k).startsWith(TOMB);
const isPin = (k) => k === PIN;
const PAGE = '/api/comments?slug=one&version=all';
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const later = async (ms, fn) => {
  const now = Date.now;
  Date.now = () => now() + ms;
  try { return await fn(); } finally { Date.now = now; }
};

async function session(env, rec) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({ created: '2026-01-01T00:00:00.000Z', avatar_url: '', ...rec }));
  return `tdoc_sid=${id}`;
}

// Olga's docs, each with the same threads: `one` is hers, with people
// invited; the team ones are a team's, whose members are `invited`.
async function world({ threads, invited = [], gone = [], pinned = true, teamDocs = 1, threadsOf = () => threads }) {
  const seed = await loadWorker();
  const env = makeEnv(seed.CommentsStore, { TDOC_EMAIL_ALIAS_SECRET: SECRET });
  const olga = await session(env, { login: 'olga', name: 'olga', account_id: 'acct-olga' });
  if (pinned) await env.META.put(PIN, JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid: hmacHex(`tdoc-identity-kid\0${SECRET}`, 'kid').slice(0, 16) }));
  for (const email of gone) await env.META.put(tombKey(email), JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }));
  const made = await (await seed.default.fetch(req('/api/teams', { method: 'POST', cookie: olga, body: { name: 'T' } }), env, { waitUntil() {} })).json();
  const teamKey = [...env.META.map.keys()].find((k) => { try { const v = JSON.parse(env.META.map.get(k)); return v && v.id === made.team.id && Array.isArray(v.members); } catch { return false; } });
  const team = JSON.parse(env.META.map.get(teamKey));
  team.members.push(...invited.map((email, i) => ({ ...team.members[0], role: 'member', key: `email:${email}`, account_id: `acct-m${i}` })));
  await env.META.put(teamKey, JSON.stringify(team), { metadata: env.META.metadata.get(teamKey) });
  const created = '2026-11-01T00:00:00.000Z';
  const doc = async (slug, extra) => {
    await env.META.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, created, versions: [{ n: 1, created }], hosted: { account_id: 'acct-olga', github_login: 'olga' }, ...extra }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Plan</h1><p>Ship on Dec 18</p>');
    await env.META.put(`comments:${slug}`, JSON.stringify(threadsOf(slug).map((x, i) => ({
      id: `${slug}t${i}`, created, version: 1, text: 'note', ...x,
      replies: (x.replies || []).map((y, j) => ({ id: `${slug}t${i}r${j}`, created, ...y })),
    }))));
  };
  await doc('one', { access: { visibility: 'public', commenting: 'signed_in', allowed_users: invited } });
  for (let d = 0; d < teamDocs; d++) await doc(`team-${String(d).padStart(2, '0')}`, { workspace_id: made.team.id, access: { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: [] } });
  const kv = { failing: null, missing: null, omit: false, bulk: null, ops: 0, keys: 0, deletion: 0 };
  for (const op of ['get', 'getWithMetadata', 'put', 'delete', 'list']) {
    const own = env.META[op];
    env.META[op] = function counted(k, ...rest) {
      const keys = Array.isArray(k) ? k : [k];
      kv.ops += 1;
      kv.keys += keys.length;
      if (keys.some((x) => isTomb(x) || isPin(x))) kv.deletion += 1;
      if (op === 'get' && kv.failing && keys.some((x) => kv.failing(x))) return Promise.reject(new Error('KV is down'));
      if (op === 'get' && kv.missing && !Array.isArray(k) && kv.missing(k)) return Promise.resolve(null);
      if (op === 'get' && Array.isArray(k) && kv.bulk) return kv.bulk(k);
      // A multi-key answer that leaves missing keys out, rather than null.
      if (op === 'get' && Array.isArray(k) && kv.omit) return own.call(this, k, ...rest).then((m) => new Map([...m].filter(([, v]) => v !== null)));
      return own.call(this, k, ...rest);
    };
  }
  const client = (m, cookie = olga) => async (path, as = cookie, opts = {}) => {
    Object.assign(kv, { ops: 0, keys: 0, deletion: 0 });
    const r = await m.default.fetch(req(path, { cookie: as, ...opts }), env, { waitUntil() {} });
    return { status: r.status, text: await r.text(), ops: kv.ops, keys: kv.keys, deletion: kv.deletion };
  };
  // Once through a worker of its own: the comment stores migrate their rows.
  const FEED = `/api/team/comments?id=${made.team.id}&offset=0`;
  const warm = client(seed);
  for (const path of [PAGE, FEED]) { const r = await warm(path); assert(r.status === 200, `${path} ${r.status} ${r.text}`); }
  return { env, kv, FEED, olga, fresh: async () => client(await loadWorker()) };
}

// A cold request's own session check: the key pin and one tombstone.
const SIGNED_IN = 2;
const A = 'ann@corp.example';
const byAnn = [{ author: { login: `email:${A}`, name: A } }];
const addresses = (text) => new Set(text.match(/[a-z0-9.]+@(?:corp|people)\.example/g) || []);

(async () => {
  console.log('comment email checks');

  await t('an address whose deletion check cannot be read is hidden, and the failure is not remembered', async () => {
    const w = await world({ threads: byAnn, invited: [A] });
    for (const path of [PAGE, w.FEED]) {
      for (const [what, failing] of [['tombstone', isTomb], ['key pin', isPin]]) {
        const ask = await w.fresh();
        w.kv.failing = failing;
        const down = await ask(path);
        assert(down.status === 200 && !down.text.includes('@corp.example'), `${path}: ${what} read failed: ${down.text}`);
        w.kv.failing = null;
        assert((await ask(path)).text.includes(`email:${A}`), `${path}: ${what}: the failure was remembered`);
        // Read once, kept a minute, then read again.
        w.kv.failing = failing;
        const after = await later(61 * 1000, () => ask(path));
        assert(after.status === 200 && !after.text.includes('@corp.example'), `${path}: ${what}: shown after a minute`);
        w.kv.failing = null;
      }
    }
  });

  await t('reads of the sign-in path are its own, and nobody is signed out', async () => {
    for (const failing of [isTomb, isPin]) {
      const w = await world({ threads: byAnn, invited: [A], gone: [A] });
      const ann = await session(w.env, { email: A, name: 'ann', created: '2026-11-20T00:00:00.000Z' });
      const ask = await w.fresh();
      w.kv.failing = failing;
      const me = await ask('/api/auth/me', ann);
      assert(me.status === 200 && me.text.includes('ann'), `signed out: ${me.status} ${me.text}`);
      for (const path of [PAGE, w.FEED]) assert(!(await ask(path)).text.includes('@corp.example'), `${path}: shown while reads fail`);
      w.kv.failing = null;
      for (const path of [PAGE, w.FEED]) {
        const r = await ask(path);
        assert(r.status === 200 && !r.text.includes('@corp.example'), `${path}: shown after another route's failed read`);
      }
    }
  });

  await t('a key pin once seen, then read as missing: a deleted account\'s address stays hidden', async () => {
    const w = await world({ threads: byAnn, invited: [A], gone: [A] });
    for (const path of [PAGE, w.FEED]) {
      const ask = await w.fresh();
      assert(!(await ask(path)).text.includes('@corp.example'), `${path}: shown`);
      w.kv.missing = isPin;
      for (const ms of [0, 61 * 1000, 122 * 1000]) {
        const r = await later(ms, () => ask(path));
        assert(r.status === 200 && !r.text.includes('@corp.example'), `${path}: shown after ${ms} ms`);
      }
      w.kv.missing = null;
    }
    // Nothing was ever deleted here, so there is no pin: addresses show.
    const live = await world({ threads: byAnn, invited: [A], pinned: false });
    for (const path of [PAGE, live.FEED]) assert((await (await live.fresh())(path)).text.includes(`email:${A}`), `${path}: no pin, a live address is hidden`);
  });

  await t('every shown address is checked, however many: the live ones show, the deleted ones do not', async () => {
    const people = range(90, (i) => `p${i}@people.example`);
    const gone = [people[0], people[25], people[89]];
    const w = await world({ threads: people.map((e) => ({ author: { login: `email:${e}`, name: e } })), invited: people, gone });
    for (const path of [PAGE, w.FEED]) {
      const ask = await w.fresh();
      for (const run of ['cold', 'warm']) {
        const r = await ask(path);
        const shown = addresses(r.text);
        assert(!gone.some((e) => shown.has(e)), `${path} ${run}: a deleted account's address is shown`);
        assert(shown.size === 87, `${path} ${run}: ${shown.size} live addresses shown`);
      }
    }
    const own = { login: 'olga', name: 'olga' };
    const mine = await world({ threads: [{ author: own, text: `ask ${people.map((e) => `@${e}`).join(' ')} now` }], gone });
    for (const path of [PAGE, mine.FEED]) {
      const shown = addresses((await (await mine.fresh())(path)).text);
      // A feed row keeps its text's first 2000 characters, and its author
      // under another field: the reader's own words are not told apart there.
      assert(!gone.some((e) => shown.has(e)), `${path}: a deleted account's address in the reader's own words`);
      if (path === PAGE) assert(shown.size === 87, `${path}: own words show ${shown.size}`);
    }
  });

  await t('past the limit of one payload an address is hidden; the people a reader may see come before their own words', async () => {
    const people = range(40, (i) => `p${i}@people.example`);
    const typed = range(600, (i) => `x${i}@corp.example`);
    const w = await world({
      threads: [{ author: { login: 'olga', name: 'olga' }, text: typed.map((e) => `@${e}`).join(' ') }, ...people.map((e) => ({ author: { login: `email:${e}`, name: e } }))],
      invited: people,
    });
    const r = await (await w.fresh())(PAGE);
    const shown = addresses(r.text);
    assert(people.every((e) => shown.has(e)), 'an invited person is hidden');
    assert(shown.size === 500, `addresses shown ${shown.size}`);
    assert(r.deletion <= SIGNED_IN + 1 + 5, `deletion check operations ${r.deletion}`);
  });

  // A third of the commenters by address, the rest by handle.
  const crowd = (slug, byEmail = (i) => i % 3 === 0) => range(120, (i) => {
    const id = `${slug}x${i}`;
    return byEmail(i) ? { author: { login: `email:${id}@people.example`, name: `${id}@people.example`, account_id: `acct-${id}` } }
      : { author: { login: `h${id}`, name: `h${id}`, ...(i % 3 === 1 ? { account_id: `acct-${id}` } : {}) } };
  });

  await t('KV operations: 120 distinct commenters, and a full page of a team\'s feed', async () => {
    const all = range(120, (i) => `onex${i}@people.example`);
    const cases = [
      ['doc page, 120 addresses, none invited', await world({ threads: crowd('one', () => true) }), PAGE, 0],
      ['doc page, 120 addresses, all invited', await world({ threads: crowd('one', () => true), invited: all }), PAGE, 120],
      ['doc page, 40 addresses, all invited', await world({ threads: crowd('one'), invited: all }), PAGE, 40],
      ['team feed, 12 docs of 120, no member', await world({ threadsOf: (slug) => crowd(slug), teamDocs: 12 }), 'feed', 0],
      ['team feed, 12 docs of 120, 99 members', await world({ threadsOf: (slug) => crowd(slug), teamDocs: 12, invited: range(99, (i) => `team-${String(i % 12).padStart(2, '0')}x${3 * Math.floor(i / 12)}@people.example`) }), 'feed', 99],
    ];
    for (const [what, w, path, expected] of cases) {
      const ask = await w.fresh();
      const cold = await ask(path === 'feed' ? w.FEED : path);
      const warm = await ask(path === 'feed' ? w.FEED : path);
      const n = (r) => `${r.ops} operations (${r.keys} keys, ${r.deletion} for deletion checks)`;
      console.log(`    ${what}: cold ${n(cold)}, warm ${n(warm)}`);
      assert(cold.status === 200, `${what} ${cold.status}`);
      for (const r of [cold, warm]) assert(addresses(r.text).size === expected, `${what}: ${addresses(r.text).size} addresses shown`);
      const bound = SIGNED_IN + (expected ? 1 + Math.ceil(expected / 100) : 0);
      assert(cold.deletion <= bound, `${what}: cold ${cold.deletion}`);
      assert(warm.deletion <= (expected ? 1 : 0), `${what}: warm ${warm.deletion}`);
    }
  });

  await t('long strings anywhere in a comment: read quickly, and no part of an address in them', async () => {
    const N = 20000;
    const long = [
      `x@${'.'.repeat(N)} `,
      `email:x@${'.'.repeat(N)} `,
      `zed@${'a.'.repeat(N / 2)}longdomain.example`,
      `zed@longdomain.${'e'.repeat(N)}`,
      `${'n'.repeat(N)}@longdomain.example`,
      `email:zed@${'longdomain.'.repeat(N / 11)}example`,
      `email:${'n'.repeat(N)}@longdomain.example`,
    ];
    const threads = long.flatMap((s) => [
      { author: { login: 'quinn', name: s } },
      { author: { login: s, name: 'quinn' } },
      { author: { login: 'quinn', name: 'quinn', avatar_url: s } },
      { author: { login: 'quinn', name: 'quinn' }, reactions: { '👍': [s] } },
      { author: { login: 'bot', kind: 'agent', handle: s, provider: s, name: 'bot' }, replies: [{ author: { login: s, name: s }, text: 'ok' }] },
    ]);
    const w = await world({ threads });
    const ask = await w.fresh();
    for (const path of [PAGE, w.FEED]) {
      const started = process.hrtime.bigint();
      const r = await ask(path);
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      console.log(`    ${path.split('?')[0]}: ${ms} ms`);
      assert(r.status === 200 && JSON.parse(r.text), `${path} ${r.status}`);
      assert(!/@longd/.test(r.text) && !/@a\.a/.test(r.text), `${path}: part of an address: ${(r.text.match(/.{40}@(longd|a\.a).{40}/) || [])[0]}`);
      assert(ms < 3000, `${path} took ${ms} ms`);
    }
  });

  await t('a multi-key answer without the missing keys shows the live addresses; one that is not an answer shows none', async () => {
    const people = range(130, (i) => `p${i}@people.example`);
    const gone = [people[3], people[110]];
    const w = await world({ threads: people.map((e) => ({ author: { login: `email:${e}`, name: e } })), invited: people, gone });
    const down = async () => { throw new Error('KV is down'); };
    const read = async (set) => {
      const ask = await w.fresh();
      Object.assign(w.kv, set);
      const r = await ask(PAGE);
      Object.assign(w.kv, { omit: false, bulk: null, failing: null });
      assert(r.status === 200, `${r.status}`);
      const shown = addresses(r.text);
      assert(!gone.some((e) => shown.has(e)), 'a deleted account\'s address is shown');
      return { ...r, shown: shown.size };
    };
    const omitted = await read({ omit: true });
    assert(omitted.shown === 128, `left out: ${omitted.shown} shown`);
    assert(omitted.ops < 500, `left out: ${omitted.ops} operations`);
    // Left out because it failed: the read of its own says so.
    const single = await read({ omit: true, failing: null, bulk: async (keys) => { w.kv.failing = isTomb; return new Map(); } });
    assert(single.shown === 0, `an empty answer, reads failing: ${single.shown} shown`);
    const part = await read({ bulk: async (keys) => new Map(keys.map((k) => [k, k === tombKey(people[5]) ? undefined : k === tombKey(people[3]) || k === tombKey(people[110]) ? '{"at":"2026-11-02"}' : null])) });
    assert(part.shown === 127, `a key answered undefined: ${part.shown} shown`);
    for (const [what, bulk] of [['rejected', down], ['null', async () => null], ['an object', async () => ({})], ['undefined', async () => undefined]]) {
      const r = await read({ bulk });
      assert(r.shown === 0, `${what}: ${r.shown} shown`);
    }
  });

  await t('keys an answer leaves out are read on their own, at most 300; what a clean read said is kept for 2,000 addresses', async () => {
    const people = range(400, (i) => `p${i}@people.example`);
    const w = await world({ threads: people.map((e) => ({ author: { login: `email:${e}`, name: e } })), invited: people });
    const ask = await w.fresh();
    w.kv.omit = true;
    const r = await ask(PAGE);
    assert(addresses(r.text).size === 300 && r.deletion <= SIGNED_IN + 1 + 4 + 300, `${addresses(r.text).size} shown, ${r.deletion} operations`);
    const many = await world({ threadsOf: (slug) => [{ author: { login: 'olga', name: 'olga' }, text: range(500, (i) => `@${slug}x${i}@people.example`).join(' ') }], teamDocs: 4 });
    const read = await many.fresh();
    const page = async (slug) => (await read(`/api/comments?slug=${slug}&version=all`)).deletion;
    assert(await page('one') >= 1 + 5, 'the first read');
    for (const slug of ['team-00', 'team-01', 'team-02']) await page(slug);
    assert(await page('one') === 1, 'kept: 2,000 addresses');
    await page('team-03');
    assert(await page('one') === 1 + 5, 'the oldest are read again');
  });

  await t('a tombstone this isolate has seen counts for ten minutes, whatever KV answers', async () => {
    const w = await world({ threads: byAnn, invited: [A], gone: [A] });
    const ann = await session(w.env, { email: A, name: 'ann', created: '2026-11-20T00:00:00.000Z' });
    const ask = await w.fresh();
    await ask('/api/auth/me', ann);
    await w.env.META.delete(tombKey(A));
    for (const [ms, shown] of [[0, false], [9 * 60 * 1000, false], [10 * 60 * 1000 + 1, true]]) {
      const r = await later(ms, () => ask(PAGE));
      assert(r.text.includes(`email:${A}`) === shown, `after ${ms} ms: ${r.text.slice(0, 200)}`);
    }
  });

  await t('deleting an account, and bringing it back, count at once where they happen', async () => {
    const w = await world({ threads: byAnn, invited: [A] });
    w.env.TDOC_UPLOAD_TOKEN = 'admin-secret';
    const here = await w.fresh();
    const shown = async (ask) => (await ask(PAGE)).text.includes(`email:${A}`);
    const ann = await session(w.env, { email: A, name: 'ann', created: new Date().toISOString() });
    const minted = await here('/api/hosted/token', ann, { method: 'POST', body: { label: 'ann' } });
    assert(minted.status === 200 && await shown(here), `${minted.status} ${minted.text}`);
    const del = await here('/api/me/account/delete', ann, { method: 'POST', headers: { Origin: 'https://tdoc.dev' }, body: { confirm: A } });
    assert(del.status === 200, `${del.status} ${del.text}`);
    // Tombstones the sign-in path keeps are the last thousand it asked about.
    for (let i = 0; i <= 1000; i++) await here('/api/auth/me', await session(w.env, { email: `s${i}@people.example`, name: 's' }));
    assert(!await shown(here), 'shown after the deletion');
    const there = await w.fresh();
    assert(!await shown(there), 'shown elsewhere');
    const back = await there('/api/admin/account/restore', '', { method: 'POST', token: 'admin-secret', body: { account_id: JSON.parse(minted.text).account_id } });
    assert(back.status === 200 && await shown(there), `${back.status} ${back.text}: hidden after the account is back`);
  });

  await t('the reader\'s own words: a tag is checked whatever is written against it', async () => {
    const G = 'gone@corp.example';
    const L = 'live@corp.example';
    const own = { login: 'olga', name: 'olga' };
    const around = (x) => [`ask @${x}, please`, `ask @${x}.`, `(@${x})`, `@${x}!?`, `@${x}\uff0c\u8bf7\u770b`, `@${x}\u8bf7\u770b`, `"@${x}"`, `@<${x}>`, `@${x}/then`, `@${x};@${x}`, `is it @${x}?`, `\u300c@${x}\u300d`];
    const w = await world({ threads: [...around(G), ...around(L)].map((text) => ({ author: own, text })), gone: [G] });
    const list = JSON.parse((await (await w.fresh())(PAGE)).text);
    list.forEach((c, i) => {
      const want = i < around(G).length ? around('gone')[i] : around(L)[i - around(G).length];
      assert(c.text === want, `${JSON.stringify(c.text)}, not ${JSON.stringify(want)}`);
    });
  });

  await t('saving an edit of one\'s own words keeps the addresses they were shown without', async () => {
    const G = 'gone@corp.example';
    const own = { login: 'olga', name: 'olga' };
    const find = (list, id) => list.flatMap((c) => [c, ...(c.replies || [])]).find((x) => x.id === id);
    const notes = async ({ threads, gone = [], failing = null }) => {
      const w = await world({ threads: threads.map(([text, ...replies]) => ({ author: own, text, replies: replies.map((x) => ({ author: own, text: x })) })), gone });
      const ask = await w.fresh();
      w.kv.failing = failing;
      const page = JSON.parse((await ask(PAGE)).text);
      return {
        w,
        shown: (id) => find(page, id).text,
        save: (id, body) => ask('/api/comments', undefined, { method: 'PATCH', body: { slug: 'one', version: 1, id, ...body } }),
        stored: async (id) => {
          const { list } = await (await w.env.COMMENTS.get('one').fetch('https://do/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'one' }) })).json();
          const { events = [] } = list.find((c) => c.id === id.replace(/r\d+$/, ''));
          return events.filter((e) => (/r\d+$/.test(id) ? e.reply_id === id : e.kind === 'text_edited')).map((e) => e.text).pop() || null;
        },
      };
    };
    // Each case: what Olga wrote, what she types over the words she is shown,
    // and what is stored then, or { names } of a refusal. As a thread and as a
    // reply, saying which words the edit started from and not.
    const edits = async (cases, { back = false, ways = [true, false], ...how } = {}) => {
      const all = cases.flatMap((c) => ways.map((withBase) => ({ c, withBase })));
      const n = await notes({ threads: all.map(({ c }) => [c[0], c[0]]), ...how });
      if (back) n.w.kv.failing = null;
      for (const [i, { c: [text, change, want], withBase }] of all.entries()) {
        for (const id of [`onet${i}`, `onet${i}r0`]) {
          const shown = n.shown(id);
          const next = change(shown);
          const r = await n.save(id, { text: next, ...(withBase ? { base_text: shown } : {}) });
          const what = `${id} ${JSON.stringify(text)} shown ${JSON.stringify(shown)} saved ${JSON.stringify(next)}${withBase ? '' : ' (no base)'}`;
          assert(r.status === (want.names ? 409 : 200), `${what}: ${r.status} ${r.text}`);
          if (want.names) {
            const body = JSON.parse(r.text);
            assert(body.error === 'edit_hidden_address' && JSON.stringify(body.names) === JSON.stringify(want.names) && want.names.every((x) => body.message.includes(x)) && !/reload|Too many/.test(body.message), `${what}: ${r.text}`);
          }
          const now = await n.stored(id);
          assert(now === (want.names ? null : want), `${what}: stored ${JSON.stringify(now)}`);
          for (const e of how.gone || []) assert(!r.text.includes(e), `${what}: the answer shows a deleted account's address`);
        }
      }
    };
    const live = 'ask @ann@corp.example, and @bob@corp.example about it';
    const two = 'ask @ann@corp.example or @ann@people.example or @ann';
    const first = 'ask @ann@corp.example first, then @ann@people.example';
    const add = (s) => `${s} today`;
    const down = [
      [live, add, add(live)],
      [live, (s) => `well, ${s.replace('and @bob ', '')}`, 'well, ask @ann@corp.example, about it'],
      [live, (s) => s.replace('@bob', '@bobby'), 'ask @ann@corp.example, and @bobby about it'],
      // Two that read the same: kept as they are and edited around; with one
      // taken out, or the two exchanged, which is which is not known.
      [two, add, add(two)],
      [two, (s) => s.replace('ask', 'do ask'), two.replace('ask', 'do ask')],
      [two, (s) => s.replace(' or @ann', ''), { names: ['@ann'] }],
      [first, () => 'then @ann ask @ann first,', { names: ['@ann'] }],
      [first, () => 'then @ann', { names: ['@ann'] }],
      [first, () => 'ask @ann and @ann first, then @ann', { names: ['@ann'] }],
      [first, () => 'neither', 'neither'],
      ['@ann@corp.example, ok', () => '@ann @ann, ok then', '@ann @ann@corp.example, ok then'],
      // The name is still there, written another way.
      ['read @ann@corp.example\'s draft', (s) => s.replace("@ann's", "(@ann's)"), { names: ['@ann'] }],
      ['read @ann@corp.example now', (s) => s.replace('@ann', '@Ann'), { names: ['@ann'] }],
      ['read @ann@corp.example now', (s) => s.replace('@ann', '@ann-led'), { names: ['@ann'] }],
      ['read @ann@corp.example now', (s) => s.replace('@ann', '@ann.then'), { names: ['@ann'] }],
      ['read @a.b@corp.example now', (s) => s.replace('@a.b', '@a.b_x'), { names: ['@a.b'] }],
      ['read @a.b@corp.example now', () => '_read @a.b_ now', { names: ['@a.b'] }],
      ['read @ann@corp.example;@bob@corp.example now', (s) => s.replace('@ann;@bob', "@ann;@bob's"), { names: ['@bob'] }],
      ['read @ann@corp.example\'s draft', (s) => `${s} now`, 'read @ann@corp.example\'s draft now'],
      ['ask @ann@corp.example or @ann-led now ok', () => 'well @ann-led then, fine', 'well @ann-led then, fine'],
      ['ask @ann@corp.example, now ok', () => "well ask @ann now and (@ann's) fine", "well ask @ann@corp.example now and (@ann's) fine"],
      ['read @ann@corp.example, not @ann-led', (s) => s.replace('@ann, not', 'them, or'), 'read them, or @ann-led'],
      // The words around a name tell which it is; where they do not, or the
      // name is there once too often, nothing is guessed.
      ['ask @ann@corp.example ok? then @ann said no', () => 'well ask @ann said no, fine', { names: ['@ann'] }],
      ['ask @ann@corp.example now ok', () => 'well ask @ann or @ann now fine', { names: ['@ann'] }],
      ['ask @ann@corp.example/x now', (s) => s.replace('/x', '/x/@ann'), { names: ['@ann'] }],
      ['@ann@corp.example, @ann@corp.example then bob and', () => '@ann then bob and @ann,', { names: ['@ann'] }],
    ];
    await edits(down, { failing: isTomb });
    await edits(down, { failing: isTomb, back: true, ways: [true] });
    await edits(down.slice(0, 2), { failing: isPin });
    // Without the words it started from: what its author would be shown now.
    await edits([[live, add, 'ask @ann, and @bob about it today']], { failing: isTomb, back: true, ways: [false] });
    await edits([
      [`see @${G}, ok`, add, `see @${G}, ok today`],
      // Whatever is written against a tag.
      ...[`@${G}/@pat`, `@${G}@`, `@${G}/@`, `@${G}/x`, `@(${G})`, `@${G}\uff0c\u8bf7\u770b`, `@${G};@pat@corp.example`, `"@${G}"`, `@${G}/@gone`, `@${G}\ud83d\ude00`].map((x) => `so ${x} it is`).flatMap((text) => [
        [text, add, add(text)], [text, (s) => `well, ${s}`, `well, ${text}`], [text, (s) => s.replace('it is', 'was'), text.replace('it is', 'was')], [text, () => 'never mind', 'never mind'],
      ]),
      [`@${G}\uff0c\u8bf7\u770b`, (s) => `${s}\u4e00\u4e0b`, `@${G}\uff0c\u8bf7\u770b\u4e00\u4e0b`],
      // The whole tag typed again, and the spaces and lines as typed.
      [`ask @${G} now`, () => `  ask @${G}\n\n  now `, `ask @${G}\n\n  now`],
      [`ask\n\n@${G}   now`, (s) => `${s}\n ok`, `ask\n\n@${G}   now\n ok`],
      [`  @${G} `, (s) => `so ${s}`, `so   @${G}`],
      // Cut short on purpose, beside one that is hidden.
      [`so @${G};@pat@corp.example it is`, (s) => s.replace('@pat@corp.example', '@pat'), `so @${G};@pat it is`],
      // The name somewhere else.
      [`ask @${G}`, () => 'I met @gone today', { names: ['@gone'] }],
      [`ask @${G}`, () => 'gone fishing', 'gone fishing'],
    ], { gone: [G] });
    // Shown in full: what is typed is what is meant.
    await edits(['ask @ann, and @bob about it', '@bob', 'ask @ann@corp.example', add(live)].map((next) => [live, () => next, next]));
    // Past the limit of what is checked.
    const many = range(520, (i) => `@x${i}@corp.example`).join(' ');
    await edits([[many, add, add(many)]], { ways: [true] });
    await edits([[many, add, add(many)]], { ways: [false] });
    // Very many, or very long: quickly. What no longer has a name is saved, and
    // so is an ordinary long comment.
    const long = `${'plain words '.repeat(4000)}${range(20, (i) => `@p${i}@corp.example`).join(' and ')} ${'more of it '.repeat(4000)}end`;
    await edits([[long, add, add(long)], [long, (s) => `well, ${s.replace('and @p7', 'or @p7')}`, `well, ${long.replace('and @p7', 'or @p7')}`]], { failing: isTomb });
    const plain = 'plain words '.repeat(300).trim();
    for (const text of [range(3000, (i) => `@x${i % 7}@corp.example`).join(' '), range(8000, (i) => `@u${i}@h.co`).join(';'), range(8000, () => '@u@h.co').join(';')]) {
      const n = await notes({ threads: [[text]], failing: isTomb });
      const base_text = n.shown('onet0');
      for (const next of [`${base_text}!`, base_text.split(/[; ]/).reverse().join(' '), base_text.split(/[; ]/).map((x) => `${x},`).join(' '), plain]) {
        for (const body of [{ text: next, base_text }, { text: next }]) {
          const started = process.hrtime.bigint();
          const r = await n.save('onet0', body);
          const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
          const names = r.status === 409 ? JSON.parse(r.text).names : [];
          assert(ms < 1500 && (next === plain ? r.status === 200 : r.status === 409 && names.length && names.every((x) => base_text.includes(x)) && /^Too many .* remove the @names\.$/.test(JSON.parse(r.text).message)), `${text.slice(0, 30)} ${next.slice(0, 20)}: ${r.status} ${ms} ms ${names.slice(0, 4)}`);
        }
        if (next === plain) assert(await n.stored('onet0') === plain, 'plain words');
      }
    }

    // Edited in another window in between: still by what this one was shown.
    const other = await notes({ threads: [[live]], failing: isTomb });
    const base_text = other.shown('onet0');
    for (const text of ['other words', 'ask @ann, and @bob now']) assert((await other.save('onet0', { text, base_text })).status === 200, text);
    assert(await other.stored('onet0') === 'ask @ann@corp.example, and @bob@corp.example now', `another window: ${await other.stored('onet0')}`);
    // Never said, or too many edits ago.
    const outdated = async (n, id, body) => {
      const was = await n.stored(id);
      const r = await n.save(id, body);
      assert(r.status === 409 && JSON.parse(r.text).error === 'edit_outdated' && /reload/.test(r.text) && await n.stored(id) === was, `${JSON.stringify(body)}: ${r.status} ${r.text}`);
    };
    const old = await notes({ threads: [[live]], failing: isTomb });
    for (const was of ['ask @ann, then', base_text.replace('ask', 'as')]) await outdated(old, 'onet0', { text: 'ask @ann, x', base_text: was });
    for (let i = 0; i < 25; i++) assert((await old.save('onet0', { text: `${i} @cat@corp.example`, base_text: i ? `${i - 1} @cat` : base_text })).status === 200, `edit ${i}`);
    await outdated(old, 'onet0', { text: add(base_text), base_text });
    // A reply's own words, not those of the one beside it.
    const pair = await notes({ threads: [['note', 'ask @bob@corp.example', 'ask @ann@corp.example']], failing: isTomb });
    await outdated(pair, 'onet0r0', { text: 'ask @ann now', base_text: 'ask @ann' });
    assert((await pair.save('onet0r1', { text: 'tell @cat@corp.example', base_text: 'ask @ann' })).status === 200, 'the other reply');
    await outdated(pair, 'onet0r0', { text: 'tell @cat now', base_text: 'tell @cat' });
  });

  await t('publishing the comments a read gave back changes none of the stored ones', async () => {
    const w = await world({ threads: [{ author: { login: 'olga', name: 'olga' }, text: `ask @${A}` }, ...byAnn], invited: [A] });
    const ask = await w.fresh();
    w.kv.failing = isTomb;
    const pulled = JSON.parse((await ask(PAGE)).text);
    w.kv.failing = null;
    assert(pulled[0].text === 'ask @ann' && /^email-alias:/.test(pulled[1].author.login), `pulled ${JSON.stringify(pulled).slice(0, 300)}`);
    const token = 'upload-secret';
    w.env.TDOC_UPLOAD_TOKEN = token;
    const up = await ask('/api/upload', '', { method: 'POST', token, body: { slug: 'one', version: 2, html: '<h1>Plan</h1>', comments: pulled } });
    assert(up.status === 200, `upload ${up.status} ${up.text}`);
    const now = JSON.parse((await ask(PAGE)).text);
    assert(now.length === 2 && now[0].text === `ask @${A}` && now[1].author.login === `email:${A}`, `stored ${JSON.stringify(now).slice(0, 300)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
