// The @agent control (SendToAgentToggle, shell/src/document/agent-ask.jsx),
// rendered: hidden for somebody who may never send here (SEND_TO_AGENT_WHO:
// a reader, a commenter on someone else's doc, a signed-out visitor), kept
// -- disabled, with its reason -- for somebody who may send but cannot yet
// (no team daemon, team admin only, no team agent, an agent that may not
// write, Finding your agents… while it loads). Dogfood 2026-11-20.
// Run with: node test/send-to-agent-visibility-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

(async () => {
  console.log('@agent: hidden only for who may never send');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-agent-toggle-'));
  const entry = path.join(dir, 'entry.jsx');
  fs.writeFileSync(entry, `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { SendToAgentToggle } from ${JSON.stringify(path.join(ROOT, 'shell/src/document/agent-ask.jsx'))};
    import { SEND_TO_AGENT_WHO, sendToAgentSetup } from ${JSON.stringify(path.join(ROOT, 'shell/src/document/agent-choices.js'))};
    export { SEND_TO_AGENT_WHO, sendToAgentSetup };
    export function render(agents) {
      const ask = { agents, choices: agents.choices || [], target: null, putDefault() {} };
      return renderToStaticMarkup(React.createElement(SendToAgentToggle, { ask }));
    }
  `);
  const out = path.join(dir, 'out.cjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, jsx: 'automatic', logLevel: 'silent', nodePaths: [path.join(ROOT, 'node_modules')], loader: { '.js': 'jsx' } });
  const m = require(out);
  const render = ({ may, targets = { ready: true, reason: null }, canSendToAgent = false, choices = [] }) => {
    const { setupHref, disabledReason } = m.sendToAgentSetup({ canSendToAgent, may, notifyOn: true, targets, href: may ? '/me?view=settings#agents' : null });
    return m.render({ canSendToAgent, choices, sendToAgentDisabledReason: disabledReason, agentSetupHref: setupHref, connectAgentPrompt: null });
  };

  t('may never send (reader, commenter, signed out): no @agent at all', () => {
    assert.equal(render({ may: false }), '');
    assert.equal(render({ may: false, targets: { ready: false } }), '');
  });

  t('may send, still loading: a disabled @agent that says "Finding your agents…"', () => {
    const html = render({ may: true, targets: { ready: false } });
    assert.match(html, /<button[^>]*disabled/);
    assert.match(html, /Finding your agents/);
  });

  for (const reason of ['no_team_daemon', 'team_admin_only', 'no_team_agent', 'team_agent_not_writer']) {
    t(`may send, blocked (${reason}): the disabled @agent stays, with its reason`, () => {
      const html = render({ may: true, targets: { ready: true, reason } });
      assert.match(html, /<button[^>]*disabled/, html);
      assert.match(html, /title="[^"]+"/, html);
      assert.ok(!html.includes(m.SEND_TO_AGENT_WHO), 'the reader sentence for a permitted person');
    });
  }

  t('may send, nobody linked: the connect link', () => {
    const html = render({ may: true, targets: { ready: true, reason: 'no_agent_bound' } });
    assert.match(html, /<a[^>]*href="\/me\?view=settings#agents"/, html);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nPASS');
})().catch((e) => { console.error(e); process.exit(1); });
