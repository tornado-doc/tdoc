// Host-runtime detection + agent identity (logos without agents passing login).
// Extracts logoForAgentLogin / detectAgentRuntime / agentIdentity from worker.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
function fn(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`fn ${name} not found`);
  // Skip the parameter list (default values like `body = {}` contain braces)
  // before matching the function body.
  let i = src.indexOf('(', s), pd = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  return src.slice(s, i);
}

const box = {};
vm.createContext(box);
vm.runInContext([
  fn('isAnthropicCompanyMark'),
  fn('logoForAgentLogin'),
  fn('isGenericAgentLogin'),
  fn('detectAgentRuntime'),
  fn('agentIdentity'),
].join('\n\n'), box);

const { isAnthropicCompanyMark, logoForAgentLogin, isGenericAgentLogin, detectAgentRuntime, agentIdentity } = box;

console.log('agent-runtime (auto-detect host logos)');

t('detects grok / claude / codex / cursor / gemini from session env', () => {
  assert(detectAgentRuntime({ GROK_SESSION_ID: 's' }).login === 'grok', 'grok');
  assert(detectAgentRuntime({ CLAUDE_SESSION_ID: 's' }).login === 'claude', 'claude');
  assert(detectAgentRuntime({ CLAUDE_CODE: '1' }).name === 'Claude', 'claude name');
  assert(detectAgentRuntime({ CODEX_SESSION_ID: 's' }).login === 'codex', 'codex');
  assert(detectAgentRuntime({ CURSOR_TRACE_ID: 's' }).login === 'cursor', 'cursor');
  assert(detectAgentRuntime({ GEMINI_CLI: '1' }).login === 'gemini', 'gemini');
  assert(detectAgentRuntime({}) === null, 'empty');
  assert(detectAgentRuntime({ ANTHROPIC_API_KEY: 'sk' }) === null, 'api key is not a host');
});

t('grok wins over a leftover CODEX_HOME in the same env', () => {
  const d = detectAgentRuntime({ GROK_AGENT: '1', CODEX_HOME: '/Users/x/.codex' });
  assert(d && d.login === 'grok', `got ${d && d.login}`);
});

t('generic logins are treated as missing so detect can fill them', () => {
  assert(isGenericAgentLogin('tdoc-agent'));
  assert(isGenericAgentLogin('agent'));
  assert(isGenericAgentLogin(''));
  assert(!isGenericAgentLogin('claude'));
  assert(!isGenericAgentLogin('codex-pm'));
});

t('agentIdentity prefers an explicit non-generic login over detect', () => {
  const a = agentIdentity(
    { agent_login: 'codex-pm', agent_name: 'Codex PM' },
    { GROK_SESSION_ID: 's' },
  );
  assert(a.login === 'codex-pm' && a.name === 'Codex PM', JSON.stringify(a));
  assert(a.avatar_url && a.avatar_url.includes('openai'), a.avatar_url);
});

t('agentIdentity fills from detect when login is missing or generic', () => {
  const missing = agentIdentity({ text: 'hi' }, { CLAUDE_SESSION_ID: 'abc' });
  assert(missing.login === 'claude' && missing.name === 'Claude', JSON.stringify(missing));
  assert(missing.avatar_url.includes('claude') && !missing.avatar_url.includes('anthropic'), missing.avatar_url);

  const generic = agentIdentity({ agent_login: 'tdoc-agent', agent_name: 'tdoc-agent' }, { GROK_AGENT: '1' });
  assert(generic.login === 'grok' && generic.name === 'Grok', JSON.stringify(generic));
  assert(generic.avatar_url.includes('xai-org'), generic.avatar_url);
});

t('TDOC_AGENT_LOGIN is the last fallback before tdoc-agent', () => {
  const a = agentIdentity({}, { TDOC_AGENT_LOGIN: 'cursor', TDOC_AGENT_NAME: 'Cursor' });
  assert(a.login === 'cursor' && a.name === 'Cursor', JSON.stringify(a));
  const bare = agentIdentity({}, {});
  assert(bare.login === 'tdoc-agent', JSON.stringify(bare));
  assert(String(bare.avatar_url).startsWith('data:image/svg+xml'), JSON.stringify(bare));
});

t('logoForAgentLogin maps each product, Claude is not Anthropic', () => {
  assert(logoForAgentLogin('grok').includes('xai-org'));
  assert(logoForAgentLogin('claude').includes('claude'));
  assert(!logoForAgentLogin('claude').includes('anthropic'));
  assert(logoForAgentLogin('codex').includes('openai'));
  assert(logoForAgentLogin('cursor').includes('cursor'));
  assert(logoForAgentLogin('gemini').includes('gemini'));
  assert(String(logoForAgentLogin('tdoc-agent')).startsWith('data:image/svg+xml'), 'tdoc lightning');
  assert(String(logoForAgentLogin('mystery-bot')).startsWith('data:image/svg+xml'), 'unmatched');
});

t('agentIdentity drops a stored Anthropic company mark', () => {
  assert(isAnthropicCompanyMark('https://github.com/anthropics.png'));
  const a = agentIdentity({
    agent_login: 'claude',
    agent_avatar_url: 'https://github.com/anthropics.png',
  }, {});
  assert(a.login === 'claude', JSON.stringify(a));
  assert(a.avatar_url === 'https://cdn.simpleicons.org/claude/d97757', a.avatar_url);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
