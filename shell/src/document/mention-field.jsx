import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useGithubUserSearch } from './github-user-search.js';
import { insertMention, matchMentionable, mentionQueryAt, splitMentions } from './mentions.js';

// A textarea that offers people after `@`. Both composers use it, so mentioning
// works the same whether you are starting a thread or answering one.
//
// The doc's own people answer first and instantly. GitHub's search is only
// reached when they do not match — its unauthenticated limit is 10/min per
// visitor and the Share panel's invite field spends from the same budget.
export function MentionField({
  value,
  onChange,
  onSubmit,
  people,
  placeholder,
  autoFocus = false,
  rootClassName = '',
}) {
  const ref = useRef(null);
  const caretAfterInsert = useRef(null);
  const [query, setQuery] = useState(null);
  const [active, setActive] = useState(0);

  const localMatches = query ? matchMentionable(people, query.query) : [];
  const remote = useGithubUserSearch(query ? query.query : '', {
    enabled: Boolean(query) && localMatches.length === 0,
  });
  const matches = useMemo(() => {
    const seen = new Set(localMatches.map((person) => String(person.login).toLowerCase()));
    return localMatches.concat(remote
      .filter((user) => user.login && !seen.has(String(user.login).toLowerCase()))
      .map((user) => ({ login: user.login, name: '', avatar_url: user.avatar_url, remote: true })))
      .slice(0, 6);
    // localMatches/remote are derived arrays; identity churn only costs a cheap
    // concat, and recomputing keeps the highlighted row in step with the query.
  }, [JSON.stringify(localMatches), remote]);
  const open = Boolean(query) && matches.length > 0;

  // Restore the caret after an insertion: React re-renders with the new value
  // and would otherwise leave it at the end of the textarea.
  useLayoutEffect(() => {
    const pos = caretAfterInsert.current;
    if (pos == null || !ref.current) return;
    caretAfterInsert.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pos, pos);
  }, [value]);

  useEffect(() => { setActive(0); }, [query?.query]);

  const syncQuery = (element) => {
    setQuery(mentionQueryAt(element.value, element.selectionStart));
  };

  const pick = (person) => {
    const next = insertMention(value, query, person.login);
    caretAfterInsert.current = next.caret;
    setQuery(null);
    onChange(next.text);
  };

  const onKeyDown = (event) => {
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(matches[active] || matches[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onSubmit?.();
  };

  return (
    <div className={`tdoc-mention-field${rootClassName ? ` ${rootClassName}` : ''}`}>
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? 'tdoc-mention-menu' : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          syncQuery(event.target);
        }}
        onKeyUp={(event) => syncQuery(event.target)}
        onClick={(event) => syncQuery(event.target)}
        onBlur={() => setQuery(null)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div className="tdoc-mention-menu" id="tdoc-mention-menu" role="listbox">
          {matches.map((person, index) => (
            <button
              key={person.login}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`tdoc-mention-option${index === active ? ' active' : ''}`}
              // Keep the caret: a blur would close the menu before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(person)}
            >
              {person.avatar_url ? <img src={person.avatar_url} alt="" /> : <span className="tdoc-mention-anon" />}
              <span className="tdoc-mention-login">@{person.login}</span>
              {person.name && person.name.toLowerCase() !== person.login ? (
                <span className="tdoc-mention-name">{person.name}</span>
              ) : null}
              {person.remote ? <span className="tdoc-mention-source">GitHub</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Posted comment text, with the mentions the server actually delivered shown
// as chips. Everything else stays exactly as it was typed.
export function MentionText({ text, mentions }) {
  const parts = splitMentions(text, mentions);
  return (
    <>
      {parts.map((part, index) => (part.type === 'mention'
        ? <span key={index} className="tdoc-mention-chip">{part.value}</span>
        : <React.Fragment key={index}>{part.value}</React.Fragment>))}
    </>
  );
}
