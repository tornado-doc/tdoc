// The doc page's comment filter on a wide screen: the segmented control at
// the head of the side comment list (CommentFilter), Open / Replied /
// Resolved / All as radios named "Open (2)". It is the one filter control:
// the bar's chevron menu repeated it and was removed (Serena, 2026-11-16),
// and the floating filter row over the comment column is gone too (Julie,
// 2026-11-16). The phone drawer keeps the same control at its head.
//
// "Open the filter" opens the side list when it is closed, and "close"
// closes it again only if this helper opened it, so a test that started
// with the list closed ends with it closed.

const SIDE = '.tdoc-doc-side';
const FILTER = `${SIDE} .tdoc-comment-filter`;

async function openDocFilterMenu(page) {
  const side = page.locator(SIDE);
  if (!(await side.isVisible().catch(() => false))) {
    const toggle = page.locator('.tdoc-bar .tdoc-comments-toggle');
    await toggle.waitFor({ state: 'visible' });
    await toggle.click();
    page.__tdocFilterOpenedSide = true;
  }
  await page.locator(FILTER).waitFor({ state: 'visible' });
  return side;
}

async function closeDocFilterMenu(page) {
  if (!page.__tdocFilterOpenedSide) return;
  page.__tdocFilterOpenedSide = false;
  const toggle = page.locator('.tdoc-bar .tdoc-comments-toggle[aria-pressed="true"]');
  if (await toggle.count()) await toggle.click();
  await page.locator(SIDE).waitFor({ state: 'detached' }).catch(() => {});
}

// One choice, by its name ("All", /^Resolved/).
async function docFilterItem(page, name) {
  await openDocFilterMenu(page);
  const re = name instanceof RegExp ? name : new RegExp(`^${name}`);
  return page.locator(FILTER).getByRole('radio', { name: re });
}

// ["Open (2)", "Replied (1)", ...]
async function docFilterLabels(page) {
  await openDocFilterMenu(page);
  return page.locator(`${FILTER} [role="radio"]`).allInnerTexts();
}

// Pick a choice; the side list goes back to how it was.
async function pickDocFilter(page, name) {
  const item = await docFilterItem(page, name);
  await item.click();
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', await item.elementHandle());
  await closeDocFilterMenu(page);
}

module.exports = { openDocFilterMenu, closeDocFilterMenu, docFilterItem, docFilterLabels, pickDocFilter };
