// /pricing is a landing doc like /start. Its numbers must be the ones the
// worker enforces, so a limit change that forgets the page fails here.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tdoc-pricing', 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(root, 'landing', 'tdoc-pricing', `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');
const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const num = (re) => Number((worker.match(re) || [])[1]);

console.log('Public /pricing page');

t('the page runs no author JavaScript', () => {
  assert(!/<script\b/i.test(html), 'pricing page contains a script tag');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'pricing page contains an inline event handler');
});

t('/pricing uses the shared landing-doc route, hosted and local', () => {
  assert(/const PRICING_SLUG = 'tdoc-pricing'/.test(worker), 'PRICING_SLUG missing');
  assert(/if \(p === '\/pricing'[\s\S]*?landingResponse\(env, req, PRICING_SLUG\)/.test(worker), '/pricing does not use landingResponse');
  assert(/if \(p === '\/pricing'[\s\S]*?Location: `\/d\/tdoc-pricing\/v\/\$\{latest\}`/.test(server), 'local /pricing alias missing');
  assert(/upload tdoc-pricing\s+landing\/tdoc-pricing 1/.test(workflow), 'publish-landing does not ship the pricing doc');
});

t('free team limit matches TEAM_FREE_DOCS and its warning', () => {
  const free = num(/const TEAM_FREE_DOCS = (\d+);/);
  const warn = num(/const TEAM_FREE_WARN_LEFT = (\d+);/);
  assert(free > 0 && warn > 0, 'worker constants not found');
  assert(text.includes(`${free} team docs`), `page does not say ${free} team docs`);
  assert(text.includes(`${free + 1}st doc`) || text.includes(`${free + 1}th doc`), 'page does not name the first doc that needs the plan');
  assert(text.includes(`warning at ${free - warn}`), `page does not say the warning comes at ${free - warn}`);
});

t('personal limits match the hosted default and the self-serve cap', () => {
  const base = num(/: (\d+);\s*\n\}\s*\n\s*\n\/\/ Self-serve bump/);
  const cap = num(/const QUOTA_BUMP_CAP = (\d+);/);
  assert(base > 0 && cap > 0, 'worker quota constants not found');
  assert(text.includes(`${base} docs, and up to ${cap} on request`), `page does not say ${base} docs, up to ${cap} on request`);
});

t('prices match TEAM_SEAT_PRICE_USD and agents take no seat', () => {
  const prices = worker.match(/const TEAM_SEAT_PRICE_USD = \{ month: (\d+), year: (\d+) \}/);
  assert(prices, 'TEAM_SEAT_PRICE_USD not found');
  assert(html.includes(`<div class="price">$${prices[1]}</div>`), `page month price is not $${prices[1]}`);
  assert(text.includes(`$${prices[2]} per member a year`), `page year price is not $${prices[2]}`);
  assert(/Agents are free; only people take a seat/.test(text), 'page does not say agents take no seat');
});

t('the homepage footer links to /pricing', () => {
  const lmeta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
  const lv = lmeta.versions[lmeta.versions.length - 1].n;
  const home = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', `v${lv}`, 'index.html'), 'utf8');
  assert(/<footer>[\s\S]*href="\/pricing"[\s\S]*<\/footer>/.test(home), 'homepage footer has no /pricing link');
});

t('navigation and SEO', () => {
  assert(/class="back" href="\/"/.test(html), 'back link missing');
  assert(/rel="canonical" href="https:\/\/tdoc\.dev\/pricing"/.test(html) && /property="og:title"/.test(html), 'SEO head incomplete');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
