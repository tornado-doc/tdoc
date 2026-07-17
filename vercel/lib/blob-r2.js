// DOCS (Cloudflare R2) shim over Vercel Blob. The worker uses five R2
// operations: put / get / head / delete / list. We map them onto the
// @vercel/blob SDK, which is injected by the caller (api/tdoc.js) instead of
// imported here — so the offline test suite can exercise this file with a
// fake SDK and no npm install.
//
// Key → pathname is 1:1 (`docs/<slug>/v<N>/index.html`), no random suffix, so
// re-publishing a version overwrites in place like R2.
//
// PRIVACY TRADEOFF (documented in vercel/README.md): Vercel Blob stores are
// public-by-URL. The store hostname contains a random store id and we never
// emit blob URLs to clients (docs are always served THROUGH the function), so
// docs stay link-only in practice — but unlike R2 there is no hard ACL in
// front of the bytes. Don't publish secrets in a doc.

// Resolve a key to its blob record via an exact-pathname list match. We list
// rather than head(pathname) because the SDK's head/del historically accepted
// only full blob URLs; list-by-prefix + exact match works on every SDK
// version and also hands us the URL that get()/delete() need.
//
// The exact `pathname === key` match (not just the prefix) drops
// suffix-extended pathnames that share this prefix, e.g.
// `docs/a/v1/index.html.bak`. Sibling versions (`docs/a/v11/index.html`)
// are already excluded by `list({ prefix: key })` because `key` is the
// full pathname. limit:10 is enough because tdoc never writes longer
// paths under a full-pathname key. If that ever changes, page the list
// instead of raising the limit.
async function resolveBlob(sdk, key) {
  const r = await sdk.list({ prefix: key, limit: 10 });
  return (r.blobs || []).find(b => b.pathname === key) || null;
}

function createDocsStore(sdk) {
  return {
    // R2.put(key, body, {httpMetadata}) — worker checks nothing on the return
    // value (it verifies with head() instead), so we just write.
    async put(key, value, opts = {}) {
      await sdk.put(key, value, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: (opts.httpMetadata && opts.httpMetadata.contentType) || 'application/octet-stream',
        // Keep CDN staleness short: a re-published version should be visible
        // quickly. 60s is the Blob minimum.
        cacheControlMaxAge: 60,
      });
    },
    // R2.get(key) → { text() } | null. The worker only ever calls .text().
    async get(key) {
      const blob = await resolveBlob(sdk, key);
      if (!blob) return null;
      const r = await sdk.fetchBlob(blob.url);
      if (!r.ok) return null;
      return { text: () => r.text() };
    },
    // R2.head(key) → { size } | null. Used as an existence probe and for the
    // post-upload write verification (which reads .size).
    async head(key) {
      const blob = await resolveBlob(sdk, key);
      return blob ? { size: blob.size } : null;
    },
    // R2.delete(key). Missing key is a no-op, matching R2.
    async delete(key) {
      const blob = await resolveBlob(sdk, key);
      if (blob) await sdk.del(blob.url);
    },
    // R2.list({prefix, cursor}) → { objects: [{key}], truncated, cursor }.
    // Only used by the admin delete path to enumerate a slug's versions.
    async list({ prefix = '', cursor } = {}) {
      const r = await sdk.list({ prefix, cursor, limit: 1000 });
      return {
        objects: (r.blobs || []).map(b => ({ key: b.pathname })),
        truncated: !!r.hasMore,
        cursor: r.cursor,
      };
    },
  };
}

export { createDocsStore, resolveBlob };
