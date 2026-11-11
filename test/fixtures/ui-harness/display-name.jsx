import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub.css';
import { ProfileSettingsCard } from '../../../shell/src/docs-hub/display-name.jsx';
import { SignInMethodsCard } from '../../../shell/src/docs-hub/sign-in-methods.jsx';

const profile = { handle: 'julie', name: 'Jingyu Shi (Julie)', display_name: '', provider_name: 'Jingyu Shi (Julie)' };

function Harness() {
  const [name, setName] = useState(profile.name);
  return (
    <main className="docs-hub wrap">
      <p data-testid="menu-name">{name}</p>
      <section className="tm-settings" aria-label="Personal workspace settings">
        <div className="tm-settings-title"><h2>Workspace settings</h2><p>Settings for your personal workspace.</p></div>
        <ProfileSettingsCard name={name} profile={profile} onNameSaved={(saved) => setName(saved.name)} />
        <SignInMethodsCard />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
