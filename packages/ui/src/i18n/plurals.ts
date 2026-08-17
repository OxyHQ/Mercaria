/**
 * Per-locale CLDR plural categories (#436).
 *
 * `i18n-js` ships ONE pluralizer and it is English-shaped: `one` when the count
 * is exactly 1, `other` otherwise. Applied to Russian that renders `5 товара`
 * where `5 товаров` is right, and to Arabic it collapses six categories onto
 * two. This module is the per-locale replacement, plus the resolution that
 * decides WHICH locale's rule a given runtime tag gets.
 *
 * ## Why `make-plural` and not `Intl.PluralRules`
 *
 * `Intl.PluralRules` is the obvious source — it is the platform's own CLDR data
 * — and it is the wrong choice HERE. Hermes' `Intl` surface is narrower than
 * V8's, this repository has already been bitten by a construct `hermesc`
 * accepts and the Hermes RUNTIME rejects, and `packages/ui/src/lib/region.ts`
 * records that its own `Intl` assumption is **unverified on a device** because
 * all three apps deploy as Expo web exports today. A missing `Intl.PluralRules`
 * does not fail to compile; it throws at the first pluralised string on a
 * screen.
 *
 * `make-plural` is already in the tree — `i18n-js` depends on it and exports
 * `useMakePlural` for exactly this purpose — and it contains no reference to
 * `Intl` at all. Every rule below is arithmetic on a number, so there is no
 * engine capability left to verify. That is why this module does not
 * feature-detect and has no degraded path: there is nothing here that a
 * constrained engine can decline.
 *
 * ## The `other` rung is what makes this safe to land before the copy exists
 *
 * `i18n-js`'s own `useMakePlural` returns `[zero?, category]` with NO terminal
 * rung, and `helpers/pluralize.ts` does NOT fall back to English on a miss — it
 * returns `missingTranslation`. So a Russian bundle carrying only `one`/`other`
 * under a Russian pluralizer would render NOTHING at count 5, which is strictly
 * worse than today's wrong-but-present form. That is the trap #436 names, and
 * appending `other` is what disarms it: where the category form exists it is
 * used, and where it does not the chain lands on exactly what ships today.
 */

import {
  ar,
  bn,
  ca,
  de,
  en,
  es,
  fr,
  hi,
  ja,
  type PluralCategory,
  pt,
  ru,
  zh,
} from 'make-plural/cardinals';
import {
  ar as arCategories,
  bn as bnCategories,
  ca as caCategories,
  de as deCategories,
  en as enCategories,
  es as esCategories,
  fr as frCategories,
  hi as hiCategories,
  ja as jaCategories,
  pt as ptCategories,
  ru as ruCategories,
  zh as zhCategories,
} from 'make-plural/pluralCategories';
import { DEFAULT_LOCALE, LOCALE_ALIASES, type SupportedLocale } from './locales';

/** What a `make-plural` cardinal rule is: a count in, a CLDR category out. */
type CardinalRule = (count: number | string) => PluralCategory;

/**
 * Each registry locale's CLDR rule and the categories that rule can produce.
 *
 * An exhaustive `Record`, so adding a locale to `SUPPORTED_LOCALES` fails `tsc`
 * HERE until somebody names its plural rule. The alternative — a lookup keyed on
 * the language subtag with a fallback — would give a new locale English plurals
 * silently, which is the defect this module exists to remove.
 *
 * The rule and the tuple are ONE entry rather than two records, because they are
 * two halves of one fact and a per-locale mismatch (`ru`'s rule beside `bn`'s
 * categories) is the kind of thing that reads fine and enforces nothing. Named
 * imports rather than a namespace index for the same reason: `pt-BR`'s
 * resolution to `pt` is then written once, on the line that uses it.
 *
 * They are additionally checked AGAINST EACH OTHER on every guard run:
 * `validate-i18n-strings.mjs` sweeps counts through `pluralCategoryChain` and
 * requires that every category the rule produces is in the tuple, and that every
 * category in the tuple is one some count actually reaches.
 *
 * The two hyphenated tags take their language's rule because that is the grain
 * CLDR publishes cardinals at: `pt-BR` and `pt-PT` share `pt`'s cardinal
 * categories (they differ in ORDINALS, which nothing here uses), and `zh` has a
 * single rule for both scripts.
 */
