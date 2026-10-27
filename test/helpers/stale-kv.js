// Shared by the folder tests: a KV whose folder blobs read stale.

// Workers KV as seen from an edge that cached a folder blob: after a put, the
// next `reads` gets of that key still return what was there before it.
function staleFolders(kv, reads) {
  const lag = new Map();
  const stale = (k) => /^(team-)?folders:/.test(k);
  const get = kv.get.bind(kv);
  const put = kv.put.bind(kv);
  kv.get = async (k) => {
    const l = lag.get(k);
    if (l && l.reads > 0) { l.reads -= 1; kv.gets.push(k); return l.prev; }
    return get(k);
  };
  kv.put = async (k, v, opts) => {
    if (stale(k)) lag.set(k, { prev: await kv.get(k), reads });
    if (lag.has(k)) lag.get(k).reads = reads;
    return put(k, v, opts);
  };
  kv.settle = () => lag.clear();
  kv.truth = async (k) => { const raw = await get(k); return raw ? JSON.parse(raw) : null; };
  return kv;
}

module.exports = { staleFolders };
