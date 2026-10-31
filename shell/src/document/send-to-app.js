// "Quick send to" on tdoc's own site pages (the homepage connect card): a
// button marked data-tdoc-send copies the setup prompt and opens the agent's
// app with it filled in, the way glasser.ai does. The page names the app;
// the URL is built here from this list, never taken from the page, and only
// site pages may ask (document-shell checks config.isLanding): any other
// document could otherwise prefill a reader's agent with its own words.
export const SEND_APPS = Object.freeze({
  codex: { name: 'Codex', url: (t) => `codex://new?prompt=${encodeURIComponent(t)}` },
  cursor: { name: 'Cursor', url: (t) => `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(t)}` },
  claude: { name: 'Claude', url: (t) => `claude://claude.ai/new?q=${encodeURIComponent(t)}` },
  claudeai: { name: 'Claude', url: (t) => `https://claude.ai/new?q=${encodeURIComponent(t)}` },
  // Sends at once (not just filled in), and works signed out.
  chatgpt: { name: 'ChatGPT', url: (t) => `https://chatgpt.com/?q=${encodeURIComponent(t)}` },
});

const MAX_PROMPT = 500;

// The link for an app and prompt, or null when either is not allowed.
export function sendToAppLink(app, text) {
  const target = Object.prototype.hasOwnProperty.call(SEND_APPS, app) ? SEND_APPS[app] : null;
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (!target || !prompt || prompt.length > MAX_PROMPT) return null;
  return { name: target.name, href: target.url(prompt) };
}

// Web links open in a new tab; an app scheme hands off from this tab.
// window.__tdocOpenApp lets a browser test see the hand-off.
export function openAppLink(href) {
  if (typeof window !== 'undefined' && typeof window.__tdocOpenApp === 'function') { window.__tdocOpenApp(href); return; }
  if (/^https:/.test(href)) window.open(href, '_blank', 'noopener');
  else window.location.href = href;
}
