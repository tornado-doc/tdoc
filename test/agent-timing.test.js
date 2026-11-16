// Agent reply metrics (server/agent-timing.js): one `agent_timing` log line
// per handoff milestone (delivered, picked_up, first_reply, suggested,
// new_version, outcome), keyed by the opaque handoff id, with channel, agent
// kind, doc kind and seconds since the handoff was created -- and never a
// comment, the instruction, a slug, a title, an agent's name or handle, a
// server id, a webhook URL, an email or an account. The helper is checked
// with fixed records; the worker's hooks through the real routes; the weekly
// script (scripts/agent-metrics.mjs) on log lines and stored records.
// Run with: node test/agent-timing.test.js

const AgentTiming = require('../server/agent-timing.js');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// Every key a line may carry. A new key is a privacy decision: add it here
// and to the PR's field list on purpose.
const ALLOWED = new Set([
  'event', 'milestone', 'handoff_id', 'channel', 'agent', 'cli', 'doc_kind', 'reply_as', 'comments', 'since_s',
  'status', 'error', 'resend', 'via', 'outcome', 'resolved',
  'delivered_s', 'picked_up_s', 'first_reply_s', 'suggested_s', 'new_version_s',
]);
const SECRETS = ['SECRET-COMMENT', 'SECRET-INSTRUCTION', 'secret-slug', 'Secret Title', 'xiaocc', 'uuid-a', 'S1-server',
  'hooks.example', 'owner@example.com', 'acct_123', 'julie-server', 'macbook'];

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();
function fullHandoff(extra = {}) {
  return {
    handoff_id: 'h_1762682400000_abc',
    at: iso(0),
    recipient: { provider: 'raft', server_id: 'S1-server', server_slug: 'julie-server', agent_sub: 'uuid-a', agent_name: 'xiaocc', url: 'https://hooks.example/x' },
    comment_ids: ['c_SECRET-COMMENT', 'c2'],
    resolved_ids: ['c2'],
    instruction: 'SECRET-INSTRUCTION',
    slug: 'secret-slug', title: 'Secret Title', by: 'acct_123', sent_by: 'owner@example.com',
    delivery: { status: 'delivered', at: iso(2), first_at: iso(2), error: null },
    acked_at: iso(30), first_reply_at: iso(95.25), first_suggested_at: iso(200), first_version_at: iso(300),
    doc_kind: 'sheet',
    progress: { text: 'SECRET-COMMENT', at: iso(40) },
    ...extra,
  };
}

