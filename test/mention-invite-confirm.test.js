// Ask before a mention adds someone to a doc (flag confirmMentionInvite).
// POST /api/comments with confirm_invites: 'ask' writes nothing and answers
// 409 would_invite when the owner names someone the doc does not let in yet;
// a list adds exactly those; without the field (older clients, agents, the
// API) a mention invites as it always has. Plus the composer's sentence.
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('mention invites: asked first, then exactly what was confirmed');

  const setup = async (access = { visibility: 'private', commenting: 'signed_in', allowed_users: ['lee'] }) => {
    const env = makeEnv(mod.CommentsStore);
    await env.META.put('meta:plan', JSON.stringify({ slug: 'plan', title: 'Plan', hosted: { github_login: 'olga' }, versions: [{ n: 1, created: '2026-11-01T00:00:00Z' }], access }));
    await env.DOCS.put('docs/plan/v1/index.html', '<h1>Plan</h1>');
    const olga = await putSession(env, 'olga');
    const lee = await putSession(env, 'lee');
    const post = async (cookie, text, extra = {}) => {
      const r = await worker.fetch(req('/api/comments', { method: 'POST', cookie, body: { slug: 'plan', version: 1, text, anchor: null, ...extra } }), env, {});
      return { status: r.status, body: await r.json() };
    };
    const allowed = () => JSON.parse(env.META.map.get('meta:plan')).access.allowed_users.join();
    const count = async () => (await (await worker.fetch(req('/api/comments?slug=plan&version=1', { cookie: olga }), env, {})).json()).length;
    return { env, olga, lee, post, allowed, count };
  };

  await t('without confirm_invites a mention invites as before', async () => {
    const { olga, post, allowed } = await setup();
    const r = await post(olga, 'Look @bob');
    assert(r.status === 200 && r.body.mention_outcome.invited.join() === 'bob', JSON.stringify(r));
    assert(allowed() === 'lee,bob', allowed());
  });

  await t("'ask': who would be added, and nothing written", async () => {
    const { olga, post, allowed, count } = await setup();
    const before = await count();
    const r = await post(olga, 'Look @bob and @lee', { confirm_invites: 'ask' });
    assert(r.status === 409 && r.body.error === 'confirm_invites' && JSON.stringify(r.body.would_invite) === '["bob"]', JSON.stringify(r));
    assert(allowed() === 'lee', `invited anyway: ${allowed()}`);
    assert(await count() === before, 'the comment was written');
  });

  await t('a list adds exactly those; the others are not told and not reported as blocked', async () => {
    const { olga, post, allowed } = await setup();
    const r = await post(olga, '@bob @carol @lee see this', { confirm_invites: ['bob', 'mallory'] });
    const o = r.body.mention_outcome;
    assert(r.status === 200 && o.invited.join() === 'bob' && o.notified.join() === 'bob,lee', JSON.stringify(o));
    assert(o.not_invited.join() === 'carol' && !o.blocked.length, JSON.stringify(o));
    assert(allowed() === 'lee,bob', allowed());
  });

  await t('an empty list (Post without adding) posts and adds nobody; a confirm that is not a list adds nobody', async () => {
    const { olga, post, allowed } = await setup();
    let r = await post(olga, 'Look @bob', { confirm_invites: [] });
    assert(r.status === 200 && r.body.id && !r.body.mention_outcome.invited.length && !r.body.mention_outcome.notified.length, JSON.stringify(r));
    r = await post(olga, 'And @carol', { confirm_invites: 'yes' });
    assert(r.status === 200 && !r.body.mention_outcome.invited.length, JSON.stringify(r));
    assert(allowed() === 'lee', allowed());
  });

  await t("'ask' posts at once when nobody would be added: a reader named, a non-owner, a public doc", async () => {
    let s = await setup();
    let r = await s.post(s.olga, 'Hi @lee', { confirm_invites: 'ask' });
    assert(r.status === 200 && r.body.mention_outcome.notified.join() === 'lee', JSON.stringify(r));
    r = await s.post(s.lee, 'Hi @bob', { confirm_invites: 'ask' });
    assert(r.status === 200 && r.body.mention_outcome.blocked.join() === 'bob', `not the owner: ${JSON.stringify(r)}`);
    s = await setup({ visibility: 'public', commenting: 'signed_in', allowed_users: [] });
    r = await s.post(s.olga, 'Hi @bob', { confirm_invites: 'ask' });
    assert(r.status === 200 && !r.body.mention_outcome.invited.length, `public: ${JSON.stringify(r)}`);
  });

  await t('a typo that reads as two handles asks for both: "@john, @gmail。com"', async () => {
    const { olga, post, allowed } = await setup();
    const r = await post(olga, 'cc @john, @gmail。com', { confirm_invites: 'ask' });
    assert(r.status === 409 && r.body.would_invite.join() === 'john,gmail', JSON.stringify(r));
    const ok = await post(olga, 'cc @john, @gmail。com', { confirm_invites: ['john'] });
    assert(ok.status === 200 && ok.body.mention_outcome.invited.join() === 'john', JSON.stringify(ok));
    assert(allowed() === 'lee,john', allowed());
  });

  await t('a reply asks the same way', async () => {
    const { olga, post, allowed } = await setup();
    const root = (await post(olga, 'Root')).body.id;
    let r = await post(olga, 'cc @bob', { parent_id: root, confirm_invites: 'ask' });
    assert(r.status === 409 && r.body.would_invite.join() === 'bob', JSON.stringify(r));
    r = await post(olga, 'cc @bob', { parent_id: root, confirm_invites: ['bob'] });
    assert(r.status === 200 && allowed() === 'lee,bob', JSON.stringify(r));
  });

  await t('an address the owner names is asked about as its key, and added as the address', async () => {
    const { olga, post, allowed } = await setup();
    const r = await post(olga, 'cc @dana@example.com', { confirm_invites: 'ask' });
    assert(r.status === 409 && r.body.would_invite.join() === 'email:dana@example.com', JSON.stringify(r));
    await post(olga, 'cc @dana@example.com', { confirm_invites: r.body.would_invite });
    assert(allowed() === 'lee,dana@example.com', allowed());
  });

  await t('the composer\'s sentence names handles with @ and addresses as they are', async () => {
    const { inviteQuestion } = await import('../shell/src/comments/core/invite-question.js');
    assert(inviteQuestion(['bob']) === 'Add @bob to this doc? They can read it.');
    assert(inviteQuestion(['john', 'gmail', 'email:d@x.com']) === 'Add @john, @gmail and d@x.com to this doc? They can read it.');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
