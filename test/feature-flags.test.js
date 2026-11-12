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
    assert.ok(Object.isFrozen(FLAGS) && Object.isFrozen(FLAGS.docThumbnails), 'registry is read-only');
  });

  t('doc thumbnails are a dev-mode-only flag for now', () => {
    assert.equal(FLAGS.docThumbnails.default, false);
    assert.equal(FLAGS.docThumbnails.label, 'Doc thumbnails');
  });

  t('a default-off flag is on only when dev mode is on', () => {
    assert.equal(isFeatureOn('docThumbnails', null), false, 'not on the allow-list');
    assert.equal(isFeatureOn('docThumbnails', { on: false }), false, 'dev mode off');
    assert.equal(isFeatureOn('docThumbnails', { on: true }), true, 'dev mode on');
    assert.equal(isFeatureOn('docThumbnails'), false, 'no window, no boot: off');
  });

  t('unknown names, and inherited keys, are off even in dev mode', () => {
    assert.equal(isFeatureOn('noSuchFlag', { on: true }), false);
    assert.equal(isFeatureOn('toString', { on: true }), false);
    assert.equal(isFeatureOn('__proto__', { on: true }), false);
  });

  t('the menu lists the default-off flags by label', () => {
    const listed = devOnlyFlags();
    assert.deepEqual(listed.map((flag) => flag.name), Object.keys(FLAGS).filter((name) => FLAGS[name].default !== true));
    assert.ok(listed.some((flag) => flag.label === 'Doc thumbnails'));
  });

  t('myDocsA (layout A) is a dev-mode flag, read by the hub', () => {
    assert.equal(FLAGS.myDocsA.default, false);
    assert.equal(isFeatureOn('myDocsA', null), false);
    assert.equal(isFeatureOn('myDocsA', { on: true }), true);
    assert.ok(devOnlyFlags().some((flag) => flag.name === 'myDocsA'));
    const hub = require('fs').readFileSync(require.resolve('../shell/src/docs-hub.jsx'), 'utf8');
    assert.ok(hub.includes("isFeatureOn('myDocsA')"), 'docs-hub.jsx reads the flag');
  });

  t('grids and the profile read the flag, not dev mode directly', () => {
    const fs = require('fs');
    const rows = fs.readFileSync(require.resolve('../shell/src/docs-hub/rows.jsx'), 'utf8');
    const profile = fs.readFileSync(require.resolve('../shell/src/profile.jsx'), 'utf8');
    assert.ok(rows.includes("isFeatureOn('docThumbnails')"), 'rows.jsx gates the grid thumbnail');
    assert.ok(profile.includes("isFeatureOn('docThumbnails')"), 'profile.jsx gates the card thumbnail');
  });

  t('full-text search results are a dev-mode-only flag, read by the hub', () => {
    assert.equal(FLAGS.fullTextSearch.default, false);
    assert.equal(isFeatureOn('fullTextSearch', null), false);
    assert.equal(isFeatureOn('fullTextSearch', { on: true }), true);
    const hub = require('fs').readFileSync(require.resolve('../shell/src/docs-hub.jsx'), 'utf8');
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
