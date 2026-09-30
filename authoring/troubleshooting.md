# Troubleshooting

When the user reports a problem, check these first:

- **`/api/publish` 404, or "string did not match the expected pattern" in the Publish modal** → the running server is stale (old process, doesn't have current routes). Restart it: `pkill -f "$SKILL_DIR/server/server.js" && nohup node "$SKILL_DIR/server/server.js" > "$TDOC_DIR/.server.log" 2>&1 &`. `/tdoc update` now auto-restarts, but a server that was started before the update is still running stale code until restarted.
- **Comment popup doesn't appear when selecting text** → selection is captured by `server/frame-probe.js` inside the author frame and posted to the shell over `postMessage`; the composer is drawn by `shell/src/document/`. Check the probe's mouseup/touchend handler first, then whether the `tdoc:selection` message reaches the shell.
- **Publish modal hangs forever** → check `~/tdocs/.server.log`. On the BYOK path it is usually `wrangler login` waiting for browser auth, or R2 not enabled. On a first hosted publish the modal now shows the pairing code itself and waits for it, so a hang there means the sign-in was never approved — the code expires and the publish fails on its own.
- **Local doc URLs show the wrong content / weird JSON, or the server "is up" but docs 404** → another local service may be squatting the tdoc port (seen in the wild: a daemon from another product bound 7878). Run `curl -s http://localhost:7878/api/ping` — if the body lacks `"service":"tdoc"`, the answerer is not tdoc. Identify the squatter with `lsof -i :7878`, then free the port or run tdoc on another port via `TDOC_PORT=<port>` (the bin scripts and server all honor it).

