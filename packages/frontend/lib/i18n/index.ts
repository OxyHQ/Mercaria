import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import ar from './locales/ar.json';
import bn from './locales/bn.json';
import ca from './locales/ca.json';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zhHans from './locales/zh-Hans.json';

// Create i18n instance with translations
// Using BCP 47 locale codes (en-US, es-ES) with fallback to language codes (en, es)
const i18n = new I18n({
  'en': en,
  'en-US': en,
  'en-GB': en,
  'en-CA': en,
  'es': es,
  'es-ES': es,
  'es-MX': es,
  'es-AR': es,
  // Simplified Chinese only. zh-Hant (zh-TW, zh-HK) is a different script and is
  // deliberately NOT aliased here — it falls back to the default locale instead.
  'zh': zhHans,
  'zh-Hans': zhHans,
  'zh-CN': zhHans,
  'zh-SG': zhHans,
  'hi': hi,
  'hi-IN': hi,
  'fr': fr,
  'fr-FR': fr,
  'fr-CA': fr,
  'fr-BE': fr,
  'fr-CH': fr,
  'ar': ar,
  'ar-SA': ar,
  'ar-EG': ar,
  'ar-AE': ar,
  'ar-MA': ar,
  'bn': bn,
  'bn-BD': bn,
  'bn-IN': bn,
  // The copy is Brazilian Portuguese. pt-PT is aliased to it because Brazilian
  // Portuguese is far closer to European Portuguese than the English default is;
  // a dedicated pt-PT bundle would still be an improvement.
  'pt': ptBR,
  'pt-BR': ptBR,
  'pt-PT': ptBR,
  'ru': ru,
  'ru-RU': ru,
  'ja': ja,
  'ja-JP': ja,
  'de': de,
  'de-DE': de,
  'de-AT': de,
  'de-CH': de,
  'ca': ca,
  'ca-ES': ca,
});

/**
 * Get the device's current locale
 * Returns full locale code (e.g., "en-US") or falls back to language code (e.g., "en")
 */
function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) {
    return 'en-US';
  }

  // Try to use full locale code (e.g., "en-US")
  const fullLocale = locales[0]?.languageTag;
  if (fullLocale) {
    return fullLocale;
  }

  // Fallback to language code (e.g., "en")
  return locales[0]?.languageCode ?? 'en-US';
}

// Set the locale from device settings
i18n.locale = getDeviceLocale();

// Enable fallback to base language if specific regional variant is missing
// e.g., if es-MX is not found, it will try 'es', then 'en'
i18n.enableFallback = true;
i18n.missingBehavior = 'guess';

// Default locale
i18n.defaultLocale = 'en-US';

export default i18n;
