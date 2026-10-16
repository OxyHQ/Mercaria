import { useSharedUiTranslation } from '../i18n/ui-translation';

/** The titles of the pages this package supplies, for an app's rail and page headers. */
export function useSharedSettingsTitles() {
  const t = useSharedUiTranslation();
  return {
    settings: t('ui.settings.dialog'),
    account: t('ui.settings.pages.account'),
    appearance: t('ui.settings.pages.appearance'),
    language: t('ui.settings.pages.language'),
  };
}
