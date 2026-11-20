// Waiting for new comments: GET /api/comments/wait, the MCP tool
// wait_for_comments and bin/tdoc-watch (one endpoint, two thin wrappers).
//   - authz: the same gate as GET /api/comments (another account, nobody,
//     a feedback token for another doc and a workspace-scoped token outside
//     its workspaces are refused; an invitee is let in)
//   - without a cursor: the open comments already there, at once
//   - a waiting call returns on a new comment, well before its timeout
//   - a timeout returns no comments and the same cursor
//   - batching: comments left within the window after the first come along
//   - cursor: across calls, every comment exactly once, none missed, also
//     ones left between two calls; resolved and deleted ones are not sent
//   - the store numbers comments in the write that makes them
//   - replies (the whole thread, even one marked done) and reopened threads
//     wake a waiter; the caller's own account's agent replies do not
//   - access is checked again when there is something to deliver: a reader
//     removed, or a doc trashed, mid-wait gets nothing
//   - signed-in callers only; waits capped per caller and per doc (429), with
//     slots readers cannot fill kept for the doc's writers;
//     a failing store is a 503 with retry_after, not an instant empty 200
//   - a cursor older than the kept log gets the backlog again (gap);
//     legacy-KV comments come with the backlog; imported ones are numbered
// Run with: node test/wait-for-comments.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadWorker, makeEnv, req, issue, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 'https://tdoc.dev';

