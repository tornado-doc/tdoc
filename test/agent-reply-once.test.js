// The agent answers a comment once per human turn (#349).
//
// A generation round posts an agent reply on every comment it handled. When a
// human deletes that reply — or rewrites it — the reply disappears from every
// folded view, including the one `tdoc pull` writes to comments.json. The next
// round therefore reads a thread it has never answered and answers it again,
// in the same place, with the same words. Deleting the AI's comment was how
// the human said "handled"; repeating it is the opposite of hearing that.
//
// The event log still holds the reply_added the fold dropped, so the gate reads
// the log. These drive the real route through worker.js with fake bindings.
//
// Run with: node test/agent-reply-once.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('agent answers once per human turn (#349)');

  // A published doc owned by `owner`, with one comment left by `reader`.
  async function seed(slug = 'agent-loop') {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug, version: 1, html: '<h1>doc</h1><p>a sentence to comment on</p>' },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const reader = await putSession(env, 'reader');
    const posted = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'this paragraph is confusing', anchor: { kind: 'text', text: 'a sentence' } },
    }), env, {});
    const comment = await posted.json();
    assert(posted.status === 200, `comment ${posted.status}: ${JSON.stringify(comment)}`);
    return { env, token: tok.token, reader, slug, commentId: comment.id };
  }

  const reply = (worker, env, slug, token, body) => worker.fetch(req('/api/agent/reply', {
    method: 'POST', token, body: { slug, ...body },
  }), env, {});

  const listComments = async (env, slug, version = 1) => {
    const r = await worker.fetch(req(`/api/comments?slug=${slug}&version=${version}`), env, {});
    return r.json();
  };

  await t('the first agent reply lands', async () => {
    const { env, token, slug, commentId } = await seed();
    const r = await reply(worker, env, slug, token, {
      parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude',
    });
    const body = await r.json();
    assert(r.status === 200 && body.id && !body.skipped, `first reply refused: ${JSON.stringify(body)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 1, `expected 1 reply, got ${c.replies.length}`);
  });

  await t('a second round on an untouched thread is skipped, not posted again [the bug]', async () => {
    const { env, token, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const again = await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const body = await again.json();
    assert(again.status === 200, `expected a clean skip, got ${again.status}`);
    assert(body.skipped === true && body.reason === 'already_answered',
      `expected already_answered, got ${JSON.stringify(body)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 1, `the second round posted again: ${c.replies.length} replies`);
  });

  await t('deleting the agent’s reply does not invite it back [the reported bug]', async () => {
    const { env, token, slug, commentId } = await seed();
    const first = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    // The doc owner deletes the agent's reply — the fold drops it, so a pulled
    // comments.json shows a thread with no agent answer at all.
    const ownerCookie = await putSession(env, 'owner');
    const del = await worker.fetch(req(`/api/comments?slug=${slug}&id=${first.id}&version=1`, { method: 'DELETE', cookie: ownerCookie }), env, {});
    assert(del.status === 200, `delete ${del.status}: ${JSON.stringify(await del.json())}`);
    const [folded] = await listComments(env, slug);
    assert(folded.replies.length === 0, 'test setup: the delete should have hidden the reply');

    const again = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(again.skipped === true && again.reason === 'already_answered',
      `the agent re-raised a comment the human had dealt with: ${JSON.stringify(again)}`);
    const [after] = await listComments(env, slug);
    assert(after.replies.length === 0, `the deleted reply came back: ${JSON.stringify(after.replies)}`);
  });

  await t('a human reply re-opens the thread for the agent', async () => {
    const { env, token, reader, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const human = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'still reads oddly to me', parent_id: commentId },
    }), env, {});
    assert(human.status === 200, `human reply ${human.status}`);
    const again = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Tightened it further.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(again.id && !again.skipped, `the agent should answer a person who wrote back: ${JSON.stringify(again)}`);
  });

  await t('a comment the human deleted outright is never answered', async () => {
    const { env, token, reader, slug, commentId } = await seed();
    const del = await worker.fetch(req(`/api/comments?slug=${slug}&id=${commentId}&version=1`, { method: 'DELETE', cookie: reader }), env, {});
    assert(del.status === 200, `delete ${del.status}`);
    const r = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(r.skipped === true && r.reason === 'comment_deleted',
      `expected comment_deleted, got ${JSON.stringify(r)}`);
  });

  // Julie, 2026-10-01: "人没回复的话 ai 不要回复 ai". Once any agent has
  // spoken, the next word belongs to a person — whichever agent asks next.
  await t('a second agent may not answer an agent: the next turn is a person\'s', async () => {
    const { env, token, slug, commentId } = await seed();
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Claude did it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    const b = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Codex looked too.', status: 'applied', applied_in: 1, agent_login: 'codex' })).json();
    assert(a.id && !a.skipped, 'first agent was refused');
    assert(b.skipped === true && b.reason === 'already_answered', `an agent answered an agent: ${JSON.stringify(b)}`);
  });

  await t('force no longer lets an agent answer itself', async () => {
    const { env, token, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const forced = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'And once more.', status: 'applied', applied_in: 1, agent_login: 'claude', force: true })).json();
    assert(forced.skipped === true && forced.reason === 'already_answered', `force posted anyway: ${JSON.stringify(forced)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 1, `expected one reply, got ${c.replies.length}`);
  });

  // ---- the gate itself, on hand-built logs -------------------------------
  // An EDIT of the comment cannot be driven through the routes on this branch
  // (PATCH with `text` arrives with the edit feature), and the whole point of
  // the gate is that it reads the log rather than any folded view — so these
  // build the log directly. They are the rule, stated once:
  //   only a human REPLY re-opens a thread the agent has already answered.
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
  function fn(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`fn ${name} not found`);
    let i = src.indexOf('{', start), d = 0;
    for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
    return src.slice(start, i);
  }
  const box = { crypto: globalThis.crypto, AGENT_STATUS_EMOJI: { applied: '✅', partial: '🟡', question: '❓', answered: '💬' } };
  vm.createContext(box);
  vm.runInContext([
    fn('isFiniteVersion'), fn('legacyToEvents'), fn('ensureEventLog'),
    fn('eventEid'), fn('backfillEids'), fn('dedupEvents'), fn('agentReplyGate'), fn('agentFollowupReason'),
    fn('appendEvent'), fn('ensureMigrated'), fn('snapshotAt'), fn('hasNoWords'), fn('keepThread'), fn('asTombstone'), fn('snapshotList'), fn('compactComments'), fn('reconcileAnchors'),
  ].join('\n\n'), box);
  const gate = box.agentReplyGate;

  const human = { login: 'reader' };
  const bot = { kind: 'agent', login: 'claude', name: 'Claude' };
  const thread = (...events) => ({
    id: 'c1', author: human, created: '2026-01-01T00:00:00Z', created_in: 1,
    events: [{ kind: 'created', at_version: 1, at: '2026-01-01T00:00:00Z', text: 'fix this', anchor: null }, ...events],
  });
  const answered = { kind: 'reply_added', at_version: 1, at: '2026-01-02T00:00:00Z', reply: { id: 'r1', author: bot, text: 'Done.' } };

  await t('a human editing their own comment does NOT re-open it', async () => {
    const g = gate(thread(answered, {
      kind: 'text_edited', at_version: 1, at: '2026-01-03T00:00:00Z', text: 'fix this, please', by: 'reader',
    }), 'claude');
    assert(g.allowed === false && g.reason === 'already_answered',
      `an edited comment is not a new comment: ${JSON.stringify(g)}`);
  });

  await t('a human editing the agent’s answer does NOT re-open it either', async () => {
    const g = gate(thread(answered, {
      kind: 'reply_text_edited', at_version: 1, at: '2026-01-03T00:00:00Z', reply_id: 'r1', text: 'trimmed', by: 'reader',
    }), 'claude');
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('a reply is the only thing that re-opens it', async () => {
    const g = gate(thread(answered, {
      kind: 'reply_added', at_version: 1, at: '2026-01-03T00:00:00Z', reply: { id: 'r2', author: human, text: 'still wrong' },
    }), 'claude');
    assert(g.allowed === true && g.reason === 'human_replied_since', JSON.stringify(g));
  });

  await t('an edit AFTER a human reply still leaves the thread open', async () => {
    // The reply is the turn; a later edit must not swallow it.
    const g = gate(thread(
      answered,
      { kind: 'reply_added', at_version: 1, at: '2026-01-03T00:00:00Z', reply: { id: 'r2', author: human, text: 'still wrong' } },
      { kind: 'text_edited', at_version: 1, at: '2026-01-04T00:00:00Z', text: 'fix this, clearer now', by: 'reader' },
    ), 'claude');
    assert(g.allowed === true, `the edit swallowed a real reply: ${JSON.stringify(g)}`);
  });

  await t('re-anchoring a comment does re-open it — it is a different place now', async () => {
    // patch_anchor already resets status to open and SKILL.md says /tdoc edit
    // picks it up again; the gate must not silently contradict that.
    const g = gate(thread(answered, {
      kind: 'anchor_changed', at_version: 1, at: '2026-01-03T00:00:00Z', by: 'reader',
      anchor: { kind: 'text', text: 'somewhere else' }, reset_status: true,
    }), 'claude');
    assert(g.allowed === true && g.reason === 'human_replied_since', JSON.stringify(g));
  });

  await t('an agent’s own re-anchor does NOT re-open it for another agent', async () => {
    // bind_anchor_aid stamps by_kind:'agent'. Before the stamp existed, one
    // agent's re-anchor read as a human turn to every other agent's gate, and
    // two agents could keep a thread alive by re-anchoring in turn.
    const g = gate(thread(answered, {
      kind: 'anchor_changed', at_version: 1, at: '2026-01-03T00:00:00Z', by: 'claude', by_kind: 'agent',
      anchor: { kind: 'element', aid: 'aid-1' }, reset_status: false,
    }), 'codex');
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('a human re-anchor stamped by_kind still re-opens it', async () => {
    const g = gate(thread(answered, {
      kind: 'anchor_changed', at_version: 1, at: '2026-01-03T00:00:00Z', by: 'reader', by_kind: 'human',
      anchor: { kind: 'text', text: 'somewhere else' }, reset_status: true,
    }), 'claude');
    assert(g.allowed === true && g.reason === 'human_replied_since', JSON.stringify(g));
  });

  await t('through the route — an agent re-anchor does not invite a second agent', async () => {
    const { env, token, slug, commentId } = await seed();
    const a = await (await reply(worker, env, slug, token, {
      parent_id: commentId, text: 'Rewrote it and re-anchored.', status: 'applied', applied_in: 1,
      agent_login: 'claude', bind_anchor_aid: 'aid-123',
    })).json();
    assert(a.id && !a.skipped, `first reply refused: ${JSON.stringify(a)}`);
    const b = await (await reply(worker, env, slug, token, {
      parent_id: commentId, text: 'Codex checked too.', status: 'applied', applied_in: 1, agent_login: 'codex',
    })).json();
    assert(b.skipped === true && b.reason === 'already_answered',
      `the re-anchor re-opened the gate for another agent: ${JSON.stringify(b)}`);
  });

  await t('an unanswered comment is always open, edited or not', async () => {
    const g = gate(thread({ kind: 'text_edited', at_version: 1, at: '2026-01-03T00:00:00Z', text: 'clearer', by: 'reader' }), 'claude');
    assert(g.allowed === true && g.reason === 'first_reply', JSON.stringify(g));
  });

  // ---- one follow-up after `partial` (Julie, 2026-11) ----------------------
  const agentSaid = (id, text, status, by = bot) => ({
    kind: 'reply_added', at_version: 1, at: '2026-01-02T00:00:00Z',
    reply: { id, author: by, text, ...(status ? { agent_status: status } : {}) },
  });
  const humanSaid = (id, text) => ({ kind: 'reply_added', at_version: 1, at: '2026-01-03T00:00:00Z', reply: { id, author: human, text } });

  await t('follow-up: the first agent reply is allowed', async () => {
    const g = gate(thread(), 'claude', 'Looking for photos.');
    assert(g.allowed === true && g.reason === 'first_reply', JSON.stringify(g));
  });

  await t('follow-up: none after answered / applied / question / no status', async () => {
    for (const st of ['answered', 'applied', 'question', null]) {
      const g = gate(thread(agentSaid('r1', 'Done.', st)), 'claude', 'One more thing.');
      assert(g.allowed === false && g.reason === 'already_answered', `${st}: ${JSON.stringify(g)}`);
    }
  });

  await t('follow-up: one is allowed after partial', async () => {
    const g = gate(thread(agentSaid('r1', 'Looking for photos, will send options.', 'partial')), 'claude', 'Here are the options.');
    assert(g.allowed === true && g.reason === 'followup_after_partial', JSON.stringify(g));
  });

  await t('follow-up: any agent may take it (agents are one side), but only one', async () => {
    const other = { kind: 'agent', login: 'codex', name: 'Codex' };
    const g1 = gate(thread(agentSaid('r1', 'Working on it.', 'partial')), 'codex', 'Done now.');
    assert(g1.allowed === true && g1.reason === 'followup_after_partial', JSON.stringify(g1));
    const g2 = gate(thread(agentSaid('r1', 'Working on it.', 'partial'), agentSaid('r2', 'Still going.', 'partial', other)), 'claude', 'Done now.');
    assert(g2.allowed === false && g2.reason === 'already_answered', JSON.stringify(g2));
  });

  await t('follow-up: a second follow-up is blocked, even after another partial', async () => {
    const g = gate(thread(
      agentSaid('r1', 'Looking for photos.', 'partial'),
      agentSaid('r2', 'Found some, still sorting.', 'partial'),
    ), 'claude', 'Here they are.');
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('follow-up: identical text (trimmed, whitespace collapsed) is a duplicate', async () => {
    const g = gate(thread(agentSaid('r1', 'Looking for  photos,\nwill send options.', 'partial')), 'claude', '  Looking for photos, will send options. ');
    assert(g.allowed === false && g.reason === 'duplicate_reply', JSON.stringify(g));
  });

  await t('follow-up: none once a human deleted the partial reply', async () => {
    const g = gate(thread(
      agentSaid('r1', 'Looking for photos.', 'partial'),
      { kind: 'reply_deleted', at_version: 1, at: '2026-01-03T00:00:00Z', reply_id: 'r1', by: 'reader' },
    ), 'claude', 'Here they are.');
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('follow-up: a human reply re-opens the gate and resets the count', async () => {
    const g = gate(thread(
      agentSaid('r1', 'Looking for photos.', 'partial'),
      agentSaid('r2', 'Here they are.', 'answered'),
      humanSaid('r3', 'Can you find a darker one?'),
    ), 'claude', 'Here is a darker one.');
    assert(g.allowed === true && g.reason === 'human_replied_since', JSON.stringify(g));
    const g2 = gate(thread(
      agentSaid('r1', 'Looking for photos.', 'partial'),
      agentSaid('r2', 'Here they are.', 'answered'),
      humanSaid('r3', 'Can you find a darker one?'),
      agentSaid('r4', 'Searching for darker ones.', 'partial'),
    ), 'claude', 'Here is a darker one.');
    assert(g2.allowed === true && g2.reason === 'followup_after_partial', JSON.stringify(g2));
  });

  await t('follow-up: through the route — partial, then one follow-up, then shut', async () => {
    const { env, token, slug, commentId } = await seed();
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Looking for photos, will send options.', status: 'partial', agent_login: 'claude' })).json();
    assert(a.id && !a.skipped, `partial refused: ${JSON.stringify(a)}`);
    const dup = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Looking for photos, will send options.', status: 'answered', agent_login: 'claude' })).json();
    assert(dup.skipped === true && dup.reason === 'duplicate_reply', JSON.stringify(dup));
    const b = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Here are the options.', status: 'answered', agent_login: 'claude' })).json();
    assert(b.id && !b.skipped, `follow-up refused: ${JSON.stringify(b)}`);
    const c = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'And it is live now.', status: 'answered', agent_login: 'claude' })).json();
    assert(c.skipped === true && c.reason === 'already_answered', JSON.stringify(c));
    const [after] = await listComments(env, slug);
    assert(after.replies.length === 2, `expected 2 replies, got ${after.replies.length}`);
  });

  // ---- "working on it", then "live now" (Julie, 2026-11) -----------------
  // An interim note (no status) may be followed by ONE reply with a status;
  // an `applied` reply naming a version newer than the agent side last saw may
  // follow anything. Still one extra reply, never two.
  const agentAt = (id, text, status, atVersion, docVersion) => ({
    kind: 'reply_added', at_version: atVersion, at: '2026-01-02T00:00:00Z',
    ...(docVersion != null ? { doc_version: docVersion } : {}),
    reply: { id, author: bot, text, ...(status ? { agent_status: status } : {}) },
  });

  await t('live: no follow-up when the previous reply recorded no doc version (no at_version fallback)', async () => {
    // at_version 1 is the comment's creation version, not what the doc was.
    const g = gate(thread(agentAt('r1', 'Will fix it in the next version.', 'answered', 1)), 'claude', 'Live now.', { status: 'applied', applied_in: 3, latest: 3 });
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('live: applied_in must be a whole version number', async () => {
    const g = gate(thread(agentAt('r1', 'Fixed in v2.', 'applied', 2, 2)), 'claude', 'Live in v2.5.', { status: 'applied', applied_in: 2.5, latest: 3 });
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('a published local reply keeps its doc_version in the log', async () => {
    const events = box.legacyToEvents({
      id: 'c1', version: 1, text: 'fix', created: '2026-01-01T00:00:00Z', status: 'open',
      replies: [{ id: 'r1', version: 1, author: bot, text: 'Working on it.', agent_status: null, doc_version: 3, created: '2026-01-02T00:00:00Z' }],
    });
    const ev = events.find((e) => e.kind === 'reply_added');
    assert(ev && ev.doc_version === 3, JSON.stringify(ev));
  });

  await t('turns follow the order events were added, not at_version [unlimited replies]', async () => {
    // The person replies on v3; agent replies without applied_in are stamped
    // with the comment's creation version (1). Sorted by at_version, every
    // agent reply sat before the person's and the gate never shut.
    const replies = [];
    let g;
    for (let i = 0; i < 4; i += 1) {
      g = gate(thread(
        { kind: 'reply_added', at_version: 3, at: '2026-01-02T00:00:00Z', reply: { id: 'h1', author: human, text: 'still wrong' } },
        ...replies,
      ), 'claude', `Answer ${i}.`, { status: 'answered' });
      if (!g.allowed) break;
      replies.push(agentAt(`r${i}`, `Answer ${i}.`, 'answered', 1, 3));
    }
    assert(replies.length === 1, `agent replied ${replies.length} times in a row after one human reply`);
    assert(g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('a publish that re-binds the anchor is nobody\'s turn', async () => {
    const c = {
      id: 'c1', author: human, created: '2026-01-01T00:00:00Z', created_in: 1,
      events: [
        { kind: 'created', at_version: 1, at: '2026-01-01T00:00:00Z', text: 'fix this', eid: 'created:c1',
          anchor: { kind: 'element', aid: 'OLD', selector: '[data-tdoc-aid="OLD"]', label: 'section', fingerprint: { tag: 'section' }, fallback: { nearestHeading: { text: 'Intro' } } } },
        { ...agentAt('r1', 'Done.', 'answered', 1, 1), eid: 'r1' },
      ],
    };
    box.reconcileAnchors([c], [{ aid: 'NEW', tag: 'section', heading: 'Intro' }], 2);
    const rebind = c.events.find((e) => e.kind === 'anchor_changed');
    assert(rebind && rebind.by === 'reconcile' && rebind.by_kind === 'system', `rebind not marked system: ${JSON.stringify(rebind)}`);
    const g = gate(c, 'claude', 'Done again.', { status: 'answered' });
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
    // A rebind written before the stamp (by:'reconcile', no by_kind) is no turn either.
    const legacy = gate(thread(agentSaid('r1', 'Done.', 'answered'), {
      kind: 'anchor_changed', at_version: 2, at: '2026-01-03T00:00:00Z', by: 'reconcile', reset_status: false, anchor: { kind: 'lost' },
    }), 'claude', 'Done again.', { status: 'answered' });
    assert(legacy.allowed === false && legacy.reason === 'already_answered', JSON.stringify(legacy));
  });

  await t('interim: after a no-status note, one applied / partial / answered reply', async () => {
    for (const st of ['applied', 'partial', 'answered']) {
      const g = gate(thread(agentSaid('r1', 'Working on it: rewriting the intro.', null)), 'claude', 'Live now: the intro is rewritten.', { status: st, applied_in: 2, latest: 2 });
      assert(g.allowed === true && g.reason === 'followup_after_interim', `${st}: ${JSON.stringify(g)}`);
    }
  });

  await t('interim: a question, or no status again, is not that follow-up', async () => {
    for (const st of ['question', null]) {
      const g = gate(thread(agentSaid('r1', 'Working on it.', null)), 'claude', 'Still working.', { status: st });
      assert(g.allowed === false && g.reason === 'already_answered', `${st}: ${JSON.stringify(g)}`);
    }
  });

  await t('interim: a deleted note leaves no follow-up', async () => {
    const g = gate(thread(
      agentSaid('r1', 'Working on it.', null),
      { kind: 'reply_deleted', at_version: 1, at: '2026-01-03T00:00:00Z', reply_id: 'r1', by: 'reader' },
    ), 'claude', 'Live now.', { status: 'applied', applied_in: 2, latest: 2 });
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('live: applied in a version newer than anything cited and than the doc then', async () => {
    const g = gate(thread(agentAt('r1', 'Fixed in v2.', 'applied', 2, 2)), 'claude', 'Live now in v3.', { status: 'applied', applied_in: 3, latest: 3 });
    assert(g.allowed === true && g.reason === 'followup_live', JSON.stringify(g));
    const g2 = gate(thread(agentAt('r1', 'Will fix it in the next version.', 'answered', 1, 4)), 'claude', 'Live now.', { status: 'applied', applied_in: 5, latest: 5 });
    assert(g2.allowed === true && g2.reason === 'followup_live', JSON.stringify(g2));
  });

  await t('live: not for a version already cited, older than the doc then, or not published', async () => {
    const same = gate(thread(agentAt('r1', 'Fixed in v2.', 'applied', 2, 2)), 'claude', 'Fixed in v2, really.', { status: 'applied', applied_in: 2, latest: 3 });
    assert(same.allowed === false && same.reason === 'already_answered', `same version: ${JSON.stringify(same)}`);
    const older = gate(thread(agentAt('r1', 'Will fix it.', 'answered', 1, 4)), 'claude', 'Live now.', { status: 'applied', applied_in: 3, latest: 5 });
    assert(older.allowed === false && older.reason === 'already_answered', `older than the doc then: ${JSON.stringify(older)}`);
    const future = gate(thread(agentAt('r1', 'Fixed in v2.', 'applied', 2, 2)), 'claude', 'Live in v9.', { status: 'applied', applied_in: 9, latest: 3 });
    assert(future.allowed === false && future.reason === 'already_answered', `unpublished version: ${JSON.stringify(future)}`);
    const answered = gate(thread(agentAt('r1', 'Fixed in v2.', 'applied', 2, 2)), 'claude', 'Live now.', { status: 'answered' });
    assert(answered.allowed === false && answered.reason === 'already_answered', `not applied: ${JSON.stringify(answered)}`);
  });

  await t('one extra reply only: a third agent reply in a row is refused whatever it says', async () => {
    const g = gate(thread(
      agentAt('r1', 'Working on it.', null, 1, 1),
      agentAt('r2', 'Live now in v2.', 'applied', 2, 2),
    ), 'claude', 'And v3 too.', { status: 'applied', applied_in: 3, latest: 3 });
    assert(g.allowed === false && g.reason === 'already_answered', JSON.stringify(g));
  });

  await t('the handoff filter keeps a thread whose last agent word is an interim note', async () => {
    const g = gate(thread(agentSaid('r1', 'Working on it.', null)), '', '', { status: 'answered' });
    assert(g.reason !== 'already_answered', JSON.stringify(g));
    const done = gate(thread(agentSaid('r1', 'Done.', 'applied')), '', '', { status: 'answered' });
    assert(done.reason === 'already_answered', JSON.stringify(done));
  });

  const publish = async (env, token, slug, version) => {
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token,
      body: { slug, version, html: `<h1>doc</h1><p>a sentence to comment on, v${version}</p>` },
    }), env, {});
    assert(up.status === 200, `upload v${version}: ${up.status}`);
  };

  await t('route (a): "working on it", then "Live now" applied, then shut', async () => {
    const { env, token, slug, commentId } = await seed('agent-interim');
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Working on it: rewriting the paragraph.', agent_login: 'claude' })).json();
    assert(a.id && !a.skipped, `interim note refused: ${JSON.stringify(a)}`);
    await publish(env, token, slug, 2);
    const b = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Live now: the paragraph is rewritten.', status: 'applied', applied_in: 2, agent_login: 'claude' })).json();
    assert(b.id && !b.skipped && b.agent_status === 'applied', `live reply refused: ${JSON.stringify(b)}`);
    await publish(env, token, slug, 3);
    const c = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Tightened it again in v3.', status: 'applied', applied_in: 3, agent_login: 'claude' })).json();
    assert(c.skipped === true && c.reason === 'already_answered', `third reply posted: ${JSON.stringify(c)}`);
    const [after] = await listComments(env, slug, 3);
    assert(after.replies.length === 2, `expected 2 replies, got ${after.replies.length}`);
  });

  await t('route (b): answered, then applied in a newly published version, then shut', async () => {
    const { env, token, slug, commentId } = await seed('agent-live');
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Good catch, fixing it in the next version.', status: 'answered', agent_login: 'claude' })).json();
    assert(a.id && !a.skipped, `first reply refused: ${JSON.stringify(a)}`);
    // Not yet: "applied" in the version the doc was already at is an answer
    // (downgraded), and an answer after an answer is refused.
    const early = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Live now.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(early.skipped === true && early.reason === 'already_answered', `early "live" posted: ${JSON.stringify(early)}`);
    await publish(env, token, slug, 2);
    const b = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Live now in v2: the paragraph is rewritten.', status: 'applied', applied_in: 2, agent_login: 'claude' })).json();
    assert(b.id && !b.skipped && b.agent_status === 'applied', `live reply refused: ${JSON.stringify(b)}`);
    await publish(env, token, slug, 3);
    const c = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'And v3.', status: 'applied', applied_in: 3, agent_login: 'claude' })).json();
    assert(c.skipped === true && c.reason === 'already_answered', `third reply posted: ${JSON.stringify(c)}`);
    const [after] = await listComments(env, slug, 3);
    assert(after.replies.length === 2, `expected 2 replies, got ${after.replies.length}`);
  });

  const rawThread = async (env, slug, id) => {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
    return ((await r.json()).list || []).find((c) => c.id === id);
  };

  await t('route: an agent reply records the doc version it landed on', async () => {
    const { env, token, slug, commentId } = await seed('agent-docv');
    await publish(env, token, slug, 2);
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Looking into it.', agent_login: 'claude' })).json();
    assert(a.id && !a.skipped, JSON.stringify(a));
    const c = await rawThread(env, slug, commentId);
    const ev = c.events.find((e) => e.kind === 'reply_added' && e.reply && e.reply.id === a.id);
    assert(ev && ev.doc_version === 2, `doc_version: ${JSON.stringify(ev)}`);
  });

  await t('route: applied_in must be a whole number (2.5 is refused)', async () => {
    const { env, token, slug, commentId } = await seed('agent-intver');
    await publish(env, token, slug, 2);
    const r = await reply(worker, env, slug, token, { parent_id: commentId, text: 'Fixed.', status: 'applied', applied_in: 2.5, agent_login: 'claude' });
    const body = await r.json();
    assert(r.status === 400 && body.error === 'invalid_applied_in', `${r.status} ${JSON.stringify(body)}`);
    const [after] = await listComments(env, slug, 2);
    assert(after.replies.length === 0, 'the reply was posted anyway');
  });

  await t('route: the unlimited-reply repro — one human reply on a later version, then only one agent answer', async () => {
    const { env, token, reader, slug, commentId } = await seed('agent-unlimited');
    await publish(env, token, slug, 2);
    await publish(env, token, slug, 3);
    const human = await worker.fetch(req('/api/comments', { method: 'POST', cookie: reader, body: { slug, version: 3, text: 'still wrong', parent_id: commentId } }), env, {});
    assert(human.status === 200, `human reply ${human.status}`);
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      out.push(await (await reply(worker, env, slug, token, { parent_id: commentId, text: `Answer number ${i}.`, status: 'answered', agent_login: 'claude' })).json());
    }
    const posted = out.filter((b) => b.id && !b.skipped).length;
    assert(posted === 1, `${posted} agent answers landed in a row: ${JSON.stringify(out.map((b) => b.reason || b.id))}`);
  });

  await t('route: two follow-ups sent at once — only one lands (gate re-run in the store)', async () => {
    const { env, token, slug, commentId } = await seed('agent-race');
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Working on it.', status: 'partial', agent_login: 'claude' })).json();
    assert(a.id && !a.skipped, JSON.stringify(a));
    // Hold each write until both requests have reached it, so both pass the
    // route's own gate check on the same read: only the store can refuse.
    const realGet = env.COMMENTS.get.bind(env.COMMENTS);
    let waiting = 0, release;
    const barrier = new Promise((r) => { release = r; });
    env.COMMENTS.get = (id) => {
      const stub = realGet(id);
      return { fetch: async (url, init) => {
        if (String(url).endsWith('/mutate')) { waiting += 1; if (waiting >= 2) release(); await barrier; }
        return stub.fetch(url, init);
      } };
    };
    const both = await Promise.all([
      reply(worker, env, slug, token, { parent_id: commentId, text: 'Here is option A.', status: 'answered', agent_login: 'claude' }).then((r) => r.json()),
      reply(worker, env, slug, token, { parent_id: commentId, text: 'Here is option B.', status: 'answered', agent_login: 'codex' }).then((r) => r.json()),
    ]);
    env.COMMENTS.get = realGet;
    const landed = both.filter((b) => b.id && !b.skipped);
    const refused = both.filter((b) => b.skipped);
    assert(landed.length === 1 && refused.length === 1 && refused[0].reason === 'already_answered', JSON.stringify(both));
    const c = await rawThread(env, slug, commentId);
    const agentReplies = c.events.filter((e) => e.kind === 'reply_added' && e.reply && e.reply.author && e.reply.author.kind === 'agent');
    assert(agentReplies.length === 2, `expected 2 agent replies stored, got ${agentReplies.length}`);
  });

  await t('store: a raw_events write carrying a gate is refused there, and nothing is written', async () => {
    const { env, token, slug, commentId } = await seed('agent-store-gate');
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Done.', status: 'answered', agent_login: 'claude' });
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await (await stub.fetch('https://do/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: {
      kind: 'raw_events', slug, id: commentId, gate: { agent_login: 'claude', text: 'Done again.', next: { status: 'answered' } },
      events: [{ kind: 'reply_added', at_version: 1, at: new Date().toISOString(), reply: { id: 'r_x', author: { kind: 'agent', login: 'claude' }, text: 'Done again.', agent_status: 'answered' } }],
    } }) })).json();
    assert(r.status === 202 && r.body.skipped === true && r.body.reason === 'already_answered', JSON.stringify(r));
    const c = await rawThread(env, slug, commentId);
    assert(!c.events.some((e) => e.reply && e.reply.id === 'r_x'), 'the refused reply was written');
  });

  await t('Ask: tdoc AI\'s answer records the doc version it landed on', async () => {
    const { env, token, reader, slug, commentId } = await seed('agent-ask-docv');
    await publish(env, token, slug, 2);
    env.TDOC_PREVIEW = '1';
    try {
      const r = await worker.fetch(req(`/api/docs/${slug}/ask`, {
        method: 'POST', cookie: reader, headers: { Origin: 'https://tdoc.dev', 'Sec-Fetch-Site': 'same-origin' },
        body: { comment_id: commentId, version: 2 },
      }), env, {});
      const body = await r.json();
      assert(r.status === 200 && !body.skipped, `ask ${r.status}: ${JSON.stringify(body)}`);
    } finally { delete env.TDOC_PREVIEW; }
    const c = await rawThread(env, slug, commentId);
    const ev = c.events.find((e) => e.kind === 'reply_added' && e.reply && e.reply.author && e.reply.author.login === 'tdoc-ai');
    assert(ev && ev.doc_version === 2, `doc_version: ${JSON.stringify(ev)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
