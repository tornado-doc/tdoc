// The doc page's comment filter on a wide screen: the chevron beside the
// bar's Comment button (CommentFilterMenu), Open / Replied / Resolved / All
// as menuitemradio rows named "Open (2)". The floating filter row over the
// comment column is gone (Julie, 2026-11-16); the phone drawer and the side
// list keep the segmented filter at the head of the list.

async function openDocFilterMenu(page) {
  const popup = page.locator('.tdoc-comments-filter-popup');
  if (!(await popup.isVisible().catch(() => false))) await page.locator('.tdoc-bar .tdoc-comments-filter-menu').click();
  await popup.waitFor();
  return popup;
}

async function closeDocFilterMenu(page) {
  const popup = page.locator('.tdoc-comments-filter-popup');
  if (await popup.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' }).catch(() => {});
  }
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
  await page.locator('.tdoc-comments-filter-popup').waitFor({ state: 'detached' }).catch(() => {});
}

module.exports = { openDocFilterMenu, closeDocFilterMenu, docFilterItem, docFilterLabels, pickDocFilter };
