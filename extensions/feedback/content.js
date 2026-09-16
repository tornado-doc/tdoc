(() => {
  if (window.top !== window || window.__TDOC_FEEDBACK__) return;
  window.__TDOC_FEEDBACK__ = true;
  const state = { active: false, hovered: null, selected: null, lastAlt: 0, surface: null, comments: [], mentionable: [] };
  const host = document.createElement('div');
  host.id = 'tdoc-feedback-root';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
  <style>
  :host{all:initial}*{box-sizing:border-box}.hidden{display:none!important}
  #outline{position:fixed;z-index:2147483642;pointer-events:none;border:2px solid #6847f5;background:rgba(104,71,245,.1);border-radius:4px}
  #label{position:fixed;z-index:2147483643;pointer-events:none;padding:5px 8px;border-radius:6px;background:#18141e;color:#fff;max-width:310px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px/1.2 ui-monospace,monospace;box-shadow:0 5px 18px #0004}
  #mode{position:fixed;right:18px;bottom:18px;z-index:2147483645;display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid #ffffff2e;border-radius:999px;background:#18141e;color:#fff;box-shadow:0 12px 30px #0005;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
  #mode i{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#7657ff;font-style:normal}#mode kbd{opacity:.55;font:10px ui-monospace,monospace}
  #pins{position:fixed;inset:0;z-index:2147483644;pointer-events:none}.pin{position:fixed;pointer-events:auto;width:25px;height:25px;border:2px solid #fff;border-radius:50%;background:#6d4cf4;color:#fff;box-shadow:0 3px 12px #0004;font:700 11px/1 -apple-system,sans-serif;cursor:pointer}.pin.resolved{background:#777;opacity:.72}
  #card{position:fixed;z-index:2147483646;width:min(370px,calc(100vw - 24px));padding:14px;border:1px solid #ded9e5;border-radius:14px;background:#fff;color:#19151f;box-shadow:0 22px 70px rgba(26,17,45,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .head{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}.head strong{font-size:14px}.sub{margin-top:2px;max-width:285px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#766f7e;font-size:11px}.close{border:0;background:transparent;color:#7b7485;font-size:20px;line-height:1;cursor:pointer}.body{max-height:min(430px,60vh);overflow:auto}.message{padding:9px 0;border-top:1px solid #eeebf0}.message:first-child{border:0}.by{font-size:11px;font-weight:700;color:#6b6373;margin-bottom:3px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.anchor{padding:8px;border-radius:8px;background:#f5f2fa;color:#6d6576;font:11px/1.35 ui-monospace,monospace;margin-bottom:9px}
  textarea{display:block;width:100%;min-height:88px;resize:vertical;border:1px solid #d7d2de;border-radius:8px;background:#fff;color:#19151f;padding:9px;font:inherit;outline:0}textarea:focus{border-color:#7657ff;box-shadow:0 0 0 3px #7657ff1f}.people{display:flex;gap:5px;overflow:auto;margin:7px 0}.person{border:1px solid #ddd7e4;border-radius:999px;background:#fff;color:#514958;padding:3px 7px;font:600 10px/1.2 inherit;cursor:pointer;white-space:nowrap}.actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}.status{color:#766f7e;font-size:11px}.buttons{display:flex;gap:7px}.secondary,.primary{border-radius:8px;padding:7px 10px;font-weight:650;cursor:pointer}.secondary{border:1px solid #d7d2de;background:#fff;color:#302a38}.primary{border:1px solid #19151f;background:#19151f;color:#fff}.primary:disabled{opacity:.5}.setup p{color:#655e6c;margin:4px 0 12px}.setup .primary{display:inline-block}
  @media(prefers-color-scheme:dark){#card{background:#211d26;color:#faf8fc;border-color:#4a4351}.sub,.status,.by{color:#aea5b6}.message{border-color:#3e3844}.anchor{background:#2d2833;color:#bbb2c2}textarea{background:#2b2630;color:#fff;border-color:#4c4554}.secondary,.person{background:#2b2630;color:#fff;border-color:#4c4554}.primary{background:#faf8fc;color:#19151f;border-color:#faf8fc}}
  </style>
  <div id="outline" class="hidden"></div><div id="label" class="hidden"></div><div id="pins"></div>
  <button id="mode" class="hidden" type="button"><i>+</i><span>Comment on the product</span><kbd>esc</kbd></button>
  <section id="card" class="hidden" aria-label="tdoc comment"><div class="head"><div><strong></strong><div class="sub"></div></div><button class="close" type="button" aria-label="Close">×</button></div><div class="body"></div></section>`;
  document.documentElement.appendChild(host);
  const outline = root.querySelector('#outline');
  const label = root.querySelector('#label');
  const pins = root.querySelector('#pins');
  const mode = root.querySelector('#mode');
  const card = root.querySelector('#card');
  const title = card.querySelector('strong');
  const sub = card.querySelector('.sub');
  const body = card.querySelector('.body');

  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text != null) value.textContent = text; return value; };
  const call = (message) => chrome.runtime.sendMessage(message);
  const canonical = () => { const url = new URL(location.href); url.hash = ''; return url.href; };
  const cssEscape = (value) => window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    for (let current = element; current && current.nodeType === 1 && parts.length < 7; current = current.parentElement) {
      let part = current.localName;
      const stable = [...current.classList].filter((name) => !/^(active|hover|focus|selected|open|css-|sc-)/.test(name)).slice(0, 2);
      if (stable.length) part += stable.map((name) => `.${cssEscape(name)}`).join('');
      const parent = current.parentElement;
      if (parent) { const peers = [...parent.children].filter((peer) => peer.localName === current.localName); if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`; }
      parts.unshift(part);
      if (current.matches('main,nav,header,footer,[role="main"]')) break;
    }
    return parts.join(' > ');
  }

  function contextFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      kind: 'product', url: canonical(), selector: selectorFor(element), tag: element.localName,
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      accessible_name: element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '',
      rect: { x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio }
    };
  }

  function targetAt(x, y) {
    host.style.pointerEvents = 'none'; const element = document.elementFromPoint(x, y); host.style.pointerEvents = '';
    return element && ![document.documentElement, document.body].includes(element) ? element : null;
  }

  function draw(element) {
    if (!element) { outline.classList.add('hidden'); label.classList.add('hidden'); return; }
    const rect = element.getBoundingClientRect();
    Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const name = element.getAttribute('aria-label') || String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    label.textContent = `${element.localName}${name ? ` · ${name}` : ''}`;
    Object.assign(label.style, { left: `${Math.max(6, Math.min(innerWidth - 316, rect.left))}px`, top: `${Math.max(6, rect.top - 29)}px` });
    outline.classList.remove('hidden'); label.classList.remove('hidden');
  }

  function placeCard(rect) {
    const width = Math.min(370, innerWidth - 24);
    const left = Math.max(12, Math.min(innerWidth - width - 12, rect ? rect.left : innerWidth - width - 18));
    const top = rect && rect.bottom + 290 < innerHeight ? rect.bottom + 10 : Math.max(12, rect ? rect.top - 300 : 64);
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
  }

  function mentionChips(textarea) {
    const row = node('div', 'people');
    for (const person of state.mentionable.slice(0, 8)) {
      const login = String(person.login || '').replace(/^email:/, '');
      const chip = node('button', 'person', `@${login}`); chip.type = 'button';
      chip.onclick = () => { textarea.value = `${textarea.value}${textarea.value && !/\s$/.test(textarea.value) ? ' ' : ''}@${login} `; textarea.focus(); };
      row.appendChild(chip);
    }
    return row;
  }

  function formActions(textarea, submitText, onSubmit, extra) {
    const actions = node('div', 'actions'); const status = node('span', 'status'); const buttons = node('div', 'buttons');
    if (extra) buttons.appendChild(extra);
    const submit = node('button', 'primary', submitText); submit.type = 'button';
    submit.onclick = async () => {
      if (!textarea.value.trim()) return;
      submit.disabled = true; status.textContent = 'Saving in tdoc…';
      const result = await onSubmit(textarea.value.trim());
      if (!result || !result.ok) {
        status.textContent = result && result.status === 401 ? 'Sign in to tdoc first' : result && result.error || 'Could not save';
        submit.disabled = false;
        if (result && result.status === 401) showSignIn();
        return;
      }
      applySurface(result); card.classList.add('hidden'); state.selected = null; draw(null);
    };
    buttons.appendChild(submit); actions.append(status, buttons); return actions;
  }

  function showSetup() {
    title.textContent = 'Connect tdoc'; sub.textContent = 'One tdoc holds this app’s product feedback'; body.replaceChildren();
    const wrap = node('div', 'setup'); wrap.appendChild(node('p', '', 'Choose an existing tdoc. Its login, access, threads, mentions, notifications, and storage will be reused here.'));
    const button = node('button', 'primary', 'Choose tdoc'); button.type = 'button'; button.onclick = () => call({ type: 'tdoc-feedback-open-options' }); wrap.appendChild(button); body.appendChild(wrap);
    placeCard(); card.classList.remove('hidden');
  }

  function showSignIn() {
    title.textContent = 'Sign in to comment'; sub.textContent = state.surface && state.surface.config ? state.surface.config.documentUrl : 'tdoc'; body.replaceChildren();
    const wrap = node('div', 'setup'); wrap.appendChild(node('p', '', 'The app uses the same tdoc account and permissions as the connected document.'));
    const button = node('button', 'primary', 'Sign in to tdoc'); button.type = 'button'; button.onclick = () => call({ type: 'tdoc-feedback-signin' }); wrap.appendChild(button); body.appendChild(wrap);
    placeCard(); card.classList.remove('hidden');
  }

  function showComposer(element) {
    if (!state.surface || !state.surface.signedIn) { showSignIn(); return; }
    state.selected = element; const anchor = contextFor(element);
    title.textContent = 'Leave product feedback'; sub.textContent = anchor.selector; body.replaceChildren(node('div', 'anchor', anchor.text || anchor.accessible_name || anchor.selector));
    const textarea = node('textarea'); textarea.placeholder = 'What should change? Tag a person or agent with @name.'; body.append(textarea, mentionChips(textarea));
    body.appendChild(formActions(textarea, 'Comment', (text) => call({ type: 'tdoc-feedback-submit', text, anchor })));
    placeCard(element.getBoundingClientRect()); card.classList.remove('hidden'); requestAnimationFrame(() => textarea.focus());
  }

  function showThread(comment, index) {
    title.textContent = `Comment ${index + 1}`; sub.textContent = comment.anchor && comment.anchor.selector || 'Product feedback'; body.replaceChildren();
    const all = [comment, ...(Array.isArray(comment.replies) ? comment.replies : [])];
    for (const item of all) { const row = node('div', 'message'); row.append(node('div', 'by', item.author && (item.author.name || item.author.login) || 'Reviewer'), node('div', 'text', item.text || '')); body.appendChild(row); }
    const textarea = node('textarea'); textarea.placeholder = 'Reply — @mention a person or agent'; body.append(textarea, mentionChips(textarea));
    const resolved = comment.status === 'applied';
    const resolve = node('button', 'secondary', resolved ? 'Reopen' : 'Resolve'); resolve.type = 'button';
    resolve.onclick = async () => { const result = await call({ type: 'tdoc-feedback-resolve', id: comment.id, resolved: !resolved, pageUrl: canonical() }); if (result && result.ok) { applySurface(result); card.classList.add('hidden'); } };
    body.appendChild(formActions(textarea, 'Reply', (text) => call({ type: 'tdoc-feedback-reply', text, parentId: comment.id, pageUrl: canonical() }), resolve));
    let element = null; try { element = document.querySelector(comment.anchor.selector); } catch (_) {}
    placeCard(element && element.getBoundingClientRect()); card.classList.remove('hidden');
  }

  function renderPins() {
    pins.replaceChildren();
    state.comments.forEach((comment, index) => {
      let element = null; try { element = document.querySelector(comment.anchor.selector); } catch (_) {}
      if (!element) return;
      const rect = element.getBoundingClientRect(); const pin = node('button', `pin${comment.status === 'applied' ? ' resolved' : ''}`, String(index + 1)); pin.type = 'button'; pin.title = comment.text || 'tdoc comment';
      Object.assign(pin.style, { left: `${Math.min(innerWidth - 30, Math.max(4, rect.right - 12))}px`, top: `${Math.min(innerHeight - 30, Math.max(4, rect.top - 12))}px` });
      pin.onclick = (event) => { event.preventDefault(); event.stopPropagation(); showThread(comment, index); }; pins.appendChild(pin);
    });
  }

  function applySurface(result) {
    state.surface = result; state.comments = result.comments || []; state.mentionable = result.mentionable || []; renderPins();
  }

  async function load() {
    const result = await call({ type: 'tdoc-feedback-load', pageUrl: canonical() });
    if (!result || !result.ok) { if (result && result.setup) showSetup(); else { title.textContent = 'tdoc Feedback'; sub.textContent = ''; body.replaceChildren(node('p', '', result && result.error || 'Could not load tdoc comments')); placeCard(); card.classList.remove('hidden'); } return; }
    applySurface(result); if (!result.signedIn) showSignIn();
  }

  async function activate(value = !state.active) {
    state.active = value; mode.classList.toggle('hidden', !value); pins.classList.toggle('hidden', !value); document.documentElement.style.cursor = value ? 'crosshair' : '';
    if (!value) { card.classList.add('hidden'); draw(null); }
    else await load();
  }

  document.addEventListener('mousemove', (event) => { if (!state.active || !card.classList.contains('hidden') || event.target === host) return; const element = targetAt(event.clientX, event.clientY); if (element !== state.hovered) { state.hovered = element; draw(element); } }, true);
  document.addEventListener('click', (event) => { if (!state.active || !card.classList.contains('hidden') || event.target === host) return; const element = targetAt(event.clientX, event.clientY); if (!element) return; event.preventDefault(); event.stopImmediatePropagation(); draw(element); showComposer(element); }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.active) { event.preventDefault(); activate(false); return; }
    if (event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const editable = event.target && (event.target.matches('input,textarea,select') || event.target.isContentEditable); if (editable) return;
    const now = Date.now(); if (now - state.lastAlt < 430) { event.preventDefault(); state.lastAlt = 0; activate(); } else state.lastAlt = now;
  }, true);
  addEventListener('scroll', renderPins, { passive: true }); addEventListener('resize', renderPins);
  card.querySelector('.close').onclick = () => { card.classList.add('hidden'); state.selected = null; draw(null); };
  mode.onclick = (event) => { event.preventDefault(); event.stopPropagation(); activate(false); };
  chrome.runtime.onMessage.addListener((message) => { if (message && message.type === 'tdoc-feedback-toggle') activate(); });
})();
