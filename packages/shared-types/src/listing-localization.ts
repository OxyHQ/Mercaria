/**
 * A native listing's own words in one locale, as a seller authors and reads
 * them (#814).
 *
 * #809 landed `listing_localizations` — the table, the `exact_locale_then_base`
 * resolution and two production reads — and scoped the write path out. This is
 * the contract of that write path: what a seller may SAY, and what comes back.
 *
 * ## Why the write shape carries neither `status` nor `provenance`
 *
 * Both are SERVER decisions, and the request has no field able to express
 * either. That is the `checkoutSchema` rule (`amount`, `paid` and
 * `paymentStatus` are refused outright rather than validated) applied to a
 * translation: a body able to carry a settlement word is where one would
 * eventually be trusted.
 *
 * The write stamps `provenance: 'seller'` — the member #814 added to
 * `LOCALIZATION_PROVENANCES`, distinct from `LOCALIZED_FIELD_CLASSES`'
 * `seller_authored`, which is the FIELD's kind rather than this row's author —
 * and the caller's own Oxy account as the settling party. So an operator review
 * row (`provenance: 'mercaria'`, written by `catalog-governance`'s
 * `reviewLocalization`) and a seller's own words are told apart on the row, in
 * one column, by every reader — which is the whole reason a new member was
 * needed rather than a reused one.
 */

import type {
  LocalizationProvenance,
  LocalizationStatus,
  SupportedLocale,
} from './catalog-localization';

/**
 * One listing's localized text in one locale, as served back to its owner.
 *
 * Every field is NAMED — the `provider_accounts` projection rule — rather than
 * spread from the row. `listing_localizations` carries a generated `tsvector`
 * whose serialized form is both large and meaningless to a client, and a
 * `select()`-and-spread is how it would reach one.
 */
export interface ListingLocalization {
  readonly listingId: string;
  readonly locale: SupportedLocale;
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  readonly title: string | null;
  readonly description: string | null;
  readonly sourceLocale: SupportedLocale | null;
  /** The Oxy account that settled this text, and when. */
  readonly settledByOxyUserId: string | null;
  readonly settledAt: string | null;
  readonly updatedAt: string;
}

/**
 * What a seller may say about one of their own listings in one locale.
 *
 * `title` is REQUIRED and may not be blank. The alternative — permitting a
 * title-less row — is a `missing` translation, and `missing` is a statement
 * that a translation is OWED, which is the translation desk's word about
 * Mercaria's own catalogue rather than a seller's about their listing.
 * A seller with nothing to say in a locale writes no row, and the resolver
 * answers from their own base text (`AUTHORED_BASE_FALLBACK_FIELD_CLASSES`).
 *
 * `description` is optional and NULLABLE because
 * `<table>_missing_text_check` ties `missing` to the PRIMARY text alone: a
 * seller who has translated their title and not yet their description holds a
 * row that is genuinely not missing.
 */
export interface ListingLocalizationWriteInput {
  readonly title: string;
  readonly description?: string | null;
}

/**
 * The status a seller's own translation carries.
 *
 * `approved` in this family means "the entity's current, live text" — the
 * reading {@link BASE_LOCALE_STATUS} states for a listing's own base words,
 * which no reviewer ever approved either. It is NOT a claim that Mercaria's
 * translation desk reviewed anything: `listing_localizations` is deliberately
 * outside that desk's coverage (`LOCALIZATION_COVERAGE_UNCOVERED_TABLES`), and
 * `catalog-governance`'s `reviewLocalization` takes `'category' | 'product_type'`
 * and has no member that could name a listing.
 *
 * It is the only truthful choice available. `machine_translated` would be a
 * false claim about the text's origin, `stale` a false claim about its currency,
 * `missing` is refused above, `deprecated` withdraws it, and `reviewed` names an
 * operator review that did not happen. Choosing `approved` also puts the row
 * inside `HUMAN_SETTLED_LOCALIZATION_STATUSES`, so the machine-write guard
 * refuses a later machine retranslation landing on a seller's own words — which
 * is the outcome this domain wants and would lose under any other status.
 */
export const SELLER_LOCALIZATION_STATUS: LocalizationStatus = 'approved';

/**
 * The provenance a seller's own translation carries.
 *
 * Never client-supplied. See this file's header for why it is `seller` and not
 * `seller_authored`, and `LOCALIZATION_PROVENANCES`' own docblock for why none
 * of the other six could carry it.
 */
export const SELLER_LOCALIZATION_PROVENANCE: LocalizationProvenance = 'seller';
