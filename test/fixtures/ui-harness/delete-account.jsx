import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub.css';
import { DeleteAccountCard } from '../../../shell/src/docs-hub/delete-account.jsx';

createRoot(document.getElementById('root')).render(
  <main className="docs-hub wrap">
    <section className="tm-settings">
      <DeleteAccountCard />
    </section>
  </main>,
);
