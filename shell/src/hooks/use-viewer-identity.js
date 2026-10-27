import { useEffect, useState } from 'react';

// Who is looking, for pages whose worker response does not carry it (the
// status pages are rendered from dozens of places that never read the
// session). `given` is the boot's identity when the worker did send one:
// null means signed out, an object means signed in, undefined means ask.
// Until the answer arrives the page shows neither an avatar nor Sign in, so
// a signed-in visitor never sees a Sign in button flash.
export function useViewerIdentity(given) {
  const [state, setState] = useState(() => (
    given === undefined ? { ready: false, identity: null } : { ready: true, identity: given }
  ));
  useEffect(() => {
    if (given !== undefined) return undefined;
    const controller = new AbortController();
    fetch('/api/auth/me', { credentials: 'same-origin', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setState({ ready: true, identity: (body && body.identity) || null }))
      .catch(() => { if (!controller.signal.aborted) setState({ ready: true, identity: null }); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
