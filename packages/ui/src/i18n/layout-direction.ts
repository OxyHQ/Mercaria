import type { I18n } from 'i18n-js';
import { I18nManager, Platform } from 'react-native';
import { isRtlLocale } from './rtl-locales';

/**
 * APPLYING a layout direction to the platform. Which locales are RTL is
 * `./rtl-locales`.
 *
 * Mirroring is two separate mechanisms, because the two platforms apply
 * direction at completely different times:
 *
 *   * **Web** reads `dir` off the document, so `padding-inline-start` and every
 *     other logical property re-resolve on the next paint. It is live, and
 *     `app/+html.tsx` cannot do it — that shell is rendered once at export time
 *     with a static `lang="en"`, long before anyone has picked a language. Every
 *     Mercaria app has its own `+html.tsx` and all three carry that same static
 *     attribute, so the live swap is needed in each of them.
 *
 *   * **Native** resolves direction when the app process starts.
 *     `I18nManager.forceRTL` writes a native preference that takes effect on the
 *     NEXT launch, so a running app cannot mirror itself. That is a React Native
 *     constraint, not a shortcut taken here.
 *
 * `allowRTL(true)` is what makes `forceRTL` mean anything at all: with it left at
 * the default, a build can refuse to mirror and `forceRTL` then reports success
 * while changing nothing. So the order below is load-bearing.
 *
 * This began as the storefront's `packages/frontend/lib/i18n/rtl.ts`, hoisted by
 * #434 so the dashboard and the POS could share ONE implementation rather than
 * growing a second and a third copy of the rule. #435 then converged the
 * storefront itself and DELETED that file, so all three apps now reach the
 * direction bootstrap through `createI18nStore`'s `onLocaleApplied` and there is
 * exactly one copy of the rule. `scripts/validate-rtl-direction.mjs` lost its
 * copy-drift comparison in the same change, having nothing left to compare.
 */

/** What a caller must do for the direction to actually be visible. */
export type DirectionSyncResult =
  /** Nothing to do — either the direction already matched, or it applied live. */
  | { kind: 'applied'; rtl: boolean }
  /** Native only: the preference is written and takes effect on the next launch. */
  | { kind: 'restart_required'; rtl: boolean };

/**
 * Bring the platform's layout direction in line with `locale`.
 *
 * Idempotent, and cheap enough to call on every locale change, on every
 * rehydration and at module scope — the native branch compares against
 * `I18nManager.isRTL` first, so a launch whose direction is already correct
 * writes nothing and asks for nothing.
 *
 * Not to be called from a `useEffect`. The direction has to be settled BEFORE
 * the tree using it renders, and `I18nManager.isRTL` is external mutable state,
 * which is exactly what must never be read from a memoised position.
 * `createI18nStore`'s `onLocaleApplied` is the seam that calls it from the two
 * places the locale actually changes, plus the module-scope initial apply.
 */
export function syncLayoutDirection(i18n: I18n, locale: string): DirectionSyncResult {
  const rtl = isRtlLocale(locale, Object.keys(i18n.translations));

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
