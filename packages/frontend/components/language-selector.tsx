import { View, Pressable } from 'react-native';
import { DropdownMenu, LOCALE_ENDONYMS, Text } from '@mercaria/ui';
import { STOREFRONT_LOCALES, useTranslation } from '@/lib/i18n';
import { ChevronDown, Globe2 } from 'lucide-react-native';

/**
 * Choose the storefront's language.
 *
 * The list comes from `STOREFRONT_LOCALES` — what the app actually SHIPS —
 * rather than a hand-written array in this file. It used to be fourteen region
 * tags written out here, which is exactly how a shipped bundle becomes
 * unreachable: adding `locales/it.json` changed nothing until somebody
 * remembered this file too. Now adding a bundle adds a row (#435).
 *
 * Each option is labelled with its ENDONYM (`Deutsch`, not `German`) and with
 * nothing else. A picker that says "German" is useless to the one population
 * that needs it — people who cannot currently read the interface — and the
 * English half was fourteen hardcoded strings that no bundle could translate.
 */
export function LanguageSelector() {
  const { locale, setLocale, t, directionRestartRequired } = useTranslation();

  // A device reporting `fr-CA`, or a preference stored as `en-GB` by the picker
  // this replaced, has no bundle of its own and renders its base language. So
  // the row in force is matched on the LANGUAGE SUBTAG; comparing whole tags
  // would leave every regional locale showing no selection at all.
  const activeLanguage = (locale.split('-')[0] ?? '').toLowerCase();
  const currentLocale =
    STOREFRONT_LOCALES.find((code) => (code.split('-')[0] ?? '').toLowerCase() === activeLanguage);

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Globe2 size={20} className="text-primary" />
        <Text className="text-base font-semibold">{t('settings.appLanguage.title')}</Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('settings.appLanguage.description')}
      </Text>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Pressable className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between">
            <Text className="text-foreground">
              {currentLocale ? LOCALE_ENDONYMS[currentLocale] : LOCALE_ENDONYMS.en}
            </Text>
            <ChevronDown size={20} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {STOREFRONT_LOCALES.map((code) => (
            <DropdownMenu.CheckboxItem
              key={code}
              value={code === currentLocale ? 'on' : 'off'}
              onValueChange={() => setLocale(code)}
            >
              <DropdownMenu.ItemIndicator />
              <DropdownMenu.ItemTitle>{LOCALE_ENDONYMS[code]}</DropdownMenu.ItemTitle>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {/* Native applies a layout-direction change on the next launch, so the
          strings switch to Arabic while the layout stays as it was. Without
          this line that reads as a bug rather than as a pending restart. Web
          mirrors live and never sets the flag. */}
      {directionRestartRequired && (
        <Text className="text-sm text-muted-foreground">
          {t('settings.appLanguage.restartRequired')}
        </Text>
      )}
    </View>
  );
}
