import { lazy, type ReactNode } from 'react';
import { SettingsDialogProvider } from '@mercaria/ui';

// Loaded on the first open request: this provider wraps the whole app, and the
// dialog is never visible before someone asks for it.
const DashboardSettingsDialog = lazy(() => import('./DashboardSettingsDialog'));

/**
 * The dashboard's PERSONAL settings — Bloom's `SettingsModal`, as in every Oxy
 * app: the account, the language and the theme of the person reading the
 * screen. Store configuration is a different thing and stays a section of the
 * app at `/settings`, gated per row by the caller's store permissions.
 */
export function DashboardSettingsProvider({ children }: { children: ReactNode }) {
  return (
    <SettingsDialogProvider defaultPage="account" dialog={DashboardSettingsDialog}>
      {children}
    </SettingsDialogProvider>
  );
}
