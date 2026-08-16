/**
 * The ONE locale registry for every Mercaria app.
 *
 * `packages/frontend` shipped its own `lib/i18n` first (#396) and the dashboard
 * and POS had none at all (#398). Three copies of "which languages exist" is
 * three answers that drift: a locale added to one app is a locale the other two
 * silently render in English, and nothing fails. So the TUPLE, the alias rules
 * and the fallback policy live here, in the one package all three consume from
 * source, and each app supplies only the message bundles it actually has.
 *
 * Note the split: this file owns which locales EXIST. It owns no strings. An
 * app's own copy stays in that app (`lib/i18n/locales/*.json`), because the
 * dashboard's "Add product" and the storefront's "Add to cart" are not one
 * vocabulary and merging them would make every copy change a cross-app change.
 */

/**
 * Every locale Mercaria has copy for anywhere.
 *
 * An app is NOT required to ship a bundle for each — `createAppI18n` registers
 * exactly what it is handed. This tuple is what stops two apps disagreeing about
 * what a locale is CALLED (`pt-BR` versus `pt_BR` versus `pt`), which is the
 * failure that makes a bundle load in one app and not the other.
 */
export const SUPPORTED_LOCALES = [
  'ar',
  'bn',
  'ca',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'ja',
  'pt-BR',
  'ru',
  'zh-Hans',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale everything falls back to, and the one every app must ship.
 *
 * `createAppI18n` refuses a bundle set without it rather than defaulting
 * quietly: with no `en` bundle, `enableFallback` resolves every missing key to
 * i18n-js's `missingBehavior`, which renders a humanised guess of the KEY. That
 * looks like a translation gap in review and is actually a missing default.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Extra BCP 47 tags that must resolve to a shipped bundle, per locale.
 *
 * Deliberately SHORT, and regional tags are deliberately absent. i18n-js's
 * fallback chain already resolves `es-MX` -> `es` and `de-CH` -> `de` on its
 * own, so enumerating them would produce a list that looks authoritative while
 * omitting whichever region nobody thought of (`en-AU`, `fr-BE`, `es-CL`) — and
 * an omission there is indistinguishable from a deliberate exclusion.
 *
 * What the chain canNOT do is jump between two different tags, so exactly the
 * two entries below are needed:
 *
 *   * `pt` -> `pt-BR`. Without it a device reporting plain `pt`, or `pt-PT`
 *     (whose chain is `pt-PT` -> `pt` -> default), gets ENGLISH. The copy is
 *     Brazilian; European Portuguese readers are far closer to it than to
 *     English. A dedicated `pt-PT` bundle would still be an improvement.
 *
 *   * `zh` -> `zh-Hans`. Without it a device reporting plain `zh` gets English.
 *     The consequence, stated rather than left to be discovered: `zh-TW` and
 *     `zh-HK` chain through `zh` and therefore receive SIMPLIFIED Chinese. That
 *     is the wrong script, and it is still a closer answer than English; a
 *     `zh-Hant` bundle is what actually fixes it, and adding one to
 *     `SUPPORTED_LOCALES` makes `zh-TW` resolve to it with no edit here.
 */
export const LOCALE_ALIASES: Readonly<Partial<Record<SupportedLocale, readonly string[]>>> = {
  'pt-BR': ['pt'],
  'zh-Hans': ['zh'],
};

/**
 * The endonym for each locale — what a language is called BY the people who
 * read it. A language picker that lists "Spanish" is useless to somebody who
 * cannot currently read the interface, which is the entire population of that
 * picker.
 */
export const LOCALE_ENDONYMS: Readonly<Record<SupportedLocale, string>> = {
  ar: 'العربية',
  bn: 'বাংলা',
  ca: 'Català',
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  ja: '日本語',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  'zh-Hans': '简体中文',
};
