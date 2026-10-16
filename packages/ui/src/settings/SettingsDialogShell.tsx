import { SettingsModal, type SettingsModalPage, type SettingsNavGroup } from "@oxy.so/bloom/settings-modal";
import { useSharedUiTranslation } from "../i18n/ui-translation";
import { useOpenOnRequest, type SettingsDialogState } from "./SettingsDialogProvider";

export interface SettingsDialogShellProps extends SettingsDialogState {
  groups: SettingsNavGroup[];
  pages: Record<string, SettingsModalPage>;
}

/**
 * Bloom's `SettingsModal` with Mercaria's chrome labels. An app's dialog module
 * builds its `groups` and `pages` and spreads the provider's state onto this.
 */
export function SettingsDialogShell({
  control,
  openRequest,
  page,
  initialView,
  onPageChange,
  onClose,
  groups,
  pages,
}: SettingsDialogShellProps) {
  const t = useSharedUiTranslation();
  useOpenOnRequest(control, openRequest);
  return (
    <SettingsModal
      control={control}
      initialView={initialView}
      page={page}
      defaultPage={page}
      onPageChange={onPageChange}
      onClose={onClose}
      groups={groups}
      pages={pages}
      testID="settings-dialog"
      labels={{
        dialog: t("ui.settings.dialog"),
        nav: t("ui.settings.nav"),
        close: t("ui.settings.close"),
        saved: t("ui.settings.saved"),
        back: t("ui.settings.back"),
      }}
    />
  );
}
