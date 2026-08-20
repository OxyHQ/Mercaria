/**
 * The catalog localization fallback resolver (ADR 0007 D4) — PURE.
 *
 * No database, no configuration, no clock, no `Intl`. Everything here is a
 * function of a requested locale, a field key and the rows a caller already
 * read, which is what makes the whole chain testable without a server and what
 * makes it impossible for a fallback to depend on which deployment is asking.
 *
 * ## The chain, stated once
 *
 * exact locale → the supported truncations of that locale (`es-mx` → `es`) →
 * Mercaria's base locale. Every step is a locale in `SUPPORTED_LOCALES`; a
 * requested tag Mercaria does not author in contributes only its truncations,
 * so `es-cl` resolves through `es` without `es-cl` ever having to exist.
 *
 * ## Two places, not one list
 *
 * A flat locale list cannot express the three policies, and the reason is that
 * the base step is NOT a locale whose row may answer: a base-locale
 * localization row is unrepresentable (`<table>_locale_not_base_check`), so the
 * base string lives on the entity's own column and is passed in. A
 * {@link LocaleFallbackPlan} therefore separates the locales whose ROWS may
 * answer from whether the entity's OWN column may. That separation is what
 * makes `exact_locale_then_base`'s "exactly two places" a shape rather than a
 * branch somebody could widen — see {@link onlyTheRequestedLocale}.
 *
 * ## Three things the return type makes impossible
 *
 * 1. **Rendering text the resolver declined to produce.**
 *    {@link LocalizedResolution}'s `unavailable` branch has no `value`, no
 *    `effectiveLocale` and no `status`. A caller that wants to show something
 *    has to handle the absence, which is what "a public client never renders a
 *    raw key" means in practice.
 * 2. **Asking for cross-market fallback on text that may not have it.** The
 *    signature takes a {@link LocalizedFieldKey} — a literal union — and reads
 *    the policy out of `CATALOG_LOCALIZED_FIELDS` itself. There is no parameter
 *    a caller could pass, so D4's exclusion of legal text is a property of the
 *    field rather than a discipline. An unregistered field is a compile error.
 * 3. **Reporting a seller's own words as Mercaria's copy.** The base branch is
 *    `basis: 'authored_base_text'` and carries no `provenance` property at all,
 *    so there is nothing to fill in with a guess.
 *
 * The effective locale, the basis and the translation status travel back beside
 * the string, deliberately: an internal client debugging "why is this English"
 * needs the step that answered, and a public client needs the basis and status
 * to decide whether to badge a machine translation or an untranslated original.
 */

import {
  BASE_LOCALE_PROVENANCE,
  BASE_LOCALE_STATUS,
  CATALOG_LOCALIZED_FIELDS,
  MERCARIA_BASE_LOCALE,
  SERVABLE_LOCALIZATION_STATUSES,
  SUPPORTED_LOCALES,
  fallbackPolicyForFieldClass,
  type LocalizationCandidate,
  type LocalizationFallbackPolicy,
  type LocalizationFallbackStep,
  type LocalizationUnavailableReason,
  type LocalizedFieldKey,
  type LocalizedResolution,
  type LocalizedSlugCandidate,
  type LocalizedSlugResolution,
  type SupportedLocale,
} from '@mercaria/shared-types';

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);
const SERVABLE: ReadonlySet<string> = new Set(SERVABLE_LOCALIZATION_STATUSES);

/**
 * The stored form of a BCP 47 tag: trimmed, underscore-separated tags repaired,
 * lowercased.
 *
 * Case folding is the whole of it, and it is what `attribute_labels` already
 * does one table over. BCP 47 tags are case-insensitive, so `zh-Hans` and
 * `zh-hans` are ONE tag — and two spellings of one tag in one column is a lookup
 * that misses rather than an error anybody sees. `_` is accepted because POSIX
 * locale environments and a few HTTP clients spell `es_MX`, and rejecting that
 * would answer a legitimate Spanish request in English.
 */
export function foldLocale(locale: string): string {
  return locale.trim().replace(/_/gu, '-').toLowerCase();
}

/** Whether a folded tag is one Mercaria authors catalog content in. */
export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED.has(locale);
}

