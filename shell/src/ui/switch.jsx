import React from 'react';
import { Switch } from '@base-ui/react/switch';

// A labelled slide switch. Base UI supplies the semantics (role, keyboard,
// checked state); chrome.css `.tdoc-switch` supplies the track and the thumb,
// the same way SegmentedControl leans on `.tdoc-seg`.
export function AppSwitch({ checked, onCheckedChange, label, id }) {
  return (
    <label className="tdoc-switch" htmlFor={id}>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="tdoc-switch-track"
      >
        <Switch.Thumb className="tdoc-switch-thumb" />
      </Switch.Root>
      <span className="tdoc-switch-label">{label}</span>
    </label>
  );
}
