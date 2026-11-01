// Signing out also ends the sign-in provider's (Clerk's) session, or the next
// sign-in goes straight back to the same account (#58).
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');
let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('logout ends the provider session');
  const logout = async (extra) => {
    const env = makeEnv(mod.CommentsStore, extra);
    const cookie = await putSession(env, 'ann');
    const r = await worker.fetch(req('/api/auth/logout', { method: 'POST', cookie }), env, {});
    return { r, body: await r.json(), env, sid: cookie.split('=')[1] };
  };
  await t('with Clerk as the OIDC issuer, logout names its frontend sign-out endpoint and drops the tdoc session', async () => {
    const { r, body, env, sid } = await logout({ OIDC_ISSUER: 'https://clerk.tdoc.dev/' });
    assert(r.status === 200 && body.provider_signout === 'https://clerk.tdoc.dev/v1/client/sessions', JSON.stringify(body));
    assert(/tdoc_sid=;/.test(r.headers.get('set-cookie') || ''), 'tdoc cookie not cleared');
    assert(!env.META.map.has(`session:${sid}`), 'tdoc session kept');
  });
  await t('without a Clerk issuer there is nothing extra to end', async () => {
    const { body } = await logout({});
    assert(body.ok && !('provider_signout' in body), JSON.stringify(body));
    const other = await logout({ OIDC_ISSUER: 'https://login.example.com' });
    assert(!('provider_signout' in other.body), JSON.stringify(other.body));
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
