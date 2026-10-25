import React from 'react';

export function ChoiceCards({ value, options, onChange, ariaLabel, disabled = false }) {
  return <div className="ui-choice-cards" role="group" aria-label={ariaLabel}>
    {options.map((option) => <button key={option.value} type="button" className="ui-choice-card"
      aria-pressed={value === option.value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>
      {option.icon}<span className="ui-choice-card-copy"><strong>{option.label}</strong><span>{option.description}</span></span>
      <span className="ui-choice-card-state">{option.status}</span>
    </button>)}
  </div>;
}
