// Quick connect's data (shell/src/quick-connect-data.js): the platforms and
// their order, the setup prompt, and the install commands read from the table
// in plugins/README.md, which stays their one source. The dialogs themselves
// run in a browser in connect-ai-apps-ui.test.js.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

(async () => {
  console.log('quick connect');
  const data = await import('../shell/src/quick-connect-data.js');
  const { FLAGS } = await import('../shell/src/feature-flags.js');
  const ROOT = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(ROOT, 'plugins', 'README.md'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'quick-connect.jsx'), 'utf8');
  const rows = data.parseInstallTable(readme);
  let failed = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };

  t('the flag is dev-only until approved', () => {
    assert.equal(FLAGS.quickConnect.default, false);
  });

  t('the README table parses into rows with their commands', () => {
    assert.equal(rows['Codex CLI, MCP only'].code[0], 'codex mcp add tdoc --url https://tdoc.dev/mcp');
    assert.match(rows.Cursor.links[0], /^https:\/\/cursor\.com\/install-mcp\?/);
    assert.ok(!rows.App && !rows['---'], 'header and rule rows skipped');
  });

  t('every row the dialogs read exists in plugins/README.md', () => {
    const labels = ['Claude Code', 'Claude Code, local CLI', 'Codex CLI', 'Codex CLI, local CLI', 'Gemini CLI', 'VS Code (Copilot)'];
    for (const label of labels) {
      assert.ok(view.includes(`'${label}'`), `quick-connect.jsx no longer reads "${label}"`);
      assert.ok(data.installCommand(rows, label), `no command for "${label}" in plugins/README.md`);
    }
    assert.ok(!/claude plugin install|codex plugin add|gemini extensions|code --add-mcp/.test(view), 'quick-connect.jsx hand-copies a command');
  });

  t('Claude Code and Codex: the local CLI rows install tdoc, the plain rows tdoc Cloud', () => {
    for (const host of ['Claude Code', 'Codex CLI']) {
      assert.match(data.installCommand(rows, `${host}, local CLI`), /tdoc@tornado-tdoc$/, host);
      assert.match(data.installCommand(rows, host), /tdoc-cloud/, host);
    }
  });

  t('installCommand swaps the production MCP URL for this host', () => {
    assert.equal(data.installCommand(rows, 'Codex CLI, MCP only', 'https://pr-1-tdoc-preview.x/mcp'), 'codex mcp add tdoc --url https://pr-1-tdoc-preview.x/mcp');
    assert.equal(data.installCommand(rows, 'No such app'), '');
  });

  t('the Cursor and VS Code buttons build the same config the README documents', () => {
    // connect-ai-apps.jsx: cursor config = base64(JSON.stringify({ url })),
    // VS Code = JSON.stringify({ name, type, url }).
    const cursorConfig = new URL(rows.Cursor.links[0]).searchParams.get('config');
    assert.equal(Buffer.from(cursorConfig, 'base64').toString(), JSON.stringify({ url: 'https://tdoc.dev/mcp' }));
    const vscode = data.installCommand(rows, 'VS Code (Copilot)').match(/'(\{.*\})'/)[1];
    assert.equal(vscode, JSON.stringify({ name: 'tdoc', type: 'http', url: 'https://tdoc.dev/mcp' }));
  });

  t('the setup prompt is the one from the design', () => {
    assert.equal(data.setupPrompt('https://tdoc.dev'), 'set up https://tdoc.dev/SKILL.md');
  });

  t('seven platforms, each labelled with its cost', () => {
    assert.deepEqual(data.PLATFORMS.map((p) => p.name), ['Claude', 'Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'VS Code', 'ChatGPT']);
    for (const p of data.PLATFORMS) assert.ok(p.cost, `${p.id}: cost`);
    assert.equal(data.PLATFORMS[0].note, 'claude.ai · Cowork · Claude Code');
  });

  t('the likely platform goes first, by referrer then user agent', () => {
    const first = (opts) => data.orderPlatforms(opts)[0].id;
    assert.equal(first({}), 'claude');
    assert.equal(first({ referrer: 'https://chatgpt.com/c/123' }), 'chatgpt');
    assert.equal(first({ referrer: 'https://claude.ai/new' }), 'claude');
    assert.equal(first({ userAgent: 'Mozilla/5.0 Cursor/1.2.3 Electron/30' }), 'cursor');
    assert.equal(first({ userAgent: 'Mozilla/5.0 Code/1.95.0 Electron/30' }), 'vscode');
    assert.equal(data.orderPlatforms({ referrer: 'https://chatgpt.com/' }).length, 7);
  });

  t('/start?connect= ids resolve, including the homepage ones', () => {
    for (const id of ['claude', 'chatgpt', 'cursor', 'vscode', 'codex', 'gemini', 'claude-code']) assert.ok(data.platformById(id), id);
    assert.equal(data.platformById('other'), null);
  });

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})();
