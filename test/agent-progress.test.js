// The progress line on a comment handed to an agent (flag agentProgress):
// what tdoc already records turned into steps, and the agent's own optional
// one-line status.
//   - server: propose_edits stamps how many edits wait on the handoff, a
//     publish stamps the newest version number, the comments API carries
//     both (and the status) to the people who may see the handoff only;
//   - POST /api/notify/progress: only the agent the comment was handed to,
//     on that doc, with write access; one plain line, capped; rate-limited;
//     refused once the handoff is handled;
//   - shell: comments/core/handoff-progress.js maps those facts to
//     "Delivered · Reading the doc · Suggested 3 edits · Published v3 ·
//     Working · 4 min", never the word "handoff".
// Run with: node test/agent-progress.test.js

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, issue, putSession } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function loadEsm(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

const LOCAL_CLAUDE = { provider: 'local', device: 'mbp', cli: 'claude' };
const AGENT_B = { provider: 'raft', server_id: 'S1', agent_sub: 'b2', server_slug: 's1', agent_name: 'agent-b' };
const AS_CLAUDE = { 'X-Tdoc-Agent': 'local/mbp/mbp_claude' };
const AS_B = { 'X-Tdoc-Raft-Agent': 'S1/b2' };

(async () => {
  console.log('agent progress line');

  // ---- the mapping (pure) ----------------------------------------------------
  const { handoffProgressSteps, handoffProgressLine, formatWorkingFor } = await loadEsm('shell/src/comments/core/handoff-progress.js');
  const base = {
    handoff_at: '2026-11-12T10:00:00Z',
    handoff_delivery: { status: 'delivered', at: '2026-11-12T10:00:02Z', first_at: '2026-11-12T10:00:01Z' },
  };
  const at = (min) => new Date(Date.parse('2026-11-12T10:00:00Z') + min * 60000).toISOString();
  const now = Date.parse(at(6));

  await t('mapping: delivered, then read, then suggestions and a version, in clock order', () => {
    const c = {
      ...base,
      handoff_acked_at: at(1),
      handoff_last_version: 3, handoff_last_version_at: at(4), handoff_first_version_at: at(3),
      handoff_suggested_edits: 3, handoff_suggested_at: at(2),
    };
    const labels = handoffProgressSteps(c).map((s) => s.label);
    assert(labels.join(' | ') === 'Delivered | Reading the doc | Suggested 3 edits | Published v3', labels.join(' | '));
    const line = handoffProgressLine(c, 'received', now);
    assert(line.text === 'Delivered · Reading the doc · Suggested 3 edits · Published v3 · Working · 5 min', line.text);
    assert(!/handoff/i.test(line.text), 'the word handoff leaked into the line');
  });

  await t('mapping: a local daemon queue reads Sent; one edit is singular; a version without a number', () => {
    const c = { ...base, handoff_delivery: { status: 'queued', at: at(0) }, handoff_acked_at: at(1), handoff_suggested_edits: 1, handoff_suggested_at: at(2), handoff_first_version_at: at(3) };
    const labels = handoffProgressSteps(c).map((s) => s.label);
    assert(labels.join(' | ') === 'Sent | Reading the doc | Suggested 1 edit | Published a version', labels.join(' | '));
  });

  await t('mapping: the agent\'s own status is the current step only while it is the newest fact', () => {
    const c = { ...base, handoff_acked_at: at(1), handoff_progress: { text: 'Editing the Pack section', at: at(2) } };
    assert(handoffProgressLine(c, 'received', now).text === 'Delivered · Reading the doc · Editing the Pack section · 5 min');
    const later = { ...c, handoff_last_version: 4, handoff_last_version_at: at(3) };
    assert(handoffProgressLine(later, 'received', now).current === 'Working', 'a stale status outlived a newer fact');
  });

  await t('mapping: only while the agent is working; nothing for other states or no handoff', () => {
    const c = { ...base, handoff_acked_at: at(1) };
    for (const s of ['waiting', 'stale', 'replied', 'failed', 'question', 'ready']) assert(handoffProgressLine(c, s, now) === null, s);
    assert(handoffProgressSteps({}).length === 0);
    assert(handoffProgressLine({ handoff_at: null }, 'received', now) === null);
  });

  await t('elapsed reads in minutes, then hours', () => {
    assert(formatWorkingFor(10 * 1000) === '1 min');
    assert(formatWorkingFor(4 * 60000 + 5000) === '4 min');
    assert(formatWorkingFor(65 * 60000) === '1 h 5 min');
    assert(formatWorkingFor(120 * 60000) === '2 h');
  });

  // ---- the server ------------------------------------------------------------
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  env.TDOC_PREVIEW = '1'; // propose_edits is dev-mode only; a preview has it for everyone
  const owner = await issue(worker, env, 'owner');
  const stranger = await issue(worker, env, 'stranger');
  const call = async (p, opts) => { const r = await worker.fetch(req(p, opts), env, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };

  for (const slug of ['doc', 'doc2']) {
    const up = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug, version: 1, html: '<h1>d</h1><p>a sentence to comment on</p><p>another line here</p>' } });
    assert(up.status === 200, `upload ${slug} ${up.status}`);
  }
  await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([LOCAL_CLAUDE, AGENT_B]));
  const reader = await putSession(env, 'reader');
  const mkComment = async (slug, text) => {
    const c = await call('/api/comments', { method: 'POST', cookie: reader, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } });
    assert(c.status === 200, `comment ${c.status}`);
    return c.body.id;
  };
  const commentId = await mkComment('doc', 'fix this');
  const otherDocComment = await mkComment('doc2', 'and here');
  const send = async (slug, comment_id, recipient) => {
    const r = await call('/api/notify/handoff', { method: 'POST', token: owner.token, body: { slug, comment_ids: [comment_id], recipient, instruction: 'fix it' } });
    assert(r.status === 200 && r.body.ok, `handoff ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.handoff_id;
  };
  const handoffId = await send('doc', commentId, LOCAL_CLAUDE);
  const otherDocHandoff = await send('doc2', otherDocComment, LOCAL_CLAUDE);
  const byId = async (slug, id) => JSON.parse(await env.META.get(`handoffs:${slug}`) || '[]').find((h) => h.handoff_id === id);
  const progress = (body, { token = owner.token, headers = AS_CLAUDE } = {}) => call('/api/notify/progress', { method: 'POST', token, headers, body });

  await t('propose_edits counts the edits waiting on the handoff (a new set replaces the old)', async () => {
    const r = await call('/api/docs/doc/suggestions', {
      method: 'POST', token: owner.token, headers: AS_CLAUDE,
      body: { comment_ids: [commentId], edits: [{ find: 'a sentence to comment on', replace: 'one sentence' }, { find: 'another line here', replace: 'a second line' }] },
    });
    assert(r.status === 200 && r.body.ok, `suggest ${r.status}: ${JSON.stringify(r.body)}`);
    const h = await byId('doc', handoffId);
    assert(h.suggested_at, 'no time');
    const comments = await call('/api/comments?slug=doc&version=all', { token: owner.token });
    const c = comments.body.find((x) => x.id === commentId);
    assert(c.handoff_suggested_edits === 2, `count ${c.handoff_suggested_edits}`);
    const again = await call('/api/docs/doc/suggestions', {
      method: 'POST', token: owner.token, headers: AS_CLAUDE,
      body: { comment_ids: [commentId], edits: [{ find: 'another line here', replace: 'line two' }] },
    });
    assert(again.status === 200, `suggest again ${again.status}: ${JSON.stringify(again.body)}`);
    const c2 = (await call('/api/comments?slug=doc&version=all', { token: owner.token })).body.find((x) => x.id === commentId);
    assert(c2.handoff_suggested_edits === 1, `replaced count ${c2.handoff_suggested_edits}`);
  });

  await t('a publish by the addressed agent records the newest version number', async () => {
    for (const v of [2, 3]) {
      const up = await call('/api/upload', { method: 'POST', token: owner.token, headers: AS_CLAUDE, body: { slug: 'doc', version: v, html: `<h1>d${v}</h1><p>a sentence to comment on</p><p>v${v}</p>` } });
      assert(up.status === 200, `upload v${v} ${up.status}`);
    }
    const h = await byId('doc', handoffId);
    assert(h.last_version === 3 && h.last_version_at, JSON.stringify(h));
    assert(h.first_version_at && h.first_version_at <= h.last_version_at, 'first version clock lost');
  });

  await t('the addressed agent posts a status; it is one plain line, capped', async () => {
    const r = await progress({ slug: 'doc', comment_id: commentId, text: '  Editing the\n Pack‮ section\u0000  ' });
    assert(r.status === 200 && r.body.ok, `progress ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.progress.text === 'Editing the Pack section', JSON.stringify(r.body.progress.text));
    const c = (await call('/api/comments?slug=doc&version=all', { token: owner.token })).body.find((x) => x.id === commentId);
    assert(c.handoff_progress && c.handoff_progress.text === 'Editing the Pack section', JSON.stringify(c.handoff_progress));
    assert(c.handoff_last_version === 3, `version ${c.handoff_last_version}`);
  });

  await t('rate-limited per handoff', async () => {
    const r = await progress({ slug: 'doc', handoff_id: handoffId, text: 'Again' });
    assert(r.status === 429 && r.body.error === 'rate_limited' && r.body.retry_after > 0, `${r.status} ${JSON.stringify(r.body)}`);
    // Age the last status past the window: the next one goes through, capped.
    const h = await byId('doc', handoffId);
    const list = JSON.parse(await env.META.get('handoffs:doc'));
    await env.META.put('handoffs:doc', JSON.stringify(list.map((x) => x.handoff_id === handoffId ? { ...h, progress: { ...h.progress, at: '2026-01-01T00:00:00Z' } } : x)));
    const long = await progress({ slug: 'doc', handoff_id: handoffId, text: 'x'.repeat(500) });
    assert(long.status === 200, `${long.status} ${JSON.stringify(long.body)}`);
    assert([...long.body.progress.text].length === 80 && long.body.progress.text.endsWith('…'), long.body.progress.text);
  });

  await t('another agent on the same account may not speak for this handoff', async () => {
    const list = JSON.parse(await env.META.get('handoffs:doc'));
    await env.META.put('handoffs:doc', JSON.stringify(list.map((x) => x.handoff_id === handoffId ? { ...x, progress: null } : x)));
    const r = await progress({ slug: 'doc', comment_id: commentId, text: 'Not mine' }, { headers: AS_B });
    assert(r.status === 403 && r.body.error === 'not_handoff_recipient', `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('no write access on the doc, no status (another account)', async () => {
    const r = await progress({ slug: 'doc', comment_id: commentId, text: 'Hi' }, { token: stranger.token, headers: {} });
    assert(r.status === 403 || r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
    assert(!(await byId('doc', handoffId)).progress, 'a stranger wrote the status');
  });

  await t('no cross-doc writes: a handoff id from another doc is not found', async () => {
    const r = await progress({ slug: 'doc', handoff_id: otherDocHandoff, text: 'Wrong doc' });
    assert(r.status === 404 && r.body.error === 'handoff_not_found', `${r.status} ${JSON.stringify(r.body)}`);
    const r2 = await progress({ slug: 'doc2', comment_id: commentId, text: 'Wrong doc' });
    assert(r2.status === 404, `${r2.status} ${JSON.stringify(r2.body)}`);
    assert(!(await byId('doc2', otherDocHandoff)).progress, 'the other doc was written');
  });

  await t('bad input is refused', async () => {
    assert((await progress({ slug: 'doc', comment_id: commentId, text: ' \n​ ' })).status === 400, 'empty text');
    assert((await progress({ slug: 'doc', text: 'x' })).status === 400, 'no handoff or comment');
    assert((await progress({ slug: '../x', comment_id: commentId, text: 'x' })).status === 400, 'bad slug');
  });

  await t('the progress fields are private to the people who see the handoff', async () => {
    // Another signed-in reader of the doc: neither the commenter nor the owner.
    const other = await call('/api/comments?slug=doc&version=all', { cookie: stranger.cookie });
    const c = (other.body || []).find((x) => x.id === commentId);
    assert(c, `other reader ${other.status}`);
    assert(!('handoff_status' in c), 'the handoff itself leaked (test setup)');
    for (const k of ['handoff_progress', 'handoff_suggested_edits', 'handoff_suggested_at', 'handoff_last_version', 'handoff_last_version_at']) {
      assert(!(k in c), `${k} leaked to another reader`);
    }
  });

  await t('a new set drops every older set it overlaps: 3 edits on [a,b] then 2 on [a] reads 2, not 5', async () => {
    const up = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'doc3', version: 1, html: '<h1>d</h1><p>first line one</p><p>second line two</p><p>third line three</p>' } });
    assert(up.status === 200, `upload ${up.status}`);
    const mk = async (text) => {
      const c = await call('/api/comments', { method: 'POST', cookie: reader, body: { slug: 'doc3', version: 1, text, anchor: { kind: 'text', text: 'first line' } } });
      assert(c.status === 200, `comment ${c.status}`);
      return c.body.id;
    };
    const a = await mk('fix a');
    const b = await mk('fix b');
    const h = await call('/api/notify/handoff', { method: 'POST', token: owner.token, body: { slug: 'doc3', comment_ids: [a, b], recipient: LOCAL_CLAUDE, instruction: 'fix them' } });
    assert(h.status === 200 && h.body.ok, `handoff ${h.status}: ${JSON.stringify(h.body)}`);
    const suggest = (comment_ids, edits, headers = AS_CLAUDE) => call('/api/docs/doc3/suggestions', { method: 'POST', token: owner.token, headers, body: { comment_ids, edits } });
    const count = async () => (await call('/api/comments?slug=doc3&version=all', { token: owner.token })).body.find((x) => x.id === a).handoff_suggested_edits;
    const three = await suggest([a, b], [
      { find: 'first line one', replace: '1' }, { find: 'second line two', replace: '2' }, { find: 'third line three', replace: '3' },
    ]);
    assert(three.status === 200, `suggest 3 ${three.status}: ${JSON.stringify(three.body)}`);
    assert((await count()) === 3, `after 3: ${await count()}`);
    const two = await suggest([a], [{ find: 'first line one', replace: 'one' }, { find: 'second line two', replace: 'two' }]);
    assert(two.status === 200, `suggest 2 ${two.status}: ${JSON.stringify(two.body)}`);
    assert((await count()) === 2, `stale count: ${await count()} (the [a,b] set was replaced)`);
    const rec = await byId('doc3', h.body.handoff_id);
    assert(Object.keys(rec.suggested_sets).join('|') === a, JSON.stringify(rec.suggested_sets));
  });

  await t('only the agent the comments were handed to is credited with suggestions', async () => {
    const before = (await byId('doc', handoffId)).suggested_sets;
    // Agent B (same account, not the recipient) proposes on the handed-off comment.
    const r = await call('/api/docs/doc/suggestions', {
      method: 'POST', token: owner.token, headers: AS_B,
      body: { comment_ids: [commentId], edits: [{ find: 'a sentence to comment on', replace: 'B was here' }, { find: 'another line here', replace: 'B again' }, { find: 'd3', replace: 'x' }] },
    });
    assert(r.status === 200, `suggest by B ${r.status}: ${JSON.stringify(r.body)}`);
    const after = (await byId('doc', handoffId)).suggested_sets || {};
    assert(before && Object.keys(before).length === 1, `setup ${JSON.stringify(before)}`);
    // B's set replaced the recipient's in the store, so the recipient's count
    // goes; B's is not credited to the handoff.
    assert(!Object.keys(after).length, `credited to the handed-off agent: ${JSON.stringify(after)}`);
    const c = (await call('/api/comments?slug=doc&version=all', { token: owner.token })).body.find((x) => x.id === commentId);
    assert(c.handoff_suggested_edits === null, `count ${c.handoff_suggested_edits}`);
  });

  await t('once handled, the handoff takes no more status', async () => {
    const r = await call('/api/notify/resolve', { method: 'POST', token: owner.token, body: { slug: 'doc', handoff_id: handoffId } });
    assert(r.status === 200, `resolve ${r.status}`);
    const p = await progress({ slug: 'doc', handoff_id: handoffId, text: 'Late' });
    assert(p.status === 409 && p.body.error === 'handoff_closed', `${p.status} ${JSON.stringify(p.body)}`);
  });

  await t('MCP report_progress is a thin wrapper over /api/notify/progress (dev mode tool)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const block = src.slice(src.indexOf('  report_progress: {'), src.indexOf('  answer_question: {'));
    assert(/devMode: true/.test(block), 'not dev mode');
    assert(/mcpApi\(call, 'POST', '\/api\/notify\/progress'/.test(block), 'does not call the endpoint');
    assert(!/env\.META|loadHandoffs/.test(block), 'reaches storage itself');
    const cli = fs.readFileSync(path.join(__dirname, '..', 'bin', 'tdoc-agent-reply'), 'utf8');
    assert(cli.includes('/api/notify/progress') && cli.includes('--progress'), 'CLI flag missing');
  });

  // ---- flag off (no dev mode, not a preview) ----------------------------------
  {
    const env2 = makeEnv(mod.CommentsStore);
    const owner2 = await issue(worker, env2, 'owner');
    const call2 = async (p, opts) => { const r = await worker.fetch(req(p, opts), env2, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
    const up = await call2('/api/upload', { method: 'POST', token: owner2.token, body: { slug: 'off', version: 1, html: '<h1>d</h1><p>a sentence to comment on</p>' } });
    await env2.META.put(`account-notify:${owner2.account_id}`, JSON.stringify([LOCAL_CLAUDE]));
    const reader2 = await putSession(env2, 'reader');
    const c = await call2('/api/comments', { method: 'POST', cookie: reader2, body: { slug: 'off', version: 1, text: 'fix', anchor: { kind: 'text', text: 'a sentence' } } });
    const h = await call2('/api/notify/handoff', { method: 'POST', token: owner2.token, body: { slug: 'off', comment_ids: [c.body.id], recipient: LOCAL_CLAUDE, instruction: 'fix it' } });
    const rec = async () => JSON.parse(await env2.META.get('handoffs:off') || '[]').find((x) => x.handoff_id === h.body.handoff_id);

    await t('flag off: POST /api/notify/progress is not found, even for the addressed agent', async () => {
      assert(up.status === 200 && c.status === 200 && h.status === 200, `setup ${up.status} ${c.status} ${h.status}`);
      const r = await call2('/api/notify/progress', { method: 'POST', token: owner2.token, headers: AS_CLAUDE, body: { slug: 'off', comment_id: c.body.id, text: 'Working' } });
      assert(r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
      assert(!(await rec()).progress, 'status written with the flag off');
    });

    await t('flag off: publishes stamp the first version once and nothing more', async () => {
      const writes = [];
      const put = env2.META.put.bind(env2.META);
      env2.META.put = (k, ...rest) => { if (k === 'handoffs:off') writes.push(k); return put(k, ...rest); };
      try {
        for (const v of [2, 3, 4]) {
          const r = await call2('/api/upload', { method: 'POST', token: owner2.token, headers: AS_CLAUDE, body: { slug: 'off', version: v, html: `<h1>d${v}</h1><p>a sentence to comment on</p>` } });
          assert(r.status === 200, `upload v${v} ${r.status}`);
        }
      } finally { env2.META.put = put; }
      const x = await rec();
      assert(x.first_version_at, 'first version not stamped');
      assert(x.last_version == null && x.last_version_at == null, `last_version written with the flag off: ${JSON.stringify(x)}`);
      assert(writes.length === 1, `handoffs rewritten on every publish: ${writes.length}`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
