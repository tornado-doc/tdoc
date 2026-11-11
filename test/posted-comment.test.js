// The POST's answer merged into the list a surface holds
// (shell/src/comments/core/posted-comment.js): what every comment surface
// shows the moment a comment or reply is saved, before the re-read.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

(async () => {
    // No bundler in the offline job: the module as a data URL.
  const src = fs.readFileSync(path.join(__dirname, '..', 'shell/src/comments/core/posted-comment.js'), 'utf8');
  const { withPostedComment } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  let pass = 0;
  const t = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
  console.log('posted comment merge');
  const root = { id: 'c_1', text: 'Root', author: { login: 'a' }, replies: [{ id: 'r_1', text: 'First', parent_id: 'c_1' }] };

  t('a new thread is appended with its fields, without the response-only ones', () => {
    const made = { id: 'c_2', text: 'New', author: { login: 'b' }, anchor: { kind: 'product' }, replies: [], mention_outcome: { notified: [] } };
    const next = withPostedComment([root], made);
    assert.equal(next.length, 2);
    assert.equal(next[1].text, 'New');
    assert.equal(next[1].mention_outcome, undefined);
    assert.deepEqual(next[1].anchor, { kind: 'product' });
  });
  t('a reply joins its thread (thread_id), once', () => {
    const made = { id: 'r_2', parent_id: 'r_1', thread_id: 'c_1', text: 'Second', author: { login: 'b' } };
    const next = withPostedComment([root], made, 'r_1');
    assert.deepEqual(next[0].replies.map((r) => r.id), ['r_1', 'r_2']);
    assert.equal(next[0].replies[1].parent_id, 'r_1');
    assert.equal(next[0].replies[1].thread_id, undefined);
    assert.strictEqual(withPostedComment(next, made, 'r_1'), next, 'a second merge adds a twin');
  });
  t('a reply to a reply finds its root without thread_id', () => {
    const next = withPostedComment([root], { id: 'r_3', text: 'x' }, 'r_1');
    assert.deepEqual(next[0].replies.map((r) => r.id), ['r_1', 'r_3']);
  });
  t('a duplicate answer (duplicate_of) or an unknown parent leaves the list as it was', () => {
    const list = [root];
    assert.strictEqual(withPostedComment(list, { id: 'c_1', duplicate_of: 'c_1', text: 'Root' }), list);
    assert.strictEqual(withPostedComment(list, { id: 'r_9', text: 'x' }, 'nope'), list);
    assert.strictEqual(withPostedComment(list, null), list);
    assert.deepEqual(withPostedComment(null, { id: 'c_5', text: 'x' }).map((c) => c.id), ['c_5']);
  });
  console.log(`\n${pass} passed, 0 failed`);
})().catch((error) => { console.log(`  ✗ ${error.message}`); process.exit(1); });
