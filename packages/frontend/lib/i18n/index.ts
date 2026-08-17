import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import { mergeSharedUiCopy } from '@mercaria/ui';
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

// Each bundle is this app's own copy PLUS `@mercaria/ui`'s shared reader-facing
// copy under the reserved `ui` namespace (#437), merged through the ONE function
// `createAppI18n` uses — so the storefront, the dashboard and the POS attach
// shared copy the same way even while this app still builds its instance by
// hand (#435 has not converged it). Merged once per bundle rather than once per
// alias below: the aliases share the object, and merging per entry would build
// forty-odd copies of the same tree.
const enUi = mergeSharedUiCopy('en', en);
const esUi = mergeSharedUiCopy('es', es);
const zhHansUi = mergeSharedUiCopy('zh-Hans', zhHans);
const hiUi = mergeSharedUiCopy('hi', hi);
const frUi = mergeSharedUiCopy('fr', fr);
const arUi = mergeSharedUiCopy('ar', ar);
const bnUi = mergeSharedUiCopy('bn', bn);
const ptBRUi = mergeSharedUiCopy('pt-BR', ptBR);
const ruUi = mergeSharedUiCopy('ru', ru);
const jaUi = mergeSharedUiCopy('ja', ja);
const deUi = mergeSharedUiCopy('de', de);
const caUi = mergeSharedUiCopy('ca', ca);

// Create i18n instance with translations
// Using BCP 47 locale codes (en-US, es-ES) with fallback to language codes (en, es)
const i18n = new I18n({
  'en': enUi,
  'en-US': enUi,
  'en-GB': enUi,
  'en-CA': enUi,
  'es': esUi,
  'es-ES': esUi,
  'es-MX': esUi,
  'es-AR': esUi,
  // Simplified Chinese only. zh-Hant (zh-TW, zh-HK) is a different script and is
  // deliberately NOT aliased here — it falls back to the default locale instead.
  'zh': zhHansUi,
  'zh-Hans': zhHansUi,
  'zh-CN': zhHansUi,
  'zh-SG': zhHansUi,
  'hi': hiUi,
  'hi-IN': hiUi,
  'fr': frUi,
  'fr-FR': frUi,
  'fr-CA': frUi,
  'fr-BE': frUi,
  'fr-CH': frUi,
  'ar': arUi,
  'ar-SA': arUi,
  'ar-EG': arUi,
  'ar-AE': arUi,
  'ar-MA': arUi,
  'bn': bnUi,
  'bn-BD': bnUi,
  'bn-IN': bnUi,
  // The copy is Brazilian Portuguese. pt-PT is aliased to it because Brazilian
  // Portuguese is far closer to European Portuguese than the English default is;
  // a dedicated pt-PT bundle would still be an improvement.
  'pt': ptBRUi,
  'pt-BR': ptBRUi,
  'pt-PT': ptBRUi,
  'ru': ruUi,
  'ru-RU': ruUi,
  'ja': jaUi,
  'ja-JP': jaUi,
  'de': deUi,
  'de-DE': deUi,
  'de-AT': deUi,
  'de-CH': deUi,
  'ca': caUi,
  'ca-ES': caUi,
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
