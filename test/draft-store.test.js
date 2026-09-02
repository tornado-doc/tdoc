const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) {
  const run = async () => fn();
  return run().then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch((error) => { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; });
}

const memory = new Map();
const box = {
  window: { indexedDB: null },
  localStorage: {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); },
  },
  Date,
  JSON,
  Map,
  Set,
  Promise,
  console,
};
vm.createContext(box);
const src = fs.readFileSync(path.join(__dirname, '../shell/src/document/draft-store.js'), 'utf8')
  .replace(/^export /gm, '');
vm.runInContext(`${src}\nthis.api = { DRAFT_MAX_AGE_MS, draftBodyExpired, draftKey, formatDraftAge, htmlHash, legacyDraftKey, loadDraft, saveDraft, saveDraftMode, clearDraftBody, clearDraft };`, box);
const {
  DRAFT_MAX_AGE_MS,
  draftBodyExpired,
  draftKey,
  formatDraftAge,
  htmlHash,
  legacyDraftKey,
  loadDraft,
  saveDraft,
  saveDraftMode,
  clearDraftBody,
  clearDraft,
} = box.api;

console.log('draft-store per-doc cache');

(async () => {
  await t('draft keys are per document, not per version and not global', () => {
    const a = { slug: 'plan', version: 1, identity: { login: 'ada' } };
    const b = { slug: 'plan', version: 2, identity: { login: 'ada' } };
    const c = { slug: 'other', version: 1, identity: { login: 'ada' } };
    assert.strictEqual(draftKey(a), 'plan:ada');
    assert.strictEqual(draftKey(a), draftKey(b));
    assert.notStrictEqual(draftKey(a), draftKey(c));
    assert.strictEqual(legacyDraftKey(a), 'plan:v1:ada');
    assert.notStrictEqual(legacyDraftKey(a), legacyDraftKey(b));
  });

  await t('htmlHash is stable and changes when the published bytes change', () => {
    assert.strictEqual(htmlHash('<p>a</p>'), htmlHash('<p>a</p>'));
    assert.notStrictEqual(htmlHash('<p>a</p>'), htmlHash('<p>b</p>'));
  });

  await t('a matching baseHash is the silent-restore case; a mismatch is stale', async () => {
    const key = 'doc:ada';
    await saveDraft(key, '<p>draft</p>', { baseHash: htmlHash('<p>pub</p>'), baseVersion: 1 });
    const record = await loadDraft(key);
    assert.strictEqual(record.bodyHtml, '<p>draft</p>');
    assert.strictEqual(record.baseHash, htmlHash('<p>pub</p>'));
    assert.strictEqual(record.baseVersion, 1);
    assert.strictEqual(record.baseHash === htmlHash('<p>pub</p>'), true);
    assert.strictEqual(record.baseHash === htmlHash('<p>new</p>'), false);
  });

  await t('a draft reaches synchronous storage before its async write settles', async () => {
    const key = 'instant:ada';
    const pending = saveDraft(key, '<p>last keystroke</p>', { baseHash: 'abc', baseVersion: 4 });
    const immediate = JSON.parse(memory.get('tdoc-draft:instant:ada'));
    assert.strictEqual(immediate.bodyHtml, '<p>last keystroke</p>');
    assert.strictEqual(immediate.baseVersion, 4);
    await pending;
    await clearDraft(key);
  });

  await t('mode is stored on the same per-doc record as the body', async () => {
    const key = 'doc:ada';
    await saveDraftMode(key, 'edit');
    const record = await loadDraft(key);
    assert.strictEqual(record.mode, 'edit');
    assert.strictEqual(record.bodyHtml, '<p>draft</p>');
  });

  await t('clearing the body keeps last mode', async () => {
    const key = 'doc:ada';
    await clearDraftBody(key);
    const record = await loadDraft(key);
    assert.strictEqual(record.mode, 'edit');
    assert.strictEqual(record.bodyHtml, undefined);
  });

  await t('a legacy per-version key is adopted into the per-doc key', async () => {
    memory.set('tdoc-draft:notes:v3:ada', JSON.stringify({
      bodyHtml: '<p>old</p>', updatedAt: Date.now(),
    }));
    const record = await loadDraft('notes:ada', 'notes:v3:ada');
    assert.strictEqual(record.bodyHtml, '<p>old</p>');
    assert.strictEqual(memory.get('tdoc-draft:notes:v3:ada'), undefined);
    assert.ok(memory.get('tdoc-draft:notes:ada'));
  });

  await t('bodies older than 30 days expire; mode-only records do not', () => {
    const now = Date.now();
    assert.strictEqual(draftBodyExpired({
      bodyHtml: '<p>x</p>', bodyUpdatedAt: now - DRAFT_MAX_AGE_MS - 1,
    }, now), true);
    assert.strictEqual(draftBodyExpired({
      bodyHtml: '<p>x</p>', bodyUpdatedAt: now - 1000,
    }, now), false);
    assert.strictEqual(draftBodyExpired({ mode: 'edit', updatedAt: now - DRAFT_MAX_AGE_MS * 2 }, now), false);
  });

  await t('formatDraftAge is what the restore dialog reads out', () => {
    const now = Date.parse('2026-09-02T12:00:00Z');
    assert.strictEqual(formatDraftAge(now - 10_000, now), 'just now');
    assert.strictEqual(formatDraftAge(now - 5 * 60_000, now), '5 minutes ago');
    assert.strictEqual(formatDraftAge(now - 3 * 3600_000, now), '3 hours ago');
    assert.strictEqual(formatDraftAge(now - 30 * 3600_000, now), 'yesterday');
    assert.strictEqual(formatDraftAge(undefined, now), 'recently');
    assert.strictEqual(formatDraftAge('corrupt', now), 'recently');
    assert.strictEqual(formatDraftAge(Number.POSITIVE_INFINITY, now), 'recently');
  });

  await clearDraft('doc:ada');
  await clearDraft('notes:ada');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
