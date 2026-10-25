import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '../ui/portal.js';
import { useGithubUserSearch } from './github-user-search.js';
import { AGENT_TAG_JOINER, agentFacts, agentMentionName, matchAgentChoices, targetKey } from './agent-choices.js';
import { ProviderMark, recipientOption } from './notify-handoff.jsx';
import { insertMention, matchMentionable, mentionQueryAt, mentionReason, splitMentions } from './mentions.js';
import { parseRichText } from './rich-text.js';
import { freeLeftText } from './ai-answerer.js';

// A textarea that offers people after `@`. Both composers use it, so mentioning
// works the same whether you are starting a thread or answering one.
//
// The doc's own people answer first and instantly. GitHub's search is only
// reached when they do not match — its unauthenticated limit is 10/min per
// visitor and the Share panel's invite field spends from the same budget.
// Kept in step with `.tdoc-mention-menu`'s max-height in chrome.css: the
// placement needs to know how tall the menu can get to decide which side of
// the textarea it fits on.
const MENU_MAX_HEIGHT = 184;

// The agents this viewer can hand comments to, in the Send to agent
// dropdown's order (orderedAgentChoices), and the one it preselects. Empty
// unless the shell lets this viewer send to agents: a reader sees people only.
// `choices` is the composer's @ list (ai-answerer.js composerAgents): agents
// that may edit and agents that may only answer, each row saying which, the
// default first. `ai` carries tdoc AI's free answers left and who is
// answering where.
export const AgentMentionContext = createContext({ choices: [], preselected: null, ai: null });

