// The feature-flag registry: every flag is described the same way, a flag that
// is not on by default is on only in dev mode, and unknown names are off.
const assert = require('assert/strict');

(async () => {
  console.log('feature flags');
  const { FLAGS, isFeatureOn, devOnlyFlags } = await import('../shell/src/feature-flags.js');
  let failed = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };

  t('every flag has a label, an owner, a date added and a boolean default', () => {
    assert.ok(Object.keys(FLAGS).length > 0);
    for (const [name, flag] of Object.entries(FLAGS)) {
      assert.match(name, /^[a-z][A-Za-z0-9]*$/, `${name}: camelCase name`);
      assert.equal(typeof flag.label, 'string', `${name}: label`);
      assert.ok(flag.label.trim(), `${name}: label`);
      assert.ok(typeof flag.owner === 'string' && flag.owner, `${name}: owner`);
      assert.match(flag.added, /^\d{4}-\d{2}-\d{2}$/, `${name}: added`);
      assert.equal(typeof flag.default, 'boolean', `${name}: default`);
    }
    assert.ok(Object.isFrozen(FLAGS) && Object.isFrozen(FLAGS.askEditV2), 'registry is read-only');
  });

  t('a default-off flag is on only when dev mode is on', () => {
    assert.equal(FLAGS.sheetEmbeds.default, false);
    assert.equal(isFeatureOn('sheetEmbeds', null), false, 'not on the allow-list');
    assert.equal(isFeatureOn('sheetEmbeds', { on: false }), false, 'dev mode off');
    assert.equal(isFeatureOn('sheetEmbeds', { on: true }), true, 'dev mode on');
    assert.equal(isFeatureOn('sheetEmbeds'), false, 'no window, no boot: off');
  });

  t('every default-off (dev-mode) flag has a graduate_by date (AGENTS.md)', () => {
    for (const [name, flag] of Object.entries(FLAGS)) {
      if (flag.default === true) continue;
      assert.equal(typeof flag.graduate_by, 'string', `${name}: a dev-mode flag needs graduate_by: 'YYYY-MM-DD' (added + 7 days by default)`);
      assert.match(flag.graduate_by, /^\d{4}-\d{2}-\d{2}$/, `${name}: graduate_by is YYYY-MM-DD`);
      assert.ok(!Number.isNaN(Date.parse(`${flag.graduate_by}T00:00:00Z`)), `${name}: graduate_by is a real date`);
      assert.ok(flag.graduate_by >= flag.added, `${name}: graduate_by is not before added`);
    }
  });

  t('the obsolete docThumbnails flag and its code path are gone', () => {
    const fs = require('fs');
    assert.equal(Object.prototype.hasOwnProperty.call(FLAGS, 'docThumbnails'), false);
    for (const file of ['../shell/src/docs-hub/rows.jsx', '../shell/src/profile.jsx']) {
      assert.ok(!fs.readFileSync(require.resolve(file), 'utf8').includes('docThumbnails'), `${file} no longer reads docThumbnails`);
    }
  });

  t('unknown names, and inherited keys, are off even in dev mode', () => {
    assert.equal(isFeatureOn('noSuchFlag', { on: true }), false);
    assert.equal(isFeatureOn('toString', { on: true }), false);
    assert.equal(isFeatureOn('__proto__', { on: true }), false);
  });

  t('the menu lists the default-off flags by label', () => {
    const listed = devOnlyFlags();
    assert.deepEqual(listed.map((flag) => flag.name), Object.keys(FLAGS).filter((name) => FLAGS[name].default !== true));
    assert.ok(listed.some((flag) => flag.label === 'Ask AI edits the doc (inline suggestions)'));
  });

  t('graduated flags (2026-11-16) are on for everyone, not listed as dev-only', () => {
    const graduated = ['agentProgress', 'myDocsA', 'fullTextSearch', 'autoReadComments', 'writeWithTdocAi', 'feedbackAreaSelect', 'feedbackDocFramePick'];
    for (const name of graduated) {
      assert.equal(FLAGS[name].default, true, `${name}: default true`);
      assert.equal(isFeatureOn(name, null), true, `${name}: on with dev mode off`);
      assert.ok(!devOnlyFlags().some((flag) => flag.name === name), `${name}: not dev-only`);
    }
    const fs = require('fs');
    const hub = fs.readFileSync(require.resolve('../shell/src/docs-hub.jsx'), 'utf8');
    assert.ok(hub.includes("isFeatureOn('myDocsA')"), 'docs-hub.jsx reads myDocsA (the off switch)');
    assert.ok(hub.includes("isFeatureOn('fullTextSearch')"), 'docs-hub.jsx gates the text results');
  });

  t('sheets import and editing are on for everyone, read by the hub and the sheet view', () => {
    assert.equal(FLAGS.sheets.default, true);
    assert.equal(isFeatureOn('sheets', null), true, 'dev mode off: on');
    assert.ok(!devOnlyFlags().some((flag) => flag.name === 'sheets'), 'not listed as dev-only');
    const fs = require('fs');
    assert.ok(fs.readFileSync(require.resolve('../shell/src/docs-hub.jsx'), 'utf8').includes("isFeatureOn('sheets')"), 'docs-hub.jsx reads the flag');
    assert.ok(fs.readFileSync(require.resolve('../shell/src/document/sheet-view.js'), 'utf8').includes("isFeatureOn('sheets')"), 'sheet-view.js reads the flag');
  });

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
