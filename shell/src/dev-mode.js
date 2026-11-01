// Dev mode: an allow-listed account's switch between being a tester (the
// Onboarding test submenu and replay) and being a person, who sees exactly
// what anybody else sees. The server decides who has the switch and keeps its
// position per account; every page's boot says so in `devMode` -- absent for
// everybody not on the list, `{ on }` for those who are.

export function readDevMode() {
  if (typeof window === 'undefined') return null;
  const boot = window.__TDOC_APP_BOOT__ || window.__TDOC_SHELL__ || null;
  const dev = boot && boot.devMode;
  return dev && typeof dev === 'object' ? { on: dev.on !== false } : null;
}

// Flip it on the server, then reload: the test menu, replay controls and the
// onboarding record the page shows are all drawn from the boot, so a reload is
// the honest way to switch between the two views of the product.
export async function setDevMode(on) {
  const response = await fetch('/api/me/dev-mode', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: Boolean(on) }),
  });
  if (!response.ok) throw new Error(`dev mode ${response.status}`);
  location.reload();
}
