// /privacy is a landing doc like /pricing. The plugin and connector
// directories link to it, so it must answer 200 with the policy, not the
// neutral fallback, once the doc is in KV.
const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const dir = path.join(root, 'landing', 'tdoc-privacy');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(dir, `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');

(async () => {
  console.log('Public /privacy page');

  await t('the page runs no author JavaScript', () => {
    assert(!/<script\b/i.test(html), 'privacy page contains a script tag');
    assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'privacy page contains an inline event handler');
  });

  await t('/privacy uses the shared landing-doc route, hosted and local, and ships', () => {
    assert(/const PRIVACY_SLUG = 'tdoc-privacy'/.test(worker), 'PRIVACY_SLUG missing');
    assert(/if \(p === '\/privacy'[\s\S]*?landingResponse\(env, req, PRIVACY_SLUG\)/.test(worker), '/privacy does not use landingResponse');
    assert(/if \(p === '\/privacy'[\s\S]*?Location: `\/d\/tdoc-privacy\/v\/\$\{latest\}`/.test(server), 'local /privacy alias missing');
    assert(/upload tdoc-privacy\s+landing\/tdoc-privacy 1/.test(workflow), 'publish-landing does not ship the privacy doc');
  });

  await t('GET /privacy returns 200 and serves the policy', async () => {
    const mod = await loadWorker();
    const env = makeEnv(mod.CommentsStore);
    await env.META.put('meta:tdoc-privacy', JSON.stringify({
      ...meta,
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'off', allowed_users: [] },
    }));
    for (const v of meta.versions) {
      await env.DOCS.put(`docs/tdoc-privacy/v${v.n}/index.html`, fs.readFileSync(path.join(dir, `v${v.n}`, 'index.html'), 'utf8'));
    }
    const page = await mod.default.fetch(req('/privacy'), env, {});
    assert(page.status === 200, `GET /privacy: ${page.status}`);
    const outer = await page.text();
    assert(outer.includes('"slug":"tdoc-privacy"'), '/privacy served the fallback, not the privacy doc');
    const frame = await mod.default.fetch(req(`/d/tdoc-privacy/v/${latest}/frame`, { dest: 'iframe' }), env, {});
    assert(frame.status === 200, `frame: ${frame.status}`);
    assert(/<h1>Privacy policy<\/h1>/.test(await frame.text()), 'policy heading missing');
  });

  await t('the policy names every outside service the worker calls', () => {
    for (const name of ['Cloudflare', 'Clerk', 'GitHub', 'Stripe', 'AppSumo', 'Resend', 'OpenRouter', 'Raft', 'Webhooks', 'Data backup']) {
      assert(html.includes(name), `policy does not mention ${name}`);
    }
    assert(html.includes('After 30 days'), 'Trash window missing');
  });

  await t('the homepage footer links to /privacy', () => {
    const lmeta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
    const lv = lmeta.versions[lmeta.versions.length - 1].n;
    const home = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', `v${lv}`, 'index.html'), 'utf8');
    assert(/<footer>[\s\S]*href="\/privacy"[\s\S]*<\/footer>/.test(home), 'homepage footer has no /privacy link');
  });

  await t('navigation and SEO', () => {
    assert(/class="back" href="\/"/.test(html), 'back link missing');
    assert(/rel="canonical" href="https:\/\/tdoc\.dev\/privacy"/.test(html) && /property="og:title"/.test(html), 'SEO head incomplete');
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
