import React, { useEffect, useState } from 'react';
import { day, docHref } from './rows.jsx';

// Full-text search: the title filter above answers as you type; this asks
// the server for the words inside documents and their comments, a moment
// after typing stops. Only docs this person's hub lists can come back, and
// every passage arrives as text segments, so nothing in a doc renders as
// markup here.
export const TEXT_SEARCH_MIN = 2;
const DEBOUNCE_MS = 250;

export function useTextSearch(query, space) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  const [state, setState] = useState({ q: '', space: '', status: 'idle', results: [], indexing: 0 });
  useEffect(() => {
    if ([...q].length < TEXT_SEARCH_MIN) {
      setState({ q: '', space, status: 'idle', results: [], indexing: 0 });
      return undefined;
    }
    const controller = new AbortController();
    setState((prev) => ({ ...prev, q, space, status: 'loading' }));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q });
      if (space) params.set('space', space);
      fetch(`/api/search?${params}`, { credentials: 'same-origin', signal: controller.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          if (r.status === 429) return setState({ q, space, status: 'limited', results: [], indexing: 0 });
          if (!r.ok || !body || !Array.isArray(body.results)) return setState({ q, space, status: 'unavailable', results: [], indexing: 0 });
          return setState({ q, space, status: 'done', results: body.results, indexing: Number(body.indexing) || 0 });
        })
        .catch((error) => {
          if (error && error.name === 'AbortError') return;
          setState({ q, space, status: 'unavailable', results: [], indexing: 0 });
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, space]);
  return state;
}

function Marked({ segments, className }) {
  return (
    <span className={className}>
      {(segments || []).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <React.Fragment key={i}>{part.text}</React.Fragment>))}
    </span>
  );
}

// `exclude`: slugs the title filter already shows; `pathFor(result)` names
// where a doc lives (space › folder).
export function TextSearchResults({ search, exclude, pathFor }) {
  if (search.status === 'idle' || search.status === 'unavailable') return null;
  const results = search.results.filter((item) => !exclude.has(item.slug));
  const loading = search.status === 'loading';
  let note = null;
  if (loading && !results.length) note = 'Searching document text…';
  else if (search.status === 'limited') note = 'Too many searches at once. Try again in a minute.';
  // Nothing more to say: the list above (or its empty notice) is the answer.
  else if (!results.length && !search.indexing) return null;
  return (
    <section className={`text-search${loading ? ' is-loading' : ''}`} aria-label="Results in document text" aria-busy={loading}>
      <h2 className="text-search-hd">Results in document text</h2>
      {search.indexing > 0 ? (
        <p className="text-search-note">Still indexing {search.indexing} {search.indexing === 1 ? 'doc' : 'docs'}; results may be incomplete.</p>
      ) : null}
      {note ? <p className="text-search-note">{note}</p> : null}
      {results.length ? (
        <div className="doc-list is-list text-search-list">
          {results.map((item) => {
            const where = pathFor(item);
            return (
              <a key={item.slug} className="doc-row text-search-row" href={docHref(item)} data-slug={item.slug}>
                <div className="doc-info">
                  <div className="doc-title-line">
                    <Marked className="doc-title" segments={item.title_marks || [{ text: item.title, hit: false }]} />
                  </div>
                  {item.snippet && item.snippet.length ? (
                    <p className="text-search-snippet">
                      {item.where === 'comments' ? <span className="text-search-where">In comments: </span> : null}
                      <Marked segments={item.snippet} />
                    </p>
                  ) : null}
                  <div className="doc-meta">
                    {[where, day(item.updated) ? `updated ${day(item.updated)}` : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