const CARDINAL: Readonly<Record<SupportedLocale, {
  rule: CardinalRule;
  categories: readonly PluralCategory[];
}>> = {
  ar: { rule: ar, categories: arCategories.cardinal },
  bn: { rule: bn, categories: bnCategories.cardinal },
  ca: { rule: ca, categories: caCategories.cardinal },
  de: { rule: de, categories: deCategories.cardinal },
  en: { rule: en, categories: enCategories.cardinal },
  es: { rule: es, categories: esCategories.cardinal },
  fr: { rule: fr, categories: frCategories.cardinal },
  hi: { rule: hi, categories: hiCategories.cardinal },
  ja: { rule: ja, categories: jaCategories.cardinal },
  'pt-BR': { rule: pt, categories: ptCategories.cardinal },
  ru: { rule: ru, categories: ruCategories.cardinal },
  'zh-Hans': { rule: zh, categories: zhCategories.cardinal },
};

/**
 * `zero` is selectable in EVERY locale, whatever CLDR says.
 *
 * i18n-js has always offered it as an affordance rather than as a CLDR
 * category: "You have no messages" instead of "You have 0 messages". The
 * default pluralizer puts it first at count 0 and this one keeps that, so no
 * bundle loses a form it relies on. It is named here because the guard's
 * permitted set has to be "what the chain can select", not "what CLDR lists" —
 * for Arabic those coincide, for the other eleven they do not.
 */
const ZERO_CATEGORY: PluralCategory = 'zero';

/**
 * The categories CLDR gives this language — what a complete bundle would carry.
 *
 * The gap between this and what a bundle actually has is #436's residual, and
 * it is what `validate-i18n-strings.mjs` pins. Read from `make-plural`'s own
 * published tuple rather than written out, so it cannot disagree with the rule
 * beside it in `CARDINAL` that produces the categories.
 */
export function cldrCardinalCategories(locale: SupportedLocale): readonly PluralCategory[] {
  return CARDINAL[locale].categories;
}

/**
 * Every category the chain below can ever SELECT for a locale — CLDR's set plus
 * `zero`, which the chain offers everywhere.
 *
 * The distinction from `cldrCardinalCategories` is the whole reason both exist.
 * A French bundle MAY carry a `zero` form and the chain will use it, so `zero`
 * is not dead copy there; but nobody OWES French a `zero` form, so its absence
 * is not a gap. Collapsing the two would either report every locale as missing
 * a `zero` nobody needs, or condemn a legitimate one as unreachable.
 */
export function selectablePluralCategories(locale: SupportedLocale): readonly PluralCategory[] {
  const cardinal = cldrCardinalCategories(locale);
  return cardinal.includes(ZERO_CATEGORY) ? cardinal : [ZERO_CATEGORY, ...cardinal];
}

/**
 * The categories `i18n-js` should try, in order, for this locale and count.
 *
 * Three rungs, and each earns its place:
 *
 *   1. `zero` at count 0 — the affordance above, and what ships today.
 *   2. the locale's own CLDR category — the whole point of #436.
 *   3. `other` — the terminal rung. See the module note: without it a locale
 *      whose `few` form nobody has written yet renders nothing at all.
 *
 * Deduped, because `i18n-js` walks the list and a repeat is a wasted lookup —
 * and because the list is what the guard's control asserts against, where a
 * duplicate would read as a second, different rung.
 */
export function pluralCategoryChain(
  locale: SupportedLocale,
  count: number,
): readonly PluralCategory[] {
  const chain: PluralCategory[] = [];
  if (count === 0) chain.push(ZERO_CATEGORY);
  const category = CARDINAL[locale].rule(count);
  if (!chain.includes(category)) chain.push(category);
  if (!chain.includes('other')) chain.push('other');
  return chain;
}

