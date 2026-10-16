import { SettingsGeneralPage, type SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import { useSharedUiTranslation } from '../i18n/ui-translation';
import { LOCALE_ENDONYMS, type SupportedLocale } from '../i18n/locales';
import { SettingsSelect } from './SettingsSelect';

export interface LanguageSettingsPageProps {
  /** What the app SHIPS — its `shippedLocales` — never a hand-written list (#435). */
  locales: readonly SupportedLocale[];
  locale: string;
  onChange: (locale: SupportedLocale) => void;
  /** Native applies a direction change on the next launch; say so (#434). */
  restartRequired?: boolean;
}

/**
 * The app's language, as a section a page can share with other rows. Each
 * option is its ENDONYM (`Deutsch`, not `German`): a picker that says "German"
 * is useless to the one population that needs it — people who cannot currently
 * read the interface.
 */
export function useLanguageSettingsSection({
  locales,
  locale,
  onChange,
  restartRequired,
}: LanguageSettingsPageProps): SettingsPageSection {
  const t = useSharedUiTranslation();
  // A device reporting `de-AT` has no bundle of its own and renders `de`, so the
  // option in force is matched on the language subtag; comparing whole tags
  // would leave every regional locale showing no selection at all.
  const language = (tag: string) => (tag.split('-')[0] ?? '').toLowerCase();
  const current = locales.find((code) => language(code) === language(locale)) ?? locales[0];
  return {
    key: 'language',
    description: restartRequired ? t('ui.settings.language.restartRequired') : undefined,
    rows: [
      {
        key: 'language',
        label: t('ui.settings.language.title'),
        description: t('ui.settings.language.description'),
        control: current ? (
          <SettingsSelect
            label={t('ui.settings.language.title')}
            value={current}
            onChange={onChange}
            items={locales.map((code) => ({ value: code, label: LOCALE_ENDONYMS[code] }))}
          />
        ) : undefined,
      },
    ],
  };
}

export function LanguageSettingsPage(props: LanguageSettingsPageProps) {
  const section = useLanguageSettingsSection(props);
  return <SettingsGeneralPage sections={[section]} />;
}
