// The doc page's Read / Comment / Edit switch heads the ⋯ menu (it left the
// bar, where it read as a second comment button beside Comment). The mode on
// screen is .tdoc-document-app[data-mode].
const modeSelector = (value) => `.tdoc-document-app[data-mode="${value}"]`;

async function chooseMode(page, label) {
  const value = label.toLowerCase();
  if (await page.locator(modeSelector(value)).count()) return;
  await page.locator('.tdoc-bar #tdoc-more-btn').click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await page.locator(modeSelector(value)).waitFor();
}

module.exports = { chooseMode, modeSelector };
