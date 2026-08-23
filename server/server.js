#!/usr/bin/env node
// tdoc local server — anonymous, $0, zero-config.
// Serves docs from ~/tdocs/<slug>/v<N>/index.html. No auth, no GitHub.
// Auth lives entirely in the published Worker. Node 18+, no deps.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.TDOC_PORT ? Number(process.env.TDOC_PORT) : 7878;
const ROOT = process.env.TDOC_DIR || path.join(os.homedir(), 'tdocs');
const OVERLAY_PATH = path.join(__dirname, 'overlay.js');
const CHROME_PATH = path.join(__dirname, 'chrome.js');
// Shared chrome module, also loaded server-side so the shell can render the real
// bar/footer markup statically (same source the browser gets as window.TDOC_CHROME).
let CHROME = {};
try { CHROME = require(CHROME_PATH); } catch {}
const FRAME_PROBE_PATH = path.join(__dirname, 'frame-probe.js');
const ONBOARD_PATH = path.join(__dirname, 'onboard.js');
const SIGNIN_PATH = path.join(__dirname, 'signin.js');
// Slugs that carry the onboarding modal. Product UI, injected under the same
// nonce as the overlay, because a doc's own <script> never runs.
const ONBOARD_SLUGS = new Set(['tornado-doc', 'tdoc-start']);
// Optional two-person local inbox (browser e2e). Off unless TDOC_E2E_USER is set.
const E2E_USER = String(process.env.TDOC_E2E_USER || '').trim();
const E2E_OWNER = String(process.env.TDOC_E2E_OWNER || E2E_USER || '').trim();

fs.mkdirSync(ROOT, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function e2eIdentity() {
  if (!E2E_USER) return null;
  return { login: E2E_USER, name: E2E_USER, avatar_url: '' };
}
function inboxFile(login) {
  return path.join(ROOT, `.inbox-${String(login).toLowerCase()}.json`);
}
function localRecordAuthor(comments, id) {
  for (const c of comments) {
    if (c.id === id) return c.author || null;
    for (const r of (c.replies || [])) if (r.id === id) return r.author || null;
  }
  return null;
}
function localDeliver(recipient, ev) {
  const who = recipient && String(recipient).trim().toLowerCase();
  const actor = ev.actor && ev.actor.login && String(ev.actor.login).trim().toLowerCase();
  if (!who || who === actor) return;
  const file = inboxFile(who);
  const inbox = readJson(file, { items: [] });
  const items = Array.isArray(inbox.items) ? inbox.items : [];
  const gk = ev.kind === 'comment' ? `comment:${ev.slug}`
    : ev.kind === 'reply' ? `reply:${ev.target_id}`
    : ev.kind === 'reaction' ? `reaction:${ev.target_id}`
    : `other:${ev.slug}`;
  const existing = items.find(i => i && !i.read && i.group_key === gk);
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1;
    existing.at = ev.at;
    existing.actor = ev.actor;
    existing.comment_id = ev.comment_id || existing.comment_id;
    existing.thread_id = ev.thread_id || existing.thread_id;
    existing.preview = ev.preview != null ? ev.preview : existing.preview;
    existing.version = ev.version || existing.version;
    const rest = items.filter(i => i !== existing);
    writeJson(file, { items: [existing, ...rest].slice(0, 200) });
    return;
  }
  items.unshift({
    id: ev.id || `n_${Date.now()}`,
    kind: ev.kind, group_key: gk, slug: ev.slug, version: ev.version || 1,
    comment_id: ev.comment_id, thread_id: ev.thread_id || ev.comment_id,
    actor: ev.actor || null, preview: ev.preview || '', title: ev.title || ev.slug,
    at: ev.at || new Date().toISOString(), read: false, count: 1, emoji: ev.emoji || null,
  });
  writeJson(file, { items: items.slice(0, 200) });
}
// Cap request bodies so a hostile/buggy client can't OOM the local server.
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — comments are small
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      b += d;
    });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// Single source of truth for slug validation. Every route that turns a slug
// into a filesystem path MUST run it through here first — otherwise
// `slug=../../etc` escapes ROOT via path.join (confirmed path-traversal on the
// comment routes). Returns the slug if safe, else null.
function safeSlug(slug) {
  return (typeof slug === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(slug)) ? slug : null;
}

// Guard for state-mutating local requests. The local server has no auth (by
// design — it's localhost-only), so a drive-by web page must not be able to
// drive it via CSRF. A cross-origin page can only send a CORS-"simple" POST
// (text/plain, no custom headers) without a preflight; requiring JSON
// content-type defeats that, and rejecting non-local Origins closes the rest.
// Returns true if the request is allowed to mutate.
function isLocalMutation(req) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  const origin = req.headers['origin'];
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
    } catch { return false; }
  }
  return true;
}