(async () => {
  console.log('agent timing');

  // ── the helper ──
  await t('each milestone is one line, seconds since the handoff was created', async () => {
    const lines = [];
    const h = fullHandoff();
    const rec = AgentTiming.emit(h, 'picked_up', { now: T0 + 30000, via: 'mcp_poll', log: (l) => lines.push(l) });
    assert(lines.length === 1 && JSON.stringify(rec) === lines[0], lines.join('\n'));
    assert(rec.event === 'agent_timing' && rec.milestone === 'picked_up' && rec.handoff_id === 'h_1762682400000_abc', lines[0]);
    assert(rec.since_s === 30 && rec.via === 'mcp_poll', lines[0]);
    assert(rec.channel === 'raft' && rec.agent === 'raft_agent' && rec.cli === null && rec.doc_kind === 'sheet' && rec.comments === 2, lines[0]);
    const reply = AgentTiming.record(h, 'first_reply', { now: T0 + 95250 });
    assert(reply.since_s === 95.3, JSON.stringify(reply));
  });

  await t('delivered: status and a short error code only; resend flagged', async () => {
    const ok = AgentTiming.record(fullHandoff(), 'delivered', { now: T0 + 2000 });
    assert(ok.status === 'delivered' && ok.error === null && ok.resend === false && ok.since_s === 2, JSON.stringify(ok));
    const bad = AgentTiming.record(fullHandoff({ delivery: { status: 'failed', error: 'Raft said: "SECRET-COMMENT" bad' } }), 'delivered', { now: T0, resend: true });
    assert(bad.status === 'failed' && bad.error === 'error' && bad.resend === true, JSON.stringify(bad));
    const code = AgentTiming.record(fullHandoff({ delivery: { status: 'failed', error: 'provider_not_configured' } }), 'delivered', { now: T0 });
    assert(code.error === 'provider_not_configured', JSON.stringify(code));
    const queued = AgentTiming.record(fullHandoff({ recipient: { provider: 'local', device: 'macbook', cli: 'claude', agent_sub: 'macbook_claude' }, delivery: { status: 'queued' } }), 'delivered', { now: T0 });
    assert(queued.status === 'queued' && queued.channel === 'local' && queued.agent === 'local_cli' && queued.cli === 'claude', JSON.stringify(queued));
  });

  await t('outcome carries every milestone so far, computed from the stored times', async () => {
    const rec = AgentTiming.record(fullHandoff(), 'outcome', { now: T0 + 400000, outcome: 'resolved' });
    assert(rec.outcome === 'resolved' && rec.resolved === 1, JSON.stringify(rec));
    assert(rec.delivered_s === 2 && rec.picked_up_s === 30 && rec.first_reply_s === 95.3 && rec.suggested_s === 200 && rec.new_version_s === 300, JSON.stringify(rec));
    const none = AgentTiming.record({ handoff_id: 'h_1_x', at: iso(0), comment_ids: ['a'] }, 'outcome', { now: T0, outcome: 'nope' });
    assert(none.outcome === null && none.picked_up_s === null && none.first_reply_s === null && none.channel === 'none' && none.agent === 'none', JSON.stringify(none));
  });

  await t('no PII: only the allowed keys, and nothing from the record but kinds, counts and times', async () => {
    const h = fullHandoff({ team_agent: { id: 'ta_SECRET', name: 'xiaocc' } });
    for (const m of AgentTiming.MILESTONES) {
      const rec = AgentTiming.record(h, m, { now: T0 + 1000, via: 'ack', outcome: 'resolved' });
      for (const k of Object.keys(rec)) assert(ALLOWED.has(k), `${m}: unexpected key ${k}`);
      const line = JSON.stringify(rec);
      for (const s of [...SECRETS, 'ta_SECRET']) assert(!line.includes(s), `${m} leaked ${s}: ${line}`);
      assert(rec.agent === 'team_agent', line);
    }
    // A handoff id that is not one tdoc mints is dropped, not cleaned.
    assert(AgentTiming.record(fullHandoff({ handoff_id: 'owner@example.com' }), 'delivered').handoff_id === null, 'odd id');
    assert(AgentTiming.record(fullHandoff({ recipient: { provider: 'local', cli: 'Claude Code by Julie' } }), 'delivered').cli === null, 'free-text cli');
    assert(AgentTiming.record(fullHandoff({ doc_kind: 'SECRET' }), 'delivered').doc_kind === 'unknown', 'doc kind');
    assert(AgentTiming.record(fullHandoff(), 'not_a_milestone') === null, 'unknown milestone');
  });

  await t('docKind: feedback space, else the stamped type, else doc', async () => {
    assert(AgentTiming.docKind({ created_from: 'feedback' }, 'doc') === 'feedback', 'feedback');
    assert(AgentTiming.docKind({}, 'slides') === 'slides' && AgentTiming.docKind({}, 'sheet') === 'sheet', 'stamped');
    assert(AgentTiming.docKind({}, '') === 'doc' && AgentTiming.docKind(null, 'weird') === 'doc', 'fallback');
  });

  // ── the worker's hooks ──
  const mod = await loadWorker();
  const worker = mod.default;
  const captured = [];
  const realLog = console.log;
  const capture = async (fn) => {
    console.log = (...a) => { const s = a.join(' '); if (s.includes('"agent_timing"')) captured.push(JSON.parse(s)); else realLog(...a); };
    try { return await fn(); } finally { console.log = realLog; }
  };
  const target = { provider: 'raft', server_id: 'S1-server', agent_sub: 'uuid-a', agent_name: 'xiaocc' };
  async function seed(slug) {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', { method: 'POST', token: tok.token, body: { slug, version: 1, html: '<h1>Secret Title</h1><p>a sentence to comment on</p>' } }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const reader = await putSession(env, 'reader');
    const posted = await worker.fetch(req('/api/comments', { method: 'POST', cookie: reader, body: { slug, version: 1, text: 'SECRET-COMMENT here', anchor: { kind: 'text', text: 'a sentence' } } }), env, {});
    const comment = await posted.json();
    assert(posted.status === 200, `comment ${posted.status}`);
    await env.META.put(`account-notify:${tok.account_id}`, JSON.stringify([target]));
    return { env, token: tok.token, accountId: tok.account_id, slug, commentId: comment.id };
  }

  await t('handoff → delivered, ack → picked_up, reply → first_reply, resolve → outcome; stored for later', async () => {
    const { env, token, slug, commentId } = await seed('secret-slug');
    captured.length = 0;
    await capture(async () => {
      const h = await (await worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: target, instruction: 'SECRET-INSTRUCTION' } }), env, {})).json();
      assert(h.handoff_id, JSON.stringify(h));
      await worker.fetch(req('/api/notify/ack', { method: 'POST', token, body: { slug, handoff_id: h.handoff_id } }), env, {});
      await worker.fetch(req('/api/notify/ack', { method: 'POST', token, body: { slug, handoff_id: h.handoff_id } }), env, {});
      const r = await worker.fetch(req('/api/agent/reply', { method: 'POST', token, body: { slug, parent_id: commentId, text: 'SECRET-COMMENT reply', status: 'answered' } }), env, {});
      assert(r.status === 200, `reply ${r.status}`);
      await worker.fetch(req('/api/agent/reply', { method: 'POST', token, body: { slug, parent_id: commentId, text: 'again', status: 'answered' } }), env, {});
      await worker.fetch(req('/api/notify/resolve', { method: 'POST', token, body: { slug, handoff_id: h.handoff_id } }), env, {});
      await worker.fetch(req('/api/notify/resolve', { method: 'POST', token, body: { slug, handoff_id: h.handoff_id } }), env, {});
    });
    const ms = captured.map((r) => r.milestone);
    assert(JSON.stringify(ms) === JSON.stringify(['delivered', 'picked_up', 'first_reply', 'outcome']), `milestones: ${ms}`);
    const [delivered, picked, reply, outcome] = captured;
    // The test env has no Raft credentials: the send fails, and says so.
    assert(delivered.channel === 'raft' && delivered.status === 'failed' && delivered.error === 'provider_not_configured' && delivered.doc_kind === 'doc', JSON.stringify(delivered));
    assert(picked.via === 'ack' && picked.since_s >= 0, JSON.stringify(picked));
    assert(reply.since_s >= picked.since_s, JSON.stringify(reply));
    assert(outcome.outcome === 'resolved' && outcome.resolved === 1 && outcome.first_reply_s != null && outcome.picked_up_s != null, JSON.stringify(outcome));
    for (const rec of captured) {
      for (const k of Object.keys(rec)) assert(ALLOWED.has(k), `unexpected key ${k}`);
      const line = JSON.stringify(rec);
      for (const s of SECRETS.concat([commentId, token])) assert(!line.includes(s), `leaked ${s}: ${line}`);
    }
    const stored = JSON.parse(await env.META.get(`handoffs:${slug}`))[0];
    assert(stored.doc_kind === 'doc' && stored.outcome === 'resolved' && stored.outcome_at && stored.acked_at && stored.first_reply_at, JSON.stringify(stored));
  });

  await t('a pull marks picked_up (via pull); an MCP get_comments, via mcp_poll', async () => {
    const { env, token, slug, commentId } = await seed('pull-doc');
    captured.length = 0;
    await capture(async () => {
      await worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: target } }), env, {});
      // A failed delivery is not acked by a pull: deliver it by hand first.
      const list = JSON.parse(await env.META.get(`handoffs:${slug}`));
      list[0].delivery = { status: 'delivered', at: list[0].at, first_at: list[0].at };
      await env.META.put(`handoffs:${slug}`, JSON.stringify(list));
      const r = await worker.fetch(req(`/api/comments?slug=${slug}&version=all`, { token }), env, {});
      assert(r.status === 200, `pull ${r.status}`);
    });
    const picked = captured.filter((r) => r.milestone === 'picked_up');
    assert(picked.length === 1 && picked[0].via === 'pull', JSON.stringify(captured));
    // Handed again; this time the agent reads it through MCP get_comments.
    env.TDOC_REMOTE_MCP = '1';
    captured.length = 0;
    await capture(async () => {
      await worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: target } }), env, {});
      const list = JSON.parse(await env.META.get(`handoffs:${slug}`));
      list[0].delivery = { status: 'delivered', at: list[0].at, first_at: list[0].at };
      await env.META.put(`handoffs:${slug}`, JSON.stringify(list));
      const r = await worker.fetch(new Request('https://tdoc.dev/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_comments', arguments: { slug } } }),
      }), env, {});
      assert(r.status === 200, `mcp ${r.status} ${(await r.text()).slice(0, 300)}`);
    });
    const viaMcp = captured.filter((r) => r.milestone === 'picked_up');
    assert(viaMcp.length === 1 && viaMcp[0].via === 'mcp_poll', JSON.stringify(captured));
  });

  await t('a local agent: delivered queued, new_version once, run failed is an outcome', async () => {
    const { env, token, slug, commentId, accountId } = await seed('local-doc');
    const local = { provider: 'local', device: 'macbook', cli: 'claude' };
    await env.META.put(`account-notify:${accountId}`, JSON.stringify([target, local]));
    captured.length = 0;
    let handoffId = null;
    await capture(async () => {
      const h = await (await worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: local } }), env, {})).json();
      handoffId = h.handoff_id;
      for (const v of [2, 3]) {
        const up = await worker.fetch(req('/api/upload', { method: 'POST', token, headers: { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' }, body: { slug, version: v, html: `<h1>Secret Title</h1><p>a sentence to comment on, v${v}</p>` } }), env, {});
        assert(up.status === 200, `upload ${v}: ${up.status}`);
      }
      const f = await worker.fetch(req('/api/notify/local/fail', { method: 'POST', token, body: { slug, handoff_id: handoffId, error: 'SECRET-COMMENT crashed' } }), env, {});
      assert(f.status === 200, `fail ${f.status}`);
    });
    const ms = captured.map((r) => r.milestone);
    assert(JSON.stringify(ms) === JSON.stringify(['delivered', 'new_version', 'outcome']), `milestones: ${ms} ${JSON.stringify(captured)}`);
    assert(captured[0].status === 'queued' && captured[0].channel === 'local' && captured[0].cli === 'claude', JSON.stringify(captured[0]));
    assert(captured[2].outcome === 'run_failed' && captured[2].new_version_s != null, JSON.stringify(captured[2]));
    for (const rec of captured) assert(!/macbook|SECRET/.test(JSON.stringify(rec)), JSON.stringify(rec));
  });

  await t('the first suggestions for a handed comment are a milestone, once', async () => {
    const { env, token, slug, commentId, accountId } = await seed('suggest-doc');
    env.TDOC_PREVIEW = '1'; // propose_edits is dev-mode only; a preview has it for everyone
    const local = { provider: 'local', device: 'macbook', cli: 'claude' };
    await env.META.put(`account-notify:${accountId}`, JSON.stringify([local]));
    const asClaude = { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' };
    captured.length = 0;
    await capture(async () => {
      await worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: local } }), env, {});
      for (const replace of ['one sentence', 'a single sentence']) {
        const r = await worker.fetch(req(`/api/docs/${slug}/suggestions`, { method: 'POST', token, headers: asClaude, body: { comment_ids: [commentId], edits: [{ find: 'a sentence to comment on', replace }] } }), env, {});
        assert(r.status === 200, `suggest ${r.status}: ${await r.text()}`);
      }
    });
    const sug = captured.filter((r) => r.milestone === 'suggested');
    assert(sug.length === 1 && sug[0].since_s >= 0 && sug[0].channel === 'local', JSON.stringify(captured));
    const stored = JSON.parse(await env.META.get(`handoffs:${slug}`))[0];
    assert(stored.first_suggested_at, JSON.stringify(stored));
  });

  await t('a handoff nobody answers is still countable from the stored record', async () => {
    const { env, token, slug, commentId } = await seed('silent-doc');
    await capture(() => worker.fetch(req('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: target } }), env, {}));
    const raw = await env.META.get(`handoffs:${slug}`);
    const { fromKvExport, summarize } = await import('../scripts/agent-metrics.mjs');
    const all = fromKvExport(`handoffs:${slug}\t${raw}`);
    const rows = summarize(all, { now: Date.now() + 2 * 86400e3 });
    assert(rows.length === 1 && rows[0].count === 1 && rows[0].no_reply_24h === 100 && rows[0].channel === 'raft', JSON.stringify(rows));
  });

  // ── the weekly script ──
  await t('weekly table: per agent × channel, median / p90 from delivered, % no reply after 24h', async () => {
    const { fromLogLines, fromKvExport, summarize, formatTable, isoWeek } = await import('../scripts/agent-metrics.mjs');
    assert(isoWeek(Date.parse('2026-11-09T10:00:00Z')) === '2026-W46' && isoWeek(Date.parse('2026-01-01T00:00:00Z')) === '2026-W01', 'iso week');
    const lines = [];
    const add = (id, m, since, extra = {}) => lines.push(JSON.stringify({ event: 'agent_timing', milestone: m, handoff_id: id, channel: 'raft', agent: 'raft_agent', doc_kind: 'doc', since_s: since, ...extra }));
    for (let i = 0; i < 10; i++) {
      const id = `h_${T0 + i}_x${i}`;
      add(id, 'delivered', 1, { status: 'delivered' });
      add(id, 'picked_up', 1 + (i + 1) * 10, { via: 'ack' });
      if (i < 8) add(id, 'first_reply', 1 + (i + 1) * 100);
      if (i < 5) add(id, 'new_version', 1 + (i + 1) * 1000);
    }
    // A wrangler tail JSON event wraps the line; noise around it is skipped.
    lines.push('not json');
    lines.push(JSON.stringify({ eventTimestamp: T0, logs: [{ message: [JSON.stringify({ event: 'agent_timing', milestone: 'delivered', handoff_id: `h_${T0}_w`, channel: 'webhook', agent: 'webhook', since_s: 0, status: 'failed' })] }] }));
    const all = fromLogLines(lines.join('\n'));
    // Stored records merge in by id: one local handoff, answered in a minute.
    fromKvExport(`handoffs:x\t${JSON.stringify([{ handoff_id: `h_${T0}_l`, at: iso(0), recipient: { provider: 'local', cli: 'codex', device: 'macbook' }, comment_ids: ['a'], delivery: { status: 'queued', first_at: iso(0) }, acked_at: iso(5), first_reply_at: iso(60) }])}`, all);
    const rows = summarize(all, { now: T0 + 3 * 86400e3 });
    const raft = rows.find((r) => r.channel === 'raft');
    assert(raft.count === 10 && raft.week === '2026-W46', JSON.stringify(raft));
    assert(raft.picked_up.median === 50 && raft.picked_up.p90 === 90, JSON.stringify(raft.picked_up));
    assert(raft.first_reply.n === 8 && raft.first_reply.median === 400 && raft.first_reply.p90 === 800, JSON.stringify(raft.first_reply));
    assert(raft.new_version.n === 5 && raft.new_version.median === 3000, JSON.stringify(raft.new_version));
    assert(raft.no_reply_24h === 20 && raft.no_reply_24h_of === 10, JSON.stringify(raft));
    const hook = rows.find((r) => r.channel === 'webhook');
    assert(hook.count === 1 && hook.failed === 1 && hook.no_reply_24h === 100, JSON.stringify(hook));
    const local = rows.find((r) => r.channel === 'local');
    assert(local.agent === 'local_cli' && local.first_reply.median === 60 && local.no_reply_24h === 0, JSON.stringify(local));
    const table = formatTable(rows);
    assert(/pickup p50/.test(table) && /raft_agent/.test(table) && /20% of 10/.test(table) && !/macbook|codex/.test(table), table);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
