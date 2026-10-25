import React from 'react';
import { ArrowRight } from 'lucide-react';

// Equal navigation choices within a shared dialog; each card opens its path.
export function ChoiceLinks({ options, onChoose, ariaLabel }) {
  return <div className="ui-choice-links" role="group" aria-label={ariaLabel}>
    {options.map((option) => <button type="button" className="ui-choice-link" key={option.value} onClick={() => onChoose(option.value)}>
      <span className="ui-choice-link-icon" aria-hidden="true">{option.icon}</span>
      <strong>{option.label}</strong><span>{option.description}</span>
      {option.detail ? <small>{option.detail}</small> : null}
      <ArrowRight size={18} aria-hidden="true" />
    </button>)}
  </div>;
}
