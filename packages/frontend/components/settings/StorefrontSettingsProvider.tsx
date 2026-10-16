import { lazy, useEffect, type ReactNode } from "react";
import { SettingsDialogProvider, useSettingsDialog } from "@mercaria/ui";
import { onSettingsRequest } from "./settings-routes";

// The dialog and its pages load on the first open request, not at startup: this
// provider wraps the whole app, and the dialog is never visible before someone
// asks for it.
const StorefrontSettingsDialog = lazy(() => import("./StorefrontSettingsDialog"));

/** Native settings links (`+native-intent`) arrive here, outside the router. */
function SettingsLinkListener() {
  const { open } = useSettingsDialog();
  useEffect(() => onSettingsRequest(open), [open]);
  return null;
}

/** The storefront's one Settings surface: Bloom's `SettingsModal`, as in every Oxy app. */
export function StorefrontSettingsProvider({ children }: { children: ReactNode }) {
  return (
    <SettingsDialogProvider defaultPage="general" dialog={StorefrontSettingsDialog}>
      <SettingsLinkListener />
      {children}
    </SettingsDialogProvider>
  );
}
