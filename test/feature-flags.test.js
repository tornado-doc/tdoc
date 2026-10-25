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

  t('grids and the profile read the flag, not dev mode directly', () => {
    const fs = require('fs');
    const rows = fs.readFileSync(require.resolve('../shell/src/docs-hub/rows.jsx'), 'utf8');
    const profile = fs.readFileSync(require.resolve('../shell/src/profile.jsx'), 'utf8');
    assert.ok(rows.includes("isFeatureOn('docThumbnails')"), 'rows.jsx gates the grid thumbnail');
    assert.ok(profile.includes("isFeatureOn('docThumbnails')"), 'profile.jsx gates the card thumbnail');
  });

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
