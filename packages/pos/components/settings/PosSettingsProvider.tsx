import { lazy, type ReactNode } from 'react';
import { SettingsDialogProvider } from '@mercaria/ui';

// Loaded on the first open request: this provider wraps the whole app, and the
// dialog is never visible before someone asks for it.
const PosSettingsDialog = lazy(() => import('./PosSettingsDialog'));

/**
 * The till's settings — Bloom's `SettingsModal`, as in every Oxy app: the
 * cashier's account, language and theme. Choosing the store and register is
 * `store-setup`, not a preference.
 */
export function PosSettingsProvider({ children }: { children: ReactNode }) {
  return (
    <SettingsDialogProvider defaultPage="account" dialog={PosSettingsDialog}>
      {children}
    </SettingsDialogProvider>
  );
}