// The composers' @agent buttons. The document page has none -- @ in the text
// is the one way to hand a comment to an agent -- the feedback overlay keeps
// them (it has no @ list of agents).
export const AgentButtonsContext = createContext(false);

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
  const agentsOnOffer = useContext(AgentMentionContext);

  // Agents are their own group above people: the first two with nothing
  // typed, every one whose name matches once something is.
  const agentMatches = query
    ? matchAgentChoices(agentsOnOffer.choices, query.query, {
      labelOf: (t) => recipientOption(t, agentsOnOffer.preselected, agentsOnOffer.choices).label,
    }).map((t) => {
      const option = recipientOption(t, agentsOnOffer.preselected, agentsOnOffer.choices);
      const left = t.tdoc_ai ? freeLeftText(agentsOnOffer.ai?.remaining) : null;
      return { agent: t, key: `agent:${targetKey(t)}`, ...option, hint: [option.hint, left].filter(Boolean).join(' · ') };
    })
    : [];
  const localMatches = query ? matchMentionable(people, query.query) : [];
  // Typing an address is already a complete tag — asking GitHub's user search
  // about "dana@corp.com" offers strangers and leaks the address upstream.
  const remote = useGithubUserSearch(query ? query.query : '', {
    enabled: Boolean(query) && localMatches.length === 0 && !query.query.includes('@'),
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
  const rows = agentMatches.concat(matches);
  const open = Boolean(query) && rows.length > 0;

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

  // Where to draw the menu, in viewport coordinates. It renders in a portal
  // rather than under the textarea because the comment card is a scroll
  // container now (#363) and an absolutely-positioned child of one is clipped
  // at its edge — the list would be cut in half the moment the composer sits
  // near the bottom of a tall thread. Fixed coordinates measured off the
  // textarea keep it whole and keep it glued to the field while that container
  // scrolls; it flips above the box when there is more room up there.
  const [menuBox, setMenuBox] = useState(null);
  const portalContainer = usePortalContainer();
  useLayoutEffect(() => {
    if (!open) {
      setMenuBox(null);
      return undefined;
    }
    const place = () => {
      const box = ref.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      setMenuBox({
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        ...(below < MENU_MAX_HEIGHT + 8 && rect.top > below
          ? { bottom: Math.round(window.innerHeight - rect.top + 4) }
          : { top: Math.round(rect.bottom + 4) }),
      });
    };
    place();
    // `true`: the scroll that moves the field is the card's, not the window's.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, rows.length]);

  const syncQuery = (element) => {
    setQuery(mentionQueryAt(element.value, element.selectionStart));
  };

  const pick = (person) => {
    if (person.agent) {
      // "@\u2060claude": reads as the agent's name, never parsed as a login.
      const next = insertMention(value, query, `${AGENT_TAG_JOINER}${agentMentionName(person.agent, agentsOnOffer.choices)}`);
      caretAfterInsert.current = next.caret;
      setQuery(null);
      onChange(next.text);
      return;
    }
    // An email participant's key is "email:<addr>"; the text form of the tag
    // is the bare address (the parser reads "@addr" back into the key).
    const key = String(person.login || '');
    const next = insertMention(value, query, key.startsWith('email:') ? key.slice(6) : key);
    caretAfterInsert.current = next.caret;
    setQuery(null);
    onChange(next.text);
  };

  const onKeyDown = (event) => {
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % rows.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(rows[active] || rows[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSubmit?.({ sendToAgent: event.shiftKey });
    }
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
      {open && menuBox ? createPortal((
        <div className="tdoc-mention-menu" id="tdoc-mention-menu" role="listbox" style={menuBox}>
          {agentMatches.length ? <div className="tdoc-mention-group" role="presentation">Agents</div> : null}
          {agentMatches.map((row, index) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`tdoc-mention-option tdoc-mention-agent${index === active ? ' active' : ''}`}
              title={row.agent.tdoc_ai ? `${row.label}: ${row.hint}` : agentFacts(row.agent).map((f) => `${f.label}: ${f.value}`).join('\n')}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(row)}
            >
              <span className="tdoc-mention-agent-mark"><ProviderMark target={row.agent} size={14} /></span>
              <span className="tdoc-mention-login">{row.label}</span>
              {row.hint ? <span className="tdoc-mention-source">{row.hint}</span> : null}
            </button>
          ))}
          {agentMatches.some((row) => row.agent.tdoc_ai) ? (
            <a className="tdoc-mention-connect" href="/start" onMouseDown={(event) => event.preventDefault()}>Connect my agent →</a>
          ) : null}
          {agentMatches.length && matches.length ? <div className="tdoc-mention-group" role="presentation">People</div> : null}
          {matches.map((person, i) => {
            const index = agentMatches.length + i;
            return (
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
                <span className="tdoc-mention-login">@{String(person.login).startsWith('email:') ? String(person.login).slice(6) : person.login}</span>
                {person.name && person.name.toLowerCase() !== person.login ? (
                  <span className="tdoc-mention-name">{person.name}</span>
                ) : null}
                {person.remote ? <span className="tdoc-mention-source">GitHub</span>
                  : mentionReason(person) ? <span className="tdoc-mention-source">{mentionReason(person)}</span> : null}
              </button>
            );
          })}
        </div>
      ), portalContainer || document.body) : null}
    </div>
  );
}

function renderMentionBits(text, mentions, keyPrefix) {
  return splitMentions(text, mentions).map((part, index) => {
    const key = `${keyPrefix}-m${index}`;
    if (part.type === 'mention') {
      return <span key={key} className="tdoc-mention-chip">{part.value}</span>;
    }
    return <React.Fragment key={key}>{part.value}</React.Fragment>;
  });
}

function renderInline(nodes, mentions, keyPrefix) {
  return (nodes || []).map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === 'strong') {
      return (
        <strong key={key} className="tdoc-md-strong">
          {renderMentionBits(node.value, mentions, key)}
        </strong>
      );
    }
    if (node.type === 'code') return <code key={key} className="tdoc-md-code">{node.value}</code>;
    if (node.type === 'link') {
      return (
        <a key={key} className="tdoc-md-link" href={node.value} target="_blank" rel="noopener noreferrer">
          {node.value}
        </a>
      );
    }
    return <React.Fragment key={key}>{renderMentionBits(node.value, mentions, key)}</React.Fragment>;
  });
}

function renderRichBlocks(blocks, mentions, keyPrefix) {
  return (blocks || []).map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    if (block.type === 'fence') {
      return <pre key={key} className="tdoc-md-pre"><code>{block.value}</code></pre>;
    }
    if (block.type === 'list') {
      return (
        <ul key={key} className="tdoc-md-list">
          {(block.items || []).map((item, i) => (
            <li key={`${key}-li-${i}`}>{renderInline(item, mentions, `${key}-li-${i}`)}</li>
          ))}
        </ul>
      );
    }
    if (block.type === 'break') return <React.Fragment key={key}>{'\n\n'}</React.Fragment>;
    if (block.type === 'paragraph') {
      return (
        <span key={key} className="tdoc-md-p">
          {renderInline(block.children, mentions, key)}
        </span>
      );
    }
    return null;
  });
}

// Posted comment text: markdown subset first (so **…@x…** stays one bold run),
// then delivered mentions become chips inside text/strong leaves. Code/fences
// stay literal. React nodes only — no HTML strings, no markdown library.
export function MentionText({ text, mentions }) {
  return <>{renderRichBlocks(parseRichText(text), mentions, 't')}</>;
}