// Escape `</script>` and HTML comment terminators so a malicious or stray value
// inside the JSON payload can't break out of the surrounding <script> block.
// Replace the acting agent's reaction on a comment with the emoji for the new
// status. Also removes legacy `tdoc-agent` reactions first so old state
// can't outlive the new outcome (e.g. an "applied" ✅ after a later
// "question" outcome on the same comment).
const AGENT_STATUS_EMOJI = { applied: '✅', partial: '🟡', question: '❓' };
// The emoji set the agent uses as a verdict marker — used by the per-version
// fold to strip a stale verdict off snapshots where the comment reads 'open'.
const AGENT_VERDICT_EMOJI = new Set(Object.values(AGENT_STATUS_EMOJI));
function isAnthropicCompanyMark(url) {
  return typeof url === 'string' && /(?:^|\/\/)(?:www\.)?github\.com\/anthropics(?:\.png)?(?:[/?#]|$)/i.test(url);
}
function logoForAgentLogin(login) {
  const key = String(login || '').toLowerCase();
  if (key.includes('grok') || key.includes('xai')) return 'https://github.com/xai-org.png';
  if (key.includes('claude') || key.includes('anthropic')) return 'https://cdn.simpleicons.org/claude/d97757';
  if (key.includes('codex') || key.includes('openai') || key.includes('chatgpt') || key === 'gpt' || key.startsWith('gpt-')) {
    return 'https://github.com/openai.png';
  }
  if (key.includes('gemini') || key.includes('bard')) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
  if (key.includes('cursor') || key.includes('composer')) return 'https://cdn.simpleicons.org/cursor/000000';
  // tdoc project mark (assets/tdoc_logo.svg, served at /tdoc_logo.svg).
  return '/tdoc_logo.svg';
}

function isGenericAgentLogin(login) {
  const k = String(login || '').trim().toLowerCase();
  return !k || k === 'tdoc-agent' || k === 'agent';
}

function detectAgentRuntime(env) {
  const e = env || {};
  const present = (names) => names.some((n) => {
    const v = e[n];
    return v != null && String(v).trim() !== '';
  });
  // Session/host markers only — never API keys. Order is the priority when
  // more than one host is visible in the same process (rare).
  if (present(['GROK_AGENT', 'GROK_SESSION_ID', 'GROK_BUILD', 'XAI_AGENT'])) {
    return { login: 'grok', name: 'Grok' };
  }
  if (present(['CLAUDE_CODE', 'CLAUDE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'])) {
    return { login: 'claude', name: 'Claude' };
  }
  if (present(['CODEX_SESSION_ID', 'CODEX_CLI', 'OPENAI_CODEX', 'CODEX_HOME'])) {
    return { login: 'codex', name: 'Codex' };
  }
  if (present(['CURSOR_TRACE_ID', 'CURSOR_AGENT', 'COMPOSER_SESSION'])) {
    return { login: 'cursor', name: 'Cursor' };
  }
  if (present(['GEMINI_CLI', 'GEMINI_SESSION_ID'])) {
    return { login: 'gemini', name: 'Gemini' };
  }
  return null;
}

function agentIdentity(body = {}, env = {}) {
  const detected = detectAgentRuntime(env);
  const clean = (v, fallback) => {
    if (typeof v !== 'string') return fallback;
    const s = v.trim().slice(0, 80);
    return s || fallback;
  };
  const rawLogin = typeof (body.agent_login || body.agent_id) === 'string'
    ? String(body.agent_login || body.agent_id).trim()
    : '';
  const rawName = typeof body.agent_name === 'string' ? body.agent_name.trim() : '';
  const login = (!isGenericAgentLogin(rawLogin) ? rawLogin : '')
    || (detected && detected.login)
    || env.TDOC_AGENT_LOGIN
    || 'tdoc-agent';
  const name = (!isGenericAgentLogin(rawName) ? rawName : '')
    || (detected && detected.name)
    || env.TDOC_AGENT_NAME
    || login;
  let avatar = typeof body.agent_avatar_url === 'string' && /^https:\/\/[^ \n\r\t]+$/i.test(body.agent_avatar_url)
    ? body.agent_avatar_url
    : null;
  if (isAnthropicCompanyMark(avatar)) avatar = null;
  if (!avatar) avatar = logoForAgentLogin(login);
  return { kind: 'agent', login: clean(login, 'tdoc-agent'), name: clean(name, login), avatar_url: avatar };
}
function setAgentReaction(target, status, actor = 'tdoc-agent') {
  if (!target.reactions) target.reactions = {};
  const agentUsers = new Set(['tdoc-agent', actor].filter(Boolean));
  for (const emoji of Object.keys(target.reactions)) {
    const users = target.reactions[emoji] || [];
    for (let i = users.length - 1; i >= 0; i--) {
      if (agentUsers.has(users[i])) users.splice(i, 1);
    }
    if (users.length === 0) delete target.reactions[emoji];
    else target.reactions[emoji] = users;
  }
  const next = AGENT_STATUS_EMOJI[status];
  if (!next) return;
  const u = target.reactions[next] || [];
  if (!u.includes(actor)) u.push(actor);
  target.reactions[next] = u;
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
}

// CSP (owner-manage-via-session hardening, mirrors worker/worker.js).
//
// Local docs are anonymous/no-auth by design, so this route isn't guarding a
// session cookie today — but the local server shares overlay.js with the
// published worker, and a doc authored locally is the same bytes that later
// get published. Blocking author <script>/onclick here too means what a doc
// author sees locally matches what ships (no "worked in dev, XSS in prod"
// surprise), and costs nothing since 0 published docs use <script>.
function cspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none';`;
}

// Interactive islands (#138). Host documents keep cspHeader(); computation
// lives in a separately served HTML resource framed with sandbox="allow-scripts"
// (never allow-same-origin). srcdoc/blob inherit the parent CSP and cannot
// run author JS — these must be real URLs.
function isValidWidgetName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}
function widgetCspHeader() {
  return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; worker-src 'none'; form-action 'none'; sandbox allow-scripts";
}
function isWidgetFrameRequest(dest) {
  return String(dest || '').toLowerCase() === 'iframe';
}
function forceWidgetSandbox(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/<iframe\b([^>]*?)>/gi, (full, attrs) => {
    const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!srcM) return full;
    const src = String(srcM[1] || srcM[2] || srcM[3] || '').trim();
    let path;
    try {
      const u = new URL(src, 'https://tdoc-widget-src.invalid');
      if (u.hostname !== 'tdoc-widget-src.invalid') return full;
      path = u.pathname;
    } catch {
      return full;
    }
    if (!/^\/d\/[a-z0-9][a-z0-9-]{0,63}\/v\/\d+\/widget\/[a-z0-9][a-z0-9-]{0,63}\/?$/i.test(path)) return full;
    const stripped = attrs.replace(/\s*sandbox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return '<iframe sandbox="allow-scripts"' + stripped + '>';
  });
}

// --- Cross-origin iframe "shell" (flag: ?shell=1). See PLAN.md. ---
// The author document is served from /d/<slug>/v/<n>/frame under a CSP `sandbox`
// (opaque origin) so its CSS/DOM can never touch the overlay chrome, which lives
// in the shell document. Same isolation mechanism as widget islands, applied to
// the whole doc. Only our own nonced scripts run in the frame (author JS stays
// inert, exactly as in the single-origin path); the sandbox directive is what
// makes the origin opaque.
function frameCspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
}

// The CHROME-only CSS for the shell: the :root design tokens + the chrome CSS
// block (bar/footer/composer/cards/pins/drawer/menus) sliced from overlay.js
// between the TDOC_CHROME_CSS_START/END markers. Excludes the reader/content-
// column rules (those would wrongly constrain the shell body). Single source
// (overlay.js) so the shell chrome stays 1:1 with the overlay, no drift.
function chromeCss() {
  try {
    const src = fs.readFileSync(OVERLAY_PATH, 'utf8');
    let root = '';
    const ri = src.indexOf(':root {');
    if (ri !== -1) { const re = src.indexOf('}', ri); if (re !== -1) root = src.slice(ri, re + 1); }
    let chrome = '';
    const s = src.indexOf('TDOC_CHROME_CSS_START');
    const e = src.indexOf('TDOC_CHROME_CSS_END');
    if (s !== -1 && e !== -1 && e > s) {
      const from = src.indexOf('*/', s);
      const to = src.lastIndexOf('/*', e);
      if (from !== -1 && to !== -1 && to > from) chrome = src.slice(from + 2, to);
    }
    return root + '\n' + chrome;
  } catch { return ''; }
}

// P1: the shell renders a top bar + embeds the author frame. P2 adds the
// postMessage anchoring bridge + comment chrome (composer/pins/cards) here.
function shellDocument(slug, version, nonce) {
  let title = slug, versions = [{ n: version }];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8'));
    if (meta && meta.title) title = meta.title;
    if (Array.isArray(meta.versions) && meta.versions.length) versions = meta.versions.map((v) => ({ n: v.n }));
  } catch {}
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const frameSrc = `/d/${encodeURIComponent(slug)}/v/${version}/frame`;
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const cfgJson = safeJsonForScript({ slug, version, mode: 'local', versions });
  // Shared chrome module (Contract 1): rendered server-side for the static bar +
  // footer (1:1 with overlay), AND inlined as a nonced <script> so the shell's
  // client logic can build the composer/pins from window.TDOC_CHROME.
  let chromeJs = '';
  try { chromeJs = fs.readFileSync(CHROME_PATH, 'utf8'); } catch {}
  const barInner = CHROME.buildBar ? CHROME.buildBar({ mode: 'local', slug, version, versions }) : '';
  const footerInner = CHROME.buildFooter ? CHROME.buildFooter() : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${chromeCss()}</style>
