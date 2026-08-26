// tdoc owner manage panel — standalone module (same shape as signin.js).
// Cut from the old overlay.js monolith near-verbatim. Reads window.__TDOC__
// for cfg (ownerManage/slug/version), uses window.TDOC_CHROME.escapeHtml, and
// exposes window.__tdocManage() for the shell Share button. Only the closure
// references were adapted; the modal logic is unchanged.
(function () {
  if (window.__tdocManage) return;
  var cfg = window.__TDOC__ || {};
  var slug = cfg.slug, version = cfg.version;
  var escapeHtml = (window.TDOC_CHROME && window.TDOC_CHROME.escapeHtml) || function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
  };
  function closeAuxModal() { var m = document.getElementById("tdoc-aux-modal"); if (m) m.remove(); }
  function publicShareUrl() { return location.origin + "/d/" + encodeURIComponent(slug) + "/v/" + version; }
function closeManageModal() {
  const m = document.getElementById('tdoc-manage-modal');
  if (m) m.remove();
}
function closeManageConfirm() {
  const m = document.getElementById('tdoc-manage-confirm');
  if (m) m.remove();
}
function showManageConfirm({ title, body, confirmLabel, danger, onConfirm }) {
  closeManageConfirm();
  const bg = document.createElement('div');
  bg.className = 'tdoc-modal-bg';
  bg.id = 'tdoc-manage-confirm';
  bg.innerHTML = `
    <div class="tdoc-modal">
      <h3>${escapeHtml(title)}</h3>
      <p>${body}</p>
      <div class="status" id="tdoc-manage-confirm-status" style="display:none;"></div>
      <div class="actions">
        <button type="button" id="tdoc-manage-confirm-cancel">Cancel</button>
        <button type="button" id="tdoc-manage-confirm-go" class="${danger ? 'danger' : 'primary'}">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  document.getElementById('tdoc-manage-confirm-cancel').onclick = closeManageConfirm;
  bg.addEventListener('click', (e) => { if (e.target === bg) closeManageConfirm(); });
  document.getElementById('tdoc-manage-confirm-go').onclick = async () => {
    const status = document.getElementById('tdoc-manage-confirm-status');
    const go = document.getElementById('tdoc-manage-confirm-go');
    go.disabled = true;
    status.style.display = 'block';
    status.textContent = 'Working…';
    try {
      await onConfirm(status);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      go.disabled = false;
    }
  };
}
// No Authorization header, no token — the owner's session cookie is sent
// automatically on this same-origin request (see doc comment above).
async function ownerFetch(url, opts) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || err.message || ('HTTP ' + r.status));
  }
  return r.json().catch(() => ({}));
}
// Delete is a lifecycle action, not a sharing setting, so it lives in the ⋯
// overflow menu (owner-only), not the Share panel. Same session-authorized
// DELETE + confirm the Share panel used to run.
function confirmDeleteDoc() {
  const om = cfg.ownerManage;
  if (!om) return; // owner-only; the ⋯ item is gated on cfg.ownerManage too
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  showManageConfirm({
    title: 'Delete this doc?',
    body: `This permanently removes <b>${escapeHtml(slug)}</b> — all <b>${plural(om.versionCount, 'version')}</b> and <b>${plural(om.commentCount, 'comment')}</b> are deleted. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async (status) => {
      await ownerFetch(`/api/doc?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      status.textContent = 'Deleted. Redirecting…';
      setTimeout(() => { window.location.href = '/'; }, 900);
    },
  });
}
const HISTORY_OPTIONS = [['owner', 'Owner only'], ['invited', 'Invited'], ['public', 'Everyone']];
const COMMENTING_OPTIONS = [['signed_in', 'Signed in'], ['invited', 'Invited'], ['owner', 'Owner only'], ['off', 'Off']];
function renderSeg(id, current) {
  const seg = document.getElementById(id);
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === current));
}
function showManageModal() {
  if (!cfg.ownerManage) return; // no owner data for this request → nothing to render
  closeAuxModal();
  const om = cfg.ownerManage;
  const url = publicShareUrl();
  const access = {
    visibility: 'unlisted', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [],
    ...(om.access || {}),
  };
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const bg = document.createElement('div');
  bg.className = 'tdoc-modal-bg';
  bg.id = 'tdoc-manage-modal';
  bg.innerHTML = `
    <div class="tdoc-modal">
      <h3>Share</h3>
      <div class="code" id="tdoc-share-url" style="font-size:14px;letter-spacing:0;text-align:left;cursor:copy;">${escapeHtml(url)}</div>
      <div class="actions" style="justify-content:flex-start;gap:8px;margin-top:0;margin-bottom:4px;">
        <button type="button" class="primary" id="tdoc-share-copy">Copy link</button>
      </div>
      <p class="muted">${escapeHtml(slug)} · ${plural(om.versionCount, 'version')} · ${plural(om.commentCount, 'comment')}</p>
      <div class="manage-section">
        <label class="field" for="tdoc-access-sel">Who has access</label>
        <select id="tdoc-access-sel" class="tdoc-select">
          <option value="private">Only people I invite</option>
          <option value="unlisted">Anyone with the link</option>
        </select>
        <p class="manage-hint" id="tdoc-access-explain">&nbsp;</p>
        <div id="tdoc-invited-wrap" style="display:none;margin-top:10px;">
          <label class="field" for="tdoc-mgmt-allowed">Invite by GitHub username</label>
          <div class="tdoc-token-field" id="tdoc-allowed-field">
            <input type="text" id="tdoc-mgmt-allowed" autocomplete="off" spellcheck="false" placeholder="Add a GitHub username…">
          </div>
          <div class="tdoc-ac" id="tdoc-allowed-ac"></div>
          <p class="manage-hint" id="tdoc-allowed-status">&nbsp;</p>
        </div>
      </div>
      <details class="tdoc-adv"${(access.commenting !== 'signed_in' || access.history_visibility !== 'owner') ? ' open' : ''}>
        <summary>Advanced</summary>
        <div class="manage-section">
          <label class="field">Who can comment</label>
          <div class="tdoc-seg" id="tdoc-comment-seg">
            ${COMMENTING_OPTIONS.map(([v, l]) => `<button type="button" data-value="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="manage-section">
          <label class="field">Who can see version history</label>
          <div class="tdoc-seg" id="tdoc-hist-seg">
            ${HISTORY_OPTIONS.map(([v, l]) => `<button type="button" data-value="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <p class="manage-hint" id="tdoc-vis-status">&nbsp;</p>
      </details>
      <div class="actions"><button type="button" id="tdoc-share-close">Close</button></div>
    </div>`;
  document.body.appendChild(bg);
  renderSeg('tdoc-hist-seg', access.history_visibility);
  renderSeg('tdoc-comment-seg', access.commenting);
  // --- General access: one plain-language dropdown replaces the old
  // Visibility segmented control AND the separate Unpublish button (Unpublish
  // was identical to switching visibility to Private, so it's gone). The
  // invite field only appears when "invited" semantics are actually in play. ---
  const accessSel = document.getElementById('tdoc-access-sel');
  const accessExplainEl = document.getElementById('tdoc-access-explain');
  const invitedWrap = document.getElementById('tdoc-invited-wrap');
  // `public` and `unlisted` are functionally identical today — `public` only
  // reserves a not-yet-built discovery listing (see worker canReadDoc), so
  // the dropdown offers two options and a legacy public doc maps onto
  // "Anyone with the link".
  accessSel.value = access.visibility === 'private' ? 'private' : 'unlisted';
  const invitedRelevant = () => access.visibility === 'private'
    || access.commenting === 'invited' || access.history_visibility === 'invited';
  function updateInvited() { invitedWrap.style.display = invitedRelevant() ? 'block' : 'none'; }
  function updateAccessExplain() {
    const n = (access.allowed_users || []).length;
    accessExplainEl.textContent =
      access.visibility !== 'private' ? 'Anyone with the link can read it.'
      : n ? `Only you and ${n === 1 ? '1 invited person' : n + ' invited people'} can open it.`
      : 'Only you can open it — add people below to invite them.';
  }
  accessSel.onchange = async () => {
    const value = accessSel.value;
    if (value === access.visibility) return;
    // patchAccess only mutates `access` on success; on failure it leaves the
    // error text in accessExplainEl, so only refresh on a confirmed change.
    await patchAccess({ visibility: value }, accessExplainEl, '');
    if (access.visibility === value) { updateAccessExplain(); updateInvited(); }
    else { accessSel.value = access.visibility; }
  };
  updateAccessExplain();
  updateInvited();
  document.getElementById('tdoc-share-close').onclick = closeManageModal;
  document.getElementById('tdoc-share-copy').onclick = () => navigator.clipboard?.writeText(url);
  document.getElementById('tdoc-share-url').onclick = () => navigator.clipboard?.writeText(url);
  bg.addEventListener('click', (e) => { if (e.target === bg) closeManageModal(); });

  // Shared PATCH /api/doc/access helper — merges `patch` into the local
  // `access` mirror on success so re-renders (renderSeg) reflect it.
  async function patchAccess(patch, statusEl, successMsg) {
    statusEl.textContent = 'Saving…';
    try {
      await ownerFetch('/api/doc/access', {
        method: 'PATCH',
        body: JSON.stringify({ slug, access: patch }),
      });
      Object.assign(access, patch);
      statusEl.textContent = successMsg;
    } catch (e) {
      statusEl.textContent = 'Failed: ' + e.message;
    }
  }

  document.getElementById('tdoc-hist-seg').querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      const value = b.dataset.value;
      if (value === access.history_visibility) return;
      await patchAccess({ history_visibility: value }, document.getElementById('tdoc-vis-status'), 'Saved.');
      renderSeg('tdoc-hist-seg', access.history_visibility);
      updateInvited(); // "Invited" history reveals the invite field
    };
  });

  document.getElementById('tdoc-comment-seg').querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      const value = b.dataset.value;
      if (value === access.commenting) return;
      await patchAccess({ commenting: value }, document.getElementById('tdoc-vis-status'), 'Saved.');
      renderSeg('tdoc-comment-seg', access.commenting);
      updateInvited(); // "Invited" commenting reveals the invite field
    };
  });

  // ----- Allowed users: chip field + live GitHub handle autocomplete -----
  // All client-side. Candidate lookup and avatar existence checks go straight
  // to GitHub from the owner's browser (their IP → their own ~10 req/min
  // anonymous budget), so there is no worker proxy and no API key. See the
  // CSS block for why the doc CSP permits these requests.
  (function setupAllowedUsers() {
    const field = document.getElementById('tdoc-allowed-field');
    const input = document.getElementById('tdoc-mgmt-allowed');
    const acWrap = document.getElementById('tdoc-allowed-ac');
    const status = document.getElementById('tdoc-allowed-status');
    const list = Array.isArray(access.allowed_users) ? access.allowed_users.slice() : [];
    // Accept a bare login, an @handle, or a pasted github.com/<login> URL.
    const norm = (s) => s.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    const avatarUrl = (login) => `https://github.com/${encodeURIComponent(login)}.png?size=48`;

    function renderChips() {
      field.querySelectorAll('.tdoc-token').forEach(c => c.remove());
      list.forEach((login) => {
        const chip = document.createElement('span');
        chip.className = 'tdoc-token';
        const img = document.createElement('img');
        img.src = avatarUrl(login); img.alt = '';
        // A 404 from the avatar endpoint means no such GitHub user — flag it
        // so the owner sees a bad handle instead of silently locking someone
        // out. (github.com/<login>.png needs no API call and no rate budget.)
        img.onerror = () => {
          chip.classList.add('invalid');
          const mark = document.createElement('span');
          mark.className = 'mark'; mark.textContent = '!';
          mark.title = 'No GitHub user with this username';
          img.replaceWith(mark);
        };
        const name = document.createElement('span'); name.textContent = login;
        const rm = document.createElement('span');
        rm.className = 'rm'; rm.textContent = '×'; rm.title = 'Remove';
        rm.onclick = () => remove(login);
        chip.append(img, name, rm);
        field.insertBefore(chip, input);
      });
    }
    const commit = async () => {
      await patchAccess({ allowed_users: list.slice() }, status, 'Saved.');
      updateAccessExplain(); // keep the "Only you and N invited people" line in sync
    };
    function add(raw) {
      const l = norm(raw);
      if (l && !list.some(x => x.toLowerCase() === l.toLowerCase())) {
        list.push(l); renderChips(); commit();
      }
      input.value = ''; closeAc();
    }
    function remove(login) {
      const i = list.findIndex(x => x.toLowerCase() === login.toLowerCase());
      if (i >= 0) { list.splice(i, 1); renderChips(); commit(); }
    }

    // ---- autocomplete dropdown ----
    let acItems = [], acActive = -1, acSeq = 0, debounceTimer = 0;
    function closeAc() { acWrap.innerHTML = ''; acItems = []; acActive = -1; }
    function renderAc(users) {
      acItems = users; acActive = -1;
      if (!users.length) return closeAc();
      const box = document.createElement('div');
      box.className = 'tdoc-ac-list';
      users.forEach((u) => {
        const it = document.createElement('div');
        it.className = 'tdoc-ac-item';
        const img = document.createElement('img');
        img.src = u.avatar_url || avatarUrl(u.login); img.alt = '';
        const login = document.createElement('span');
        login.className = 'login'; login.textContent = u.login;
        it.append(img, login);
        // mousedown (not click) so it fires before the input's blur handler.
        it.addEventListener('mousedown', (e) => { e.preventDefault(); add(u.login); });
        box.appendChild(it);
      });
      acWrap.innerHTML = ''; acWrap.appendChild(box);
    }
    async function search(q) {
      const seq = ++acSeq;
      try {
        const r = await fetch(
          `https://api.github.com/search/users?q=${encodeURIComponent(q)}+in:login&per_page=6`,
          { headers: { 'Accept': 'application/vnd.github+json' } });
        if (seq !== acSeq) return; // superseded by a newer keystroke
        if (!r.ok) return closeAc(); // rate-limited / error → no suggestions; typing still works
        const data = await r.json();
        if (seq !== acSeq) return;
        renderAc((data.items || []).filter(u => u.type === 'User').slice(0, 6));
      } catch { if (seq === acSeq) closeAc(); }
    }
    function moveAc(dir) {
      const items = acWrap.querySelectorAll('.tdoc-ac-item');
      if (!items.length) return;
      acActive = (acActive + dir + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === acActive));
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = norm(input.value);
      if (q.length < 2) return closeAc();
      // Generous debounce: GitHub's anonymous search budget is ~10/min per IP.
      debounceTimer = setTimeout(() => search(q), 450);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && acItems.length) { e.preventDefault(); return moveAc(1); }
      if (e.key === 'ArrowUp' && acItems.length) { e.preventDefault(); return moveAc(-1); }
      if (e.key === 'Escape') return closeAc();
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (acActive >= 0 && acItems[acActive]) add(acItems[acActive].login);
        else if (input.value.trim()) add(input.value);
        return;
      }
      if (e.key === 'Backspace' && !input.value && list.length) remove(list[list.length - 1]);
    });
    input.addEventListener('focus', () => field.classList.add('focus'));
    input.addEventListener('blur', () => {
      field.classList.remove('focus');
      // Defer so a candidate click (mousedown) resolves first; then commit any
      // half-typed handle left in the box.
      setTimeout(() => { if (input.value.trim()) add(input.value); closeAc(); }, 150);
    });
    field.addEventListener('click', () => input.focus());

    renderChips();
  })();

}


  window.__tdocManage = showManageModal;
})();
