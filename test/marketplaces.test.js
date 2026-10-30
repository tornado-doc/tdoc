// The repo's plugin marketplaces: Claude Code reads .claude-plugin/marketplace.json,
// Codex / ChatGPT read .agents/plugins/marketplace.json, and Cursor reads
// .cursor-plugin/marketplace.json. Each must parse,
// and every entry must point at a folder in this repo that holds the right
// manifest, with the same name as the entry.
//   Claude: https://code.claude.com/docs/en/plugins/marketplace-reference.md
//   Codex:  https://developers.openai.com/plugins/build/plugins
// Run with: node test/marketplaces.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A relative source: starts with ./ (or is "."), no "..", no backslash.
function folder(src, where) {
  assert(typeof src === 'string', `${where}: source path must be a string`);
  assert(src === '.' || src.startsWith('./'), `${where}: "${src}" must start with ./`);
  assert(!src.split('/').includes('..') && !src.includes('\\'), `${where}: "${src}" leaves the repo`);
  const abs = path.resolve(root, src);
  assert(abs === root || abs.startsWith(root + path.sep), `${where}: "${src}" leaves the repo`);
  assert(fs.existsSync(abs) && fs.statSync(abs).isDirectory(), `${where}: folder "${src}" does not exist`);
  return abs;
}

console.log('repo marketplaces');

t('Claude Code: .claude-plugin/marketplace.json lists tdoc (CLI) and tdoc-cloud (remote MCP)', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert(NAME.test(m.name) && m.owner && m.owner.name, 'name + owner.name');
  const names = m.plugins.map((p) => p.name);
  assert(names.join(',') === 'tdoc,tdoc-cloud', names.join(','));
  assert(new Set(names).size === names.length, 'duplicate entry names');
  for (const [i, p] of m.plugins.entries()) {
    assert(NAME.test(p.name), `plugins[${i}].name`);
    const dir = folder(p.source, `plugins[${i}]`);
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    assert(fs.existsSync(manifest), `plugins[${i}]: no .claude-plugin/plugin.json in ${p.source}`);
    const pj = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert(pj.name === p.name, `plugins[${i}]: entry name "${p.name}" != plugin.json name "${pj.name}"`);
  }
  const cloud = m.plugins.find((p) => p.name === 'tdoc-cloud');
  assert(cloud.source === './plugins/claude', 'tdoc-cloud points at plugins/claude');
  const mcp = json('plugins/claude/.mcp.json');
  assert(mcp.mcpServers.tdoc.url === 'https://tdoc.dev/mcp', 'tdoc-cloud ships the remote MCP server');
});

t('Codex / ChatGPT: .agents/plugins/marketplace.json lists tdoc (local CLI, ./) and tdoc-cloud -> plugins/codex, the Claude names', () => {
  const m = json('.agents/plugins/marketplace.json');
  assert(NAME.test(m.name), 'name');
  assert(m.interface && m.interface.displayName, 'interface.displayName');
  assert(Array.isArray(m.plugins) && m.plugins.map((p) => p.name).join(',') === 'tdoc,tdoc-cloud', `plugins: ${m.plugins.map((p) => p.name)}`);
  const claude = json('.claude-plugin/marketplace.json');
  for (const [i, p] of m.plugins.entries()) {
    const src = typeof p.source === 'string' ? p.source : (p.source.source === 'local' && p.source.path);
    const dir = folder(src, `plugins[${i}]`);
    if (p.name === 'tdoc') {
      // The local CLI plugin is the repo root, as in Claude Code: the skill plus bin/.
      const local = claude.plugins.find((c) => c.name === 'tdoc');
      assert(src === './' && local.source === './', 'tdoc -> ./ in both marketplaces');
      assert(fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'bin', 'tdoc-publish')), 'SKILL.md + bin/');
    } else {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      assert(pj.name === p.name, `entry "${p.name}" != plugin.json "${pj.name}"`);
      assert(fs.existsSync(path.join(dir, 'mcp.json')), 'mcp.json');
    }
    assert(p.policy && ['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE'].includes(p.policy.installation), 'policy.installation');
    assert(p.policy.authentication, 'policy.authentication');
    assert(typeof p.category === 'string' && p.category, 'category');
  }
});

t('Cursor: .cursor-plugin/marketplace.json lists tdoc -> plugins/cursor', () => {
  // https://cursor.com/docs/reference/plugins: multi-plugin repos keep this file
  // at the repo root; a source is a path to a folder with .cursor-plugin/plugin.json.
  const m = json('.cursor-plugin/marketplace.json');
  assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name) && m.owner && m.owner.name, 'kebab-case name + owner.name');
  assert(m.plugins.length === 1, 'one plugin');
  const p = m.plugins[0];
  assert(!p.source.startsWith('/') && !p.source.split('/').includes('..'), 'relative path, no ..');
  const dir = path.join(root, p.source);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'));
  assert(pj.name === p.name, `entry "${p.name}" != plugin.json "${pj.name}"`);
  assert(fs.existsSync(path.join(dir, 'mcp.json')), 'mcp.json');
});

t('all three marketplaces share one name, tornado-tdoc', () => {
  const names = ['.claude-plugin', '.agents/plugins', '.cursor-plugin'].map((d) => json(`${d}/marketplace.json`).name);
  assert(new Set(names).size === 1, names.join(','));
});

t('pack.sh builds every upload file and README documents the one-line installs', () => {
  const pack = fs.readFileSync(path.join(root, 'plugins', 'pack.sh'), 'utf8');
  for (const f of ['tdoc-claude.zip', 'tdoc-codex.zip', 'tdoc-cursor.zip', 'tdoc-gemini.tar.gz', 'logo-400.png']) assert(pack.includes(f), f);
  const readme = fs.readFileSync(path.join(root, 'plugins', 'README.md'), 'utf8');
  for (const s of ['claude plugin install tdoc-cloud@tornado-tdoc', 'codex plugin marketplace add tornado-doc/tdoc', 'cursor://anysphere.cursor-deeplink/mcp/install', 'gemini extensions install', 'code --add-mcp']) assert(readme.includes(s), `README: ${s}`);
  const sub = fs.readFileSync(path.join(root, 'plugins', 'SUBMITTING.md'), 'utf8');
  for (const s of ['claude.ai/directory/manage', 'platform.openai.com/plugins', 'cursor.com/marketplace/publish', 'cline/mcp-marketplace', 'gemini-cli-extension']) assert(sub.includes(s), `SUBMITTING: ${s}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