<style>
  /* shell layout only — the real chrome CSS above owns bar/footer/composer/pins */
  html,body{margin:0;padding:0;min-height:100vh;background:#fff;}
  body{display:flex;flex-direction:column;}
  .tdoc-doc-frame{flex:1 1 auto;width:100%;border:0;display:block;}
  /* Footer: floats at the viewport bottom, revealed only when the doc is scrolled
     to its end (like the old "footer at end of document"). Fixed + fade so it
     never steals reading height and toggling it causes no layout shift. */
  .tdoc-footer{margin-top:0;position:fixed;left:0;right:0;bottom:0;z-index:4;background:#fff;opacity:0;transform:translateY(100%);transition:opacity .18s ease,transform .18s ease;pointer-events:none;}
  .tdoc-footer.tdoc-footer-show{opacity:1;transform:none;pointer-events:auto;}
  /* Narrow: one line — just "built with tdoc" (don't stack to two rows). */
  @media (max-width:700px){
    .tdoc-footer .tdoc-footer-row{flex-direction:row;}
    .tdoc-footer .tdoc-footer-row>a:first-child{display:none;}
  }
  .tdoc-pin{position:fixed;}             /* shell body never scrolls; JS sets left from the article edge */
  .tdoc-popup{position:fixed;}
  .tdoc-margin-comment{position:fixed;}  /* JS positions it in the gutter by the pin */
</style>
</head><body>
  <div class="tdoc-bar">${barInner}</div>
  <iframe class="tdoc-doc-frame" title="Document content" sandbox="allow-scripts" src="${esc(frameSrc)}"></iframe>
  <footer class="tdoc-footer">${footerInner}</footer>
  <script${nonceAttr}>${chromeJs}</script>
  <script${nonceAttr}>window.__TDOC_SHELL__ = ${cfgJson};</script>
  <script${nonceAttr}>${shellScript()}</script>
</body></html>`;
}

// Shell-side chrome logic (P2): consume anchoring messages from the frame probe
// and drive the composer. P3 adds pins/cards/highlights + scroll sync. Kept as
// a string so it inlines under the shell nonce (author docs never run JS).
function shellScript() {
  return `(function(){
  'use strict';
  var cfg = window.__TDOC_SHELL__ || {};
  var frame = document.querySelector('.tdoc-doc-frame');
  var BAR = 48; // top bar height; frame viewport coords + BAR = shell coords
  var pending = null; // last selection anchor awaiting a comment
  var pinData = []; // [{id, docY, login}]
  var commentsById = {}; // id -> comment (for the floating card)
  var commentList = []; // ordered comments (for Copy: doc + comments)
  var gutterRight = 0;  // article right edge (from the probe) — where pins live
  var openCardId = null; // comment id of the currently open floating card
  var pinEls = {};       // id -> pin element (cached so scroll doesn't re-query the DOM)
  function pinX(){ return Math.min((gutterRight || (window.innerWidth - 44)) + 14, window.innerWidth - 34); }
  var copyReq = null; // { includeComments } awaiting tdoc:docMarkdown
  var frameScrollY = 0;
  function copyText(t){
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function(){return true;}).catch(function(){return false;});
    try { var ta=document.createElement('textarea'); ta.value=t; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); var ok=document.execCommand('copy'); ta.remove(); return Promise.resolve(ok); } catch(e){ return Promise.resolve(false); }
  }
  function reactionsToMd(r){ if(!r) return ''; var out=Object.keys(r).filter(function(k){return r[k]&&r[k].length;}).map(function(k){return k+' '+r[k].length;}); return out.length?('\\n'+out.join('  ')+'\\n'):''; }
  function commentToMd(c){
    var who=c.author?('**@'+c.author.login+'**'):'*anonymous*'; var when=''; try{when=new Date(c.created).toLocaleString();}catch(e){}
    var anchorLine=''; if(c.anchor){ if(c.anchor.kind==='element'||c.anchor.selector) anchorLine='> _on '+(c.anchor.label||c.anchor.selector)+'_\\n'; else if(c.anchor.text) anchorLine='> "'+c.anchor.text.replace(/\\n/g,' ').slice(0,200)+'"\\n'; }
    var md=who+' — _'+when+'_\\n'+anchorLine+'\\n'+(c.text||'')+'\\n'+reactionsToMd(c.reactions);
    if(Array.isArray(c.replies)) c.replies.forEach(function(r){ var rwho=r.author?('**@'+r.author.login+'**'):'*anonymous*'; md+='  ↳ '+rwho+'\\n    '+(r.text||'')+'\\n'; });
    return md;
  }
  function frameWin(){ return frame && frame.contentWindow; }
  function sendFrame(msg){ var w = frameWin(); if (w) w.postMessage(Object.assign({source:'tdoc-shell'}, msg), '*'); }

  // --- narrow / drawer mode ---
  function layout(){ document.body.classList.toggle('tdoc-narrow', window.innerWidth < 700); positionPins(); }
  window.addEventListener('resize', layout);

  // --- comments: fetch → resolve in frame → draw pins ---
  function loadComments(){
    return fetch('/api/comments?slug=' + encodeURIComponent(cfg.slug) + '&version=' + encodeURIComponent(cfg.version))
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(list){ list = Array.isArray(list) ? list : []; commentList = list; commentsById = {}; list.forEach(function(c){ commentsById[c.id] = c; }); sendFrame({ type:'tdoc:anchors', comments: list }); return list; })
      .catch(function(){ return []; });
  }
  function postReply(parentId, text, btn){
    text = (text || '').trim(); if (!text) return; if (btn) btn.disabled = true;
    fetch('/api/comments', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug, version: cfg.version, text: text, parent_id: parentId }) })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(){ return loadComments(); })
      .then(function(){ openCard(parentId); })   // reopen with the new reply shown
      .catch(function(){ if (btn){ btn.disabled = false; btn.textContent = 'Retry'; } });
  }
  function postReaction(targetId, emoji){
    fetch('/api/reactions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug, comment_id: targetId, emoji: emoji, version: cfg.version }) })
      .then(function(r){ if (r.ok) return loadComments().then(function(){ openCard(targetId); }); })
      .catch(function(){});
  }
  var emojiPicker = null;
  function closeEmojiPicker(){ if (emojiPicker){ emojiPicker.remove(); emojiPicker = null; } }
  function openEmojiPicker(anchorBtn, targetId){
    closeEmojiPicker();
    emojiPicker = document.createElement('div'); emojiPicker.className = 'tdoc-emoji-picker'; emojiPicker.style.position = 'fixed';
    emojiPicker.innerHTML = window.TDOC_CHROME.buildEmojiPicker();
    document.body.appendChild(emojiPicker);
    var r = anchorBtn.getBoundingClientRect();
    emojiPicker.style.visibility = 'hidden'; emojiPicker.style.top = '0'; emojiPicker.style.left = '0';
    var pw = emojiPicker.offsetWidth, ph = emojiPicker.offsetHeight;
    var left = r.left, top = r.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, r.right - pw);
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
    emojiPicker.style.top = top + 'px'; emojiPicker.style.left = left + 'px'; emojiPicker.style.visibility = '';
    emojiPicker.querySelectorAll('button').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation(); var emoji = b.getAttribute('data-emoji'); closeEmojiPicker(); postReaction(targetId, emoji); }); });
  }
  // Footer reveals only when the doc is scrolled to its end (or the doc is short
  // enough to fit). d = {scrollY, innerH, height} from the frame probe.
  function updateFooter(d){
    var f = document.querySelector('.tdoc-footer'); if (!f) return;
    var atBottom = !d || !d.innerH || (d.scrollY + d.innerH) >= (d.height - 4);
    f.classList.toggle('tdoc-footer-show', !!atBottom);
  }
  // Floating comment card (real .tdoc-margin-comment markup + CSS). The card
  // stays glued to its pin: positionCard() re-runs whenever pins move (scroll/
  // resize), and the card closes if its pin scrolls out of view. Clicking a pin
  // opens the card WITHOUT scrolling the doc.
  function closeCard(){ var el = document.querySelector('.tdoc-margin-comment'); if (el) el.remove(); openCardId = null; }
  function pinTopFor(id){ for (var i=0;i<pinData.length;i++){ if (pinData[i].id===id) return BAR + (pinData[i].docY - frameScrollY); } return null; }
  function positionCard(){
    var card = document.querySelector('.tdoc-margin-comment'); if (!card || openCardId == null) return;
    var top = pinTopFor(openCardId);
    if (top == null || top < BAR - 40 || top > window.innerHeight - 8){ card.remove(); openCardId = null; return; } // pin off-screen → close
    card.style.top = Math.max(BAR + 4, Math.min(top, window.innerHeight - card.offsetHeight - 8)) + 'px';
    card.style.left = Math.max(8, Math.min(pinX() + 34, window.innerWidth - (card.offsetWidth || 280) - 8)) + 'px';
  }
  function openCard(id){
    closeCard();
    var c = commentsById[id]; if (!c || !window.TDOC_CHROME) return;
    var card = document.createElement('div');
    card.className = 'tdoc-margin-comment tdoc-floating-open';
    card.setAttribute('data-comment-id', id);
    card.innerHTML = window.TDOC_CHROME.buildCard(c, (cfg.identity && cfg.identity.login) || 'anon');
    card.addEventListener('click', function(e){ e.stopPropagation(); });
    document.body.appendChild(card);
    openCardId = id;
    // reactions: click a chip to toggle, click + to pick
    card.querySelectorAll('.tdoc-react-chip').forEach(function(chip){ chip.addEventListener('click', function(e){ e.stopPropagation(); postReaction(chip.getAttribute('data-target-id') || id, chip.getAttribute('data-emoji')); }); });
    card.querySelectorAll('.tdoc-react-add').forEach(function(add){ add.addEventListener('click', function(e){ e.stopPropagation(); openEmojiPicker(add, add.getAttribute('data-target-id') || id); }); });
    // replies expand/collapse
    var rtog = card.querySelector('.tdoc-replies-toggle'), rlist = card.querySelector('.tdoc-replies');
    if (rtog && rlist) rtog.addEventListener('click', function(e){ e.stopPropagation(); var o = rlist.classList.toggle('open'); rtog.classList.toggle('open', o); positionCard(); });
    // reply: show form + submit (POST with parent_id)
    var rbtn = card.querySelector('.tdoc-reply-toggle'), rform = card.querySelector('.tdoc-reply-form');
    if (rbtn && rform) rbtn.addEventListener('click', function(e){ e.stopPropagation(); var o = rform.classList.toggle('open'); if (o){ var t = rform.querySelector('textarea'); if (t) t.focus(); } positionCard(); });
    if (rform){ var sub = rform.querySelector('.tdoc-reply-submit'), rta = rform.querySelector('textarea');
      if (sub && rta){ sub.addEventListener('click', function(e){ e.stopPropagation(); postReply(id, rta.value, sub); });
        rta.addEventListener('keydown', function(e){ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') postReply(id, rta.value, sub); }); } }
    // delete (1:1 with overlay: deletes on click, no native confirm)
    var del = card.querySelector('.del');
    if (del) del.addEventListener('click', function(e){ e.stopPropagation();
      fetch('/api/comments?slug=' + encodeURIComponent(cfg.slug) + '&id=' + encodeURIComponent(id) + '&version=' + encodeURIComponent(cfg.version), { method:'DELETE' })
        .then(function(r){ if (r.ok){ closeCard(); loadComments(); } else { r.json().catch(function(){return {};}).then(function(x){ alert('Could not delete: ' + (x.error || x.message || ('HTTP ' + r.status))); }); } });
    });
    positionCard();
  }
  // Full reconcile — only on tdoc:pins (comment set changed). Creates/removes
  // pin elements against the cached pinEls map, then positions them. O(P) once.
  function positionPins(){
    var seen = {};
    pinData.forEach(function(p){
      seen[p.id] = 1;
      var el = pinEls[p.id];
      if (!el){
        el = document.createElement('div'); el.className='tdoc-pin'; el.setAttribute('data-id', p.id);
        el.setAttribute('role','button'); el.setAttribute('tabindex','0');
        el.innerHTML = window.TDOC_CHROME.avatarHtml({ login: p.login, avatar_url: p.avatar_url }, 'tdoc-pin-anon');
        el.addEventListener('click', (function(id){ return function(ev){ ev.stopPropagation(); openCard(id); }; })(p.id));
        document.body.appendChild(el);
        pinEls[p.id] = el;
      }
    });
    Object.keys(pinEls).forEach(function(id){ if (!seen[id]){ pinEls[id].remove(); delete pinEls[id]; } });
    repositionPins();
  }
  // Cheap — on every scroll frame. No DOM query/rebuild: just move cached pins.
  function repositionPins(){
    var left = pinX() + 'px';
    for (var i = 0; i < pinData.length; i++){
      var p = pinData[i], el = pinEls[p.id]; if (!el) continue;
      var top = BAR + (p.docY - frameScrollY);
      el.hidden = !(top >= BAR - 20 && top <= window.innerHeight - 8);
      el.style.top = Math.max(BAR + 4, top) + 'px';
      el.style.left = left;
    }
    positionCard();
  }

  // Publish flow — self-contained chrome modal (real .tdoc-modal CSS), 1:1 with
  // overlay.js showPublishModal. POSTs /api/publish; no doc-DOM access.
  function closeAuxModal(){ var m = document.getElementById('tdoc-aux-modal'); if (m) m.remove(); }
  function showPublishModal(){
    closeAuxModal();
    var esc = window.TDOC_CHROME.escapeHtml, bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg'; bg.id = 'tdoc-aux-modal';
    bg.innerHTML = '<div class="tdoc-modal" data-state="idle"><h3>Publish this doc</h3>' +
      '<p>We\\'ll deploy this so anyone with the link can read it. GitHub sign-in is required for commenting.</p>' +
      '<div class="step"><span class="n">·</span><span>Slug: <code id="tdoc-pub-slug">' + esc(cfg.slug) + '</code></span></div>' +
      '<div class="status" id="tdoc-pub-status" style="margin-top:10px;display:none;"></div>' +
      '<div id="tdoc-pub-result" style="margin-top:10px;display:none;"><div class="code" style="font-size:14px;letter-spacing:0;text-align:left;" id="tdoc-pub-url"></div>' +
      '<div class="actions" style="justify-content:flex-start;gap:8px;"><button class="primary" id="tdoc-pub-copy">Copy link</button><button id="tdoc-pub-open">View live →</button></div></div>' +
      '<div class="actions"><button id="tdoc-pub-cancel">Cancel</button><button class="primary" id="tdoc-pub-go">Publish</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function(e){ if (e.target === bg) closeAuxModal(); });
    document.getElementById('tdoc-pub-cancel').onclick = closeAuxModal;
    document.getElementById('tdoc-pub-go').onclick = function(){
      var status = document.getElementById('tdoc-pub-status'), go = document.getElementById('tdoc-pub-go');
      status.style.display = 'block'; status.textContent = 'Publishing — this can take 20–60s on first run…'; go.disabled = true;
      fetch('/api/publish', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug }) })
        .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
        .then(function(x){
          if (!x.ok || x.d.error){ status.textContent = 'Failed: ' + (x.d.error || x.d.message || 'unknown'); go.disabled = false; return; }
          var url = x.d.url; status.style.display = 'none';
          var res = document.getElementById('tdoc-pub-result'); res.style.display = 'block';
          document.getElementById('tdoc-pub-url').textContent = url;
          document.getElementById('tdoc-pub-copy').onclick = function(){ copyText(url); };
          document.getElementById('tdoc-pub-open').onclick = function(){ window.open(url, '_blank'); };
          go.style.display = 'none'; document.getElementById('tdoc-pub-cancel').textContent = 'Done';
        })
        .catch(function(e){ status.textContent = 'Failed: ' + e.message; go.disabled = false; });
    };
  }
  function close(){ var el = document.querySelector('.tdoc-popup'); if (el) el.remove(); pending = null; }
  function open(d){
    close();
    pending = { text: d.text, context_before: d.context_before, context_after: d.context_after };
    var pop = document.createElement('div');
    pop.className = 'tdoc-popup';
    // Real composer markup from the shared chrome module (1:1 with the overlay).
    pop.innerHTML = window.TDOC_CHROME.buildComposer({ anchor: { kind: d.kind || 'text', text: d.text, label: d.label }, needsSignIn: false });
    document.body.appendChild(pop);
    // Pin the composer to the caret line (frame coords + bar height). Shell body
    // is fixed (never scrolls), so .tdoc-popup is position:fixed.
    var r = d.rect || { bottom: 0, left: 8 };
    var top = BAR + (r.bottom || 0) + 8;
    var left = Math.max(8, Math.min((r.left || 8), window.innerWidth - (pop.offsetWidth || 320) - 8));
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
    var ta = pop.querySelector('textarea'), submit = pop.querySelector('.submit'), x = pop.querySelector('.x');
    if (x) x.addEventListener('click', close);
    if (ta) ta.focus();
    if (submit) submit.addEventListener('click', function(){ postComment(ta ? ta.value : '', submit); });
    if (ta) ta.addEventListener('keydown', function(e){ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') postComment(ta.value, submit); });
  }
  function postComment(text, btn){
    text = (text||'').trim();
    if (!text || !pending) { close(); return; }
    btn.disabled = true;
    fetch('/api/comments', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ slug: cfg.slug, version: cfg.version, text: text,
        anchor: { kind:'text', text: pending.text, context_before: pending.context_before, context_after: pending.context_after } })
    }).then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(){ close(); loadComments(); })   // re-resolve so the new pin appears
      .catch(function(){ btn.disabled = false; btn.textContent = 'Retry'; });
  }
  window.addEventListener('message', function(e){
    if (!frameWin() || e.source !== frameWin()) return;      // validate by window identity (opaque origin)
    var d = e.data; if (!d || d.source !== 'tdoc-frame') return;
    if (d.type === 'tdoc:selection') open(d);
    else if (d.type === 'tdoc:cleared') { if (!document.querySelector('.tdoc-popup textarea:focus')) close(); closeCard(); closeMenus(); closeEmojiPicker(); }
    else if (d.type === 'tdoc:ready') { layout(); loadComments(); sendFrame({ type:'tdoc:theme', theme: document.documentElement.getAttribute('data-tdoc-theme') === 'dark' ? 'dark' : 'light' }); }
    else if (d.type === 'tdoc:pins') { pinData = d.pins || []; frameScrollY = d.scrollY || 0; if (d.articleRight) gutterRight = d.articleRight; positionPins(); }
    else if (d.type === 'tdoc:scroll') { frameScrollY = d.scrollY || 0; repositionPins(); updateFooter(d); }
    else if (d.type === 'tdoc:docMarkdown' && copyReq) {
      var md = d.markdown || '';
      if (copyReq.includeComments && commentList.length) md += '\\n\\n---\\n\\n## Comments\\n\\n' + commentList.map(commentToMd).join('\\n---\\n\\n');
      var btn = document.getElementById('tdoc-copy-md-btn'); copyReq = null;
      copyText(md).then(function(ok){ if (btn){ var s=btn.querySelector('span'); if(s){ var o=s.textContent; s.textContent=ok?'Copied':'Copy failed'; setTimeout(function(){ s.textContent=o; },1200);} } });
    }
  });
  // --- bar handlers (shell-safe subset; Copy-markdown/Publish/Share deferred
  //     until the probe supplies doc text / the publish flow is ported) ---
  function wire(sel, ev, fn){ var el = document.querySelector(sel); if (el) el.addEventListener(ev, fn); }
  // Theme toggle: paint the shell; frame theme comes with the probe theme msg.
  (function(){
    var KEY='tdoc-theme';
    function apply(t){ document.documentElement.setAttribute('data-tdoc-theme', t); var b=document.getElementById('tdoc-theme-btn'); if(b) b.setAttribute('aria-pressed', t==='dark'?'true':'false'); }
    try { if (localStorage.getItem(KEY)==='dark') apply('dark'); } catch(e){}
    wire('#tdoc-theme-btn','click',function(){ var dark=document.documentElement.getAttribute('data-tdoc-theme')!=='dark'; apply(dark?'dark':'light'); try{localStorage.setItem(KEY,dark?'dark':'light');}catch(e){} sendFrame({type:'tdoc:theme',theme:dark?'dark':'light'}); });
  })();
  // My docs
  wire('#tdoc-bar-mark','click',function(){ location.href='/me'; });
  // Publish (local mode)
  wire('#tdoc-publish-btn','click',function(e){ e.stopPropagation(); showPublishModal(); });
  // Menus open by toggling .open on the MENU element (matches the real CSS
  // .tdoc-menu.open / .tdoc-version-menu.open).
  function toggleMenu(id){ var m=document.getElementById(id); if(!m) return; var was=m.classList.contains('open'); closeMenus(); if(!was) m.classList.add('open'); }
  function closeMenus(){ document.querySelectorAll('.tdoc-menu.open, .tdoc-version-menu.open, .tdoc-secondary-menu.open').forEach(function(m){ m.classList.remove('open'); }); }
  wire('#tdoc-version-toggle','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-version-menu'); });
  document.querySelectorAll('.tdoc-version-menu [data-version]').forEach(function(b){ b.addEventListener('click', function(){ location.href='/d/'+encodeURIComponent(cfg.slug)+'/v/'+b.getAttribute('data-version'); }); });
  wire('#tdoc-copy-md-btn','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-copy-md-menu'); });
  document.querySelectorAll('#tdoc-copy-md-menu [data-mode]').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation(); closeMenus(); copyReq={ includeComments: b.getAttribute('data-mode')==='doc-comments' }; sendFrame({ type:'tdoc:copyDoc', requestId: Date.now() }); }); });
  wire('#tdoc-more-btn','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-secondary-menu'); });
  document.addEventListener('click', function(){ closeMenus(); closeEmojiPicker(); closeCard(); });
  layout();
})();`;
}

function injectOverlay(html, slug, version, nonce) {
  html = forceWidgetSandbox(html);
  if (ONBOARD_SLUGS.has(slug)) {
    try {
      const onboard = fs.readFileSync(ONBOARD_PATH, 'utf8');
      const tag = `<script${nonce ? ` nonce="${nonce}"` : ''}>${onboard}</script>`;
      html = html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : html + tag;
    } catch {}
  }
  // The shared device flow goes in before the overlay, which calls into it.
  try {
    const signin = fs.readFileSync(SIGNIN_PATH, 'utf8');
    const tag = `<script${nonce ? ` nonce="${nonce}"` : ''}>${signin}</script>`;
    html = html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : html + tag;
  } catch {}
  const overlay = fs.readFileSync(OVERLAY_PATH, 'utf8');
  // Hand the overlay the full version list so the bar can offer a version
  // picker. Read straight from meta.json; ignore failures and fall back to
  // the current version only.
  let versions = [{ n: version }];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8'));
    if (Array.isArray(meta.versions) && meta.versions.length) {
      versions = meta.versions.map(v => ({ n: v.n, created: v.created || null }));
    }
  } catch {}
  // nonce is stamped onto BOTH injected <script> tags so only they run under
  // the CSP set by cspHeader() above — author content in `html` has no nonce
  // and is inert.
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const ident = e2eIdentity();
  const cfg = `<script${nonceAttr}>window.__TDOC__ = ${safeJsonForScript({
    slug, version,
    identity: ident,
    isOwner: !!(ident && E2E_OWNER && ident.login.toLowerCase() === E2E_OWNER.toLowerCase()),
    authConfigured: !!ident, mode: 'local', versions,
  })};</script>`;
  const inject = `${cfg}\n<script${nonceAttr}>${overlay}</script>`;
  if (html.includes('</body>')) return html.replace('</body>', `${inject}\n</body>`);
  return html + inject;
}

// Always returns an array for a comments file. A comments.json that parses to a
// non-array (corrupt / hand-edited to `{}`) would otherwise crash the .filter/
// .find/.push that follow every read (#33 hardening).
function readCommentFile(file) {
  const v = readJson(file, []);
  return Array.isArray(v) ? v : [];
}

// Fold the flat comment list to a per-version SNAPSHOT, matching the worker's
// event-fold semantics (worker.js snapshotAt): reading a doc "as of version N"
// shows each comment exactly as it existed then. The local store is a flat
// record (not an event log), but it carries enough fields to fold:
//   - created_in > N        → the comment didn't exist yet → hide it.
//   - applied_in > N        → it wasn't resolved yet at N → show status 'open'
//                             and drop applied_in (no "✓ fixed" on a past version).
//   - replies made after N  → fold out (a reply added in v4 isn't on v3).
// Without this the local dev server returned the LATEST status for every
// version, so resolving a comment in v4 made it look resolved on v2/v3 too.
function foldCommentsAtVersion(comments, version) {
  const V = Number(version);
  if (!Number.isFinite(V)) return comments; // no version → latest state (back-compat)
  const out = [];
  for (const c of comments) {
    const createdIn = Number(c.created_in != null ? c.created_in : c.version) || 1;
    if (createdIn > V) continue; // didn't exist yet at version V
    const appliedIn = c.applied_in != null ? Number(c.applied_in) : null;
    const resolvedByV = c.status === 'applied' && appliedIn != null && appliedIn <= V;
    // Reactions are stored flat (no per-reaction version), so spreading `...c`
    // would carry the CURRENT reactions — including the agent verdict emoji
    // (✅/🟡/❓ written by setAgentReaction) — onto every past snapshot. On a
    // version where the comment folds to 'open' that's a contradictory
    // "resolved" emoji, so drop the agent verdict there.
    let reactions = c.reactions;
    if (!resolvedByV && reactions) {
      const filtered = {};
      for (const [emoji, users] of Object.entries(reactions)) {
        const agentActor = c.agent_actor || 'tdoc-agent';
        const rest = Array.isArray(users) ? users.filter(u => !((u === 'tdoc-agent' || u === agentActor) && AGENT_VERDICT_EMOJI.has(emoji))) : users;
        if (rest && rest.length) filtered[emoji] = rest;
      }
      reactions = filtered;
    }
    const snap = {
      ...c,
      status: resolvedByV ? 'applied' : 'open',
      applied_in: resolvedByV ? appliedIn : undefined,
      reactions,
      replies: Array.isArray(c.replies)
        ? c.replies.filter(r => (Number(r.version != null ? r.version : createdIn) || createdIn) <= V)
        : [],
    };
    out.push(snap);
  }
  return out;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function indexPage() {
  const slugs = fs.readdirSync(ROOT).filter(f => {
    try { return fs.statSync(path.join(ROOT, f)).isDirectory() && !f.startsWith('.'); }
    catch { return false; }
  });
  const rows = slugs.map(slug => {
    const meta = readJson(path.join(ROOT, slug, 'meta.json'), { title: slug, versions: [] });
    const latest = meta.versions?.[meta.versions.length - 1]?.n || 1;
    const versionCount = Array.isArray(meta.versions) && meta.versions.length ? meta.versions.length : 1;
    return `<tr>
      <td><a href="/d/${encodeURIComponent(slug)}/v/${latest}">${escHtml(meta.title || slug)}</a></td>
      <td>${escHtml(slug)}</td>
      <td>v${latest}</td>
      <td><button class="del" data-slug="${escHtml(slug)}" data-versions="${versionCount}">Delete</button></td>
    </tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>tdoc</title>
