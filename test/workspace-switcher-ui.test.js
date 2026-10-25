// Top-bar workspace switcher: shows the current space, lists My docs and
// every team with the current one checked, and New team; the only switcher
// (the old pill row is gone); on a phone the same list is under ⋯.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('workspace-switcher-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function withBoot(html, update) {
  return html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, b, j, a) => b + JSON.stringify(update(JSON.parse(j))) + a);
}
const TEAMS = [{ id: 'tm_befreed', name: 'BeFreed', role: 'admin', member_count: 4 }, { id: 'tm_lab', name: 'Smrti Lab', role: 'member', member_count: 2 }];
const PERSONAL = { slug: 'personal-plan', title: 'Personal plan', excerpt: 'Only in My docs', workspace_id: '', folder: '', mine: true, created: '2026-10-01', updated: '2026-10-02', at: '2026-10-03', starred: true };
const TEAM_DOC = { slug: 'team-plan', title: 'Team plan', excerpt: 'Only in BeFreed', workspace_id: 'tm_befreed', team: 'tm_befreed', author: 'Alice', mine: true, created: '2026-10-01', updated: '2026-10-02', at: '2026-10-03', starred: true, can_file: true, can_manage: true };
const PERSONAL_FOLDERS = [{ id: 'f_research', name: 'Research', parent: '' }, { id: 'f_2027', name: '2027', parent: 'f_research' }];
const NESTED_PERSONAL = { slug: 'revenue-plan', title: 'Revenue plan', excerpt: 'Expansion in Japan', workspace_id: '', folder: 'f_2027', mine: true, created: '2026-10-04', updated: '2026-10-05', at: '2026-10-05', starred: false };
const TEAM_FOLDERS = [{ id: 'tf_strategy', name: 'Strategy', parent: '' }, { id: 'tf_launch', name: 'Launch', parent: 'tf_strategy' }];
const NESTED_TEAM = { slug: 'launch-brief', title: 'Launch brief', excerpt: 'Confidential tiger notes', workspace_id: 'tm_befreed', team: 'tm_befreed', folder: 'tf_launch', author: 'Alice', created: '2026-10-04', updated: '2026-10-05', at: '2026-10-05', starred: false, can_file: true, can_manage: true };

