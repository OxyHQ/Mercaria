/**
 * `@mercaria/ui/settings` — the DIALOG side of Settings: Bloom's
 * `SettingsModal` with Mercaria's labels, and the pages every app shares.
 *
 * A subpath, not the barrel, on purpose: everything here imports
 * `@oxy.so/bloom/settings-modal`, and Metro does not tree-shake, so a barrel
 * export would put the dialog in every app's startup bundle. Only an app's
 * `lazy()` dialog module imports this. The provider and `useSettingsDialog`,
 * which every screen needs, are in the barrel.
 */
export { SettingsDialogShell, type SettingsDialogShellProps } from "./SettingsDialogShell";
export { AccountSettingsPage, type AccountSettingsPageProps } from "./AccountSettingsPage";
export { AppearanceSettingsPage, type AppearanceSettingsPageProps } from "./AppearanceSettingsPage";
export {
  LanguageSettingsPage,
  useLanguageSettingsSection,
  type LanguageSettingsPageProps,
} from "./LanguageSettingsPage";
export { SettingsSelect } from "./SettingsSelect";
export { useSharedSettingsTitles } from "./titles";
