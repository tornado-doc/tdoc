import React from 'react';
import { Checkbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';

// A labelled checkbox. Base UI supplies the semantics (role, keyboard,
// checked / disabled state); ui.css `.ui-checkbox` draws the box, the same
// way AppSwitch leans on `.tdoc-switch`. `hint` is a muted line after the
// label (why it is locked, what it does).
export function AppCheckbox({ checked, onCheckedChange, label, hint = '', disabled = false, className = '' }) {
  return (
    <label className={`ui-checkbox${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}>
      <Checkbox.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange?.(Boolean(next))}
        className="ui-checkbox-box"
      >
        <Checkbox.Indicator className="ui-checkbox-indicator">
          <Check size={11} strokeWidth={3} aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span className="ui-checkbox-label">{label}</span>
      {hint ? <span className="ui-checkbox-hint">{hint}</span> : null}
    </label>
  );
}
