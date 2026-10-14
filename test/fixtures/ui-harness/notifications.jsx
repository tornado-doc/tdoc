// Mounts the Notifications dialog with its real hook, for
// test/notifications-ui.test.js. The top bar opens this same pair.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { NotificationsDialog } from '../../../shell/src/notifications-dialog.jsx';
import { useNotifications } from '../../../shell/src/hooks/use-notifications.js';

function Harness() {
  const notifications = useNotifications(true);
  useEffect(() => { notifications.load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <NotificationsDialog
      open
      notifications={notifications}
      onOpenChange={() => {}}
      onSelect={(item) => { window.__selected = item.id; notifications.markRead(item); }}
    />
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