(async () => {
  console.log('Workspace switcher UI');
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
  try {
    const shell = await (await fetch(`${base}/me`)).text();
    const open = async (width, query) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.route(`${base}/me*`, (r) => r.fulfill({ contentType: 'text/html', body: withBoot(shell, (boot) => ({ ...boot, capabilities: { ...boot.capabilities, folders: true }, teams: TEAMS, docs: [PERSONAL, NESTED_PERSONAL], folders: PERSONAL_FOLDERS, recent: [PERSONAL, TEAM_DOC], starred: [PERSONAL, TEAM_DOC], team_docs: [TEAM_DOC, NESTED_TEAM], team_folders: { tm_befreed: TEAM_FOLDERS } })) }));
      await page.route('**/api/me/connectors', (r) => r.fulfill({ json: {
        targets: [], available: [{ id: 'raft', ready: true }, { id: 'local', ready: true }, { id: 'webhook', ready: true }],
        connectors: [
          { id: 'raft:srv', kind: 'raft', server_id: 'srv', server_slug: 'acme', agents: [{ provider: 'raft', server_id: 'srv', agent_sub: 'alice-bot', agent_name: 'alice-bot' }] },
          { id: 'local:juliesmac', kind: 'local', device: 'juliesmac', agents: [{ provider: 'local', device: 'juliesmac', server_id: 'juliesmac', cli: 'claude', agent_sub: 'juliesmac_claude', status: 'active', last_seen: new Date().toISOString() }] },
        ],
      } }));
      await page.route('**/api/me/tokens', (r) => r.fulfill({ json: { ok: true, tokens: [] } }));
      await page.route('**/api/team/backup?*', (r) => r.fulfill({ json: { ok: true, backup: { enabled: false } } }));
      await page.route(/\/api\/team\?/, (r) => r.fulfill({ json: { ok: true, team: {
        ...TEAMS[0], invites: [], invite_url: 'https://tdoc.dev/t/acme/join', team_url: 'https://tdoc.dev/t/befreed',
        members: [{ account_id: 'a_alice', name: 'Alice', key: 'alice', role: 'admin', me: true }],
      } } }));
      await page.goto(`${base}/me${query}`);
      return page;
    };
    await t('desktop: shows the current team and switches from the menu', async () => {
      const page = await open(1280, '?team=tm_befreed');
      const trigger = page.locator('.tdoc-space-trigger');
      await trigger.waitFor();
      assert.equal((await trigger.locator('.name').textContent()).trim(), 'BeFreed');
      await trigger.click();
      const items = page.locator('.ui-menu-popup .tdoc-space-item-name');
      await items.first().waitFor();
      assert.deepEqual((await items.allTextContents()).map((s) => s.trim()), ['My docs', 'BeFreed', 'Smrti Lab', 'Workspace settings', 'New team']);
      assert.equal(await page.locator('.ui-menu-popup .tdoc-space-check').count(), 1);
      assert.equal(await trigger.locator('svg').count(), 1, 'the trigger should only keep its dropdown chevron');
      assert.equal(await page.getByRole('menuitem', { name: 'My docs' }).locator('svg').count(), 0, 'My docs has a decorative icon');
      assert.equal(await page.getByRole('menuitem', { name: 'Smrti Lab' }).locator('svg').count(), 0, 'team rows have decorative icons');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'switcher-desktop.png') }); }
      await page.getByRole('menuitem', { name: 'Smrti Lab' }).click();
      await page.getByRole('heading', { name: 'Smrti Lab' }).waitFor();
      await page.close();
    });
    await t('desktop: the account menu has light/dark, and no second Switch space beside the chip', async () => {
      const page = await open(1280, '?team=tm_befreed');
      await page.locator('.tdoc-space-trigger').waitFor();
      assert.equal(await page.locator('#tdoc-theme-btn, .tdoc-theme-btn').count(), 0, 'standalone theme button is back');
      await page.locator('.tdoc-bar .tdoc-account-trigger').click();
      await page.getByRole('menuitem', { name: /Dark mode|Light mode/ }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: /Switch space/ }).count(), 0, 'Switch space duplicated in the account menu');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-account-menu-desktop.png') });
      await page.close();
    });
    await t('My docs is the current space without ?team; New team opens the dialog', async () => {
      const page = await open(1280, '');
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'New team' }).click();
      await page.getByRole('dialog', { name: 'New team' }).waitFor();
      await page.close();
    });
    await t('every workspace has the same tabs and Recent/Starred follow the workspace', async () => {
      const page = await open(1280, '');
      assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Docs', 'Recent', 'Starred', 'Comments', 'Trash', 'Settings']);
      await page.getByRole('tab', { name: 'Recent' }).click();
      await page.getByRole('link', { name: 'Personal plan' }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Team plan' }).count(), 0);
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.getByRole('heading', { name: 'BeFreed' }).waitFor();
      assert.match(page.url(), /team=tm_befreed.*view=recent/);
      assert.equal(await page.getByRole('tab', { name: 'Recent' }).getAttribute('aria-selected'), 'true');
      await page.getByRole('link', { name: 'Team plan' }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Personal plan' }).count(), 0);
      await page.close();
    });
    await t('grid/list preview switch is shared, complete, and remembered', async () => {
      const page = await open(1280, '');
      await page.getByRole('button', { name: 'Grid view' }).click();
      await page.locator('.doc-list.is-grid .doc-card-preview').waitFor();
      assert.match(await page.locator('.doc-card-preview').textContent(), /Only in My docs/);
      assert.equal(await page.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'catalog-grid-desktop.png'), fullPage: true });
      await page.reload();
      await page.locator('.doc-list.is-grid').waitFor();
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.locator('.doc-list.is-grid .doc-card-preview').waitFor();
      assert.match(await page.locator('.doc-card-preview').textContent(), /Only in BeFreed/);
      await page.getByRole('button', { name: 'List view' }).click();
      assert.equal(await page.locator('.doc-list.is-list').count(), 1);
      await page.close();
    });
    await t('search returns documents from every folder, not folder rows, with paths and field scopes', async () => {
      const page = await open(1280, '');
      assert.equal(await page.locator('.folder-row').count(), 1);
      const search = page.getByRole('searchbox', { name: 'Search docs' });
      await search.fill('Japan');
      await page.getByRole('link', { name: 'Revenue plan' }).waitFor();
      assert.equal(await page.locator('.folder-row').count(), 0);
      assert.match(await page.locator('.doc-path').textContent(), /Research.*2027/);
      assert.match(await page.locator('.search-syntax').textContent(), /Searching every folder.*title:/);
      await search.fill('title:Japan');
      assert.equal(await page.getByRole('link', { name: 'Revenue plan' }).count(), 0);
      await search.fill('path:2027');
      await page.getByRole('link', { name: 'Revenue plan' }).waitFor();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'catalog-search-desktop.png'), fullPage: true });

      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.getByRole('heading', { name: 'BeFreed' }).waitFor();
      await search.fill('preview:tiger');
      await page.getByRole('link', { name: 'Launch brief' }).waitFor();
      assert.match(await page.locator('.doc-path').textContent(), /Strategy.*Launch/);
      assert.equal(await page.locator('.folder-row').count(), 0);
      await page.close();
    });
    await t('the global switcher opens a real workspace settings page', async () => {
      const admin = await open(1280, '?team=tm_befreed');
      await admin.locator('.tdoc-space-trigger').click();
      await admin.getByRole('menuitem', { name: 'Workspace settings' }).click();
      await admin.getByRole('heading', { name: 'Workspace settings' }).waitFor();
      assert.deepEqual(await admin.getByRole('tab').allTextContents(), ['Docs', 'Recent', 'Starred', 'Comments', 'Trash', 'Settings']);
      await admin.getByRole('heading', { name: 'Members' }).waitFor();
      await admin.getByRole('heading', { name: 'Agents' }).waitFor();
      const agents = await admin.locator('#agents').textContent();
      assert.match(agents, /Raft · acme.*This computer · juliesmac.*Daemon running/s);
      await admin.getByRole('heading', { name: 'Data backup' }).waitFor();
      assert.match(admin.url(), /view=settings/);
      if (SHOTS) await admin.screenshot({ path: path.join(SHOTS, 'workspace-settings-desktop.png'), fullPage: true });
      await admin.close();

      const member = await open(1280, '?team=tm_lab');
      await member.getByRole('tab', { name: 'Settings' }).click();
      assert.equal(await member.getByRole('heading', { name: 'Data backup' }).count(), 0);
      // A member sees the team's agents, and not the admin's own connectors.
      const memberAgents = await member.locator('#agents').textContent();
      assert.match(memberAgents, /Team agents/);
      assert.doesNotMatch(memberAgents, /Your own agents|Add a connector/);
      await member.close();
    });
    await t('personal Settings has one Agents area for Raft and local setup', async () => {
      const page = await open(1280, '?view=settings');
      await page.getByRole('heading', { name: 'Agents' }).waitFor();
      const text = await page.locator('#agents').textContent();
      assert.match(text, /Raft · acme.*This computer · juliesmac/s);
      assert.equal(await page.locator('#agents').getByRole('link', { name: 'Connect a computer', exact: true }).getAttribute('href'), '/setup', 'local setup starts through the guided connection flow');
      assert.equal(await page.getByRole('link', { name: 'Open guided setup' }).getAttribute('href'), '/setup');
      await page.getByRole('heading', { name: 'Agent access' }).waitFor();
      await page.close();
    });
    await t('phone: the spaces are in ⋯ and the old pill row is gone', async () => {
      const page = await open(390, '?team=tm_befreed');
      // The chip gives its room to ⋯ on a phone; the same list is under
      // ⋯ → Switch space (phone-top-bar-ui.test.js covers the doc page).
      const more = page.locator('#tdoc-more-btn');
      await more.waitFor();
      assert.equal(await page.locator('.tdoc-space-trigger').isVisible(), false, 'space chip hidden on a phone');
      assert.equal(await page.locator('.tm-spaces').count(), 0, 'the pill row is back');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-phone.png') });
      await page.getByRole('button', { name: 'Grid view' }).click();
      await page.locator('.doc-list.is-grid .doc-card-preview').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'grid overflows sideways');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'catalog-grid-phone.png'), fullPage: true });
      await more.click();
      await page.getByRole('menuitem', { name: /Switch space/ }).click();
      const names = page.locator('.ui-menu-popup .tdoc-space-item-name');
      await names.first().waitFor();
      assert.deepEqual((await names.allTextContents()).map((x) => x.trim()), ['My docs', 'BeFreed', 'Smrti Lab', 'Workspace settings', 'New team']);
      assert.equal(await page.locator('.ui-menu-popup .tdoc-space-check').count(), 1, 'the current team is checked');
      await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
      await page.getByRole('heading', { name: 'Data backup' }).waitFor();
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('body *')].map((el) => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, cls: el.className, left: Math.round(r.left), right: Math.round(r.right), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        }).filter((x) => x.left < -1 || x.right > innerWidth + 1 || x.scrollWidth > x.clientWidth + 1).slice(0, 8),
      }));
      assert.ok(geometry.scrollWidth <= geometry.width + 1, `settings page overflows sideways ${JSON.stringify(geometry)}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'workspace-settings-phone.png'), fullPage: true });
      await page.close();
    });
    await t('phone: all-folder search stays readable without sideways overflow', async () => {
      const page = await open(390, '');
      await page.getByRole('searchbox', { name: 'Search docs' }).fill('path:2027');
      await page.getByRole('link', { name: 'Revenue plan' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'search results overflow sideways');
      assert.equal(await page.locator('.folder-row').count(), 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'catalog-search-phone.png'), fullPage: true });
      await page.close();
    });
    await t('on My docs, switching happens in place', async () => {
      const page = await open(1280, '');
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.getByRole('heading', { name: 'BeFreed' }).waitFor();
      assert.match(page.url(), /team=tm_befreed/);
      await page.close();
    });
    await t('moving to a team updates the list immediately, closes after success, and stays on My docs', async () => {
      const page = await open(1280, '');
      let finishMove;
      await page.route('**/api/team/move', async (route) => {
        await new Promise((resolve) => { finishMove = resolve; });
        await route.fulfill({ json: { ok: true, moved: 1, team: 'tm_befreed' } });
      });
      await page.locator('.doc-row[data-slug="personal-plan"] .row-menu-btn').click();
      await page.getByRole('menuitem', { name: 'Move to team' }).click();
      await page.getByRole('dialog', { name: 'Move this doc to a team' }).getByRole('button', { name: 'BeFreed' }).click();
      await page.waitForFunction(() => !document.querySelector('.doc-row[data-slug="personal-plan"]'));
      assert.equal(page.url(), `${base}/me`);
      finishMove();
      await page.getByRole('dialog', { name: 'Move this doc to a team' }).waitFor({ state: 'detached' });
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.locator('.doc-row[data-slug="personal-plan"]').waitFor();
      await page.close();
    });
    await t('a failed team move restores the row and keeps the dialog open on a phone', async () => {
      const page = await open(390, '');
      await page.route('**/api/team/move', (route) => route.fulfill({ status: 403, json: { error: 'forbidden', message: 'Could not move this doc' } }));
      await page.locator('.doc-row[data-slug="personal-plan"] .row-menu-btn').click();
      await page.getByRole('menuitem', { name: 'Move to team' }).click();
      await page.getByRole('dialog', { name: 'Move this doc to a team' }).getByRole('button', { name: 'BeFreed' }).click();
      await page.locator('.doc-row[data-slug="personal-plan"]').waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Move this doc to a team' }).count(), 1);
      assert.equal(page.url(), `${base}/me`);
      await page.close();
    });
    await t('moving a team doc back to My docs updates both lists without navigation', async () => {
      const page = await open(390, '?team=tm_befreed');
      let finishMove;
      await page.route('**/api/team/move', async (route) => {
        await new Promise((resolve) => { finishMove = resolve; });
        await route.fulfill({ json: { ok: true, moved: 1, team: null } });
      });
      await page.locator('.doc-row[data-slug="team-plan"] .row-menu-btn').click();
      await page.getByRole('menuitem', { name: /Move to My docs/ }).click();
      await page.waitForFunction(() => !document.querySelector('.doc-row[data-slug="team-plan"]'));
      assert.match(page.url(), /team=tm_befreed/);
      finishMove();
      await page.locator('#tdoc-more-btn').click();
      await page.getByRole('menuitem', { name: /Switch space/ }).click();
      // The space row, not the ⋯ menu's own My docs link (that one navigates).
      await page.locator('.ui-menu-popup .tdoc-space-item-name', { hasText: /^My docs$/ }).click();
      await page.locator('.doc-row[data-slug="team-plan"]').waitFor();
      await page.close();
    });
    await t('moving into a folder updates its list before the server replies', async () => {
      const page = await open(1280, '');
      let finishMove;
      await page.route('**/api/folders/move', async (route) => {
        await new Promise((resolve) => { finishMove = resolve; });
        await route.fulfill({ json: { ok: true, moved: 1 } });
      });
      await page.locator('.doc-row[data-slug="personal-plan"] .row-menu-btn').click();
      await page.locator('.ui-menu-popup .row-move').click();
      await page.getByRole('dialog', { name: 'Move to folder' }).getByRole('button', { name: 'Research' }).click();
      await page.waitForFunction(() => !document.querySelector('.doc-row[data-slug="personal-plan"]'));
      assert.equal(page.url(), `${base}/me`);
      finishMove();
      await page.getByRole('dialog', { name: 'Move to folder' }).waitFor({ state: 'detached' });
      await page.locator('.folder-row[data-folder-id="f_research"] .doc-title').click();
      await page.locator('.doc-row[data-slug="personal-plan"]').waitFor();
      await page.close();
    });
    await t('moving a folder to a team stays on the current page and refreshes both lists', async () => {
      const page = await open(1280, '');
      let finishMove;
      await page.route('**/api/folders/move-to-team', async (route) => {
        await new Promise((resolve) => { finishMove = resolve; });
        await route.fulfill({ json: { ok: true, moved: 1, remaining: 0, skipped: [], results: [{ slug: 'revenue-plan', status: 'moved', folder: 'tf_strategy' }], folder: 'tf_strategy', folders: TEAM_FOLDERS } });
      });
      await page.route('**/api/me', (route) => route.fulfill({ json: {
        ok: true, docs: [PERSONAL], folders: [], recent: [PERSONAL, TEAM_DOC], starred: [PERSONAL, TEAM_DOC],
        team_docs: [TEAM_DOC, NESTED_TEAM, { ...NESTED_PERSONAL, team: 'tm_befreed', workspace_id: 'tm_befreed', folder: 'tf_strategy', can_manage: true, can_file: true }],
        team_folders: { tm_befreed: TEAM_FOLDERS },
      } }));
      await page.locator('.folder-row[data-folder-id="f_research"] .row-menu-btn').click();
      await page.getByRole('menuitem', { name: 'Move to team…' }).click();
      await page.getByRole('dialog', { name: 'Move Research to a team' }).getByRole('button', { name: 'BeFreed' }).click();
      await page.getByRole('button', { name: 'Move 1 doc' }).click();
      await page.waitForFunction(() => !document.querySelector('.folder-row[data-folder-id="f_research"]'));
      assert.equal(page.url(), `${base}/me`);
      finishMove();
      await page.getByRole('dialog', { name: /Move Research/ }).waitFor({ state: 'detached' });
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.getByRole('searchbox', { name: 'Search docs' }).fill('Revenue plan');
      await page.locator('.doc-row[data-slug="revenue-plan"]').waitFor();
      await page.close();
    });
  } finally { await browser.close(); await target.stop(); }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
