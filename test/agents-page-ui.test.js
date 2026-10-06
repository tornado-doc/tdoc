// The Agents page and its "Choose your default agent" modal, in a real
// browser against the built shell. Julie (2026-10-06): the agent pickers were
// native <select>s — the closed box unstyled and the open list drawn by the
// OS — beside wrong margins and stray line breaks. This locks the page to the
// shared primitives: AppSelect (closed box .tdoc-select, open list the
// AppMenu popup), 34px controls in a connector form, and no native select.
// The Send to agent dialog (document and feedback overlay) is the same
// NotifyHandoffPanel component; test/ui-primitives.test.js holds it to
// AppSelect at the source level.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('agents-page-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';

function withBoot(html, update) {
  return html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, before, json, after) => (
    before + JSON.stringify(update(JSON.parse(json))) + after
  ));
}

const agent = (sub, name, extra = {}) => ({ provider: 'raft', server_id: 'S1', server_slug: 'julie', agent_sub: sub, agent_name: name, ...extra });
const AGENTS = [
  agent('a1', 'earn-with-ai-claw'),
  agent('a2', 'smarter-tdoc-claw', { source: 'directory' }),
  agent('a3', 'research-claw', { source: 'directory' }),
];
function connectors({ withDefault }) {
  return {
    ok: true,
    connectors: [{ kind: 'raft', id: 'raft:S1', server_id: 'S1', server_slug: 'julie', agents: withDefault ? AGENTS : AGENTS.slice(1) }],
    default: withDefault ? AGENTS[0] : null,
    targets: withDefault ? [AGENTS[0]] : [],
    available: [{ id: 'raft', name: 'Raft agent', ready: true }, { id: 'webhook', name: 'Webhook', ready: true }],
  };
}

async function controlBox(locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, cls: el.className, height: Math.round(r.height), font: s.fontFamily, size: s.fontSize, top: Math.round(r.top) };
  });
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  console.log('Agents page UI');
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  const browser = await chromium.launch({ headless: true });
  const shell = await (await fetch(`${base}/me`)).text();
  try {
    for (const width of [1280, 390]) {
      for (const withDefault of [true, false]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/api/me/connectors', (route) => route.fulfill({ json: connectors({ withDefault }) }));
        await page.route(`${base}/me/agents*`, (route) => route.fulfill({
          contentType: 'text/html',
          body: withBoot(shell, (boot) => ({ page: 'agents', identity: boot.identity, tokens: [] })),
        }));
        await page.goto(`${base}/me/agents?tab=send${withDefault ? '' : '&connected=raft'}`);
        const label = withDefault ? 'connected server with a default' : 'right after Connect with Raft';

        await t(`${width}px, ${label}: no native select, pickers are AppSelect`, async () => {
          await page.locator('.ui-select-trigger').first().waitFor();
          assert.equal(await page.locator('select').count(), 0, 'a native <select> is back; use AppSelect (shell/src/ui/select.jsx)');
          const triggers = page.locator('.ui-select-trigger');
          for (let i = 0; i < await triggers.count(); i++) {
            const box = await controlBox(triggers.nth(i));
            assert.equal(box.tag, 'BUTTON', `picker ${i} is ${box.tag}`);
            assert.match(box.cls, /\btdoc-select\b/, `picker ${i} lost the shared .tdoc-select look`);
          }
        });

        if (withDefault) {
          await t(`${width}px: the connector form lines up (34px picker and Save, one row on desktop)`, async () => {
            const form = page.locator('.tdoc-conn-card .tdoc-conn-pick').first();
            const picker = await controlBox(form.locator('.ui-select-trigger'));
            const save = await controlBox(form.getByRole('button', { name: 'Save' }));
            assert.equal(picker.height, 34, `picker is ${picker.height}px`);
            assert.equal(save.height, 34, `Save is ${save.height}px`);
            if (width > 640) assert.equal(picker.top, save.top, 'picker and Save are not on one row');
          });
          await t(`${width}px: the open list is tdoc's menu, not the OS list`, async () => {
            await page.locator('.tdoc-conn-card .ui-select-trigger').first().click();
            const popup = page.locator('.ui-select-popup');
            await popup.waitFor();
            assert.match(await popup.getAttribute('class'), /\bui-menu-popup\b/);
            const names = await popup.locator('.ui-select-item').allTextContents();
            assert.deepEqual(names, ['earn-with-ai-claw', 'smarter-tdoc-claw', 'research-claw', 'Another agent…']);
            if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `agents-${width}-open.png`) });
            const item = await controlBox(popup.locator('.ui-select-item').first());
            assert.equal(item.size, '13px', `menu rows are ${item.size}`);
            await popup.getByText('research-claw', { exact: true }).click();
            await popup.waitFor({ state: 'hidden' });
            assert.equal((await page.locator('.tdoc-conn-card .ui-select-trigger').first().textContent()).trim(), 'research-claw');
          });
        } else {
          await t(`${width}px: the default-agent modal uses the same picker, and its list opens above the modal`, async () => {
            const dialog = page.getByRole('dialog', { name: 'Choose your default agent' });
            await dialog.waitFor();
            const trigger = dialog.locator('.ui-select-trigger');
            const box = await controlBox(trigger);
            const save = await controlBox(dialog.getByRole('button', { name: 'Save' }));
            // 34px, or the modal's 44px touch target on a phone — but always
            // the same as the button beside it, on the same row.
            assert.ok(box.height === (width > 700 ? 34 : 44), `picker is ${box.height}px`);
            assert.equal(save.height, box.height, `Save ${save.height}px beside a ${box.height}px picker`);
            assert.equal(save.top, box.top, 'Save fell onto its own row');
            const saveWidth = await dialog.getByRole('button', { name: 'Save' }).evaluate((el) => el.getBoundingClientRect().width);
            assert.ok(saveWidth < 140, `Save is stretched to ${Math.round(saveWidth)}px`);
            await trigger.click();
            const popup = page.locator('.ui-select-popup');
            await popup.waitFor();
            const onTop = await popup.evaluate((el) => {
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
              return el.contains(hit);
            });
            assert.ok(onTop, 'the open list is hidden behind the dialog');
            await page.keyboard.press('Escape');
          });
        }

        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, `agents-${width}-${withDefault ? 'default' : 'setup'}.png`), fullPage: true });
        }
        await t(`${width}px, ${label}: no page errors`, async () => assert.deepEqual(errors, []));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
