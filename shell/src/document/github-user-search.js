import { useEffect, useState } from 'react';

// GitHub's own user search, one implementation shared by the Share panel's
// invite field and the comment composer's @ picker.
//
// Unauthenticated and called straight from the browser on purpose: GitHub caps
// search at 10 requests/minute PER IP, so keeping it client-side gives every
// visitor their own budget. Proxying it through the worker would pool the
// whole site into the worker's egress addresses and exhaust one shared limit.
// Callers still have to spend that budget carefully — see `enabled`.

export function normalizeLogin(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/.*$/, '');
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

// `enabled` is the rate-limit valve: the @ picker passes false while the doc's
// own people already answer the query, so typing a colleague's name never
// reaches GitHub at all.
export function useGithubUserSearch(rawQuery, { enabled = true, limit = 5 } = {}) {
  const [users, setUsers] = useState([]);

  const login = normalizeLogin(rawQuery);

  useEffect(() => {
    if (!enabled || login.length < MIN_QUERY) {
      setUsers([]);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const query = new URLSearchParams({ q: `${login} in:login`, per_page: String(limit) });
      try {
        const response = await fetch(`https://api.github.com/search/users?${query}`, {
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json' },
        });
        const body = response.ok ? await response.json() : {};
        setUsers(Array.isArray(body.items) ? body.items : []);
      } catch (error) {
        // A rate-limited or offline search is not an error the user can act
        // on — they can still type the login by hand.
        if (error.name !== 'AbortError') setUsers([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [login, enabled, limit]);

  return users;
}
