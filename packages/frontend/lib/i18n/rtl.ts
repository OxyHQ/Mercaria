import { I18nManager, Platform } from 'react-native';
import i18n from './index';

/**
 * Layout direction for the storefront.
 *
 * The Arabic bundle (#396) shipped correct strings in a left-to-right layout.
 * Mirroring it is two separate mechanisms, because the two platforms apply
 * direction at completely different times:
 *
 *   * **Web** reads `dir` off the document, so `padding-inline-start` and every
 *     other logical property re-resolve on the next paint. It is live, and
 *     `app/+html.tsx` cannot do it — that shell is rendered once at export time
 *     with a static `lang="en"`, long before anyone has picked a language.
 *
 *   * **Native** resolves direction when the app process starts.
 *     `I18nManager.forceRTL` writes a native preference that takes effect on the
 *     NEXT launch, so a running app cannot mirror itself. That is a React Native
 *     constraint, not a shortcut taken here.
 *
 * `allowRTL(true)` is what makes `forceRTL` mean anything at all: with it left
 * at the default, a build can refuse to mirror and every call below silently
 * does nothing.
 */

/**
 * Language subtags written right-to-left.
 *
 * Deliberately broader than what Mercaria ships — the set describes the SCRIPT,
 * so adding `he.json` needs no edit here. `isRtlLocale` is what narrows it to
 * languages that actually have a bundle.
 */
const RTL_LANGUAGE_CODES = new Set([
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

const languageOf = (locale: string): string => (locale.split('-')[0] ?? '').toLowerCase();

/**
 * Whether `locale` should be laid out right-to-left.
 *
 * The bundle check is the load-bearing half. `i18n.enableFallback` is on and
 * `defaultLocale` is `en-US`, so a locale with no bundle renders ENGLISH. Reading
 * direction off the language subtag alone would therefore mirror the layout for a
 * Hebrew device while every string on screen was still English — a screen that is
 * wrong in a way neither the strings nor the layout can explain on its own.
 *
 * So a language mirrors only once somebody has shipped copy for it, and it starts
 * mirroring on the commit that adds the bundle, with no edit here.
 */
export function isRtlLocale(locale: string): boolean {
  const language = languageOf(locale);
  if (!RTL_LANGUAGE_CODES.has(language)) return false;
  return Object.keys(i18n.translations).some(
    (available) => languageOf(available) === language,
  );
}

/** What a caller must do for the direction to actually be visible. */
export type DirectionSyncResult =
  /** Nothing to do — either the direction already matched, or it applied live. */
  | { kind: 'applied'; rtl: boolean }
  /** Native only: the preference is written and takes effect on the next launch. */
  | { kind: 'restart_required'; rtl: boolean };

/**
 * Bring the platform's layout direction in line with `locale`.
 *
 * Idempotent, and cheap enough to call on every locale change and on every
 * rehydration — the native branch compares against `I18nManager.isRTL` first, so
 * a launch whose direction is already correct writes nothing and asks for
 * nothing.
 */
export function syncLayoutDirection(locale: string): DirectionSyncResult {
  const rtl = isRtlLocale(locale);

  if (Platform.OS === 'web') {
    // `document` is absent during the static web export, which runs this module
    // in Node. Nothing to mirror there: the export produces the shell, and the
    // first client render calls this again with a real document.
    if (typeof document !== 'undefined') {
      document.documentElement.dir = rtl ? 'rtl' : 'ltr';
      document.documentElement.lang = locale;
    }
    return { kind: 'applied', rtl };
  }

  // Must precede forceRTL: without it the build may refuse to mirror, and
  // forceRTL then reports success while changing nothing.
  I18nManager.allowRTL(true);

  if (I18nManager.isRTL === rtl) return { kind: 'applied', rtl };

  I18nManager.forceRTL(rtl);
  return { kind: 'restart_required', rtl };
}