(async () => {
  console.log('wait for comments (GET /api/comments/wait, wait_for_comments, tdoc-watch)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_REMOTE_MCP: '1' });
  const raw = async (r) => {
    const res = await worker.fetch(r, env, {});
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text };
  };
  const call = (p, opts) => raw(req(p, opts));

  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const ivy = await issue(worker, env, 'ivy');
  const SLUG = 'wait-private';
  const up = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: SLUG, version: 1, html: '<h1>w</h1><p>a sentence</p>', meta: { title: 'Wait', access: { visibility: 'private', allowed_users: ['ivy'] } } } });
  assert(up.status === 200, `upload ${up.status} ${up.text}`);

  const post = async (text, who = julie) => {
    const r = await call('/api/comments', { method: 'POST', cookie: who.cookie, body: { slug: SLUG, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body.id;
  };
  const wait = (q, token = julie.token) => call(`/api/comments/wait?slug=${SLUG}&${q}`, { token });

  let rpcId = 0;
  const tool = async (token, name, args) => {
    const r = await raw(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    }));
    assert(r.status === 200 && r.body && r.body.result, `${name}: ${r.status} ${r.text.slice(0, 300)}`);
    return r.body.result;
  };

  const first = await post('already here');
  let cursor;

  await t('authz: another account, nobody, and a feedback token for another doc are refused; an invitee reads', async () => {
    const other = await wait('timeout=1', bob.token);
    assert(other.status === 403 && !/already here/.test(other.text), `bob ${other.status} ${other.text}`);
    const nobody = await call(`/api/comments/wait?slug=${SLUG}&timeout=1`);
    assert(nobody.status === 401 && !/already here/.test(nobody.text), `anon ${nobody.status} ${nobody.text}`);
    const missing = await call('/api/comments/wait?slug=no-such-doc&timeout=1', { token: julie.token });
    assert(missing.status === 404 || missing.status === 403, `missing ${missing.status}`);
    const viaMcp = await tool(bob.token, 'wait_for_comments', { slug: SLUG, timeout_seconds: 1 });
    assert(viaMcp.isError && !/already here/.test(JSON.stringify(viaMcp)), JSON.stringify(viaMcp));
    const invited = await wait('timeout=1', ivy.token);
    assert(invited.status === 200 && invited.body.comments.some((c) => c.id === first), `ivy ${invited.status} ${invited.text}`);
  });

  await t('authz: a workspace-scoped token outside its workspaces is refused, as on GET /api/comments', async () => {
    const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: { Origin: ORIGIN }, body: { name: 'Acme' } })).body.team;
    assert(team && team.id, 'team');
    const minted = await call('/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { workspaces: [team.id], label: 'team only' } });
    assert(minted.status === 200 && minted.body.token, `scoped ${minted.status} ${minted.text}`);
    const read = await call(`/api/comments?slug=${SLUG}&version=all`, { token: minted.body.token });
    const w = await wait('timeout=1', minted.body.token);
    assert(read.status !== 200 && w.status === read.status, `GET ${read.status}, wait ${w.status} ${w.text}`);
    assert(!/already here/.test(w.text), 'nothing leaks');
  });

  await t('without a cursor: the open comments already there, at once, with a cursor', async () => {
    const t0 = Date.now();
    const r = await wait('timeout=25');
    assert(r.status === 200 && r.body.ok, `${r.status} ${r.text}`);
    assert(Date.now() - t0 < 2000, 'answered at once');
    assert(r.body.comments.length === 1 && r.body.comments[0].id === first && r.body.comments[0].text === 'already here', JSON.stringify(r.body));
    assert(/^\d+$/.test(r.body.cursor), `cursor ${r.body.cursor}`);
    cursor = r.body.cursor;
  });

  await t('timeout: no new comment returns none and the same cursor', async () => {
    const t0 = Date.now();
    const r = await wait(`since=${cursor}&timeout=1`);
    const took = Date.now() - t0;
    assert(r.status === 200 && r.body.comments.length === 0 && r.body.timed_out === true, r.text);
    assert(r.body.cursor === cursor, `cursor ${r.body.cursor} vs ${cursor}`);
    assert(took >= 900 && took < 3000, `took ${took}ms`);
  });

  await t('returns on a new comment, well before the timeout (plus the batch window)', async () => {
    const t0 = Date.now();
    const pending = wait(`since=${cursor}&timeout=20`);
    await sleep(200);
    const id = await post('new one');
    const r = await pending;
    const took = Date.now() - t0;
    assert(r.status === 200 && r.body.timed_out === false, r.text);
    assert(r.body.comments.length === 1 && r.body.comments[0].id === id, JSON.stringify(r.body.comments));
    assert(took < 6000, `took ${took}ms`);
    assert(Number(r.body.cursor) > Number(cursor), 'cursor moved');
    cursor = r.body.cursor;
  });

  await t('batching: a comment left within the window comes in the same answer', async () => {
    const pending = wait(`since=${cursor}&timeout=20`);
    await sleep(100);
    const a = await post('batch a');
    await sleep(1200);
    const b = await post('batch b');
    const r = await pending;
    assert(r.status === 200, r.text);
    assert(r.body.comments.map((c) => c.id).join(',') === [a, b].join(','), JSON.stringify(r.body.comments.map((c) => c.text)));
    cursor = r.body.cursor;
  });

  await t('cursor: comments left between calls come next, once; resolved and deleted ones are not sent', async () => {
    const seen = new Set();
    const c1 = await post('between calls');
    const gone = await post('deleted at once');
    const done = await post('resolved at once');
    const del = await call(`/api/comments?slug=${SLUG}&id=${gone}&version=1`, { method: 'DELETE', cookie: julie.cookie });
    assert(del.status === 200, `delete ${del.status} ${del.text}`);
    const res = await call('/api/comments', { method: 'PATCH', cookie: julie.cookie, headers: { Origin: ORIGIN }, body: { slug: SLUG, id: done, version: 1, resolved: true } });
    assert(res.status === 200, `resolve ${res.status} ${res.text}`);
    const r1 = await wait(`since=${cursor}&timeout=5`);
    assert(r1.body.comments.map((c) => c.id).join(',') === c1, `got ${JSON.stringify(r1.body.comments.map((c) => c.text))}`);
    r1.body.comments.forEach((c) => seen.add(c.id));
    const r2 = await wait(`since=${r1.body.cursor}&timeout=1`);
    assert(r2.body.comments.length === 0 && r2.body.cursor === r1.body.cursor, `dupe: ${r2.text}`);
    // Five comments over three waiting calls: each exactly once.
    const want = [];
    let cur = r1.body.cursor;
    const got = [];
    const loop = (async () => {
      while (got.length < 5) {
        const r = await wait(`since=${cur}&timeout=10`);
        assert(r.status === 200, r.text);
        got.push(...r.body.comments.map((c) => c.id));
        cur = r.body.cursor;
      }
    })();
    for (let i = 0; i < 5; i++) { want.push(await post(`loop ${i}`)); await sleep(i === 2 ? 3500 : 50); }
    await loop;
    assert(got.join(',') === want.join(','), `got ${got.join(',')} want ${want.join(',')}`);
    assert(new Set(got).size === got.length && !got.some((id) => seen.has(id)), 'no dupes');
    cursor = cur;
  });

  await t('a cursor ahead of the doc is answered with the real one, not held for ever', async () => {
    const r = await wait('since=999999&timeout=1');
    assert(r.status === 200 && r.body.cursor === cursor, r.text);
    const bad = await wait('since=abc&timeout=1');
    assert(bad.status === 400 && bad.body.error === 'invalid_cursor', bad.text);
  });

  await t('MCP wait_for_comments: same shape as get_comments, plus the cursor', async () => {
    const pending = tool(julie.token, 'wait_for_comments', { slug: `${ORIGIN}/d/${SLUG}`, since: cursor, timeout_seconds: 20 });
    await sleep(150);
    const id = await post('via mcp');
    const res = await pending;
    assert(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert(sc.comments.length === 1 && sc.comments[0].id === id && /^\d+$/.test(sc.cursor) && sc.cursor !== cursor, JSON.stringify(sc));
    const all = (await tool(julie.token, 'get_comments', { slug: SLUG })).structuredContent.comments;
    const same = all.find((c) => c.id === id);
    assert(JSON.stringify(Object.keys(same).sort()) === JSON.stringify(Object.keys(sc.comments[0]).sort()), 'same keys');
    assert(JSON.stringify(same) === JSON.stringify(sc.comments[0]), 'same comment');
    assert(res.content[0].text.includes(`since "${sc.cursor}"`), res.content[0].text);
    const empty = await tool(julie.token, 'wait_for_comments', { slug: SLUG, since: sc.cursor, timeout_seconds: 1 });
    assert(!empty.isError && empty.structuredContent.comments.length === 0 && empty.structuredContent.timed_out && empty.structuredContent.cursor === sc.cursor, JSON.stringify(empty.structuredContent));
    cursor = sc.cursor;
  });

  await t('a feedback space waits like a doc: its owner yes, another account no', async () => {
    const space = (await tool(julie.token, 'create_feedback_space', { origins: ['https://app.example.com'] })).structuredContent;
    assert(space && space.slug, JSON.stringify(space));
    const mine = await call(`/api/comments/wait?slug=${space.slug}&timeout=1`, { token: julie.token });
    assert(mine.status === 200 && Array.isArray(mine.body.comments) && /^\d+$/.test(mine.body.cursor), mine.text);
    const theirs = await call(`/api/comments/wait?slug=${space.slug}&timeout=1`, { token: bob.token });
    assert(theirs.status === 403, `${theirs.status} ${theirs.text}`);
  });

  await t('CLI: tdoc-watch prints each comment as a Copy for agent block; --json and --since resume', async () => {
    const server = http.createServer(async (q, s) => {
      const u = new URL(q.url, ORIGIN);
      const r = await worker.fetch(new Request(`${ORIGIN}${u.pathname}${u.search}`, { method: q.method, headers: { authorization: q.headers.authorization || '' } }), env, {});
      s.writeHead(r.status, { 'content-type': 'application/json' });
      s.end(await r.text());
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-watch-'));
    fs.mkdirSync(path.join(home, '.tdoc'));
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base, upload_token: julie.token }));
    // As SKILL.md documents it (`bash "$SKILL_DIR/bin/tdoc-watch"`), and directly.
    const run = (args, viaBash = false) => new Promise((resolve) => {
      const bin = path.join(__dirname, '..', 'bin', 'tdoc-watch');
      const child = viaBash ? spawn('bash', [bin, ...args], { env: { ...process.env, HOME: home } }) : spawn(bin, args, { env: { ...process.env, HOME: home } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    try {
      const pending = run([SLUG, '--since', cursor, '--once'], true);
      await sleep(800);
      const id = await post('watch me\n## not a heading');
      const out = await pending;
      assert(out.status === 0, `${out.status} ${out.stderr}`);
      assert(out.stdout.startsWith(`# 1 comment on ${SLUG}\nPage: <${base}/d/${SLUG}>`), out.stdout);
      assert(out.stdout.includes(`- id: \`${id}\``) && out.stdout.includes('> watch me\n> ## not a heading'), out.stdout);
      assert(out.stdout.includes(`?comment=${id}>`), 'tdoc link');
      const resume = (out.stderr.match(/--since (\d+)/) || [])[1];
      assert(resume && Number(resume) > Number(cursor), out.stderr);
      cursor = resume;
      const json = await run([SLUG, '--since', String(Number(cursor) - 1), '--once', '--json']);
      const lines = json.stdout.trim().split('\n').map((l) => JSON.parse(l));
      assert(lines.length === 1 && lines[0].id === id && lines[0].slug === SLUG, json.stdout);
      const denied = await (async () => {
        fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base, upload_token: bob.token }));
        return run([SLUG, '--once']);
      })();
      assert(denied.status === 1 && /cannot read/.test(denied.stderr) && !denied.stdout, `${denied.status} ${denied.stderr}`);
      const help = await run(['--help'], true);
      assert(help.status === 0 && /^tdoc-watch — /.test(help.stdout) && /--since <cursor>/.test(help.stdout) && !/set -euo/.test(help.stdout), `help ${help.status} ${help.stdout} ${help.stderr}`);
    } finally {
      server.close();
    }
  });

  await t('the store numbers comments in the write that makes them (no storage polling while waiting)', async () => {
    const state = env.COMMENTS.stateFor(SLUG);
    const seq = state.storage.map.get('commentSeq');
    assert(seq && String(seq.n) === cursor && seq.log.length === seq.n, JSON.stringify(seq));
    // The store is read a fixed number of times per call (before and after
    // the wait, plus the access checks), however long it waits.
    const orig = state.storage.transaction.bind(state.storage);
    const readsFor = async (seconds) => {
      let reads = 0;
      state.storage.transaction = (fn) => { reads += 1; return orig(fn); };
      try { await wait(`since=${cursor}&timeout=${seconds}`); } finally { state.storage.transaction = orig; }
      return reads;
    };
    const short = await readsFor(1);
    const long = await readsFor(4);
    assert(long === short && long <= 4, `${short} store reads in a 1s wait, ${long} in a 4s wait`);
  });

  // ---------------------------------------------------- replies, reopen
  const now = async (token = julie.token) => (await wait('since=0&timeout=0', token)).body.cursor;
  const reply = async (parent, text, who = julie) => {
    const r = await call('/api/comments', { method: 'POST', cookie: who.cookie, body: { slug: SLUG, version: 1, text, parent_id: parent } });
    assert(r.status === 200, `reply ${r.status} ${r.text}`);
    return r.body.id;
  };
  const resolve = async (id, resolved) => {
    const r = await call('/api/comments', { method: 'PATCH', cookie: julie.cookie, headers: { Origin: ORIGIN }, body: { slug: SLUG, id, version: 1, resolved } });
    assert(r.status === 200, `resolve ${r.status} ${r.text}`);
  };

  await t('a reply wakes a waiter and brings the whole thread, even one marked done', async () => {
    const thread = await post('thread for replies');
    await resolve(thread, true);
    const c0 = await now();
    const pending = wait(`since=${c0}&timeout=20`);
    await sleep(150);
    const rid = await reply(thread, 'still wrong', ivy);
    const r = await pending;
    assert(r.status === 200 && r.body.comments.length === 1, r.text);
    const got = r.body.comments[0];
    assert(got.id === thread && got.replies.some((x) => x.id === rid && x.text === 'still wrong'), JSON.stringify(got));
    // Its next call does not get it again.
    const again = await wait(`since=${r.body.cursor}&timeout=1`);
    assert(again.body.comments.length === 0, again.text);
  });

  await t('a thread reopened wakes a waiter', async () => {
    const thread = await post('to reopen');
    await resolve(thread, true);
    const c0 = await now();
    const pending = wait(`since=${c0}&timeout=20`);
    await sleep(150);
    await resolve(thread, false);
    const r = await pending;
    assert(r.body.comments.map((c) => c.id).join(',') === thread, r.text);
  });

  await t("the caller's own agent's reply does not wake it; another account's waiter does wake", async () => {
    const thread = await post('agent answers this');
    const c0 = await now();
    const mine = wait(`since=${c0}&timeout=4`);
    const theirs = wait(`since=${c0}&timeout=20`, ivy.token);
    await sleep(150);
    const ar = await call('/api/agent/reply', { method: 'POST', token: julie.token, body: { slug: SLUG, parent_id: thread, text: 'Done: see v1.', status: 'answered' } });
    assert(ar.status === 200 && !ar.body.skipped, `agent reply ${ar.status} ${ar.text}`);
    const [m, o] = await Promise.all([mine, theirs]);
    assert(m.status === 200 && m.body.comments.length === 0 && m.body.timed_out === true, `own agent woke it: ${m.text}`);
    assert(Number(m.body.cursor) > Number(c0), 'cursor still moves past it');
    assert(o.status === 200 && o.body.comments.length === 1 && o.body.comments[0].id === thread, o.text);
    // The person's answer to the agent wakes the agent's account again.
    const pending = wait(`since=${m.body.cursor}&timeout=20`);
    await sleep(150);
    await reply(thread, 'thanks, but one more thing', ivy);
    const back = await pending;
    assert(back.body.comments.length === 1 && back.body.comments[0].id === thread, back.text);
  });

  // ------------------------------------------------------- abuse bounds
  await t('anonymous callers cannot hold a wait, even on a public doc', async () => {
    const pub = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'wait-public', version: 1, html: '<h1>p</h1><p>x</p>', meta: { title: 'Pub', access: { visibility: 'public' } } } });
    assert(pub.status === 200, pub.text);
    const anon = await call('/api/comments/wait?slug=wait-public&timeout=1');
    assert(anon.status === 401 && anon.body.error === 'sign_in_required', `${anon.status} ${anon.text}`);
    const signed = await call('/api/comments/wait?slug=wait-public&timeout=1', { token: bob.token });
    assert(signed.status === 200, signed.text);
  });

  await t('waits held are capped per caller (3) and per doc (50): 429 with retry_after', async () => {
    const c0 = await now();
    const held = [1, 2, 3].map(() => wait(`since=${c0}&timeout=20`));
    await sleep(100);
    const fourth = await wait(`since=${c0}&timeout=20`);
    assert(fourth.status === 429 && fourth.body.error === 'too_many_waiters' && fourth.body.retry_after > 0, `${fourth.status} ${fourth.text}`);
    const other = wait(`since=${c0}&timeout=20`, ivy.token);
    await sleep(50);
    // Fill the doc to its cap with other callers, straight at the store.
    const stub = env.COMMENTS.get(SLUG);
    const doWait = (who) => stub.fetch('https://do/wait', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: SLUG, op: { since: Number(c0), timeout_ms: 20000, who, exclude: [] } }) }).then((r) => r.json());
    const fill = Array.from({ length: 46 }, (_, i) => doWait(`filler-${i}`));
    await sleep(100);
    const over = await doWait('one-too-many');
    assert(over.busy === true, JSON.stringify(over));
    const viaRoute = await wait(`since=${c0}&timeout=20`, bob.token);
    assert(viaRoute.status === 403 || viaRoute.status === 429, `${viaRoute.status}`);
    // One comment releases them all (after the batch window).
    await post('release');
    const done = await Promise.all([...held, other]);
    assert(done.every((r) => r.status === 200 && r.body.comments.length === 1), done.map((r) => r.text).join('\n'));
    await Promise.all(fill);
  });

  await t('a store that fails answers 503 with retry_after, never an instant empty 200', async () => {
    const orig = env.COMMENTS.get.bind(env.COMMENTS);
    env.COMMENTS.get = () => ({ fetch: async () => { throw new Error('store restarted'); } });
    try {
      const r = await wait(`since=${await (async () => { env.COMMENTS.get = orig; const c = await now(); env.COMMENTS.get = () => ({ fetch: async () => { throw new Error('store restarted'); } }); return c; })()}&timeout=5`);
      assert(r.status === 503 && r.body.error === 'wait_unavailable' && r.body.retry_after >= 1, `${r.status} ${r.text}`);
    } finally { env.COMMENTS.get = orig; }
  });

  // ------------------------------------- access re-checked at delivery
  await t('access removed mid-wait: the reader gets nothing posted after it (403)', async () => {
    const slug = 'wait-revoke';
    const up = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: '<h1>r</h1><p>x</p>', meta: { title: 'R', access: { visibility: 'private', allowed_users: ['ivy'] } } } });
    assert(up.status === 200, up.text);
    const c0 = (await call(`/api/comments/wait?slug=${slug}&since=0&timeout=0`, { token: ivy.token })).body.cursor;
    const pending = call(`/api/comments/wait?slug=${slug}&since=${c0}&timeout=20`, { token: ivy.token });
    await sleep(150);
    const rev = await call('/api/doc/access', { method: 'PATCH', cookie: julie.cookie, headers: { Origin: ORIGIN }, body: { slug, access: { visibility: 'private', allowed_users: [] } } });
    assert(rev.status === 200, `revoke ${rev.status} ${rev.text}`);
    const posted = await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug, version: 1, text: 'secret after revoke', anchor: null } });
    assert(posted.status === 200, posted.text);
    const r = await pending;
    assert(r.status === 403 && !/secret after revoke/.test(r.text), `${r.status} ${r.text}`);
  });

  await t('doc moved to Trash mid-wait: nothing is delivered (404)', async () => {
    const slug = 'wait-trash';
    const up = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: '<h1>t</h1><p>x</p>', meta: { title: 'T', access: { visibility: 'private', allowed_users: ['ivy'] } } } });
    assert(up.status === 200, up.text);
    const c0 = (await call(`/api/comments/wait?slug=${slug}&since=0&timeout=0`, { token: ivy.token })).body.cursor;
    const pending = call(`/api/comments/wait?slug=${slug}&since=${c0}&timeout=20`, { token: ivy.token });
    await sleep(150);
    const posted = await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug, version: 1, text: 'posted then trashed', anchor: null } });
    assert(posted.status === 200, posted.text);
    // Within the batch window, before the wait answers.
    const tr = await call(`/api/doc?slug=${slug}`, { method: 'DELETE', cookie: julie.cookie, headers: { Origin: ORIGIN } });
    assert(tr.status === 200, `trash ${tr.status} ${tr.text}`);
    const r = await pending;
    assert(r.status === 404 && !/posted then trashed/.test(r.text), `${r.status} ${r.text}`);
  });

  await t('writers keep slots: with 40 readers waiting, the owner and its agent can still wait', async () => {
    const c0 = await now();
    const stub = env.COMMENTS.get(SLUG);
    const doWait = (who, writer) => stub.fetch('https://do/wait', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: SLUG, op: { since: Number(c0), timeout_ms: 20000, who, writer, exclude: [] } }) }).then((r) => r.json());
    const readers = Array.from({ length: 40 }, (_, i) => doWait(`reader-${i}`, false));
    await sleep(100);
    const reader41 = await doWait('reader-41', false);
    assert(reader41.busy === true, `a 41st reader: ${JSON.stringify(reader41)}`);
    const invitee = await wait(`since=${c0}&timeout=20`, ivy.token);
    assert(invitee.status === 429, `invitee (a reader) ${invitee.status}`);
    const owner = wait(`since=${c0}&timeout=20`);
    await sleep(100);
    await post('owner still hears this');
    const r = await owner;
    assert(r.status === 200 && r.body.comments.length === 1, `owner ${r.status} ${r.text}`);
    await Promise.all(readers);
  });

  // ------------------------------------------- gap, legacy, imported
  await t('a cursor older than the kept log gets the open backlog again, marked gap', async () => {
    const state = env.COMMENTS.stateFor(SLUG);
    const seq = state.storage.map.get('commentSeq');
    const saved = JSON.parse(JSON.stringify(seq));
    try {
      seq.log = seq.log.slice(5); // as if the first five had been trimmed
      const r = await wait('since=1&timeout=1');
      assert(r.status === 200 && r.body.gap === true && r.body.comments.length > 0, r.text);
      assert(r.body.comments.every((c) => c.status !== 'applied' && !c.resolved), 'open backlog only');
    } finally { state.storage.map.set('commentSeq', saved); }
  });

  await t('comments only in the legacy KV value come with the backlog; imported ones are numbered', async () => {
    const slug = 'wait-legacy';
    const r0 = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: '<h1>l</h1><p>x</p>', meta: { title: 'L', access: { visibility: 'private', allowed_users: [] } } } });
    assert(r0.status === 200, r0.text);
    env.COMMENTS.stateFor(slug).storage.map.delete('list');
    await env.META.put(`comments:${slug}`, JSON.stringify([{ id: 'c_legacy_1', author: { login: 'julie', name: 'julie' }, text: 'from before', created: new Date().toISOString(), created_in: 1, anchor: null }]));
    const r = await call(`/api/comments/wait?slug=${slug}&timeout=1`, { token: julie.token });
    assert(r.status === 200 && r.body.comments.some((c) => c.id === 'c_legacy_1'), r.text);
    const c0 = Number(r.body.cursor);
    const stub = env.COMMENTS.get(slug);
    const merged = await (await stub.fetch('https://do/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'publish_merge', localComments: [{ id: 'c_imported_1', author: { login: 'julie', name: 'julie' }, text: 'imported', created: new Date().toISOString(), created_in: 1, anchor: null }], aids: [], version: 1 } }) })).json();
    assert(merged.status === 200, JSON.stringify(merged));
    const after = await call(`/api/comments/wait?slug=${slug}&since=${c0}&timeout=1`, { token: julie.token });
    assert(after.body.comments.map((c) => c.id).join(',') === 'c_imported_1', after.text);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
