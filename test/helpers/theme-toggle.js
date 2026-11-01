// Light / dark is a row of the account menu (or of ⋯ when signed out, or on a
// phone), not a bar button. These open whichever menu holds it.
async function openThemeMenu(page) {
  const account = page.locator('.tdoc-bar button.tdoc-account-trigger:not(.signin)');
  if (await account.count() && await account.first().isVisible()) await account.first().click();
  else await page.locator('#tdoc-more-btn').click();
  await page.locator('.ui-menu-popup').first().waitFor();
}

// The theme row in the open menu, or null when the page offers none. A
// document offers it once its frame says the design supports a theme, which
// can land just after load: look again for a moment before saying none.
async function themeRow(page, { waitMs = 3000 } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    await openThemeMenu(page);
    const row = page.locator('.ui-menu-popup [data-action="theme"]').filter({ visible: true });
    if (await row.count()) return row.first();
    if (Date.now() > until) return null;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
}

async function toggleTheme(page) {
  const row = await themeRow(page);
  if (!row) throw new Error('no light/dark row in the account menu or ⋯');
  await row.click();
}

module.exports = { openThemeMenu, themeRow, toggleTheme };
