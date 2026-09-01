import { useEffect, useState } from 'react';
import { listMentionableUsers } from '../document/api.js';

// The people this session may name after `@` on this doc. Refetched as the
// conversation grows, so whoever just commented becomes someone you can answer
// by name. Empty for a reader who cannot comment here — the server answers 403
// and there is nobody to offer.
export function useMentionable(slug, enabled, participantCount) {
  const [people, setPeople] = useState([]);

  useEffect(() => {
    if (!enabled || !slug) {
      setPeople([]);
      return undefined;
    }
    let live = true;
    listMentionableUsers(slug)
      .then((body) => { if (live) setPeople(Array.isArray(body?.users) ? body.users : []); })
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [slug, enabled, participantCount]);

  return people;
}
