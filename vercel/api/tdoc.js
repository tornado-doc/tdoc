// tdoc on Vercel — a single catch-all function that runs the SAME bundled
// worker code the Cloudflare deployment runs, with the two storage bindings
// swapped for Vercel-native backends:
//
//   DOCS (R2 bucket)   → Vercel Blob            (lib/blob-r2.js)
//   META (KV namespace)→ Upstash Redis REST     (lib/upstash-kv.js)
//   COMMENTS (DO)      → intentionally ABSENT   — the worker detects the
//                        missing binding and uses its built-in KV fallback
//                        (functional, not per-slug serialized; see #34).
//
// IMPORTANT: `../_worker.bundled.js` does not exist in the repo — tdoc-publish
// generates it (worker/worker.js with server/overlay.js inlined) into the
// deploy dir before every `vercel deploy`, exactly like the wrangler flow.
// Deploying this directory without running tdoc-publish will fail the build,
// on purpose: a worker without the overlay is a broken product.
//
// Uses the Node runtime's web handler signature (Request → Response), so the
// worker's fetch handler runs unmodified.

import worker from '../_worker.bundled.js';
import { createDocsStore } from '../lib/blob-r2.js';
import { createKvStore } from '../lib/upstash-kv.js';
import { originalRequestUrl } from '../lib/request-url.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// Build the worker env from this deployment's environment variables. Returns
// { env } or { error: Response } — a missing storage integration becomes a
// clear 500 the user can act on, not a cryptic throw deep inside a route.
async function buildEnv() {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return { error: json({ error: 'storage_not_configured', message: 'No Vercel Blob store is connected to this project (BLOB_READ_WRITE_TOKEN is unset). Create a Blob store in the Vercel dashboard (Storage tab) and connect it, then redeploy.' }, 500) };
  }
  // Marketplace Upstash exposes UPSTASH_REDIS_REST_*; stores created under the
  // legacy "Vercel KV" name expose KV_REST_API_*. Accept both.
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) {
    return { error: json({ error: 'storage_not_configured', message: 'No Redis/KV store is connected to this project (KV_REST_API_URL / UPSTASH_REDIS_REST_URL is unset). Add an Upstash Redis store from the Vercel Marketplace (Storage tab) and connect it, then redeploy.' }, 500) };
  }
  // @vercel/blob is imported lazily so this module stays loadable (and the
  // config errors above stay reachable) even if the dependency install is
  // broken — and so lib/blob-r2.js keeps its SDK injectable for tests.
  const blob = await import('@vercel/blob');
  const sdk = {
    put: (key, value, opts) => blob.put(key, value, { ...opts, token: blobToken }),
    del: (url) => blob.del(url, { token: blobToken }),
    list: (opts) => blob.list({ ...opts, token: blobToken }),
    fetchBlob: (url) => fetch(url),
  };
  return {
    env: {
      DOCS: createDocsStore(sdk),
      META: createKvStore({ url: kvUrl, token: kvToken }),
      TDOC_UPLOAD_TOKEN: process.env.TDOC_UPLOAD_TOKEN,
      TDOC_OWNER: process.env.TDOC_OWNER || '',
      // GitHub Device Flow app for published-doc comments. The OAuth app
      // identity is user-visible on GitHub's authorization screen, so do not
      // silently fall back to a personal/deprecated app.
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
      TDOC_DEBUG: process.env.TDOC_DEBUG || '',
    },
  };
}

async function handle(req) {
  const built = await buildEnv();
  if (built.error) return built.error;
  const url = originalRequestUrl(req);
  const init = { method: req.method, headers: req.headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half'; // Node fetch requires this for streamed bodies
  }
  return worker.fetch(new Request(url, init), built.env, {});
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
