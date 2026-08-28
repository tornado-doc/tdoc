import React from 'react';

// Option set styled by chrome.css `.tdoc-seg` (bordered pill, accent-filled
// active option) — the same control the legacy Share panel used.
export function SegmentedControl({ value, options, onChange, ariaLabel }) {
  return (
    <div className="tdoc-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'active' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
