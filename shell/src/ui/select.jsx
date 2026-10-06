import React from 'react';
import { Select } from '@base-ui/react/select';

// The one dropdown. A native <select> lets the operating system draw the open
// list, so it never looks like tdoc; this draws both halves itself. The closed
// box is chrome.css `.tdoc-select` (the Share access picker's look) and the
// open list is the same popup and rows as AppMenu (`.ui-menu-popup`,
// `.ui-menu-item`), so a dropdown and a menu read as one family.
//
// options: [{ value, label }]. Values are strings. `plain` drops the field box
// for a control that sits in a toolbar or a row and brings its own class; the
// open list stays the same everywhere.
export function AppSelect({ value, onChange, options, id, ariaLabel, className = '', disabled = false, plain = false }) {
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => { if (next != null) onChange(next); }}
      disabled={disabled}
    >
      <Select.Trigger id={id} aria-label={ariaLabel} className={[plain ? null : 'tdoc-select', 'ui-select-trigger', className].filter(Boolean).join(' ')}>
        <Select.Value className="ui-select-value" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-menu-positioner ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup className="ui-menu-popup ui-select-popup">
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="ui-menu-item ui-select-item">
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
