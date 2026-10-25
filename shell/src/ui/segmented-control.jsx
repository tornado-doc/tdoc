import React from 'react';

// Option set styled by chrome.css `.tdoc-seg` (bordered pill, accent-filled
// active option) — the same control the legacy Share panel used. An option
// may be `disabled`, with `reason` as its tooltip and accessible description.
export function SegmentedControl({ value, options, onChange, ariaLabel, className = '' }) {
  return (
    <div className={`tdoc-seg${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={Boolean(option.disabled)}
          title={option.disabled && option.reason ? option.reason : undefined}
          aria-label={option.disabled && option.reason ? `${option.label} (${option.reason})` : undefined}
          className={value === option.value ? 'active' : undefined}
          onClick={() => { if (!option.disabled) onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