/**
 * How far one policy's chain reaches, split by WHERE an answer may come from.
 *
 * `rowLocales` never contains {@link MERCARIA_BASE_LOCALE}: a base-locale
 * localization row cannot exist, so the base locale is not a row candidate and
 * listing it as one is what previously required the caller to special-case it
 * mid-loop.
 */
export interface LocaleFallbackPlan {
  /** Locales whose localization ROWS may answer, in order. */
  readonly rowLocales: readonly SupportedLocale[];
  /** Whether the ENTITY'S OWN base column may answer once the rows run out. */
  readonly baseText: 'permitted' | 'withheld';
}

/**
 * At most one locale. A tuple type, so a second entry is a compile error.
 *
 * This is half of what stops `exact_locale_then_base` from becoming
 * `language_then_base` under another name; {@link onlyTheRequestedLocale} is
 * the other half.
 */
type AtMostOneLocale = readonly [SupportedLocale] | readonly [];

/**
 * The requested locale's own row, and NOTHING else.
 *
 * BOTH exact policies read this ONE producer, and that is deliberate rather
 * than tidy. Widening it to reach a truncation would widen `exact_locale_only`
 * in the same edit, and `exact_locale_only`'s `unsupported_locale` tests go red
 * — so the new policy cannot quietly acquire cross-market reach while the old
 * one keeps passing. The return type refuses a second entry outright.
 */
function onlyTheRequestedLocale(folded: string): AtMostOneLocale {
  return isSupportedLocale(folded) ? [folded] : [];
}

/**
 * The requested locale and its supported truncations, base locale excluded.
 *
 * Truncation is mechanical rather than a hand-maintained map, and that is
 * deliberate: a per-tag fallback table is a second list to keep in step with
 * `SUPPORTED_LOCALES`, and the failure of a stale entry is silent (a locale
 * falling back to one nobody authors). The truncations are FILTERED to supported
 * tags, so no step can name a locale that has no row shape.
 */
function truncationChain(folded: string): readonly SupportedLocale[] {
  const chain: SupportedLocale[] = [];
  let candidate = folded;
  for (;;) {
    if (
      isSupportedLocale(candidate) &&
      candidate !== MERCARIA_BASE_LOCALE &&
      !chain.includes(candidate)
    ) {
      chain.push(candidate);
    }
    const cut = candidate.lastIndexOf('-');
    if (cut <= 0) break;
    candidate = candidate.slice(0, cut);
  }
  return chain;
}

/**
 * Where a request may be answered from, under one policy. THE primitive.
 *
 * The `switch` is exhaustive against {@link LocalizationFallbackPolicy} and
 * ends in a `never` assignment, so a FOURTH policy added to the tuple fails the
 * build here rather than falling through to `undefined`. This function is the
 * hand-wired reader of a closed set, and gating the set does not gate its
 * readers.
 *
 * `exact_locale_only` returns at most one row locale and withholds the base —
 * which is what turns a legal-text request in an unauthored market into
 * `unsupported_locale` rather than into another market's copy.
 */
export function localeFallbackPlan(
  requestedLocale: string,
  policy: LocalizationFallbackPolicy,
): LocaleFallbackPlan {
  const folded = foldLocale(requestedLocale);
  switch (policy) {
    case 'language_then_base':
      return { rowLocales: truncationChain(folded), baseText: 'permitted' };
    case 'exact_locale_then_base':
      return { rowLocales: onlyTheRequestedLocale(folded), baseText: 'permitted' };
    case 'exact_locale_only':
      return { rowLocales: onlyTheRequestedLocale(folded), baseText: 'withheld' };
    default: {
      const unhandled: never = policy;
      throw new Error(`unhandled localization fallback policy: ${String(unhandled)}`);
    }
  }
}