<style>
  :root {
    --td-accent: #1652f0; --td-accent-hover: #1245d0;
    --td-danger: #b42318; --td-danger-hover: #931c14;
    --td-ink: #111; --td-muted: #666; --td-line: #eee;
  }
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; color: var(--td-ink); }
  h1 { font-size: 28px; margin: 0 0 4px; color: var(--td-accent); }
  .sub { color: var(--td-muted); margin: 0 0 32px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--td-line); }
  th { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.04em; }
  a { color: var(--td-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 40px 0; text-align: center; }
  .del { font: 12px system-ui; color: var(--td-danger); background: none; border: 1px solid #e0c9c9; border-radius: 6px; padding: 3px 9px; cursor: pointer; transition: background .12s, color .12s; }
  .del:hover { background: var(--td-danger); color: #fff; border-color: var(--td-danger); }
  /* Styled confirm modal — replaces window.confirm() (JUL-36). Standalone
     copy of the doc overlay's .tdoc-modal-bg/.tdoc-modal visual language;
     this page doesn't load overlay.js. */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: var(--td-ink); border-radius: 12px; padding: 26px; width: 420px; max-width: calc(100vw - 32px); box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 10px; font-size: 18px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .tdoc-modal button { font: inherit; cursor: pointer; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button.danger { background: var(--td-danger); border-color: var(--td-danger); color: #fff; }
  .tdoc-modal button.danger:hover { background: var(--td-danger-hover); border-color: var(--td-danger-hover); }
</style></head><body>
<h1>tdoc</h1><p class="sub">Prompt-native documents.</p>
${slugs.length === 0 ? '<p class="empty">No docs yet. Try <code>/tdoc new &lt;prompt&gt;</code>.</p>' :
  `<table><thead><tr><th>Title</th><th>Slug</th><th>Version</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
<script>
function showConfirm({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.innerHTML = '<div class="tdoc-modal">' +
      '<h3></h3><p></p>' +
      '<div class="actions">' +
        '<button type="button" data-act="cancel">Cancel</button>' +
        '<button type="button" data-act="go"></button>' +
      '</div></div>';
    bg.querySelector('h3').textContent = title;
    bg.querySelector('p').innerHTML = body;
    const goBtn = bg.querySelector('[data-act="go"]');
    goBtn.textContent = confirmLabel;
    if (danger) goBtn.className = 'danger';
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-act="cancel"]').onclick = () => done(false);
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    goBtn.onclick = () => done(true);
    document.body.appendChild(bg);
  });
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.del');
  if (!b) return;
  const slug = b.dataset.slug;
  let comments = 0;
  try {
    const r = await fetch('/api/comments?slug=' + encodeURIComponent(slug));
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) {
        for (const c of list) comments += 1 + (Array.isArray(c.replies) ? c.replies.length : 0);
      }
    }
  } catch {}
  // Irreversible: name exactly what disappears before acting.
  const proceed = await showConfirm({
    title: 'Delete "' + slug + '"?',
    body: 'This permanently removes <b>' + b.dataset.versions + ' version(s)</b> and <b>' + comments +
      ' comment(s)</b> — the local copy AND the published copy (if any). No undo.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!proceed) return;
  b.disabled = true; b.textContent = 'Deleting…';
  const r = await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
  if (r.ok) { b.closest('tr').remove(); }
  else { const d = await r.json().catch(() => ({})); alert('Delete failed: ' + (d.error || r.status)); b.disabled = false; b.textContent = 'Delete'; }
});
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
 try {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // `service` is the identity marker health checks grep for — a foreign
  // process answering 200 on this port must not pass as tdoc (seen in the
  // wild: a daemon from another product bound 7878).
  if (p === '/api/ping') return json(res, 200, { ok: true, service: 'tdoc' });

  if (p === '/api/notifications' && req.method === 'GET') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const inbox = readJson(inboxFile(ident.login), { items: [] });
    const items = Array.isArray(inbox.items) ? inbox.items.filter(Boolean) : [];
    const unread = items.filter(i => !i.read);
    const ordered = unread.concat(items.filter(i => i.read));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return json(res, 200, {
      items: ordered.slice(offset, offset + 20),
      unread: unread.length,
      has_more: offset + 20 < ordered.length,
    });
  }
  if (p === '/api/notifications/unread' && req.method === 'GET') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const inbox = readJson(inboxFile(ident.login), { items: [] });
    const items = Array.isArray(inbox.items) ? inbox.items : [];
    return json(res, 200, { unread: items.filter(i => i && !i.read).length });
  }
  if (p === '/api/notifications/read' && req.method === 'POST') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const body = await readBody(req);
    const file = inboxFile(ident.login);
    const inbox = readJson(file, { items: [] });
    const items = (Array.isArray(inbox.items) ? inbox.items : []).map((i) => {
      if (!i) return i;
      if (Array.isArray(body.ids) && body.ids.includes(i.id)) return { ...i, read: true };
      if (body.comment_id && i.comment_id === body.comment_id) return { ...i, read: true };
      return i;
    });
    writeJson(file, { items });
    return json(res, 200, { ok: true, unread: items.filter(i => i && !i.read).length });
  }

  if (p === '/tdoc_logo.svg') {
    const logoPath = path.join(__dirname, '..', 'assets', 'tdoc_logo.svg');
    if (!fs.existsSync(logoPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(logoPath), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  if (p === '/tdoc_logo.png') {
    const logoPath = path.join(__dirname, '..', 'assets', 'tdoc_logo.png');
    if (!fs.existsSync(logoPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(logoPath), {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    });
  }

  if (p === '/') return send(res, 200, indexPage(), { 'Content-Type': 'text/html; charset=utf-8' });
  // Overlay mark always goes to /me. Local studio has no hosted catalog, so
  // send them to the local index — the analog of My docs.
  if (p === '/me') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  const widgetMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/widget\/([^/]+)\/?$/);
  if (widgetMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    const [, rawSlug, vStr, rawName] = widgetMatch;
    const slug = safeSlug(rawSlug);
    if (!slug || !isValidWidgetName(rawName)) return send(res, 400, 'invalid slug or widget');
    const dest = req.headers['sec-fetch-dest'];
    if (!isWidgetFrameRequest(dest)) return send(res, 403, 'widget must be framed');
    const file = path.join(ROOT, slug, `v${vStr}`, 'widgets', `${rawName}.html`);
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr} widget ${rawName}`);
    const body = req.method === 'HEAD' ? '' : fs.readFileSync(file, 'utf8');
    return send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': widgetCspHeader(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Vary': 'Sec-Fetch-Dest',
    });
  }

  // Author document frame (shell mode). Served under a CSP `sandbox` (opaque
  // origin), gated on Sec-Fetch-Dest: iframe like widgets, so it can only be
  // loaded inside the shell — never top-level.
  const frameMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/frame\/?$/);
  if (frameMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    const [, rawSlug, vStr] = frameMatch;
    const slug = safeSlug(rawSlug);
    if (!slug) return send(res, 400, 'invalid slug');
    if (!isWidgetFrameRequest(req.headers['sec-fetch-dest'])) return send(res, 403, 'document frame must be framed');
    const file = path.join(ROOT, slug, `v${vStr}`, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr}`);
    const nonce = crypto.randomBytes(16).toString('hex');
    let body = '';
    if (req.method !== 'HEAD') {
      body = forceWidgetSandbox(fs.readFileSync(file, 'utf8'));
      // Inject the anchoring probe — the only tdoc code allowed into the author
      // DOM. Nonced so it runs under the frame CSP while author <script> stays
      // inert (same guarantee as the single-origin path).
      try {
        const probe = fs.readFileSync(FRAME_PROBE_PATH, 'utf8');
        const tag = `<script nonce="${nonce}">${probe}</script>`;
        body = body.includes('</body>') ? body.replace('</body>', `${tag}\n</body>`) : body + tag;
      } catch {}
    }
    return send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': frameCspHeader(nonce),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Vary': 'Sec-Fetch-Dest',
    });
  }

  const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
  if (docMatch) {
    const [, rawSlug, vStr] = docMatch;
    const slug = safeSlug(rawSlug);
    if (!slug) return send(res, 400, 'invalid slug');
    const file = path.join(ROOT, slug, `v${vStr}`, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr}`);
    const nonce = crypto.randomBytes(16).toString('hex');
    // Shell mode (opt-in): render chrome + embed the author frame instead of
    // inlining the overlay into the author document. Default path unchanged.
    if (url.searchParams.get('shell') === '1') {
      return send(res, 200, shellDocument(slug, Number(vStr), nonce), {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': cspHeader(nonce),
      });
    }
    const html = fs.readFileSync(file, 'utf8');
    return send(res, 200, injectOverlay(html, slug, Number(vStr), nonce), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': cspHeader(nonce),
    });
  }

  // --- COMMENTS (anonymous) ---
  if (p === '/api/comments' && req.method === 'GET') {
    const slug = safeSlug(url.searchParams.get('slug'));
    if (!slug) return json(res, 400, { error: 'invalid or missing slug' });
    const all = readCommentFile(path.join(ROOT, slug, 'comments.json'));
    // Fold to the requested version's snapshot so past versions keep their
    // historical status (matches the worker). Missing version → latest state.
    const ver = url.searchParams.get('version');
    return json(res, 200, ver != null ? foldCommentsAtVersion(all, ver) : all);
  }

  if (p === '/api/comments' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { version, anchor, text, parent_id } = body;
    if (!slug || !text) return json(res, 400, { error: 'invalid slug or missing text' });
    const file = path.join(ROOT, slug, 'comments.json');
    const comments = readCommentFile(file);
    const created = new Date().toISOString();
    if (parent_id) {
      const thread = comments.find(c => c.id === parent_id)
        || comments.find(c => (c.replies || []).some(r => r.id === parent_id));
      if (!thread) return json(res, 404, { error: 'parent_not_found' });
      if (!Array.isArray(thread.replies)) thread.replies = [];
      // Persist the version the reply was made at so foldCommentsAtVersion can
      // scope it — without this the reply record has no `version` and the fold's
      // `r.version` check falls back to the parent's created_in, so replies were
      // never hidden on older versions (diverging from the worker).
      // parent_id is the immediate parent (top-level or another reply).
      const reply = { id: `r_${Date.now()}`, parent_id, text, version: Number(version) || 1, author: e2eIdentity(), created, reactions: {} };
      thread.replies.push(reply);
      writeJson(file, comments);
      if (E2E_USER) {
        const parentA = localRecordAuthor(comments, parent_id);
        let title = slug;
        try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
        localDeliver(parentA && parentA.login, {
          kind: 'reply', slug, version: Number(version) || 1, comment_id: reply.id,
          thread_id: thread.id, target_id: parent_id, actor: reply.author, preview: text, title, at: created,
        });
      }
      return json(res, 200, reply);
    }
    const entry = {
      id: `c_${Date.now()}`,
      version: version || 1,
      anchor: anchor || null,
      text,
      author: e2eIdentity(),
      status: 'open',
      created,
      replies: [],
      reactions: {}
    };
    comments.push(entry);
    writeJson(file, comments);
    if (E2E_USER && E2E_OWNER) {
      let title = slug;
      try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
      localDeliver(E2E_OWNER, {
        kind: 'comment', slug, version: Number(version) || 1, comment_id: entry.id,
        thread_id: entry.id, actor: entry.author, preview: text, title, at: created,
      });
    }
    return json(res, 200, entry);
  }

  // Agent reply: posts a reply attributed to the acting agent, updates the
  // parent comment's status, AND drops a status emoji on the parent's
  // reactions row. Each status maps to a different emoji so the user can
  // tell at a glance from the comment list which were addressed:
  //   applied  -> ✅
  //   partial  -> 🟡
  //   question -> ❓
  // The agent always clears its previous emoji on this comment first, so a
  // stale "applied" emoji can't outlive a later "question" outcome.
  if (p === '/api/agent/reply' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { parent_id, text, status: agentStatus, applied_in } = body;
    if (!slug || !parent_id || !text) return json(res, 400, { error: 'invalid slug or missing parent_id/text' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    const parent = all.find(c => c.id === parent_id)
      || all.find(c => (c.replies || []).some(r => r.id === parent_id));
    if (!parent) return json(res, 404, { error: 'parent_not_found' });
    if (!Array.isArray(parent.replies)) parent.replies = [];
    const agent = agentIdentity(body, process.env);
    parent.agent_actor = agent.login;
    const reply = {
      id: `r_${Date.now()}`,
      parent_id,
      text,
      // Scope the agent reply to the version it was applied at (falls back to
      // the request version, then 1) so the fold can hide it on earlier ones.
      version: Number(applied_in != null ? applied_in : body.version) || 1,
      author: agent,
      agent_status: ['applied', 'partial', 'question'].includes(agentStatus) ? agentStatus : null,
      created: new Date().toISOString(),
      reactions: {},
    };
    parent.replies.push(reply);
    if (agentStatus === 'applied') {
      parent.status = 'applied';
      if (applied_in) parent.applied_in = applied_in;
    } else if (agentStatus === 'question' || agentStatus === 'partial') {
      parent.status = 'open';
    }
    setAgentReaction(parent, agentStatus, agent.login);
    writeJson(file, all);
    return json(res, 200, reply);
  }

  // Re-anchor an existing comment without changing its text/thread state.
  // Used by the "click unanchored, then select new text" flow. Also clears
  // the agent's prior status emoji + flips the comment back to "open" — a
  // re-anchor means the comment now points at different text, so any old
  // agent verdict is stale.
  if (p === '/api/comments' && req.method === 'PATCH') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { id, anchor } = body;
    if (!slug || !id || !anchor) return json(res, 400, { error: 'invalid slug or missing id/anchor' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    const target = all.find(c => c.id === id);
    if (!target) return json(res, 404, { error: 'not_found' });
    target.anchor = anchor;
    target.status = 'open';
    delete target.applied_in;
    setAgentReaction(target, null, target.agent_actor || 'tdoc-agent');
    delete target.agent_actor;
    writeJson(file, all);
    return json(res, 200, target);
  }

  if (p === '/api/comments' && req.method === 'DELETE') {
    // DELETE carries no body, so the JSON content-type check doesn't apply;
    // a cross-origin DELETE is not a CORS-simple request, but reject non-local
    // Origins explicitly for defense in depth.
    const dOrigin = req.headers['origin'];
    if (dOrigin) {
      try { const h = new URL(dOrigin).hostname; if (!['localhost','127.0.0.1','::1'].includes(h)) return json(res, 403, { error: 'forbidden' }); }
      catch { return json(res, 403, { error: 'forbidden' }); }
    }
    const slug = safeSlug(url.searchParams.get('slug'));
    const id = url.searchParams.get('id');
    if (!slug || !id) return json(res, 400, { error: 'invalid slug or missing id' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    const top = all.find(c => c.id === id);
    if (top) {
      writeJson(file, all.filter(c => c.id !== id));
      return json(res, 200, { ok: true });
    }
    for (const c of all) {
      if (!Array.isArray(c.replies)) continue;
      if (c.replies.some(r => r.id === id)) {
        c.replies = c.replies.filter(r => r.id !== id);
        writeJson(file, all);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not_found' });
  }

  // Reactions: anonymous on local, keyed by an "anon" pseudo-user so toggling works
  if (p === '/api/reactions' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { comment_id, emoji } = body;
    if (!slug || !comment_id || !emoji) return json(res, 400, { error: 'invalid slug or missing comment_id/emoji' });
    if (emoji.length === 0 || emoji.length > 8) return json(res, 400, { error: 'invalid_emoji' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    function findTarget(list) {
      for (const c of list) {
        if (c.id === comment_id) return c;
        if (Array.isArray(c.replies)) {
          for (const r of c.replies) if (r.id === comment_id) return r;
        }
      }
      return null;
    }
    const target = findTarget(all);
    if (!target) return json(res, 404, { error: 'not_found' });
    if (!target.reactions) target.reactions = {};
    const users = target.reactions[emoji] || [];
    const me = E2E_USER || 'anon';
    const idx = users.indexOf(me);
    const added = idx < 0;
    if (idx >= 0) users.splice(idx, 1);
    else users.push(me);
    if (users.length === 0) delete target.reactions[emoji];
    else target.reactions[emoji] = users;
    writeJson(file, all);
    if (added && E2E_USER && target.author && target.author.login) {
      let title = slug;
      try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
      const thread = all.find(c => c.id === comment_id || (c.replies || []).some(r => r.id === comment_id));
      const V = Number(body.version) || Number(target.version) || Number(thread && thread.version) || 1;
      localDeliver(target.author.login, {
        kind: 'reaction', slug, version: V, comment_id, thread_id: thread && thread.id,
        target_id: comment_id, actor: e2eIdentity(), title, emoji,
      });
    }
    return json(res, 200, { ok: true, reactions: target.reactions });
  }

  // --- PUBLISH ---
  // Shells out to bin/tdoc-publish <slug>. Returns { url }. Slow (20–60s on
  // first run); the browser modal shows a "this can take a minute" hint.
  // Honor TDOC_DRY_PUBLISH=1 for tests — echoes "would publish <slug>" and
  // returns a fake URL without invoking wrangler.
  if (p === '/api/delete' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    if (!slug) return json(res, 400, { error: 'invalid slug' });
    if (!fs.existsSync(path.join(ROOT, slug))) return json(res, 404, { error: 'not found' });
    const bin = path.join(__dirname, '..', 'bin', 'tdoc-delete');
    if (!fs.existsSync(bin)) return json(res, 500, { error: 'tdoc-delete script not found' });
    // Same spawn hardening as /api/publish: error listener, hard timeout,
    // bounded output. Deleting is quick; 60s covers a slow unpublish curl.
    const args = body.published === false ? [slug, '--local-only'] : [slug];
    const proc = spawn(bin, args, { env: process.env });
    let out = '', err = '', settled = false, killed = false;
    const CAP = 64 * 1024;
    const append = (buf, d) => (buf.length < CAP ? buf + d : buf);
    const settle = (status, obj) => { if (settled) return; settled = true; clearTimeout(timer); json(res, status, obj); };
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000); }, 60000);
    proc.on('error', (e) => settle(500, { error: 'delete_spawn_failed', detail: String(e && e.message || e) }));
    proc.stdout.on('data', d => { out = append(out, d); });
    proc.stderr.on('data', d => { err = append(err, d); });
    proc.on('close', (code) => {
      if (killed) return settle(504, { error: 'delete_timeout', stdout: out, stderr: err });
      if (code !== 0) return settle(500, { error: 'delete_failed', code, stdout: out, stderr: err });
      settle(200, { ok: true, stdout: out });
    });
    return;
  }

  if (p === '/api/publish' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    if (!slug) return json(res, 400, { error: 'invalid slug' });
    if (process.env.TDOC_DRY_PUBLISH === '1') {
      return json(res, 200, {
        ok: true,
        dry: true,
        url: `https://example.workers.dev/d/${slug}/v/1`,
        stdout: `would publish ${slug}\n`,
      });
    }
    const bin = path.join(__dirname, '..', 'bin', 'tdoc-publish');
    if (!fs.existsSync(bin)) return json(res, 500, { error: 'tdoc-publish script not found' });
    // Spawn hardening: an `error` listener (so an EACCES doesn't crash the whole
    // server with an unhandled 'error' event), a hard timeout (SIGTERM→SIGKILL)
    // so a hung wrangler/curl can't leave the HTTP response pending forever, and
    // a bounded output buffer so runaway child output can't OOM us. wrangler
    // legitimately needs the inherited env (CLOUDFLARE_* creds), so we keep it
    // but this endpoint is now origin/CSRF-gated above.
    const proc = spawn(bin, [slug], { env: process.env });
    let out = '', err = '', settled = false, killed = false;
    const CAP = 256 * 1024; // 256 KiB of captured output is plenty
    const append = (buf, d) => (buf.length < CAP ? buf + d : buf);
    const settle = (status, obj) => { if (settled) return; settled = true; clearTimeout(timer); json(res, status, obj); };
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000); }, 180000);
    proc.on('error', (e) => settle(500, { error: 'publish_spawn_failed', detail: String(e && e.message || e) }));
    proc.stdout.on('data', d => { out = append(out, d); });
    proc.stderr.on('data', d => { err = append(err, d); });
    proc.on('close', (code) => {
      if (killed) return settle(504, { error: 'publish_timeout', stdout: out, stderr: err });
      if (code !== 0) return settle(500, { error: 'publish_failed', code, stdout: out, stderr: err });
      // tdoc-publish ends with "Published: <URL>"
      const m = out.match(/Published:\s*(https?:\/\/\S+)/);
      settle(200, { ok: true, url: m ? m[1] : null, stdout: out });
    });
    return;
  }

  send(res, 404, 'Not found');
 } catch (e) {
  // Body too large, malformed request, or unexpected throw — respond cleanly
  // instead of crashing the server with an unhandled rejection.
  const tooBig = e && /too large/i.test(String(e.message));
  if (!res.headersSent) json(res, tooBig ? 413 : 500, { error: tooBig ? 'payload_too_large' : 'internal_error' });
 }
});

// Bind to loopback only. The local server has no auth by design; binding all
// interfaces (the Node default when host is omitted) would expose the
// unauthenticated comment + publish API to the local network.
const HOST = process.env.TDOC_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`tdoc server: http://localhost:${PORT}  (root: ${ROOT})`);
  console.log(`mode: local (anonymous, no auth) — bound to ${HOST}`);
});
