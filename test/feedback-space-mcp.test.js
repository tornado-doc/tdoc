// create_feedback_space (remote MCP) and POST /api/feedback/spaces (browser
// session or hosted token; same code, same result): an agent
// makes a website's comment space and gets the embed line, with nobody
// clicking through /feedback.
//   - personal: private (owner + invitees), bound to the origins, one meta
//     write; the owner's bookmarklet on that origin finds the same space
//   - team: team admins only; private to the team; a member who is not an
//     admin, and a non-member, are refused
//   - origins validated like the site binding; a duplicate returns the
//     existing space, never another person's or a space only joined
//   - a feedback token cannot call it; a workspace-scoped token stays in its
//     workspaces
//   - the space works with /api/feedback/connect {space} from a bound origin
//     only
// And the race from production: binding a site and changing Share both used
// to re-save the whole meta record from a read that can be a minute stale,
// so each could undo the other. Each test parks one writer between its read
// and its write and lets the other one run (the pattern of
// scan-backfill-race.test.js).
// Run with: node test/feedback-space-mcp.test.js

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadWorker, makeEnv, req, issue, putSession, bootData } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = 'https://tdoc.dev';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const SITE = 'https://app.example.com';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The first time `key` is read while armed, run `during` (the other
// writer) before the reader gets the value it read: the reader holds a
// record that is now stale, exactly as a KV read from another location can.
function runBin(bin, args, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function interleaveRead(env, key, during) {
  const orig = env.META.get.bind(env.META);
  let fired = false;
  env.META.get = async (k, ...rest) => {
    const v = await orig(k, ...rest);
    if (k === key && !fired) {
      fired = true;
      await during();
    }
    return v;
  };
  return { restore: () => { env.META.get = orig; }, fired: () => fired };
}

(async () => {
  console.log('create_feedback_space + site binding race');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_REMOTE_MCP: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef' });
  const raw = async (r) => {
    const res = await worker.fetch(r, env, {});
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text };
  };
  const call = (path, opts) => raw(req(path, opts));
  const home = { Origin: ORIGIN };

  let rpcId = 0;
  const mcp = (token, method, params = {}) => {
    const name = params.name;
    return raw(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    }));
  };
  const tool = async (token, args, name = 'create_feedback_space') => {
    const r = await mcp(token, 'tools/call', { name, arguments: args });
    assert(r.status === 200 && r.body && r.body.result, `${name}: ${r.status} ${r.text.slice(0, 300)}`);
    return r.body.result;
  };

  // A real connector token (OAuth), which works at /mcp only: the tool must
  // reach its route in process.
  const oauthToken = async (who) => {
    const client = (await call('/oauth/register', { method: 'POST', body: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] } })).body;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const cookie = await putSession(env, who.login);
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'mcp', resource: `${ORIGIN}/mcp` });
    const page = await call(`/oauth/authorize?${q}`, { cookie });
    const boot = bootData(page.text, '__TDOC_APP_BOOT__');
    const ok = await call('/api/oauth/approve', { method: 'POST', cookie, headers: home, body: { request_id: boot.request_id, csrf: boot.csrf, decision: 'allow' } });
    const code = new URL(ok.body.redirect).searchParams.get('code');
    const tok = await raw(new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id, resource: `${ORIGIN}/mcp` }).toString(),
    }));
    assert(tok.status === 200 && tok.body.access_token, `oauth ${tok.status} ${tok.text}`);
    return tok.body.access_token;
  };

  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const carl = await issue(worker, env, 'carl');
  const dana = await issue(worker, env, 'dana');
  const julieOauth = await oauthToken(julie);

  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: home, body: { name: 'Acme' } })).body.team;
  assert(team && team.id, 'team');
  const joined = await call('/api/team/join', { method: 'POST', cookie: bob.cookie, headers: home, body: { token: team.invite_url.split('/').pop() } });
  assert(joined.status === 200, `bob joins ${joined.status} ${joined.text}`);
  const other = (await call('/api/teams', { method: 'POST', cookie: dana.cookie, headers: home, body: { name: 'Other' } })).body.team;

  const connectSpace = (who, slug, origin = SITE) => call('/api/feedback/connect', { method: 'POST', cookie: who.cookie, headers: home, body: { origin, space: slug } });
  const stored = async (slug) => JSON.parse(await env.META.get(`meta:${slug}`));

  let personal;
  await t('tools/list: create_feedback_space with a schema, a title and annotations', async () => {
    const tools = (await mcp(julieOauth, 'tools/list')).body.result.tools;
    const x = tools.find((tt) => tt.name === 'create_feedback_space');
    assert(x && x.title, 'listed with a title');
    assert(x.inputSchema.required.join() === 'origins' && x.inputSchema.properties.origins.maxItems === 10 && x.inputSchema.additionalProperties === false, JSON.stringify(x.inputSchema));
    assert(x.annotations.readOnlyHint === false && x.annotations.destructiveHint === false && x.annotations.idempotentHint === true, JSON.stringify(x.annotations));
  });

  await t('personal: a private space bound to the origins, the snippet, written in one meta write', async () => {
    const puts = [];
    const orig = env.META.put.bind(env.META);
    env.META.put = async (k, ...rest) => { if (k.startsWith('meta:') || k.startsWith('site:')) puts.push(k); return orig(k, ...rest); };
    let res;
    try { res = await tool(julieOauth, { origins: [`${SITE}/`, 'http://localhost:3000'] }); } finally { env.META.put = orig; }
    assert(!res.isError, JSON.stringify(res));
    const d = res.structuredContent;
    personal = d.slug;
    assert(d.created === true && d.url === `${ORIGIN}/d/${d.slug}`, JSON.stringify(d));
    assert(d.snippet === `<script src="${ORIGIN}/feedback.js" data-tdoc-space="${d.slug}" async></script>`, d.snippet);
    assert(JSON.stringify(d.origins) === JSON.stringify([SITE, 'http://localhost:3000']), JSON.stringify(d.origins));
    assert(d.access.visibility === 'private' && !d.access.team && d.team === null, JSON.stringify(d.access));
    assert(/^You and the people you invite can comment/.test(d.who_can_comment), d.who_can_comment);
    assert(res.content[0].text.includes(d.snippet), 'the text carries the snippet');
    assert(JSON.stringify(puts) === JSON.stringify([`meta:${d.slug}`]), `writes: ${puts.join(', ')}`);
    const m = await stored(d.slug);
    assert(m.created_from === 'feedback' && m.feedback.origin === SITE && m.title === 'Feedback · app.example.com', JSON.stringify(m));
    assert(JSON.stringify(m.site) === JSON.stringify({ origins: [SITE, 'http://localhost:3000'] }) && m.access.visibility === 'private', JSON.stringify(m));
    assert(m.hosted && m.hosted.account_id === julie.account_id && !m.workspace_id, 'owned by the caller, in My docs');
  });

  await t('the space works from a bound origin for its owner, never from another origin, never for a stranger', async () => {
    const ok = await connectSpace(julie, personal);
    assert(ok.status === 200 && ok.body.token && ok.body.site === true, `owner ${ok.status} ${ok.text}`);
    const local = await connectSpace(julie, personal, 'http://localhost:3000');
    assert(local.status === 200, `second origin ${local.status}`);
    const elsewhere = await connectSpace(julie, personal, 'https://evil.example');
    assert(elsewhere.status === 403 && elsewhere.body.error === 'origin_not_allowed', `${elsewhere.status} ${elsewhere.text}`);
    const stranger = await connectSpace(carl, personal);
    assert(stranger.status === 403 && stranger.body.error === 'not_invited', `${stranger.status} ${stranger.text}`);
    const anon = await call(`/d/${personal}/v/1/raw`);
    assert(anon.status !== 200 || !anon.text.includes('Product feedback'), `anonymous read ${anon.status}`);
  });

  await t("the owner's bookmarklet on that origin opens the same space", async () => {
    const r = await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: home, body: { origin: SITE } });
    assert(r.status === 200 && r.body.slug === personal, `${r.status} ${r.body && r.body.slug} vs ${personal}`);
  });

  await t('asked again for the same origin: the same space, not a second one; a new origin is added to it', async () => {
    const again = (await tool(julie.token, { origins: [SITE] })).structuredContent;
    assert(again.created === false && again.slug === personal, JSON.stringify(again));
    const more = (await tool(julie.token, { origins: ['https://staging.example.com', SITE] })).structuredContent;
    assert(more.slug === personal && more.origins.includes('https://staging.example.com') && more.origins.includes(SITE), JSON.stringify(more.origins));
    const r = await connectSpace(julie, personal, 'https://staging.example.com');
    assert(r.status === 200, `new origin ${r.status}`);
  });

  await t("the duplicate lookup never hands out someone else's space, even one the caller joined", async () => {
    // Carl joins Julie's space (she invites him) for the same origin.
    const inv = await call('/api/doc/access', { method: 'PATCH', cookie: julie.cookie, headers: home, body: { slug: personal, access: { allowed_users_add: ['carl'] } } });
    assert(inv.status === 200, `invite ${inv.status} ${inv.text}`);
    const j = await call('/api/feedback/join', { method: 'POST', cookie: carl.cookie, headers: home, body: { slug: personal } });
    assert(j.status === 200, `join ${j.status} ${j.text}`);
    const mine = (await tool(carl.token, { origins: [SITE] })).structuredContent;
    assert(mine.created === true && mine.slug !== personal, `carl got ${mine.slug}`);
    const m = await stored(mine.slug);
    assert(m.hosted.account_id === carl.account_id, 'carl owns his own');
    // And Julie still gets hers.
    assert((await tool(julie.token, { origins: [SITE] })).structuredContent.slug === personal, 'julie keeps hers');
  });

  let teamSpace;
  await t('team admin: a space private to the team; members comment, outsiders are refused', async () => {
    const res = await tool(julie.token, { origins: ['https://acme.example'], team: 'Acme', title: 'Acme beta feedback' });
    assert(!res.isError, JSON.stringify(res));
    const d = res.structuredContent;
    teamSpace = d.slug;
    assert(d.created && d.team.id === team.id && d.access.visibility === 'private' && d.access.team === true, JSON.stringify(d));
    assert(/^Members of Acme can comment/.test(d.who_can_comment), d.who_can_comment);
    const m = await stored(d.slug);
    assert(m.workspace_id === team.id && m.access.team === true && m.title === 'Acme beta feedback', JSON.stringify(m));
    assert((await connectSpace(bob, d.slug, 'https://acme.example')).status === 200, 'a member comments');
    const out = await connectSpace(carl, d.slug, 'https://acme.example');
    assert(out.status === 403, `outsider ${out.status}`);
    // The admin's own bookmarklet on that origin stays personal.
    const bm = await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: home, body: { origin: 'https://acme.example' } });
    assert(bm.status === 200 && bm.body.slug !== d.slug && !(await stored(bm.body.slug)).workspace_id, `bookmarklet went to the team space: ${bm.body.slug}`);
    // By id or handle too, and again: the same space.
    const byId = (await tool(julie.token, { origins: ['https://acme.example'], team: team.id })).structuredContent;
    assert(byId.created === false && byId.slug === d.slug, JSON.stringify(byId));
  });

  await t('team: a member who is not an admin is refused, and nothing is made', async () => {
    const before = [...env.META.map.keys()].filter((k) => k.startsWith('meta:')).length;
    const res = await tool(bob.token, { origins: ['https://bob.example'], team: 'Acme' });
    assert(res.isError && res.structuredContent.error === 'not_team_admin', JSON.stringify(res.structuredContent));
    const after = [...env.META.map.keys()].filter((k) => k.startsWith('meta:')).length;
    assert(before === after, 'no doc was created');
    // Nor may he pick up the admin-made team space as "his".
    const dup = await tool(bob.token, { origins: ['https://acme.example'], team: team.id });
    assert(dup.isError && dup.structuredContent.error === 'not_team_admin', JSON.stringify(dup.structuredContent));
  });

  await t('team: not a member (by name or by id) is refused', async () => {
    const byName = await tool(julie.token, { origins: [SITE], team: 'Other' });
    assert(byName.isError && byName.structuredContent.error === 'not_team_member', JSON.stringify(byName.structuredContent));
    const byId = await tool(julie.token, { origins: [SITE], team: other.id });
    assert(byId.isError && byId.structuredContent.error === 'not_team_member', JSON.stringify(byId.structuredContent));
  });

  await t('invalid origins are refused before anything is made', async () => {
    for (const origins of [['https://app.example.com/path'], ['ftp://app.example.com'], ['not a url'], ['javascript:alert(1)'], ['https://user:pw@app.example.com']]) {
      const res = await tool(julie.token, { origins });
      assert(res.isError && res.structuredContent.error === 'invalid_origin', `${origins}: ${JSON.stringify(res.structuredContent)}`);
    }
    const none = await tool(julie.token, { origins: [] });
    assert(none.isError && none.structuredContent.error === 'invalid_arguments', JSON.stringify(none.structuredContent));
    const many = await tool(julie.token, { origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`) });
    assert(many.isError, 'eleven origins');
    const direct = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`) } });
    assert(direct.status === 400 && direct.body.error === 'too_many_origins', `${direct.status} ${direct.text}`);
    const notArray = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: SITE } });
    assert(notArray.status === 400, `string origins ${notArray.status}`);
  });

  await t('a feedback token cannot make a space (route or /mcp)', async () => {
    const fb = await call('/api/feedback/connect', { method: 'POST', cookie: carl.cookie, headers: home, body: { origin: 'https://carl.example' } });
    assert(fb.status === 200 && /^fb_/.test(fb.body.token), `fb token ${fb.status}`);
    const r = await call('/api/feedback/spaces', { method: 'POST', token: fb.body.token, body: { origins: ['https://carl2.example'] } });
    assert(r.status === 403 && r.body.error === 'feedback_token_scope', `${r.status} ${r.text}`);
    const m = await mcp(fb.body.token, 'tools/call', { name: 'create_feedback_space', arguments: { origins: ['https://carl2.example'] } });
    assert(m.status === 401, `/mcp with a feedback token ${m.status}`);
  });

  await t('a cookie session from another origin is refused (CSRF)', async () => {
    const r = await call('/api/feedback/spaces', { method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://evil.example' }, body: { origins: ['https://x.example'] } });
    assert(r.status === 403 && r.body.error === 'forbidden', `${r.status} ${r.text}`);
  });

  await t('a workspace-scoped token stays in its workspaces', async () => {
    const meOnly = (await call('/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { workspaces: ['me'], label: 'me-bot' } })).body.token;
    const teamOnly = (await call('/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { workspaces: [team.id], label: 'team-bot' } })).body.token;
    assert(meOnly && teamOnly, 'scoped tokens');
    const a = await call('/api/feedback/spaces', { method: 'POST', token: meOnly, body: { origins: ['https://acme.example'], team: team.id } });
    assert(a.status === 403 && a.body.error === 'token_scope', `me-only into a team ${a.status} ${a.text}`);
    const b = await call('/api/feedback/spaces', { method: 'POST', token: teamOnly, body: { origins: [SITE] } });
    assert(b.status === 403 && b.body.error === 'token_scope', `team-only into My docs ${b.status} ${b.text}`);
    const c = await call('/api/feedback/spaces', { method: 'POST', token: teamOnly, body: { origins: ['https://acme.example'], team: 'Acme' } });
    assert(c.status === 200 && c.body.slug === teamSpace, `team-only into its team ${c.status} ${c.text}`);
  });

  // ------------------------------------------------- HTTP endpoint
  await t('HTTP: a same-origin browser session makes a space; the body is the MCP tool\'s result', async () => {
    const http = await call('/api/feedback/spaces', { method: 'POST', cookie: dana.cookie, headers: home, body: { origins: ['https://dana-http.example'], title: 'Dana app' } });
    assert(http.status === 201 && http.body.created === true, `${http.status} ${http.text}`);
    assert(http.body.snippet.includes(`data-tdoc-space="${http.body.slug}"`) && http.body.access.visibility === 'private', JSON.stringify(http.body));
    assert((await stored(http.body.slug)).title === 'Dana app', 'title');
    // The same request through MCP returns the same object (now: the existing space).
    const viaMcp = (await tool(dana.token, { origins: ['https://dana-http.example'] })).structuredContent;
    const viaHttp = (await call('/api/feedback/spaces', { method: 'POST', cookie: dana.cookie, headers: home, body: { origins: ['https://dana-http.example'] } }));
    assert(viaHttp.status === 200, `again ${viaHttp.status}`);
    assert(JSON.stringify(viaMcp) === JSON.stringify(viaHttp.body), `MCP ${JSON.stringify(viaMcp)}\nHTTP ${JSON.stringify(viaHttp.body)}`);
  });

  await t('HTTP: a hosted Bearer token makes a space, and a team one for an admin', async () => {
    const r = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: ['https://bearer.example'] } });
    assert(r.status === 201 && r.body.team === null && (await stored(r.body.slug)).hosted.account_id === julie.account_id, `${r.status} ${r.text}`);
    const tm = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: ['https://bearer-team.example'], team: team.id } });
    assert(tm.status === 201 && tm.body.team.id === team.id && tm.body.access.team === true, `${tm.status} ${tm.text}`);
    const notAdmin = await call('/api/feedback/spaces', { method: 'POST', token: bob.token, body: { origins: ['https://bob2.example'], team: team.id } });
    assert(notAdmin.status === 403 && notAdmin.body.error === 'not_team_admin', `${notAdmin.status}`);
    const anon = await call('/api/feedback/spaces', { method: 'POST', body: { origins: ['https://anon.example'] } });
    assert(anon.status === 401, `anonymous ${anon.status}`);
  });

  await t('HTTP: a cookie POST with no Origin header is refused like a cross-origin one', async () => {
    const r = await call('/api/feedback/spaces', { method: 'POST', cookie: julie.cookie, body: { origins: ['https://x.example'] } });
    assert(r.status === 403 && r.body.error === 'forbidden', `${r.status} ${r.text}`);
  });

  await t("an existing bookmarklet space (own or joined) keeps the owner's bookmarklet; the site space is found again by its own key", async () => {
    // Carl joined Julie's space for SITE earlier, and made his own site space after.
    const bm = await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://bm.example' } });
    const r = (await tool(dana.token, { origins: ['https://bm.example'] })).structuredContent;
    assert(r.created && r.slug !== bm.body.slug, 'a new private site space');
    const again = await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://bm.example' } });
    assert(again.body.slug === bm.body.slug, `the bookmarklet was moved to ${again.body.slug}`);
    assert((await tool(dana.token, { origins: ['https://bm.example'] })).structuredContent.slug === r.slug, 'found again');
  });

  await t('a bookmarklet space in Trash keeps its pointer: restored, the bookmarklet finds it again', async () => {
    const bm = (await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://trashed.example' } })).body.slug;
    assert((await call(`/api/doc?slug=${bm}`, { method: 'DELETE', cookie: dana.cookie, headers: home })).status === 200, 'trash');
    const site = (await tool(dana.token, { origins: ['https://trashed.example'] })).structuredContent;
    assert(site.created && site.slug !== bm, 'a new site space');
    const back = await call('/api/trash/restore', { method: 'POST', cookie: dana.cookie, headers: home, body: { slug: bm } });
    assert(back.status === 200, `restore ${back.status} ${back.text}`);
    const again = await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://trashed.example' } });
    assert(again.body.slug === bm, `bookmarklet now at ${again.body.slug}`);
  });

  await t('an origin added to an existing space is indexed: asking for it alone returns the same space', async () => {
    const a = (await tool(dana.token, { origins: ['https://one.example'] })).structuredContent;
    const ab = (await tool(dana.token, { origins: ['https://one.example', 'https://two.example'] })).structuredContent;
    assert(ab.slug === a.slug, 'extended');
    const b = (await tool(dana.token, { origins: ['https://two.example'] })).structuredContent;
    assert(b.created === false && b.slug === a.slug, `a second space for two.example: ${b.slug}`);
  });

  await t('a team word that is one team\'s handle and another\'s name is refused as ambiguous', async () => {
    const t2 = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: home, body: { name: team.handle || 'acme' } })).body.team;
    assert(t2 && t2.id !== team.id, 'second team');
    assert(team.handle, 'the team has a handle');
    const r = await call('/api/feedback/spaces', { method: 'POST', token: julie.token, body: { origins: ['https://amb.example'], team: team.handle } });
    assert(r.status === 409 && r.body.error === 'team_ambiguous', `${r.status} ${r.text}`);
  });

  // ------------------------------------------------------------- CLI
  await t('CLI: tdoc-feedback init prints the snippet, --env the slug, --write adds the tag once; same space as MCP', async () => {
    const server = http.createServer((q, s) => {
      let b = '';
      q.on('data', (d) => { b += d; }).on('end', async () => {
        const u = new URL(q.url, ORIGIN);
        const r = await worker.fetch(new Request(`${ORIGIN}${u.pathname}${u.search}`, {
          method: q.method, headers: { authorization: q.headers.authorization || '', 'content-type': 'application/json' }, body: b || undefined,
        }), env, {});
        s.writeHead(r.status, { 'content-type': 'application/json' });
        s.end(await r.text());
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-feedback-'));
    const bin = path.join(__dirname, '..', 'bin', 'tdoc-feedback');
    const base = `http://127.0.0.1:${server.address().port}`;
    const as = (who) => {
      const dir = path.join(home, who.login);
      fs.mkdirSync(path.join(dir, '.tdoc'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base, upload_token: who.token }));
      return { ...process.env, HOME: dir };
    };
    try {
      const jEnv = as(julie);
      // Parity: the CLI and the MCP tool, same inputs, same space and snippet.
      const viaMcp = (await tool(julie.token, { origins: ['https://cli.example'] })).structuredContent;
      const out = await runBin(bin, ['init', '--site', 'https://cli.example'], jEnv);
      assert(out.status === 0, `init ${out.status}\n${out.stderr}`);
      // The CLI builds the tag itself, on the tdoc it is signed in to.
      const cliSnippet = viaMcp.snippet.replace(ORIGIN, base);
      assert(out.stdout.trim() === cliSnippet, `snippet ${JSON.stringify(out.stdout)} vs ${cliSnippet}`);
      assert(/found your feedback space in My docs/.test(out.stderr) && out.stderr.includes(viaMcp.url), out.stderr);
      const envOut = await runBin(bin, ['init', '--site', 'https://cli.example', '--env'], jEnv);
      assert(envOut.stdout.trim() === `TDOC_FEEDBACK_SPACE=${viaMcp.slug}`, envOut.stdout);
      // A new site through the CLI first, then MCP finds that one.
      const fresh = await runBin(bin, ['init', '--site', 'https://cli-new.example/', '--team', team.id, '--env'], jEnv);
      assert(fresh.status === 0 && /created feedback space in team Acme/.test(fresh.stderr), `${fresh.status} ${fresh.stderr}`);
      const freshSlug = fresh.stdout.trim().split('=')[1];
      assert((await tool(julie.token, { origins: ['https://cli-new.example'], team: team.id })).structuredContent.slug === freshSlug, 'MCP finds the CLI-made space');
      // --write: before </head>, once.
      const page = path.join(home, 'index.html');
      fs.writeFileSync(page, '<!doctype html>\n<html>\n  <head>\n    <title>App</title>\n  </head>\n  <body></body>\n</html>\n');
      for (let i = 0; i < 2; i++) {
        const w = await runBin(bin, ['init', '--site', 'https://cli.example', '--write', page], jEnv);
        assert(w.status === 0, `write ${w.status} ${w.stderr}`);
      }
      const html = fs.readFileSync(page, 'utf8');
      assert(html.split('data-tdoc-space=').length === 2, `tag count: ${html}`);
      assert(html.indexOf(cliSnippet) < html.indexOf('</head>') && html.indexOf(cliSnippet) > html.indexOf('<title>'), html);
      // Tags for another space (two, one unquoted) are replaced by one.
      fs.writeFileSync(page, html.replace(cliSnippet, `${cliSnippet.replace(viaMcp.slug, 'old-space')}\n    <script src="x/feedback.js" data-tdoc-space=older async></script>`));
      await runBin(bin, ['init', '--site', 'https://cli.example', '--write', page], jEnv);
      const html2 = fs.readFileSync(page, 'utf8');
      assert(html2.split('data-tdoc-space=').length === 2 && html2.includes(cliSnippet) && !html2.includes('old-space') && !html2.includes('older'), html2);
      // Refusals arrive as messages, exit 1, nothing on stdout.
      const notAdmin = await runBin(bin, ['init', '--site', 'https://bob-cli.example', '--team', team.id], as(bob));
      assert(notAdmin.status === 1 && !notAdmin.stdout.trim() && /Only an admin of Acme/.test(notAdmin.stderr), `${notAdmin.status} ${notAdmin.stderr}`);
      const noTitle = await runBin(bin, ['init', '--site', 'https://x.example', '--title'], jEnv);
      assert(noTitle.status === 2 && /--title needs/.test(noTitle.stderr), noTitle.stderr);
      const bad = await runBin(bin, ['init', '--site', 'https://x.example/path'], jEnv);
      assert(bad.status === 1 && /not a site origin/.test(bad.stderr), bad.stderr);
      const noSignin = await runBin(bin, ['init', '--site', 'https://x.example'], { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nohome-')) });
      assert(noSignin.status === 1 && /tdoc-publish --signin-only/.test(noSignin.stderr), noSignin.stderr);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------- race
  await t('race: Share made private while a site bind holds the old record stays private', async () => {
    const made = await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://dana.example' } });
    const slug = made.body.slug;
    assert((await stored(slug)).access.visibility === 'unlisted', 'precondition: a bookmarklet space starts unlisted');
    const hook = interleaveRead(env, `meta:${slug}`, async () => {
      const r = await call('/api/doc/access', { method: 'PATCH', cookie: dana.cookie, headers: home, body: { slug, access: { visibility: 'private' } } });
      assert(r.status === 200, `make private ${r.status}`);
    });
    let bind;
    try {
      bind = await call('/api/feedback/site', { method: 'POST', cookie: dana.cookie, headers: home, body: { slug, origins: ['https://dana.example'] } });
    } finally { hook.restore(); }
    assert(hook.fired(), 'the bind never read the record');
    assert(bind.status === 200, `bind ${bind.status} ${bind.text}`);
    assert((await stored(slug)).access.visibility === 'private', `the bind put the old access back: ${(await stored(slug)).access.visibility}`);
    const site = await call(`/api/feedback/site?slug=${slug}`, { cookie: dana.cookie, headers: home });
    assert(site.body.site && site.body.site.origins[0] === 'https://dana.example', 'and the binding is there');
    const stranger = await connectSpace(carl, slug, 'https://dana.example');
    assert(stranger.status === 403, `a stranger got in: ${stranger.status}`);
  });

  await t('race: a site bound while a Share change holds the old record stays bound', async () => {
    const made = await call('/api/feedback/connect', { method: 'POST', cookie: dana.cookie, headers: home, body: { origin: 'https://dana2.example' } });
    const slug = made.body.slug;
    const hook = interleaveRead(env, `meta:${slug}`, async () => {
      const r = await call('/api/feedback/site', { method: 'POST', cookie: dana.cookie, headers: home, body: { slug, origins: ['https://dana2.example'] } });
      assert(r.status === 200, `bind ${r.status}`);
    });
    let share;
    try {
      share = await call('/api/doc/access', { method: 'PATCH', cookie: dana.cookie, headers: home, body: { slug, access: { visibility: 'private' } } });
    } finally { hook.restore(); }
    assert(hook.fired(), 'the Share change never read the record');
    assert(share.status === 200, `share ${share.status} ${share.text}`);
    const ok = await connectSpace(dana, slug, 'https://dana2.example');
    assert(ok.status === 200, `the Share change dropped the binding: ${ok.status} ${ok.text}`);
    assert((await stored(slug)).access.visibility === 'private', 'and access is what Share said');
  });

  await t('race: share_doc right after create_feedback_space keeps the binding, and turning it off sticks', async () => {
    const d = (await tool(julie.token, { origins: ['https://fresh.example'] })).structuredContent;
    const s = await tool(julie.token, { slug: d.slug, invite: ['carl'] }, 'share_doc');
    assert(!s.isError, JSON.stringify(s.structuredContent));
    assert((await connectSpace(carl, d.slug, 'https://fresh.example')).status === 200, 'the invitee comments from the site');
    const off = await call('/api/feedback/site', { method: 'POST', cookie: julie.cookie, headers: home, body: { slug: d.slug, off: true } });
    assert(off.status === 200 && off.body.site === null, `off ${off.status}`);
    // meta.site (the binding it was created with) no longer counts.
    assert((await stored(d.slug)).site, 'meta untouched by the binding write');
    const gone = await connectSpace(julie, d.slug, 'https://fresh.example');
    assert(gone.status === 404 && gone.body.error === 'space_not_found', `still bound after off: ${gone.status}`);
    const again = (await tool(julie.token, { origins: ['https://fresh.example'] })).structuredContent;
    assert(again.created === true && again.slug !== d.slug, 'an unbound space is not returned as the site space');
  });

  await t('a doc erased for good takes its binding key with it', async () => {
    const d = (await tool(dana.token, { origins: ['https://erase.example'] })).structuredContent;
    await call('/api/feedback/site', { method: 'POST', cookie: dana.cookie, headers: home, body: { slug: d.slug, origins: ['https://erase.example', 'https://erase2.example'] } });
    assert(await env.META.get(`site:${d.slug}`), 'precondition: binding key');
    const del = await call(`/api/doc?slug=${d.slug}`, { method: 'DELETE', cookie: dana.cookie, headers: home });
    assert(del.status === 200, `trash ${del.status} ${del.text}`);
    const purge = await call('/api/trash/purge', { method: 'POST', cookie: dana.cookie, headers: home, body: { slug: d.slug } });
    assert(purge.status === 200, `purge ${purge.status} ${purge.text}`);
    assert(!(await env.META.get(`site:${d.slug}`)), 'binding key left behind');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
