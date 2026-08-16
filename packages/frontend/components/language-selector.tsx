import { View, Pressable } from 'react-native';
import { DropdownMenu, Text } from '@mercaria/ui';
import { useTranslation } from '@/hooks/useTranslation';
import { ChevronDown, Globe2 } from 'lucide-react-native';

const SUPPORTED_LOCALES = [
  { code: 'en-US', label: 'English', nativeLabel: 'English' },
  { code: 'en-GB', label: 'English (UK)', nativeLabel: 'English (UK)' },
  { code: 'es-ES', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'es-MX', label: 'Spanish (Mexico)', nativeLabel: 'Español (México)' },
  { code: 'ca-ES', label: 'Catalan', nativeLabel: 'Català' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)', nativeLabel: '简体中文' },
  { code: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी' },
  { code: 'fr-FR', label: 'French', nativeLabel: 'Français' },
  { code: 'ar-SA', label: 'Arabic', nativeLabel: 'العربية' },
  { code: 'bn-BD', label: 'Bengali', nativeLabel: 'বাংলা' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português (Brasil)' },
  { code: 'ru-RU', label: 'Russian', nativeLabel: 'Русский' },
  { code: 'ja-JP', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'de-DE', label: 'German', nativeLabel: 'Deutsch' },
];

export function LanguageSelector() {
  const { locale, changeLocale, t } = useTranslation();

  const getCurrentLocaleLabel = () => {
    // A device locale such as fr-CA has no entry of its own; fall back to the
    // base language so the trigger never mislabels the language actually in use.
    const baseLanguage = locale.split('-')[0];
    const current =
      SUPPORTED_LOCALES.find((l) => l.code === locale) ??
      SUPPORTED_LOCALES.find((l) => l.code.split('-')[0] === baseLanguage);
    return current?.nativeLabel || SUPPORTED_LOCALES[0].nativeLabel;
  };

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
            <Text className="text-foreground">{getCurrentLocaleLabel()}</Text>
            <ChevronDown size={20} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {SUPPORTED_LOCALES.map((lang) => (
            <DropdownMenu.CheckboxItem
              key={lang.code}
              value={locale === lang.code ? 'on' : 'off'}
              onValueChange={() => changeLocale(lang.code)}
            >
              <DropdownMenu.ItemIndicator />
              <DropdownMenu.ItemTitle>{lang.nativeLabel}</DropdownMenu.ItemTitle>
              {lang.label !== lang.nativeLabel && (
                <DropdownMenu.ItemSubtitle>{lang.label}</DropdownMenu.ItemSubtitle>
              )}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </View>
  );
}
