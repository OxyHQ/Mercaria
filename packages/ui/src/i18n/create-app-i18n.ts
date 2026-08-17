import { getLocales } from 'expo-localization';
import { I18n, type TranslateOptions } from 'i18n-js';
import {
  DEFAULT_LOCALE,
  LOCALE_ALIASES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locales';
import { SHARED_UI_COPY, SHARED_UI_COPY_NAMESPACE } from './shared-copy';

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
 * One locale's messages: the app's own copy plus `@mercaria/ui`'s shared
 * reader-facing copy, under the reserved `ui` namespace (#437).
 *
 * Exported because `createAppI18n` is not the only construction site: the
 * storefront still builds its own `I18n` from an explicit alias table (#435 has
 * not converged it yet) and must get the same shared copy through the same
 * merge. Two spellings of "how shared copy is attached" is exactly the drift
 * this issue exists to remove, so there is ONE.
 *
 * The collision is REFUSED rather than resolved by spread order. An app naming
 * its own top-level `ui` key is not doing anything wrong; silently letting one
 * side win would put a shared sentence where an app's copy should be, or the
 * reverse, with nothing in either tree to read.
 */
export function mergeSharedUiCopy(locale: SupportedLocale, appBundle: object): object {
  if (Object.prototype.hasOwnProperty.call(appBundle, SHARED_UI_COPY_NAMESPACE)) {
    throw new Error(
      `mergeSharedUiCopy: the ${locale} bundle already has a top-level `
      + `"${SHARED_UI_COPY_NAMESPACE}" key. That namespace is reserved for `
      + '@mercaria/ui\'s own copy (#437); rename the app key.',
    );
  }
  return { ...appBundle, ...SHARED_UI_COPY[locale] };
}

/**
 * Build an app's i18n instance from the bundles it ships.
 *
 * Registration is the tag plus its `LOCALE_ALIASES` entries and NOTHING else;
 * every regional variant is left to i18n-js's own fallback chain (`es-MX` ->
 * `es` -> `en`), which is what makes the alias table short enough to be read.
 *
 * `@mercaria/ui`'s shared copy is merged into each REGISTERED locale, which is
 * the intersection of the registry and what this app ships — never the union.
 * So the dashboard shipping no `ar` bundle keeps no Arabic locale, even though
 * the shared copy has one; an Arabic device there gets a whole English screen
 * rather than Arabic condition labels inside an unmirrored English layout.
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
    const merged = mergeSharedUiCopy(locale, bundle);
    translations[locale] = merged;
    for (const alias of LOCALE_ALIASES[locale] ?? []) translations[alias] = merged;
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
