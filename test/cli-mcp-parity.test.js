// CLI + MCP parity (AGENTS.md): every capability is one HTTP endpoint in the
// worker; MCP tools and CLI commands are thin wrappers over it. This test
// keeps the map honest: every MCP tool names the HTTP route(s) it calls in
// process (mcpApi), each route is a real worker route, and each tool names
// the CLI command that reaches the same capability -- or says why there is
// none (an allowlisted exception).
// Run with: node test/cli-mcp-parity.test.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');

let pass = 0, fail = 0;
function t(n, fn) {
  try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// tool -> { http: routes it calls, cli: the bin command (null + why when none) }.
// A new MCP tool fails this test until it is added here.
const PARITY = {
  get_writing_guide: { http: [], cli: null, why: 'local content: the CLI reads authoring/ from the skill directly' },
  create_doc: { http: ['/api/upload'], cli: 'tdoc-publish' },
  update_doc: { http: ['/api/upload'], cli: 'tdoc-publish' },
  edit_doc: { http: ['/api/upload'], cli: 'tdoc-publish' },
  create_upload: { http: ['/api/upload'], cli: 'tdoc-publish' },
  commit_upload: { http: ['/api/upload'], cli: 'tdoc-publish' },
  get_doc: { http: [], cli: 'tdoc-pull', why: 'reads the public document routes (/d/<slug>/...)' },
  list_docs: { http: ['/api/me'], cli: 'tdoc-me' },
  get_comments: { http: ['/api/comments'], cli: 'tdoc-pull' },
  reply_to_comment: { http: ['/api/agent/reply'], cli: 'tdoc-agent-reply' },
  resolve_comment: { http: ['/api/comments', '/api/notify/resolve'], cli: 'tdoc-agent-reply' },
  answer_question: { http: ['/api/agent/ask-reply'], cli: 'tdoc-agent-reply' },
  share_doc: { http: ['/api/doc/access'], cli: 'tdoc-publish', why: 'tdoc-publish --visibility / --allow-user sets access with the upload' },
  create_feedback_space: { http: ['/api/feedback/spaces'], cli: 'tdoc-feedback', strict: true },
};

function toolBlocks() {
  const block = worker.slice(worker.indexOf('const MCP_TOOLS = {'), worker.indexOf('const MCP_CAPABILITIES'));
  const heads = [...block.matchAll(/^  ([a-z_]+): \{$/gm)];
  return Object.fromEntries(heads.map((m, i) => [m[1], block.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : undefined)]));
}

console.log('CLI + MCP parity');
const blocks = toolBlocks();

t('every MCP tool is in the parity map, and the map names no tool that is gone', () => {
  const served = Object.keys(blocks).sort().join(',');
  const mapped = Object.keys(PARITY).sort().join(',');
  assert(served === mapped, `served: ${served}\n    mapped: ${mapped}\n    add the new tool to PARITY with its HTTP route and CLI command`);
});

// A route is `p === '<route>'`, or one of the `p.match(/^...$/)` patterns.
const routePatterns = [...worker.matchAll(/\bp\.match\(\/(\^[^\n]*?\$)\/\)/g)].map((m) => { try { return new RegExp(m[1]); } catch { return null; } }).filter(Boolean);
const isRoute = (route) => worker.includes(`p === '${route}'`) || routePatterns.some((re) => re.test(route));

t('each mapped HTTP route is a worker route', () => {
  for (const [tool, p] of Object.entries(PARITY)) {
    for (const route of p.http) assert(isRoute(route), `${tool}: no worker route ${route}`);
  }
});

t('each tool with a direct route calls it through mcpApi (in process, same rules as HTTP)', () => {
  for (const [tool, p] of Object.entries(PARITY)) {
    const direct = [...blocks[tool].matchAll(/mcpApi\(call, '[A-Z]+', [`']([^`'?$]+)/g)].map((m) => m[1]);
    for (const route of direct) {
      if (route.startsWith('/d/')) continue;
      assert(p.http.includes(route), `${tool} calls ${route}, which its PARITY entry does not name`);
    }
  }
});

t('each CLI counterpart exists; an exception says why', () => {
  for (const [tool, p] of Object.entries(PARITY)) {
    if (!p.cli) { assert(p.why, `${tool}: no CLI and no reason`); continue; }
    assert(fs.existsSync(path.join(root, 'bin', p.cli)), `${tool}: bin/${p.cli} missing`);
  }
});

t('strict pairs: the tool and the CLI call the same one endpoint and hold no logic of their own', () => {
  for (const [tool, p] of Object.entries(PARITY)) {
    if (!p.strict) continue;
    const cli = fs.readFileSync(path.join(root, 'bin', p.cli), 'utf8');
    for (const route of p.http) assert(cli.includes(route), `bin/${p.cli} does not call ${route}`);
    assert(p.http.length === 1, `${tool}: one endpoint`);
    const block = blocks[tool];
    assert(!/loadDocMeta|env\.META|createDoc/.test(block), `${tool} reaches storage itself instead of through ${p.http[0]}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
