// An invitation nobody hears about is not one.
//
// Adding someone to allowed_users mails them — once. The sending domain's
// reputation is shared by everything tdoc will ever send, so the path is
// deliberately stingy: only the diff sends, a per-doc+address cooldown
// absorbs churn, opt-out is permanent, and a missing EMAIL binding means the
// feature quietly does not exist.
//
// Run with: node test/invite-email.test.js

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function fakeEmail() {
  const sent = [];
  return { sent, binding: { send: async (msg) => { sent.push(msg); } } };
}

// A doc owned by a hosted account, and a session for that same account.
function seedOwnedDoc(env, slug) {
  env.META.map.set(`meta:${slug}`, JSON.stringify({
    title: 'Quarterly plan', created: '2026-01-01T00:00:00Z',
    versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }],
    hosted: { account_id: 'acct_owner0000', github_login: 'olivia' },
  }));
  env.META.map.set('session:feedface01', JSON.stringify({
    login: 'olivia', name: 'Olivia', email: 'olivia@example.com',
    account_id: 'acct_owner0000', created: new Date().toISOString(),
  }));
  return 'tdoc_sid=feedface01';
}

async function patchAccess(worker, env, cookie, slug, access) {
  const r = await worker.fetch(req('/api/doc/access', {
    method: 'PATCH', cookie, body: { slug, access },
  }), env, {});
  const data = await r.json().catch(() => null);
  return { r, data };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('invite emails');

  await t('a newly added address gets exactly one email', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    const { r } = await patchAccess(worker, env, cookie, 'plan', {
      visibility: 'private', allowed_users: ['dana@example.com'],
    });
    assert(r.status === 200, `patch: ${r.status}`);
    assert(sent.length === 1, `sends: ${sent.length}`);
    assert(sent[0].to === 'dana@example.com', JSON.stringify(sent[0].to));
    assert(sent[0].from && sent[0].from.email === 'invites@tdoc.dev', JSON.stringify(sent[0].from));
    assert(/Olivia/.test(sent[0].subject) && /Quarterly plan/.test(sent[0].subject), sent[0].subject);
    assert(sent[0].text && sent[0].html, 'both text and html bodies are required');
    assert(sent[0].text.includes('/d/plan'), 'doc link missing from text body');
    assert(sent[0].text.includes('/email/optout?t='), 'opt-out link missing');
  });

  await t('saving the same list again sends nothing', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    assert(sent.length === 1, `re-save re-sent: ${sent.length}`);
  });

  await t('remove and re-add inside the cooldown sends nothing new', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: [] });
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    assert(sent.length === 1, `churn re-sent: ${sent.length}`);
  });

  await t('an opted-out address is never mailed', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    env.META.map.set('email-optout:dana@example.com', JSON.stringify({ at: '2026-01-01T00:00:00Z' }));
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    assert(sent.length === 0, `opted-out address was mailed: ${JSON.stringify(sent)}`);
  });

  await t('a handle invitee reaches the email its account has on record', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    env.META.map.set('hosted-account:sam', JSON.stringify({
      account_id: 'acct_sam000000', github_login: 'sam', email: 'sam@example.com',
    }));
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['sam'] });
    assert(sent.length === 1 && sent[0].to === 'sam@example.com', JSON.stringify(sent));
  });

  await t('a handle with no account (or no email) mails nobody and still saves', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    const { r, data } = await patchAccess(worker, env, cookie, 'plan', {
      visibility: 'private', allowed_users: ['stranger'],
    });
    assert(r.status === 200 && data.ok === true, `patch: ${r.status}`);
    assert(sent.length === 0, `unmailable handle was mailed: ${JSON.stringify(sent)}`);
  });

  await t('a failing send does not fail the access patch', async () => {
    const env = makeEnv(mod.CommentsStore, {
      EMAIL: { send: async () => { throw new Error('smtp on fire'); } },
    });
    const cookie = seedOwnedDoc(env, 'plan');
    const { r, data } = await patchAccess(worker, env, cookie, 'plan', {
      visibility: 'private', allowed_users: ['dana@example.com'],
    });
    assert(r.status === 200 && data.ok === true, `patch failed with broken email: ${r.status}`);
  });

  await t('without the binding the patch works and nothing is attempted', async () => {
    const env = makeEnv(mod.CommentsStore); // no EMAIL
    const cookie = seedOwnedDoc(env, 'plan');
    const { r, data } = await patchAccess(worker, env, cookie, 'plan', {
      visibility: 'private', allowed_users: ['dana@example.com'],
    });
    assert(r.status === 200 && data.ok === true, `patch: ${r.status}`);
  });

  await t('the emailed opt-out link works once and sticks forever', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: ['dana@example.com'] });
    const tok = (sent[0].text.match(/optout\?t=([a-f0-9]+)/) || [])[1];
    assert(tok, 'no token in the email body');
    const r1 = await worker.fetch(req(`/email/optout?t=${tok}`), env, {});
    assert(r1.status === 200 && (await r1.text()).includes('unsubscribed'), 'opt-out did not confirm');
    assert(env.META.map.has('email-optout:dana@example.com'), 'suppression not recorded');
    // The token is single-use; a replay renders the expired page, and the
    // suppression it already wrote stays.
    const r2 = await worker.fetch(req(`/email/optout?t=${tok}`), env, {});
    assert((await r2.text()).includes('expired'), 'replayed token still claimed success');
    // A later invite to another doc must now stay silent.
    seedOwnedDoc(env, 'other');
    await patchAccess(worker, env, cookie, 'other', { visibility: 'private', allowed_users: ['dana@example.com'] });
    assert(sent.length === 1, `suppressed address was mailed again: ${sent.length}`);
  });

  await t('the daily cap stops a bulk blast', async () => {
    const { sent, binding } = fakeEmail();
    const env = makeEnv(mod.CommentsStore, { EMAIL: binding });
    const cookie = seedOwnedDoc(env, 'plan');
    const many = Array.from({ length: 60 }, (_, i) => `p${i}@example.com`);
    await patchAccess(worker, env, cookie, 'plan', { visibility: 'private', allowed_users: many });
    assert(sent.length === 50, `cap did not hold: ${sent.length}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
