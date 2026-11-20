// Signing in without leaving the page: the sign-in runs in a window of its
// own, and this page carries on when tdoc says the person is signed in.
//
// The window walks through the provider's pages (accounts.tdoc.dev, behind a
// Cloudflare check), which send Cross-Origin-Opener-Policy: same-origin, so
// from there on it has no window.opener and reads as closed from here while
// the person is still signing in (see "Connecting when the popup loses its
// opener" in the worker). Neither postMessage nor popup.closed can be
// trusted, then. What is:
//   - the truth is the server: GET /api/auth/me with this browser's cookie,
//     polled while waiting. Nothing the window says is taken as a sign-in;
//   - the window's last page (/auth/signed-in, same origin as this one) says
//     "check now" on a BroadcastChannel, which reaches every same-origin tab
//     whatever the opener. The message carries nothing: no token, no name.
// No token or code ever travels in a URL here: the provider's own redirect
// sets the session cookie, as on a full-page sign-in.

export const SIGNED_IN_PATH = '/auth/signed-in';
export const SIGNED_IN_CHANNEL = 'tdoc-auth';
export const SIGNED_IN_MESSAGE = 'tdoc:signed-in';
const WINDOW_NAME = 'tdoc-sign-in';
const WINDOW_FEATURES = 'popup,width=520,height=680,resizable=yes,scrollbars=yes';
const POLL_MS = 1500;
const TIMEOUT_MS = 10 * 60 * 1000;

// The provider's door for this deployment, landing on SIGNED_IN_PATH; null
// where there is none (the device-code dialog is the way in there).
export function signInHref({ oidcAuth = false, webAuth = false } = {}, returnTo = SIGNED_IN_PATH) {
  if (oidcAuth) return `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnTo)}`;
  if (webAuth) return `/api/auth/web/login?return=${encodeURIComponent(returnTo)}`;
  return null;
}

async function signedInIdentity() {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return (body && body.identity) || null;
}

// Opens the window (call it from the click: a window no click opened is
// blocked). Returns null when the browser blocked it; otherwise
// { done, reopen, cancel }: `done` resolves with the identity tdoc reports
// once signed in, and rejects with { cancelled } or { timedOut }.
export function startSignInPopup(href, { check = signedInIdentity, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS } = {}) {
  let popup = null;
  try { popup = window.open(href, WINDOW_NAME, WINDOW_FEATURES); } catch { popup = null; }
  if (!popup) return null;
  let timer = null;
  let channel = null;
  let settled = false;
  let checking = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const started = Date.now();
  const stop = () => {
    settled = true;
    window.clearTimeout(timer);
    try { if (channel) channel.close(); } catch { /* ignore */ }
  };
  const fail = (extra) => {
    if (settled) return;
    stop();
    const error = new Error(extra.cancelled ? 'Sign-in cancelled' : 'Sign-in took too long');
    Object.assign(error, extra);
    rejectDone(error);
  };
  const check_ = async () => {
    if (settled || checking) return;
    checking = true;
    window.clearTimeout(timer);
    let identity = null;
    try { identity = await check(); } catch { identity = null; }
    checking = false;
    if (settled) return;
    if (identity) {
      stop();
      try { if (popup && !popup.closed) popup.close(); } catch { /* ignore */ }
      resolveDone(identity);
      return;
    }
    if (Date.now() - started > timeoutMs) { fail({ timedOut: true }); return; }
    timer = window.setTimeout(check_, pollMs);
  };
  try {
    channel = new BroadcastChannel(SIGNED_IN_CHANNEL);
    channel.onmessage = (event) => { if (event && event.data && event.data.type === SIGNED_IN_MESSAGE) check_(); };
  } catch { /* no BroadcastChannel: polling alone */ }
  timer = window.setTimeout(check_, pollMs);
  return {
    done,
    // Bring the window back: to the front while it is there, a new one
    // (from this click) when it is gone or cut off from us.
    reopen: () => {
      if (settled) return true;
      if (popup && !popup.closed) { try { popup.focus(); } catch { /* ignore */ } return true; }
      let next = null;
      try { next = window.open(href, WINDOW_NAME, WINDOW_FEATURES); } catch { next = null; }
      if (next) popup = next;
      return Boolean(next);
    },
    cancel: () => {
      try { if (popup && !popup.closed) popup.close(); } catch { /* ignore */ }
      fail({ cancelled: true });
    },
  };
}

// The window's last page: tell this browser's tdoc tabs to check now, then
// close. Harmless when nobody is waiting, and says nothing but "check".
export function announceSignedIn() {
  try {
    const channel = new BroadcastChannel(SIGNED_IN_CHANNEL);
    channel.postMessage({ type: SIGNED_IN_MESSAGE });
    channel.close();
  } catch { /* the opener's polling still sees the session */ }
}
