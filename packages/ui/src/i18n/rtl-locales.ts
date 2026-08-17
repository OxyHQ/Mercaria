/**
 * WHICH locales are laid out right-to-left. The decision only — applying it to a
 * platform is `./layout-direction`.
 *
 * ## Why the split
 *
 * This module imports nothing. No `react-native`, no `i18n-js`, no
 * `expo-localization`. That is deliberate and load-bearing rather than tidiness:
 * `react-native` cannot be imported outside a bundler, so anything that touches
 * `I18nManager` is unreachable from a plain `bun scripts/…` run — and these four
 * packages have no test runner, which makes a `scripts/validate-*.mjs` guard the
 * only place a property of theirs can be asserted at all (CI says so on the RTL
 * and bidi steps). Keeping the DECISION pure is what lets
 * `scripts/validate-rtl-direction.mjs` run the real function rather than a copy
 * of its logic.
 */

/**
 * Language subtags written right-to-left.
 *
 * Deliberately broader than what any Mercaria app ships — the set describes the
 * SCRIPT, so adding `he.json` needs no edit here. `isRtlLocale` is what narrows
 * it to languages that actually have a bundle.
 */
export const RTL_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  'ar', // Arabic
  'ckb', // Central Kurdish
  'dv', // Divehi
  'fa', // Persian
  'he', // Hebrew
  'iw', // Hebrew (legacy subtag, still emitted by some Android builds)
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'ur', // Urdu
  'yi', // Yiddish
]);

/** The language subtag of a BCP 47 tag: `ar-EG` -> `ar`. */
export function languageOf(locale: string): string {
  return (locale.split('-')[0] ?? '').toLowerCase();
}

/**
 * Whether `locale` should be laid out right-to-left, given the locales an app
 * actually has copy for.
 *
 * **The bundle check is the load-bearing half.** `createAppI18n` sets
 * `enableFallback` with a `defaultLocale` of `en`, so a locale with no bundle
 * renders ENGLISH. Reading direction off the language subtag alone would mirror
 * the layout for an Arabic device while every string on screen was still
 * English — a screen that is wrong in a way neither the strings nor the layout
 * can explain on its own, and strictly worse than leaving it unmirrored.
 *
 * That is not hypothetical here: the dashboard and the POS ship eleven locales
 * and `ar` is deliberately NOT among them (#434 ships the layout; the bundles
 * follow). So both apps must answer `false` for `ar` TODAY, and must start
 * answering `true` on the commit that adds the bundle, with no edit here.
 *
 * `availableLocales` is a plain list rather than an `I18n` instance so this stays
 * importable outside a bundler — see the module docblock.
 */
export function isRtlLocale(locale: string, availableLocales: readonly string[]): boolean {
  const language = languageOf(locale);
  if (!RTL_LANGUAGE_CODES.has(language)) return false;
  return availableLocales.some((available) => languageOf(available) === language);
}
