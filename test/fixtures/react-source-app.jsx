// A small React app for test/react-source-ui.test.js: App › Pricing ›
// PlanCard, one element carrying a source attribute (react-dev-inspector
// style), and a component whose name and source path are hostile markup.
import React from 'react';
import { createRoot } from 'react-dom/client';

function PlanCard({ name, price }) {
  return (
    <div className="plan" id={`plan-${name.toLowerCase()}`} data-inspector-relative-path="src/pricing/PlanCard.jsx" data-inspector-line="9" data-inspector-column="5">
      <h3>{name}</h3>
      <p className="price">{price}</p>
      <button type="button" id={`buy-${name.toLowerCase()}`}>Choose {name}</button>
    </div>
  );
}

function Pricing() {
  return (
    <section className="pricing">
      <PlanCard name="Starter" price="$9" />
      <PlanCard name="Pro" price="$29" />
    </section>
  );
}

function Evil() {
  return <p id="evil" data-inspector-relative-path={'<img src=x onerror="window.__pwned=1">.jsx'} data-inspector-line="1">Hostile names</p>;
}
Evil.displayName = '<img src=x onerror="window.__pwned=2">';

function App() {
  return (
    <main>
      <h1>Acme pricing</h1>
      <Pricing />
      <Evil />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