/**
 * Which registered locale's plural rule a runtime tag gets.
 *
 * The rule must follow the BUNDLE that will render, never the device's
 * language, and those two come apart constantly: a Swahili phone gets English
 * copy (no `sw` bundle exists), and applying Swahili's rule to English strings
 * would be a fresh defect rather than the one being fixed. So the resolution
 * mirrors i18n-js's own fallback — exact tag, then alias, then language subtag
 * — over the locales THIS app actually shipped, and lands on `en` when none
 * matches, which is precisely when the English bundle is what renders.
 *
 * `shipped` rather than `SUPPORTED_LOCALES` for the same reason `createAppI18n`
 * registers the intersection: an app with no `ar` bundle renders Arabic screens
 * in English, and English is then the correct rule for them.
 */
export function pluralRuleLocaleFor(
  tag: string,
  shipped: readonly SupportedLocale[],
): SupportedLocale {
  const normalised = tag.toLowerCase();
  const exact = shipped.find((locale) => locale.toLowerCase() === normalised);
  if (exact) return exact;
  const aliased = shipped.find((locale) =>
    (LOCALE_ALIASES[locale] ?? []).some((alias) => alias.toLowerCase() === normalised));
  if (aliased) return aliased;
  const language = normalised.split('-')[0];
  const byLanguage = shipped.find((locale) => locale.toLowerCase().split('-')[0] === language);
  if (byLanguage) return byLanguage;
  return DEFAULT_LOCALE;
}

/**
 * The i18n-js `Pluralizer` shape, restated rather than imported.
 *
 * Importing `Pluralizer` from `i18n-js` would drag the `I18n` class into this
 * module's type graph, and `scripts/validate-i18n-strings.mjs` imports this file
 * DIRECTLY to run the real chain — the `validate-logical-side.mjs` idiom, which
 * works only while this module's imports are things a bare script can resolve.
 * The instance argument is unused here anyway: the locale arrives through the
 * closure, not off the instance.
 */
type Pluralizer = (i18n: unknown, count: number) => string[];

/**
 * Register a per-locale pluralizer for every locale an app registered
 * translations for.
 *
 * Called by `createAppI18n` from the SAME loop that registers the bundles, so a
 * locale can never have copy without a rule or a rule without copy.
 *
 * Two kinds of registration, because `i18n-js`'s registry lookup is
 * `registry[options.locale] || registry[i18n.locale] || registry.default` with
 * no fallback chain of its own:
 *
 *   * one per registered TAG, which is what `useTranslation` hits — it passes
 *     `locale` explicitly on every call;
 *   * `default`, which is what a REGIONAL tag hits. `resolveDeviceLocale()`
 *     returns the OS's raw value, so `i18n.locale` is routinely `es-MX` or
 *     `ru-RU`, and neither is a key any registration could enumerate.
 *
 * Both go through `pluralRuleLocaleFor`, so they cannot disagree.
 */
export function registerPluralizers(
  i18n: { locale: string; pluralization: { register: (locale: string, fn: Pluralizer) => void } },
  shipped: readonly SupportedLocale[],
): void {
  const pluralizerFor = (locale: SupportedLocale): Pluralizer =>
    (_i18n, count) => [...pluralCategoryChain(locale, count)];

  for (const locale of shipped) {
    i18n.pluralization.register(locale, pluralizerFor(locale));
    for (const alias of LOCALE_ALIASES[locale] ?? []) {
      i18n.pluralization.register(alias, pluralizerFor(locale));
    }
  }

  // Reads `i18n.locale` at CALL time rather than closing over it: the store
  // reassigns it on every locale change, and a captured value would leave every
  // screen pluralising in the language the app booted in.
  i18n.pluralization.register('default', (_i18n, count) =>
    [...pluralCategoryChain(pluralRuleLocaleFor(i18n.locale, shipped), count)]);
}
