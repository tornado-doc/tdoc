// What the quick-connect dialogs (quick-connect.jsx) show, with no React, so
// tests can run it in Node: the platforms in their order, the setup prompt,
// and the install commands read from the table under "Install tdoc in your
// AI app" in plugins/README.md. That table is the one place a command
// changes; quick-connect.jsx imports the README as text at build time.

// Row label -> { code: [every `inline code`], links: [every (https://...)] }.
export function parseInstallTable(markdown) {
  const rows = {};
  const start = markdown.indexOf('## Install tdoc in your AI app');
  if (start < 0) return rows;
  const section = markdown.slice(start).split(/\n(?=## |---)/)[0];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    // | label | one line |  ->  ['', label, one line, '']
    if (cells.length < 4 || !cells[1] || cells[1] === 'App' || /^-+$/.test(cells[1])) continue;
    const text = cells.slice(2, -1).join('|');
    rows[cells[1]] = {
      code: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      links: [...text.matchAll(/\]\((https:[^)\s]+)\)/g)].map((m) => m[1]),
    };
  }
  return rows;
}

// The first command of a row, with the production MCP URL swapped for this
// host's (PR previews, a local worker). Empty when the row is missing.
export function installCommand(rows, label, mcpUrl = 'https://tdoc.dev/mcp') {
  const row = rows[label];
  const first = row && row.code[0];
  return first ? first.split('https://tdoc.dev/mcp').join(mcpUrl) : '';
}

export function setupPrompt(origin = typeof location !== 'undefined' ? location.origin : 'https://tdoc.dev') {
  return `set up ${origin}/SKILL.md`;
}

export const PLATFORMS = Object.freeze([
  { id: 'claude', name: 'Claude', cost: 'plugin', note: 'claude.ai · Cowork · Claude Code' },
  { id: 'claude-code', name: 'Claude Code', cost: 'plugin' },
  { id: 'codex', name: 'Codex', cost: 'plugin' },
  { id: 'gemini', name: 'Gemini CLI', cost: 'extension' },
  { id: 'cursor', name: 'Cursor', cost: '1 click' },
  { id: 'vscode', name: 'VS Code', cost: '1 command' },
  { id: 'chatgpt', name: 'ChatGPT', cost: '~2 min, paid' },
]);

// The likely platform first: the page that sent the visitor here, else the
// app the browser runs in. Everything else keeps its order.
export function orderPlatforms({ referrer = '', userAgent = '' } = {}) {
  let first = null;
  if (/chatgpt\.com|chat\.openai\.com/i.test(referrer)) first = 'chatgpt';
  else if (/claude\.ai/i.test(referrer)) first = 'claude';
  else if (/\bCursor\//.test(userAgent)) first = 'cursor';
  else if (/\bCode\/\d/.test(userAgent)) first = 'vscode';
  if (!first) return PLATFORMS.slice();
  return [...PLATFORMS.filter((p) => p.id === first), ...PLATFORMS.filter((p) => p.id !== first)];
}

// A /start?connect=<value> asks for a platform; the old homepage links say
// claude, chatgpt, cursor, vscode, codex, gemini.
export function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}
