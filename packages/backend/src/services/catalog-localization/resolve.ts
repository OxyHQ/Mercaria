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
 * ## Two things the return type makes impossible
 *
 * 1. **Rendering text the resolver declined to produce.**
 *    {@link LocalizedResolution}'s `unavailable` branch has no `value`, no
 *    `effectiveLocale` and no `status`. A caller that wants to show something
 *    has to handle the absence, which is what "a public client never renders a
 *    raw key" means in practice.
 * 2. **Asking for cross-market fallback on text that may not have it.** The
 *    signature takes a {@link LocalizedFieldKey} — a literal union — and reads
 *    the policy out of `CATALOG_LOCALIZED_FIELDS` itself. There is no parameter
 *    a caller could pass, so D4's exclusion of legal and seller-authored text is
 *    a property of the field rather than a discipline. An unregistered field is
 *    a compile error.
 *
 * The effective locale and the translation status travel back beside the
 * string, deliberately: an internal client debugging "why is this English"
 * needs the step that answered, and a public client needs the status to decide
 * whether to badge a machine translation.
 */

import {
  CATALOG_LOCALIZED_FIELDS,
  MERCARIA_BASE_LOCALE,
  SERVABLE_LOCALIZATION_STATUSES,
  SUPPORTED_LOCALES,
  fallbackPolicyForFieldClass,
  type LocalizationCandidate,
  type LocalizationFallbackPolicy,
  type LocalizationFallbackStep,
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
 * The locales that may answer a request, in order.
 *
 * Truncation is mechanical rather than a hand-maintained map, and that is
 * deliberate: a per-tag fallback table is a second list to keep in step with
 * `SUPPORTED_LOCALES`, and the failure of a stale entry is silent (a locale
 * falling back to one nobody authors). The truncations are FILTERED to supported
 * tags, so no step of the chain can name a locale that has no row shape.
 *
 * `exact_locale_only` returns at most one entry, and returns NONE for an
 * unsupported request — which is what turns a legal-text request in an
 * unauthored market into `unsupported_locale` rather than into another market's
 * copy.
 */
export function localeFallbackChain(
  requestedLocale: string,
  policy: LocalizationFallbackPolicy,
): readonly SupportedLocale[] {
  const folded = foldLocale(requestedLocale);
  if (policy === 'exact_locale_only') {
    return isSupportedLocale(folded) ? [folded] : [];
  }

  const chain: SupportedLocale[] = [];
  let candidate = folded;
  for (;;) {
    if (isSupportedLocale(candidate) && !chain.includes(candidate)) chain.push(candidate);
    const cut = candidate.lastIndexOf('-');
    if (cut <= 0) break;
    candidate = candidate.slice(0, cut);
  }
  if (!chain.includes(MERCARIA_BASE_LOCALE)) chain.push(MERCARIA_BASE_LOCALE);
  return chain;
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
  const chain = localeFallbackChain(requested, descriptor.fallback);
  if (chain.length === 0) {
    return { outcome: 'unavailable', requestedLocale: requested, reason: 'unsupported_locale' };
  }

  for (const locale of chain) {
    if (locale === MERCARIA_BASE_LOCALE) {
      const baseText = readableText(input.baseValue);
      if (baseText === undefined) continue;
      return {
        outcome: 'resolved',
        value: baseText,
        requestedLocale: requested,
        effectiveLocale: locale,
        step: stepFor(locale, requested),
        // A base string is not a translation: it is the text the concept was
        // authored in. Constants rather than stored columns, so no writer can
        // claim a base string was machine translated.
        status: 'approved',
        provenance: 'mercaria',
      };
    }
    const row = input.candidates.find((entry) => foldLocale(entry.locale) === locale);
    if (row === undefined) continue;
    if (!SERVABLE.has(row.status)) continue;
    const text = readableText(row.value);
    if (text === undefined) continue;
    return {
      outcome: 'resolved',
      value: text,
      requestedLocale: requested,
      effectiveLocale: locale,
      step: stepFor(locale, requested),
      status: row.status,
      provenance: row.provenance,
    };
  }

  return { outcome: 'unavailable', requestedLocale: requested, reason: 'no_text_in_locale' };
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
 */
export function resolveLocalizedSlug(
  input: LocalizedSlugResolutionInput,
): LocalizedSlugResolution {
  const requested = foldLocale(input.requestedLocale);
  const chain = localeFallbackChain(requested, fallbackPolicyForFieldClass('catalog_presentation'));
  if (chain.length === 0) {
    return { outcome: 'unavailable', requestedLocale: requested, reason: 'unsupported_locale' };
  }

  for (const locale of chain) {
    if (locale === MERCARIA_BASE_LOCALE) {
      const baseSlug = readableText(input.baseSlug);
      if (baseSlug === undefined) continue;
      return {
        outcome: 'resolved',
        slug: baseSlug,
        requestedLocale: requested,
        effectiveLocale: locale,
        step: stepFor(locale, requested),
        provenance: 'mercaria',
      };
    }
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

  return { outcome: 'unavailable', requestedLocale: requested, reason: 'no_text_in_locale' };
}
