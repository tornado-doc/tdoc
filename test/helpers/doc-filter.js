// The doc page's comment filter on a wide screen: the chevron beside the
// bar's Comment button (CommentFilterMenu), Open / Replied / Resolved / All
// as menuitemradio rows named "Open (2)". The floating filter row over the
// comment column is gone (Julie, 2026-11-16); the phone drawer and the side
// list keep the segmented filter at the head of the list.

// Base UI keeps a closing popup in the DOM (data-closed, data-ending-style)
// until its exit animation ends, so "visible" is not "open": a popup that is
// still closing from the last pick would detach under the next lookup. Only
// a popup with data-open counts, and a closing one is waited out first.
const POPUP = '.tdoc-comments-filter-popup';
const OPEN_POPUP = `${POPUP}[data-open]:not([data-ending-style])`;

async function openDocFilterMenu(page) {
  const open = page.locator(OPEN_POPUP);
  if (await open.isVisible().catch(() => false)) return open;
  await page.locator(`${POPUP}:not([data-open])`).waitFor({ state: 'detached' }).catch(() => {});
  const trigger = page.locator('.tdoc-bar .tdoc-comments-filter-menu');
  await trigger.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const button = document.querySelector('.tdoc-bar .tdoc-comments-filter-menu');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  });
  for (let attempt = 0; ; attempt++) {
    await trigger.click();
    try {
      await open.waitFor({ timeout: attempt ? 30000 : 5000 });
      return open;
    } catch (error) {
      if (attempt) throw error;
      // The click landed while the bar was re-rendering; close whatever
      // half-opened and try once more.
      await page.keyboard.press('Escape');
      await page.locator(POPUP).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  }
}

async function closeDocFilterMenu(page) {
  if (await page.locator(OPEN_POPUP).isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await page.locator(POPUP).waitFor({ state: 'detached' }).catch(() => {});
}

// One choice, by its name ("All", /^Resolved/).
async function docFilterItem(page, name) {
  const popup = await openDocFilterMenu(page);
  const re = name instanceof RegExp ? name : new RegExp(`^${name}`);
  return popup.getByRole('menuitemradio', { name: re });
}

// ["Open (2)", "Replied (1)", ...]
async function docFilterLabels(page) {
  const popup = await openDocFilterMenu(page);
  return popup.locator('[role="menuitemradio"]').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
}

// Pick a choice; the menu closes behind it.
async function pickDocFilter(page, name) {
  await (await docFilterItem(page, name)).click();
  await page.locator(POPUP).waitFor({ state: 'detached' }).catch(() => {});
}

module.exports = { openDocFilterMenu, closeDocFilterMenu, docFilterItem, docFilterLabels, pickDocFilter };