/**
 * The flat list of locales a QUERY should narrow on — a different question from
 * {@link localeFallbackPlan}, and derived from it so the two cannot drift.
 *
 * "Which rows might I need to read" is not "where may this be answered from",
 * and the base locale is exactly where they part. The resolver must know the
 * base is the ENTITY'S OWN COLUMN; a query narrowing an `IN (...)` predicate
 * only needs a superset of the locales that could match, and over-fetching a
 * row that cannot exist costs nothing.
 *
 * It is a superset rather than the plan's own list because `attribute_labels`
 * predates ADR 0007 D4 and deliberately does NOT carry
 * `localizationLocaleChecks` — its own schema comment names "a stray `en` row"
 * — so a base-locale row IS readable there and dropping the base locale from
 * this list would silently stop finding one.
 *
 * Callers RESOLVE with the plan and NARROW with this. Nothing resolves from
 * this list: a flat list cannot say whether its last entry means a row or a
 * column, which is the distinction `exact_locale_then_base` exists to make.
 */
export function localeFallbackChain(
  requestedLocale: string,
  policy: LocalizationFallbackPolicy,
): readonly SupportedLocale[] {
  const plan = localeFallbackPlan(requestedLocale, policy);
  if (plan.baseText === 'withheld') return plan.rowLocales;
  return [...plan.rowLocales, MERCARIA_BASE_LOCALE];
}

/**
 * Why nothing answered.
 *
 * `unsupported_locale` is reserved for the case its own doc names: the request
 * names a locale Mercaria does not author in AND the field's class forbids
 * answering from anywhere else. A policy that permits the base column does not
 * forbid it, so an entity that simply holds no text at all is
 * `no_text_in_locale` — the remedy is somebody writing the text, not Mercaria
 * opening a market.
 */
function unavailableReason(plan: LocaleFallbackPlan): LocalizationUnavailableReason {
  const nowhereToLook = plan.rowLocales.length === 0 && plan.baseText === 'withheld';
  return nowhereToLook ? 'unsupported_locale' : 'no_text_in_locale';
}

/**
 * How an effective locale was reached.
 *
 * `base` is checked BEFORE `language`, so `en-us` → `en` reports `base` rather
 * than `language`. Both descriptions are true of that hop and only one is the
 * fact a reader debugging a gap needs: "we fell all the way back" tells them a
 * translation is missing, "the language happened to be the base" does not.
 */
function stepFor(effective: SupportedLocale, requested: string): LocalizationFallbackStep {
  if (effective === requested) return 'exact';
  if (effective === MERCARIA_BASE_LOCALE) return 'base';
  return 'language';
}

/**
 * Text somebody could read, or `undefined`.
 *
 * A type predicate rather than a boolean helper, so the narrowing survives into
 * the returned object literal. Under `strict: false` an un-narrowed
 * `string | null` would assign to a `string` field silently, which is exactly
 * the direction that puts a `null` on the wire.
 */
function readableText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/** Everything resolving one localized field needs. */
export interface LocalizedFieldResolutionInput {
  /** The field being resolved. Its class decides the chain; see the header. */
  readonly field: LocalizedFieldKey;
  /** What the reader asked for. Folded here, so a caller need not. */
  readonly requestedLocale: string;
  /** The entity's localization rows. Order is irrelevant; locales are unique. */
  readonly candidates: readonly LocalizationCandidate[];
  /**
   * The entity's OWN base-locale text for this field — `categories.name`.
   *
   * Passed in rather than looked up because the base string lives on the entity
   * and never in a localization row (`<table>_locale_not_base_check`), so this
   * parameter is the one place the base step can be answered from. `null` is a
   * real answer: `categories` carries no description column, so
   * `category.description` legitimately falls all the way through.
   */
  readonly baseValue: string | null;
}

/**
 * Resolve one localized field down the chain its class allows.
 *
 * A row whose status is not servable — `missing`, `deprecated` — is SKIPPED and
 * the chain continues past it, rather than ending the search. A withdrawn
 * Spanish name should produce the English one, not nothing.
 */
