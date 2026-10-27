const crypto = require('crypto');

// Keep the timestamp for readable IDs, but don't rely on its millisecond
// precision: two comments can be saved before Date.now() changes.
function commentId(kind, now = Date.now()) {
  return `${kind}_${now}_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { commentId };
