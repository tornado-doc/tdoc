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
    const run = (args) => new Promise((resolve) => {
      const child = spawn(path.join(__dirname, '..', 'bin', 'tdoc-watch'), args, { env: { ...process.env, HOME: home } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    try {
      const pending = run([SLUG, '--since', cursor, '--once']);
      await sleep(800);
      const id = await post('watch me\n## not a heading');
      const out = await pending;
      assert(out.status === 0, `${out.status} ${out.stderr}`);
      assert(out.stdout.startsWith(`# 1 new comment on ${SLUG}\nPage: <${base}/d/${SLUG}>`), out.stdout);
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
    } finally {
      server.close();
    }
  });

  await t('the store numbers comments in the write that makes them (no storage polling while waiting)', async () => {
    const state = env.COMMENTS.stateFor(SLUG);
    const seq = state.storage.map.get('commentSeq');
    assert(seq && String(seq.n) === cursor && seq.log.length === seq.n, JSON.stringify(seq));
    // A waiter reads the store twice (before and after), whatever it waits.
    let reads = 0;
    const orig = state.storage.transaction.bind(state.storage);
    state.storage.transaction = (fn) => { reads += 1; return orig(fn); };
    try {
      await wait(`since=${cursor}&timeout=2`);
    } finally { state.storage.transaction = orig; }
    assert(reads <= 2, `${reads} store reads in a 2s wait`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