export function resolveLocalizedField(
  input: LocalizedFieldResolutionInput,
): LocalizedResolution {
  const descriptor = CATALOG_LOCALIZED_FIELDS[input.field];
  const requested = foldLocale(input.requestedLocale);
  const plan = localeFallbackPlan(requested, descriptor.fallback);

  for (const locale of plan.rowLocales) {
    const row = input.candidates.find((entry) => foldLocale(entry.locale) === locale);
    if (row === undefined) continue;
    if (!SERVABLE.has(row.status)) continue;
    const text = readableText(row.value);
    if (text === undefined) continue;
    return {
      outcome: 'resolved',
      basis: 'localization_row',
      value: text,
      requestedLocale: requested,
      effectiveLocale: locale,
      step: stepFor(locale, requested),
      status: row.status,
      provenance: row.provenance,
    };
  }

  if (plan.baseText === 'permitted') {
    const baseText = readableText(input.baseValue);
    if (baseText !== undefined) {
      return {
        outcome: 'resolved',
        basis: 'authored_base_text',
        value: baseText,
        requestedLocale: requested,
        effectiveLocale: MERCARIA_BASE_LOCALE,
        step: stepFor(MERCARIA_BASE_LOCALE, requested),
        // A base string is not a translation: it is the text the concept was
        // authored in. A constant rather than a stored column, so no writer can
        // claim a base string was machine translated — and no `provenance`,
        // because this branch does not know who wrote it and for a
        // `seller_authored` field the answer is not Mercaria.
        status: BASE_LOCALE_STATUS,
      };
    }
  }

  return { outcome: 'unavailable', requestedLocale: requested, reason: unavailableReason(plan) };
}

/** Everything resolving one localized slug needs. */
export interface LocalizedSlugResolutionInput {
  readonly requestedLocale: string;
  /** The entity's localized slug rows, current and retired alike. */
  readonly candidates: readonly LocalizedSlugCandidate[];
  /** The entity's own base-locale slug — `categories.slug`. */
  readonly baseSlug: string | null;
}

/**
 * Resolve the slug a reader should be shown.
 *
 * A slug is not a member of `CATALOG_LOCALIZED_FIELDS`, and the omission is
 * deliberate rather than an oversight: it lives in a different table, its
 * candidate has a different shape, and it carries no `status` at all — its
 * lifecycle is `superseded_at`, and a status column beside that would be a
 * second answer to the one question a slug has. What it DOES share is the
 * policy derivation: a URL is `catalog_presentation`, and asking
 * `fallbackPolicyForFieldClass` for it means there is still exactly one place a
 * fallback policy is decided.
 *
 * A RETIRED slug is never returned. It exists so a shared link keeps resolving
 * — which is `findCategoryByLocalizedSlug`'s job — and showing it as the current
 * URL would hand out a link that immediately redirects.
 *
 * A slug's base branch DOES report `provenance`, where a field's does not, and
 * the asymmetry is a fact rather than an oversight: a slug is always
 * `catalog_presentation`, so its base is `categories.slug` — a URL Mercaria
 * minted — and {@link BASE_LOCALE_PROVENANCE} is true of it. No policy can make
 * a slug seller-authored, because this function names its own field class.
 */
export function resolveLocalizedSlug(
  input: LocalizedSlugResolutionInput,
): LocalizedSlugResolution {
  const requested = foldLocale(input.requestedLocale);
  const plan = localeFallbackPlan(requested, fallbackPolicyForFieldClass('catalog_presentation'));

  for (const locale of plan.rowLocales) {
    const row = input.candidates.find(
      (entry) => entry.superseded === 'no' && foldLocale(entry.locale) === locale,
    );
    if (row === undefined) continue;
    const slug = readableText(row.slug);
    if (slug === undefined) continue;
    return {
      outcome: 'resolved',
      slug,
      requestedLocale: requested,
      effectiveLocale: locale,
      step: stepFor(locale, requested),
      provenance: row.provenance,
    };
  }

  if (plan.baseText === 'permitted') {
    const baseSlug = readableText(input.baseSlug);
    if (baseSlug !== undefined) {
      return {
        outcome: 'resolved',
        slug: baseSlug,
        requestedLocale: requested,
        effectiveLocale: MERCARIA_BASE_LOCALE,
        step: stepFor(MERCARIA_BASE_LOCALE, requested),
        provenance: BASE_LOCALE_PROVENANCE,
      };
    }
  }

  return { outcome: 'unavailable', requestedLocale: requested, reason: unavailableReason(plan) };
}
