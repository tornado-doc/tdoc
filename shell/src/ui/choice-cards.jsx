import React from 'react';

export function ChoiceCards({ value, options, onChange, ariaLabel, disabled = false }) {
  return <div className="ui-choice-cards" role="group" aria-label={ariaLabel}>
    {options.map((option) => <button key={option.value} type="button" className="ui-choice-card" data-tone={option.tone}
      aria-pressed={value === option.value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>
      <span className="ui-choice-card-mark" aria-hidden="true">{option.icon}</span><span className="ui-choice-card-copy"><span className="ui-choice-card-title"><strong>{option.label}</strong><span className="ui-choice-card-state">{option.status}</span></span><span>{option.description}</span></span>
      <span className="ui-choice-card-check" aria-hidden="true">{value === option.value ? '✓' : ''}</span>
    </button>)}
  </div>;
}
