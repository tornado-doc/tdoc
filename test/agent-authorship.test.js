// Authorship is enforced when an agent WRITES, not only when a handoff is
// sent (#823's rules, Julie 2026-10-25). An agent token -- a person's upload
// token (their agent) or a team agent's -- may change a team doc only where
// authorship lets it:
//   team agent     the doc is new, or last written by a team agent or by a
//                  person in the browser; never over somebody's own agent
//   person's token they own the doc, or it is new, or a person wrote the
//                  latest version in the browser, or their own agent did
// Refused: 403 agent_not_author_editor (upload, and agent replies that mark
// a comment applied / partial or move its anchor).
// And an answer-only question (own agent, Only me, team agent) locks its
// agent out of edits on that doc from the moment it is SENT until its answer
// lands (or the run ends), per question, failing closed: 403 answer_only_run.
// Run with: node test/agent-authorship.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('agent authorship at write time');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const origin = { Origin: 'https://tdoc.dev' };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  await env.META.delete(`account-terminal:${bob.account_id}`);
  const versions = {};
  const html = (slug, v) => `<h1>${slug}</h1><p>${slug} v${v}: a sentence to comment on</p>`;
  const upload = async (token, slug) => {
    const v = (versions[slug] || 0) + 1;
    const r = await call('/api/upload', { method: 'POST', token, body: { slug, version: v, html: html(slug, v), meta: { title: slug } } });
    if (r.status === 200) versions[slug] = v;
    return r;
  };
  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Acme' } })).body.team;
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  const slugs = ['julies-doc', 'human-doc', 'bobs-doc', 'mine-doc'];
  for (const slug of slugs) assert((await upload(julie.token, slug)).status === 200, `seed ${slug}`);
  await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs } });
  await upload(julie.token, 'personal');
  const added = (await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: team.id, name: 'acme-bot' } })).body;
  const agentToken = (await call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'acme-box' } })).body.token;
  await call('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'acme-box', clis: ['claude'] } });
  await call('/api/notify/local/register', { method: 'POST', token: bob.token, body: { device: 'bobbox', clis: ['claude'] } });
  await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'juliesmac', clis: ['claude'] } });
  // The team agent wrote agent-doc and busy-doc; a person wrote human-doc in
  // the browser; Bob's agent wrote bobs-doc.
  // The team agent creates its own docs (they land in its team).
  for (const slug of ['agent-doc', 'busy-doc']) {
    const r = await upload(agentToken, slug);
    assert(r.status === 200 && r.body.team === team.id, `the team agent creates ${slug}: ${r.status} ${r.text}`);
  }
  const restamp = (slug, patch) => {
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    const last = meta.versions.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a));
    Object.assign(last, patch);
    if (patch.by === undefined && patch.source) delete last.by;
    env.META.map.set(`meta:${slug}`, JSON.stringify(meta));
  };
  restamp('human-doc', { source: 'browser', author: 'julie' });
  restamp('bobs-doc', { by: bob.account_id });

  const comment = async (who, slug, text) => (await call('/api/comments', { method: 'POST', cookie: who.cookie, headers: origin, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } })).body.id;
  const handOff = (who, slug, body) => call(`/api/docs/${slug}/hand-off`, { method: 'POST', cookie: who.cookie, headers: origin, body });
  const mine = async (who, slug) => (await call(`/api/docs/${slug}/my-agent`, { cookie: who.cookie })).body;
  const agentReply = (token, slug, parent, status) => call('/api/agent/reply', { method: 'POST', token, body: { slug, parent_id: parent, text: 'done', status } });
  const teamTarget = (await mine(bob, 'agent-doc')).team_agents[0];

  // ---- the bypasses (each passed on main) ----
  await t("a member's own agent cannot publish over a team doc somebody else's agent wrote", async () => {
    const r = await upload(bob.token, 'julies-doc');
    assert(r.status === 403 && r.body.error === 'agent_not_author_editor' && r.body.reason === 'written_by_other', `${r.status} ${r.text}`);
    assert(/julie/.test(r.body.message), r.body.message);
    const c = await comment(bob, 'julies-doc', 'fix it');
    const rep = await agentReply(bob.token, 'julies-doc', c, 'applied');
    assert(rep.status === 403 && rep.body.error === 'agent_not_author_editor', `mark applied: ${rep.status} ${rep.text}`);
    const answer = await agentReply(bob.token, 'julies-doc', c, 'answered');
    assert(answer.status === 200, `an answer is still fine: ${answer.status} ${answer.text}`);
  });

  await t("the team agent cannot publish, with no handoff, over a doc a person's own agent wrote", async () => {
    const r = await upload(agentToken, 'julies-doc');
    assert(r.status === 403 && r.body.error === 'agent_not_author_editor', `${r.status} ${r.text}`);
    const c = await comment(julie, 'julies-doc', 'tidy');
    const rep = await agentReply(agentToken, 'julies-doc', c, 'partial');
    assert(rep.status === 403 && rep.body.error === 'agent_not_author_editor', `mark partial: ${rep.status} ${rep.text}`);
  });

  await t('answer only: the lock starts when the question is SENT, before any ack', async () => {
    const c = await comment(bob, 'agent-doc', 'why billing first?');
    const sent = await handOff(bob, 'agent-doc', { ask_only: true, comment_id: c, recipient: teamTarget });
    assert(sent.status === 200 && sent.body.ask, sent.text);
    const up = await upload(agentToken, 'agent-doc');
    assert(up.status === 403 && up.body.error === 'answer_only_run', `upload before ack: ${up.status} ${up.text}`);
    // The answer itself lands, and lifts the lock.
    const ans = await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'agent-doc', ask_id: sent.body.ask.ask_id, text: 'because invoices' } });
    assert(ans.status === 200, ans.text);
    const after = await upload(agentToken, 'agent-doc');
    assert(after.status === 200, `after the answer: ${after.status} ${after.text}`);
  });

  await t('overlapping questions: ending the second does not lift the first', async () => {
    const c1 = await comment(bob, 'busy-doc', 'q one');
    const c2 = await comment(bob, 'busy-doc', 'q two');
    const a1 = (await handOff(bob, 'busy-doc', { ask_only: true, comment_id: c1, recipient: teamTarget })).body.ask.ask_id;
    const a2 = (await handOff(bob, 'busy-doc', { ask_only: true, comment_id: c2, recipient: teamTarget })).body.ask.ask_id;
    for (const id of [a1, a2]) await call('/api/agent/ask-ack', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: id } });
    await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: a2, text: 'two' } });
    await call('/api/agent/ask-done', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: a2 } });
    const up = await upload(agentToken, 'busy-doc');
    assert(up.status === 403 && up.body.error === 'answer_only_run', `first still open: ${up.status} ${up.text}`);
    await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: a1, text: 'one' } });
    assert((await upload(agentToken, 'busy-doc')).status === 200, 'both answered');
  });

  await t('the lock fails closed when its storage cannot be read', async () => {
    const c = await comment(bob, 'busy-doc', 'q three');
    const id = (await handOff(bob, 'busy-doc', { ask_only: true, comment_id: c, recipient: teamTarget })).body.ask.ask_id;
    await call('/api/agent/ask-ack', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: id } });
    const realGet = env.META.get.bind(env.META);
    const realNs = env.COMMENTS.get.bind(env.COMMENTS);
    env.META.get = async (key, ...rest) => { if (/^(team-ask-run:|answer-lock)/.test(key)) throw new Error('kv down'); return realGet(key, ...rest); };
    env.COMMENTS.get = (id_) => {
      const stub = realNs(id_);
      return { fetch: (url, init) => (String(url).includes('/answer-locks') ? Promise.reject(new Error('do down')) : stub.fetch(url, init)) };
    };
    try {
      const up = await upload(agentToken, 'busy-doc');
      assert(up.status === 403 || up.status === 503, `storage down let an upload through: ${up.status} ${up.text}`);
    } finally {
      env.META.get = realGet;
      env.COMMENTS.get = realNs;
    }
    await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'busy-doc', ask_id: id, text: 'three' } });
  });

  await t("a member asking their own agent (Only me) locks that agent's edits on the doc until the answer lands", async () => {
    const own = (await mine(bob, 'bobs-doc')).agents[0];
    assert(own, 'bob has an agent');
    const sent = await handOff(bob, 'bobs-doc', { ask_only: true, only_me: true, question: 'what is this?', recipient: own });
    assert(sent.status === 200 && sent.body.ask, sent.text);
    const up = await upload(bob.token, 'bobs-doc');
    assert(up.status === 403 && up.body.error === 'answer_only_run', `${up.status} ${up.text}`);
    await call('/api/agent/ask-reply', { method: 'POST', token: bob.token, body: { slug: 'bobs-doc', ask_id: sent.body.ask.ask_id, text: 'an answer' } });
    assert((await upload(bob.token, 'bobs-doc')).status === 200, 'after the answer');
  });

  // ---- what must keep working ----
  await t('the owner publishes their own docs with their own token (team and personal), even with a question of their own open', async () => {
    assert((await upload(julie.token, 'julies-doc')).status === 200, 'team doc');
    assert((await upload(julie.token, 'personal')).status === 200, 'personal doc');
    const own = (await mine(julie, 'mine-doc')).agents[0];
    const sent = await handOff(julie, 'mine-doc', { ask_only: true, only_me: true, question: 'q?', recipient: own });
    assert(sent.status === 200, sent.text);
    assert((await upload(julie.token, 'mine-doc')).status === 200, 'the owner is not locked out of their own doc');
    assert((await upload(julie.token, 'brand-new')).status === 200, 'a new doc');
  });

  await t('a team doc a person last wrote in the browser: members\' agents and the team agent may edit', async () => {
    assert((await upload(bob.token, 'human-doc')).status === 200, "bob's agent");
    restamp('human-doc', { source: 'browser', author: 'julie' });
    assert((await upload(agentToken, 'human-doc')).status === 200, 'the team agent');
  });

  await t("a member's own agent continues a doc it wrote; the team agent continues its own", async () => {
    assert((await upload(bob.token, 'bobs-doc')).status === 200, "bob's agent on bob's agent's doc");
    assert((await upload(agentToken, 'agent-doc')).status === 200, 'team agent on its doc');
    const r = await upload(agentToken, 'bobs-doc');
    assert(r.status === 403 && r.body.error === 'agent_not_author_editor', `team agent over bob's agent: ${r.status}`);
    const m = await upload(bob.token, 'agent-doc');
    assert(m.status === 403 && m.body.error === 'agent_not_author_editor' && m.body.reason === 'team_agent_wrote', `bob's agent over the team agent: ${m.status} ${m.text}`);
  });

  // ---- security review of #829 ----
  const second = (await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: team.id, name: 'acme-two' } })).body;
  const agentTwo = (await call('/api/team/agents/connect', { method: 'POST', body: { code: second.setup_code, device: 'two-box' } })).body.token;
  const html2 = (slug) => `<!doctype html><html><body><h1>${slug}</h1><p>${slug}: a sentence to comment on, saved</p></body></html>`;
  const saveVersion = (opts, slug) => call('/api/doc/versions', { method: 'POST', ...opts, body: { slug, baseVersion: versions[slug], html: html2(slug) } });

  await t('H1: /api/doc/versions takes no token: an admin\'s agent cannot save as a "browser edit" to open a doc', async () => {
    const r = await saveVersion({ token: julie.token }, 'agent-doc');
    assert(r.status === 403 && r.body.error === 'browser_session_required', `admin token saved: ${r.status} ${r.text}`);
    const t2 = await saveVersion({ token: agentToken }, 'agent-doc');
    assert(t2.status === 403, `team agent token saved: ${t2.status}`);
    // A person in the browser still saves.
    const ok = await saveVersion({ cookie: julie.cookie, headers: origin }, 'agent-doc');
    assert(ok.status === 200, `browser save: ${ok.status} ${ok.text}`);
    versions['agent-doc'] += 1;
    // and it is a person's edit: the team agent may write it again.
    assert((await upload(agentToken, 'agent-doc')).status === 200, 'team agent after a browser save');
  });

  await t('H1: rename and delete with an agent token follow authorship (sharing stays the admin\'s)', async () => {
    const title = await call('/api/doc/title', { method: 'PATCH', token: julie.token, body: { slug: 'agent-doc', title: 'Renamed by an agent' } });
    assert(title.status === 403 && title.body.error === 'agent_not_author_editor', `rename: ${title.status} ${title.text}`);
    const del = await call('/api/doc?slug=agent-doc', { method: 'DELETE', token: julie.token });
    assert(del.status === 403 && del.body.error === 'agent_not_author_editor', `delete: ${del.status} ${del.text}`);
    // The owner's token on their own doc still renames.
    const own = await call('/api/doc/title', { method: 'PATCH', token: julie.token, body: { slug: 'julies-doc', title: 'Julie renames hers' } });
    assert(own.status === 200, `owner rename: ${own.status} ${own.text}`);
  });

  await t('H2: a client cannot mark a doc a feedback space (or unmark one) by upload meta', async () => {
    const r = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'julies-doc', version: versions['julies-doc'] + 1, html: html('julies-doc', 9), meta: { title: 'julies-doc', created_from: 'feedback', feedback: { origin: 'https://evil.example' } } } });
    assert(r.status === 200, r.text);
    versions['julies-doc'] += 1;
    const meta = JSON.parse(env.META.map.get('meta:julies-doc'));
    assert(meta.created_from !== 'feedback' && !meta.feedback, `stored: ${meta.created_from} ${JSON.stringify(meta.feedback)}`);
    const bobs = await upload(bob.token, 'julies-doc');
    assert(bobs.status === 403, `bob's agent after the feedback trick: ${bobs.status}`);
    // nor whitewash a version as a person's or a blank scaffold
    const w = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: 'julies-doc', version: versions['julies-doc'] + 1, html: html('julies-doc', 10), meta: { title: 'julies-doc', versions: [{ n: versions['julies-doc'] + 1, blank: true, human: true, source: 'browser' }] } } });
    assert(w.status === 200, w.text);
    versions['julies-doc'] += 1;
    assert((await upload(agentToken, 'julies-doc')).status === 403, 'a client-claimed blank/human version opened the doc');
  });

  await t('M1: a blank doc made in the browser is nobody\'s agent\'s: the team agent may write it', async () => {
    const made = await call('/api/doc/create', { method: 'POST', cookie: julie.cookie, headers: origin, body: { team: team.id } });
    assert(made.status === 200 && made.body.slug, made.text);
    versions[made.body.slug] = 1;
    const r = await upload(agentToken, made.body.slug);
    assert(r.status === 200, `team agent on a blank doc: ${r.status} ${r.text}`);
  });

  await t('M2: a legacy version that does not say who wrote it locks nobody out', async () => {
    assert((await upload(julie.token, 'legacy-doc')).status === 200, 'seed');
    await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: ['legacy-doc'] } });
    const meta = JSON.parse(env.META.map.get('meta:legacy-doc'));
    for (const v of meta.versions) { delete v.by; delete v.token; }
    env.META.map.set('meta:legacy-doc', JSON.stringify(meta));
    assert((await upload(bob.token, 'legacy-doc')).status === 200, "a teammate's agent on a legacy doc");
  });

  await t('M3: the asked agent cannot end its own lock with ask-done; only its answer (or the asker) does', async () => {
    const c = await comment(bob, 'agent-doc', 'stuck?');
    const id = (await handOff(bob, 'agent-doc', { ask_only: true, comment_id: c, recipient: teamTarget })).body.ask.ask_id;
    await call('/api/agent/ask-done', { method: 'POST', token: agentToken, body: { slug: 'agent-doc', ask_id: id } });
    const up = await upload(agentToken, 'agent-doc');
    assert(up.status === 403 && up.body.error === 'answer_only_run', `done lifted the lock: ${up.status}`);
    // M4: the asker cancels it.
    const cancel = await call('/api/docs/agent-doc/my-agent/cancel', { method: 'POST', cookie: bob.cookie, headers: origin, body: { ask_id: id } });
    assert(cancel.status === 200 && cancel.body.ok, `cancel: ${cancel.status} ${cancel.text}`);
    assert((await upload(agentToken, 'agent-doc')).status === 200, 'after cancel');
  });

  await t('M4: the doc owner / a team admin can clear stuck locks; a stranger cannot cancel', async () => {
    const c = await comment(bob, 'agent-doc', 'stuck again?');
    const id = (await handOff(bob, 'agent-doc', { ask_only: true, comment_id: c, recipient: teamTarget })).body.ask.ask_id;
    const carl = await issue(worker, env, 'carl');
    const no = await call('/api/docs/agent-doc/my-agent/cancel', { method: 'POST', cookie: carl.cookie, headers: origin, body: { ask_id: id } });
    assert(no.status !== 200, `a stranger cancelled: ${no.status}`);
    const all = await call('/api/docs/agent-doc/my-agent/cancel', { method: 'POST', cookie: julie.cookie, headers: origin, body: { all: true } });
    assert(all.status === 200 && all.body.cleared >= 1, `admin clear: ${all.status} ${all.text}`);
    assert((await upload(agentToken, 'agent-doc')).status === 200, 'after the admin cleared it');
  });

  await t('M4: a question that fails to be recorded leaves no lock behind', async () => {
    const c = await comment(bob, 'agent-doc', 'will it record?');
    const realPut = env.META.put.bind(env.META);
    env.META.put = async (key, ...rest) => { if (String(key).startsWith('agent-asks:agent-doc:')) throw new Error('kv put down'); return realPut(key, ...rest); };
    let r;
    try { r = await handOff(bob, 'agent-doc', { ask_only: true, comment_id: c, recipient: teamTarget }); } finally { env.META.put = realPut; }
    assert(r.status >= 500, `ask: ${r.status} ${r.text}`);
    assert((await upload(agentToken, 'agent-doc')).status === 200, 'an orphaned lock holds the agent');
  });

  await t('LOW (kept): another agent of the same team may continue a team agent\'s doc, as handoffs offer it', async () => {
    assert((await upload(agentTwo, 'agent-doc')).status === 200, 'second team agent');
  });

  await t('LOW: a refused agent cannot reopen a resolved comment with an answer status', async () => {
    const c = await comment(julie, 'julies-doc', 'resolved one');
    await call('/api/comments', { method: 'PATCH', cookie: julie.cookie, headers: origin, body: { slug: 'julies-doc', version: 1, id: c, resolved: true } });
    const r = await agentReply(agentToken, 'julies-doc', c, 'answered');
    assert(r.status === 403 && r.body.error === 'agent_not_author_editor', `reopened: ${r.status} ${r.text}`);
    const list = (await call('/api/comments?slug=julies-doc&version=1', { cookie: julie.cookie })).body;
    assert(list.find((x) => x.id === c).status === 'applied', 'it was reopened');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
