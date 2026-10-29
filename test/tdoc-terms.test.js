// /terms is a landing doc like /privacy. The plugin and connector
// directories link to it (OpenAI requires a terms URL), so it must answer 200
// with the terms, not the neutral fallback, once the doc is in KV.
const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const dir = path.join(root, 'landing', 'tdoc-terms');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(dir, `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');
const latestHtml = (slug) => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'landing', slug, 'meta.json'), 'utf8'));
  return fs.readFileSync(path.join(root, 'landing', slug, `v${m.versions[m.versions.length - 1].n}`, 'index.html'), 'utf8');
};

(async () => {
  console.log('Public /terms page');

  await t('the page runs no author JavaScript', () => {
    assert(!/<script\b/i.test(html), 'terms page contains a script tag');
    assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'terms page contains an inline event handler');
  });

  await t('/terms uses the shared landing-doc route, hosted and local, and ships', () => {
    assert(/const TERMS_SLUG = 'tdoc-terms'/.test(worker), 'TERMS_SLUG missing');
    assert(/if \(p === '\/terms'[\s\S]*?landingResponse\(env, req, TERMS_SLUG\)/.test(worker), '/terms does not use landingResponse');
    assert(/if \(p === '\/terms'[\s\S]*?Location: `\/d\/tdoc-terms\/v\/\$\{latest\}`/.test(server), 'local /terms alias missing');
    assert(/upload tdoc-terms\s+landing\/tdoc-terms 1/.test(workflow), 'publish-landing does not ship the terms doc');
  });

  await t('GET /terms returns 200 and serves the terms', async () => {
    const mod = await loadWorker();
    const env = makeEnv(mod.CommentsStore);
    await env.META.put('meta:tdoc-terms', JSON.stringify({
      ...meta,
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'off', allowed_users: [] },
    }));
    for (const v of meta.versions) {
      await env.DOCS.put(`docs/tdoc-terms/v${v.n}/index.html`, fs.readFileSync(path.join(dir, `v${v.n}`, 'index.html'), 'utf8'));
    }
    const page = await mod.default.fetch(req('/terms'), env, {});
    assert(page.status === 200, `GET /terms: ${page.status}`);
    const outer = await page.text();
    assert(outer.includes('"slug":"tdoc-terms"'), '/terms served the fallback, not the terms doc');
    const frame = await mod.default.fetch(req(`/d/tdoc-terms/v/${latest}/frame`, { dest: 'iframe' }), env, {});
    assert(frame.status === 200, `frame: ${frame.status}`);
    assert(/<h1>Terms of service<\/h1>/.test(await frame.text()), 'terms heading missing');
  });

  await t('the terms name the operator, date, contact and the delete path', () => {
    assert(/run by Tornado Doc/.test(html), 'operator not named');
    assert(/Effective October 29, 2026/.test(html), 'effective date missing');
    assert(html.includes('mailto:hello@tdoc.dev'), 'contact missing');
    assert(/href="\/me\?view=settings"/.test(html), 'Settings delete link missing');
    for (const word of ['Stripe', 'AppSumo', 'Ask this doc', 'as is']) assert(html.includes(word), `terms do not mention ${word}`);
  });

  await t('exactly the two owner notes are left for review', () => {
    const notes = (html.match(/<!--[\s\S]*?-->/g) || []).filter((n) => /OWNER/.test(n));
    assert(notes.length === 2, `expected 2 owner notes, got ${notes.length}`);
    assert(notes.some((n) => /refund policy/.test(n)) && notes.some((n) => /governing law/.test(n)), 'owner notes changed');
  });

  await t('homepage footer, privacy page and MCP consent page link to /terms', () => {
    assert(/<footer>[\s\S]*href="\/privacy">Privacy<\/a>[\s\S]*href="\/terms"[\s\S]*<\/footer>/.test(latestHtml('tornado-doc')), 'homepage footer has no /terms link next to Privacy');
    assert(/href="\/terms"/.test(latestHtml('tdoc-privacy')), 'privacy page has no /terms link');
    const consent = fs.readFileSync(path.join(root, 'shell', 'src', 'oauth-consent-page.jsx'), 'utf8');
    assert(/href="\/privacy"[^\n]*href="\/terms"/.test(consent), 'consent page has no /terms link next to privacy');
  });

  await t('the plugin manifests point at /terms', () => {
    const claude = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'claude', '.claude-plugin', 'plugin.json'), 'utf8'));
    assert(claude.termsOfServiceUrl === 'https://tdoc.dev/terms', 'claude plugin termsOfServiceUrl');
    const codex = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'codex', 'plugin.json'), 'utf8'));
    assert(codex.extensions['com.openai'].interface.termsOfServiceURL === 'https://tdoc.dev/terms', 'codex plugin termsOfServiceURL');
  });

  await t('navigation and SEO', () => {
    assert(/class="back" href="\/"/.test(html), 'back link missing');
    assert(/rel="canonical" href="https:\/\/tdoc\.dev\/terms"/.test(html) && /property="og:title"/.test(html), 'SEO head incomplete');
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
