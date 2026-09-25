import { useEffect, useState } from 'react';
import { listMentionableUsers } from '../document/api.js';

// Homepage demo: people the visitor can try tagging without hitting /api/mentions.
// Pick a handle everyone recognizes as "on GitHub" — the point is the affordance.
export const DEMO_MENTIONABLE = [
  { login: 'torvalds', name: 'Linus Torvalds' },
];

// The people this session may name after `@` on this doc. Refetched as the
// conversation grows, so whoever just commented becomes someone you can answer
// by name. Empty for a reader who cannot comment here — the server answers 403
// and there is nobody to offer. `demo` skips the API and offers DEMO_MENTIONABLE.
export function useMentionable(slug, enabled, participantCount, { demo = false } = {}) {
  const [people, setPeople] = useState(demo ? DEMO_MENTIONABLE : []);

  useEffect(() => {
    if (demo) {
      setPeople(DEMO_MENTIONABLE);
      return undefined;
    }
    if (!enabled || !slug) {
      setPeople([]);
      return undefined;
    }
    let live = true;
    listMentionableUsers(slug)
      .then((body) => { if (live) setPeople(Array.isArray(body?.users) ? body.users : []); })
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [slug, enabled, participantCount, demo]);

  return people;
}
