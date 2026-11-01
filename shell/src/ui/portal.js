import { createContext, useContext } from 'react';

// Where popups (dialogs, menus, pickers) mount. Unset means document.body.
// The feedback overlay sets its own container, so its popups are told apart
// from the host page's — which, on tdoc.dev, use the very same classes.
export const PortalContainerContext = createContext(undefined);
export const usePortalContainer = () => useContext(PortalContainerContext);
