import React, { useMemo, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';

// The searchable dropdown, for lists long enough that scrolling is the slow
// part: a Raft server's agents run to dozens. It looks like AppSelect closed
// (the same .tdoc-select box and arrow) and opens the same menu popup, but the
// box is a text field -- click it and the whole list opens, type and it narrows.
//
// options: [{ value, label, hint? }]. `hint` is a short muted note on the right
// of a row ("this doc's agent", "used 2h ago"); search matches label and hint.
// `onQuery` hears what was typed, for a caller that offers the typed text
// itself as a row (a handle the list does not know yet).
export function AppCombobox({ value, onChange, options, id, ariaLabel, className = '', disabled = false, placeholder = 'Search…', empty = 'No match', onQuery }) {
  // Callers rebuild `options` every render. A new object for the same choice
  // reads to the combobox as a new selection, which rewrites the box with its
  // label mid-typing, so the selection is kept stable by value and label.
  const found = options.find((o) => o.value === value) || null;
  const selected = useMemo(() => found, [found && found.value, found && found.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState('');
  return (
    <Combobox.Root
      items={options}
      value={selected}
      onValueChange={(next) => { if (next) onChange(next.value); }}
      onInputValueChange={(next) => { setQuery(next); if (onQuery) onQuery(next); }}
      itemToStringLabel={(o) => (o ? o.label : '')}
      isItemEqualToValue={(a, b) => Boolean(a && b && a.value === b.value)}
      // The selected label sitting in the box is not a search: opening shows
      // everything, and only real typing narrows it.
      filter={(o, q) => {
        const needle = String(q || '').trim().toLowerCase();
        if (!needle || (selected && needle === selected.label.toLowerCase())) return true;
        return `${o.label} ${o.hint || ''}`.toLowerCase().includes(needle);
      }}
      openOnInputClick
      autoHighlight
      disabled={disabled}
    >
      <Combobox.InputGroup className={['ui-combo', className].filter(Boolean).join(' ')}>
        <Combobox.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="tdoc-select ui-combo-input"
          // Focus selects the current name, so typing replaces it instead of
          // appending to it.
          onFocus={(e) => e.currentTarget.select()}
        />
        <Combobox.Trigger className="ui-combo-trigger" aria-label={ariaLabel ? `Show all: ${ariaLabel}` : 'Show all'} tabIndex={-1} />
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="ui-menu-positioner ui-select-positioner" sideOffset={4} align="start">
          <Combobox.Popup className="ui-menu-popup ui-select-popup ui-combo-popup">
            <Combobox.Empty className="ui-combo-empty">{query.trim() || !options.length ? empty : null}</Combobox.Empty>
            <Combobox.List>
              {(o) => (
                <Combobox.Item key={o.value} value={o} className="ui-menu-item ui-select-item ui-combo-item">
                  <span className="ui-combo-label">{o.label}</span>
                  {o.hint ? <span className="ui-combo-hint">{o.hint}</span> : null}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
