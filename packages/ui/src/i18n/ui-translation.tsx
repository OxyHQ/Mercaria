import { I18n } from "i18n-js";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Translate } from "./create-app-i18n";
import { DEFAULT_LOCALE } from "./locales";
import { SHARED_UI_COPY } from "./shared-copy";

/**
 * How a component in `@mercaria/ui` translates its own copy (#437).
 *
 * ## Why a context and not a module-level slot
 *
 * This package cannot import an app's i18n instance — three apps consume it
 * from source and each builds its own — so the `t` has to arrive from outside.
 * The tempting version is a module-level `let` that `createI18nStore` writes at
 * boot and `useSharedUiTranslation` reads. That is external mutable state read
 * from a render position, which the React Compiler is free to memoise around,
 * and it makes the number of hooks a component calls depend on whether the slot
 * was filled yet. A context is reactive by construction and has neither
 * problem.
 *
 * ## It is NOT suspenseful, and must never become so
 *
 * `useContext` and nothing else. The app's own `t` (from `createI18nStore`) is
 * already a synchronous `i18n.t` over a zustand slice for the same reason: a
 * boot-mounted provider that suspends deadlocks an Expo app into a permanent
 * white screen with no error at all.
 *
 * ## The default is English, deliberately, and it is gated
 *
 * A component rendered outside the provider resolves against this package's own
 * `en` bundle. That is EXACTLY the text that shipped before #437 — never a raw
 * key, never i18n-js's humanised guess of one, and never a thrown error at the
 * root of somebody's app. The cost is that a forgotten provider is silent, so
 * `validate:i18n-strings` fails the build if an app's root layout does not
 * mount one. What the gate proves is that a provider is mounted at the root, not
 * that every subtree is under it; a screen rendered outside the root tree would
 * still fall back, and would fall back to correct English.
 *
 * `missingBehavior` is left at i18n-js's loud default here. The keys this
 * resolver is asked for all exist in `en.json` (part C of the guard is what
 * makes that true), so the branch is unreachable — and if it ever were reached,
 * a visible `[missing "…"]` is a better thing to ship than a humanised guess
 * that reads like real copy.
 */
const fallbackI18n = new I18n({ [DEFAULT_LOCALE]: SHARED_UI_COPY[DEFAULT_LOCALE] });
fallbackI18n.defaultLocale = DEFAULT_LOCALE;
fallbackI18n.locale = DEFAULT_LOCALE;

const fallbackTranslate: Translate = (key, options) => fallbackI18n.t(key, options);

/**
 * What this package knows about the language around it: the sentence resolver
 * and the locale its NUMBERS must be spelled for (#500).
 *
 * They travel together, in one context, on purpose. The formatters need a
 * locale and there were three places to get one from — a second context, a
 * module-level slot written at boot, or re-deriving it from the platform the
 * way `useIsRtlLayout` reads back `I18nManager.isRTL`. Each is a SECOND answer
 * to "what language is this app in", and two answers to that can disagree; the
 * place that must not happen is a price, where the disagreement renders as a
 * decimal separator that does not match the sentence around it. Carrying the
 * locale on the same value as `t`, supplied by the same `useTranslation()` call
 * at the app root, makes them one fact with one writer.
 */
interface SharedUiTranslation {
  t: Translate;
  locale: string;
}

const SharedUiTranslationContext = createContext<SharedUiTranslation>({
  t: fallbackTranslate,
  locale: DEFAULT_LOCALE,
});

export interface SharedUiTranslationProviderProps {
  /**
   * The host app's own `t`. It resolves the `ui.*` namespace because
   * `mergeSharedUiCopy` put this package's copy into the same i18n instance —
   * so there is ONE locale in force per app, not a second one here that could
   * disagree with the screen around it.
   */
  t: Translate;
  /**
   * The locale in force, from the SAME `useTranslation()` call that supplied
   * `t`. It is the store's raw value — a device tag like `es-MX`, not narrowed
   * to a `SupportedLocale` — because that is the right input for `Intl`: copy
   * resolves `es-MX` to the `es` bundle through i18n-js's fallback chain while
   * numbers keep Mexican grouping, and narrowing here would throw that away.
   */
  locale: string;
  children: ReactNode;
}

/**
 * Mounted once, at each app's root. The value is the app's `t` itself rather
 * than something memoised around it: that function's identity already changes
 * exactly when the locale does, which is what re-renders every shared component
 * on a language switch.
 */
export function SharedUiTranslationProvider({
  t,
  locale,
  children,
}: SharedUiTranslationProviderProps) {
  // Memoised because the value is now an OBJECT rather than `t` itself. A fresh
  // object each render would re-render every shared component on every parent
  // render, where `t`'s own identity already changes exactly when the locale
  // does — which is what re-rendered them on a language switch before and still
  // does, since `t` is a dependency here.
  const value = useMemo<SharedUiTranslation>(() => ({ t, locale }), [t, locale]);
  return (
    <SharedUiTranslationContext.Provider value={value}>
      {children}
    </SharedUiTranslationContext.Provider>
  );
}

/** What a component in this package calls to render one of its own sentences. */
export function useSharedUiTranslation(): Translate {
  return useContext(SharedUiTranslationContext).t;
}

/**
 * The locale in force, for a component that must SPELL something rather than
 * translate it — a price, a distance, a review count (#500).
 *
 * Prefer {@link useFormatters}, which binds the formatters to this so a call
 * site cannot hold a locale and forget to pass it. This is the escape hatch for
 * a component that needs the tag itself.
 */
export function useSharedUiLocale(): string {
  return useContext(SharedUiTranslationContext).locale;
}
