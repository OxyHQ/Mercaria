import { getLocales } from 'expo-localization';
import { I18n, type TranslateOptions } from 'i18n-js';
import {
  DEFAULT_LOCALE,
  LOCALE_ALIASES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locales';

/**
 * The message bundles one app ships, keyed by locale.
 *
 * `Partial` on purpose: an app is allowed to be ahead of or behind the registry
 * without either of them lying. What it may NOT be is missing `en` — see
 * `createAppI18n`.
 */
export type AppLocaleBundles = Partial<Record<SupportedLocale, object>>;

/**
 * The device's preferred locale as a BCP 47 tag.
 *
 * Read once at module scope by the callers below, which is safe: the OS locale
 * cannot change without restarting the app process, and reading it from a
 * memoised position later would be reading external mutable state.
 */
export function resolveDeviceLocale(): string {
  const locales = getLocales();
  const first = locales?.[0];
  return first?.languageTag ?? first?.languageCode ?? DEFAULT_LOCALE;
}

/**
 * Build an app's i18n instance from the bundles it ships.
 *
 * Registration is the tag plus its `LOCALE_ALIASES` entries and NOTHING else;
 * every regional variant is left to i18n-js's own fallback chain (`es-MX` ->
 * `es` -> `en`), which is what makes the alias table short enough to be read.
 */
export function createAppI18n(bundles: AppLocaleBundles): I18n {
  if (!bundles[DEFAULT_LOCALE]) {
    throw new Error(
      `createAppI18n: no "${DEFAULT_LOCALE}" bundle. Every other locale falls back to it, `
      + 'so without one a missing key renders a humanised guess of the key itself.',
    );
  }

  const translations: Record<string, object> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const bundle = bundles[locale];
    if (!bundle) continue;
    translations[locale] = bundle;
    for (const alias of LOCALE_ALIASES[locale] ?? []) translations[alias] = bundle;
  }

  const i18n = new I18n(translations);
  i18n.defaultLocale = DEFAULT_LOCALE;
  i18n.locale = resolveDeviceLocale();
  // Resolve `es-MX` through `es` before reaching the default, rather than
  // jumping straight to English for every regional tag.
  i18n.enableFallback = true;
  // Only reachable when a key is in NO bundle including `en`, which
  // `validate:i18n-strings` fails the build on. It exists so that if one ever
  // did ship, a merchant sees a humanised key rather than a blank control.
  i18n.missingBehavior = 'guess';
  return i18n;
}

/** What a screen calls. Interpolation values are i18n-js's own option bag. */
export type Translate = (key: string, options?: TranslateOptions) => string;

/** Which of the registry's locales this app actually has copy for. */
export function shippedLocales(bundles: AppLocaleBundles): SupportedLocale[] {
  return SUPPORTED_LOCALES.filter((locale) => Boolean(bundles[locale]));
}
