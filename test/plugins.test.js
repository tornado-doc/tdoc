// plugins/: the packages that install the remote MCP server in AI apps.
// Offline checks only (no host is contacted): every manifest parses, points
// at https://tdoc.dev/mcp with the transport its host expects, carries the
// repo's VERSION, and the one skill they share is the same file everywhere,
// with SKILL.md's routing description verbatim.
// Run with: node test/plugins.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const dir = path.join(root, 'plugins');
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const VERSION = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const URL_ = 'https://tdoc.dev/mcp';
const frontDescription = (md) => {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert(m, 'no frontmatter');
  const d = m[1].match(/description:\s*>-\n((?:  .*\n?)+)/);
  assert(d, 'no folded description');
  return d[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
};

console.log('plugins/ packages');

t('Claude: plugin.json + .mcp.json (type http)', () => {
  const p = json('claude/.claude-plugin/plugin.json');
  // tdoc-cloud: the repo marketplace already has a plugin named tdoc (the CLI
  // one), and an entry name must equal its plugin.json name.
  assert(p.name === 'tdoc-cloud' && p.version === VERSION, `${p.name} ${p.version}`);
  assert(typeof p.repository === 'string', 'repository is a string (#42)');
  assert(!p.icon || fs.existsSync(path.join(dir, 'claude', p.icon)), 'icon inside the plugin');
  const m = json('claude/.mcp.json');
  assert(m.mcpServers.tdoc.type === 'http' && m.mcpServers.tdoc.url === URL_, JSON.stringify(m));
});

t('Codex / ChatGPT: plugin.json + mcp.json (streamable-http)', () => {
  const p = json('codex/plugin.json');
  assert(p.name === 'tdoc' && p.version === VERSION, `${p.name} ${p.version}`);
  const ui = p.extensions && p.extensions['com.openai'] && p.extensions['com.openai'].interface;
  assert(ui && ui.displayName === 'tdoc', 'OpenAI interface block');
  // OpenAI portal limits (https://developers.openai.com/plugins/deploy/submission)
  assert(ui.displayName.length <= 30 && ui.shortDescription.length <= 30, 'displayName / shortDescription <= 30 chars');
  assert(ui.longDescription.length <= 4000 && ui.developerName.length <= 80, 'longDescription <= 4000, developerName <= 80');
  assert(ui.defaultPrompt.length <= 3 && ui.defaultPrompt.every((x) => x.length <= 128), 'at most 3 starter prompts of 128 chars');
  for (const k of ['logo', 'composerIcon']) assert(!ui[k] || fs.existsSync(path.join(dir, 'codex', ui[k])), `${k} inside the plugin`);
  const m = json('codex/mcp.json');
  assert(m.mcpServers.tdoc.type === 'streamable-http' && m.mcpServers.tdoc.url === URL_, JSON.stringify(m));
});

t('Cursor: .cursor-plugin/plugin.json + mcp.json (url)', () => {
  const p = json('cursor/.cursor-plugin/plugin.json');
  assert(p.name === 'tdoc' && p.version === VERSION, `${p.name} ${p.version}`);
  assert(!p.logo || fs.existsSync(path.join(dir, 'cursor', p.logo)), 'logo inside the plugin');
  assert(json('cursor/mcp.json').mcpServers.tdoc.url === URL_, 'url');
});

t('Gemini CLI: gemini-extension.json (httpUrl = Streamable HTTP) + context file', () => {
  const p = json('gemini/gemini-extension.json');
  assert(p.name === 'tdoc' && p.version === VERSION, `${p.name} ${p.version}`);
  assert(p.mcpServers.tdoc.httpUrl === URL_ && !p.mcpServers.tdoc.url, 'httpUrl, not url (SSE)');
  assert(fs.existsSync(path.join(dir, 'gemini', p.contextFileName)), 'context file exists');
});

t('VS Code: servers.tdoc type http', () => {
  const m = json('vscode/mcp.json');
  assert(m.servers.tdoc.type === 'http' && m.servers.tdoc.url === URL_, JSON.stringify(m));
});

t('one skill, identical in every plugin, with SKILL.md\'s description verbatim and no Bash', () => {
  const copies = ['claude', 'codex', 'cursor', 'gemini'].map((p) => read(`${p}/skills/tdoc/SKILL.md`));
  assert(copies.every((c) => c === copies[0]), 'the plugin skills differ; copy one over the others');
  const main = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  assert(frontDescription(copies[0]) === frontDescription(main), 'description drifted from SKILL.md');
  assert(/^name: tdoc$/m.test(copies[0]), 'name: tdoc');
  assert(!/allowed-tools/.test(copies[0]), 'no tool grants: these hosts may have no terminal');
  for (const tool of ['create_doc', 'update_doc', 'get_doc', 'list_docs', 'get_comments', 'reply_to_comment', 'resolve_comment', 'answer_question', 'share_doc']) {
    assert(copies[0].includes(`\`${tool}\``), `skill names ${tool}`);
  }
});

t('the skill names exactly the tools the worker serves', () => {
  const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  const block = worker.slice(worker.indexOf('const MCP_TOOLS = {'), worker.indexOf('const MCP_CAPABILITIES'));
  const served = [...block.matchAll(/^  ([a-z_]+): \{$/gm)].map((m) => m[1]).sort();
  assert(served.join(',') === 'answer_question,create_doc,get_comments,get_doc,list_docs,reply_to_comment,resolve_comment,share_doc,update_doc', served.join(','));
});

t('README cites sources and marks unverified fields', () => {
  const r = read('README.md');
  assert((r.match(/https:\/\/[^\s)]+/g) || []).length > 10, 'cites the docs');
  assert(/UNVERIFIED/.test(r), 'marks unverified');
});

t('SKILL.md prefers the MCP tools when they are connected; CLI stays the fallback', () => {
  const main = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const section = main.slice(main.indexOf('## When the tdoc MCP tools are available'), main.indexOf('## Document routing'));
  assert(section.length > 200 && /prefer them to the CLI/.test(section) && /CLI stays\s+the fallback/.test(section), 'section missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
