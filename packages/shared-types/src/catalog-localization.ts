/**
 * Catalog localization — ADR 0007 D4, epic #367 merge-order step 2.
 *
 * Every localized string in the catalog lives in a table dedicated to its
 * entity: `category_localizations`, `product_type_localizations`,
 * `attribute_value_localizations`, and `attribute_labels` (#94's, which is
 * ADOPTED as this family's attribute-definition member rather than duplicated).
 * A single polymorphic `(entity_type, entity_id, locale, field, value)` table
 * was rejected in the ADR: `entity_id` could carry no foreign key, so every
 * orphan would be invisible.
 *
 * This file is the vocabulary. It carries no row shape and no query; it carries
 * the closed value sets every CHECK in `db/schema/catalogLocalization.ts` is
 * rendered from, and the two things a caller of the resolver may name.
 *
 * ## The four distinctions this file exists to hold
 *
 * 1. **A resolution that found nothing has no `value` to render.**
 *    {@link LocalizedResolution} is a discriminated union on a STRING
 *    (`outcome`), because the backend compiles with `strict: false` and without
 *    `strictNullChecks` TypeScript does not narrow on a boolean-literal
 *    discriminant. Its `unavailable` branch has no `value` property at all, so
 *    "a public client never renders a raw key" is a fact about the type rather
 *    than a rule somebody follows.
 * 2. **Fallback is a property of the FIELD, never of the caller.** A caller
 *    names a {@link LocalizedFieldKey} — a literal union — and the resolver
 *    looks the policy up in {@link CATALOG_LOCALIZED_FIELDS} itself. There is
 *    no parameter through which a caller could ask for cross-market fallback on
 *    legal or seller-authored text, and an unregistered field is a compile
 *    error rather than a silent default.
 * 3. **Cross-market fallback is granted by an explicit list, never by
 *    omission.** {@link CROSS_MARKET_FALLBACK_FIELD_CLASSES} names the classes
 *    that MAY fall back; anything else — including a class somebody adds later
 *    without reading this comment — resolves at the exact requested locale or
 *    not at all. A market's legal copy is not a default for another market's,
 *    and there is no policy under which it may be.
 * 4. **Machine translation is a suggestion, not a source.**
 *    {@link HUMAN_SETTLED_LOCALIZATION_STATUSES} is the tuple the schema's
 *    trigger and its two companion CHECKs are written from. The trigger refuses
 *    the TRANSITION (a machine write landing on human work); the CHECKs make
 *    the resulting ROW unrepresentable. Neither covers the other: a machine
 *    write that also downgrades the status passes the CHECK, and an INSERT
 *    claiming `provenance = 'machine', status = 'approved'` never fires the
 *    update trigger.
 *
 * The tuples are the closed value sets the schema CHECKs read (`text` + CHECK,
 * never a pg enum — `db/schema/CONVENTIONS.md`). Widening one is a code change
 * plus `bun run db:generate` plus an additive (`pre`) migration in the SAME PR,
 * or the build is green and the first write of the new value fails in
 * production.
 */

/**
 * Every locale a catalog string may be authored in, as lowercase BCP 47.
 *
 * DERIVED, not invented: this is exactly the set of tags the storefront's own
 * `lib/i18n/index.ts` can present — its twelve translation bundles plus every
 * regional tag it aliases onto one. A catalog translation in a locale no
 * Mercaria client can render is a translation nobody reads, and a market tag
 * the client CAN carry (`es-MX`) has to be storable or the ADR's own fallback
 * example has nothing to fall back from.
 *
 * **Stored lowercase**, which is `attribute_labels`' existing decision one table
 * over and the reason it is repeated here rather than re-argued: BCP 47 tags are
 * case-insensitive, so `zh-Hans` and `zh-hans` are one tag, and two spellings of
 * one tag in one column is a lookup that misses. Canonical BCP 47 casing is a
 * PRESENTATION concern and belongs at the `Intl` boundary, which accepts the
 * folded form unchanged.
 */
export const SUPPORTED_LOCALES = [
  'ar',
  'ar-ae',
  'ar-eg',
  'ar-ma',
  'ar-sa',
  'bn',
  'bn-bd',
  'bn-in',
  'ca',
  'ca-es',
  'de',
  'de-at',
  'de-ch',
  'de-de',
  'en',
  'en-ca',
  'en-gb',
  'en-us',
  'es',
  'es-ar',
  'es-es',
  'es-mx',
  'fr',
  'fr-be',
  'fr-ca',
  'fr-ch',
  'fr-fr',
  'hi',
  'hi-in',
  'ja',
  'ja-jp',
  'pt',
  'pt-br',
  'pt-pt',
  'ru',
  'ru-ru',
  'zh',
  'zh-cn',
  'zh-hans',
  'zh-sg',
] as const;

/** A locale a catalog string may be authored in. Lowercase BCP 47. */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale every catalog concept's own columns are written in.
 *
 * A LANGUAGE and not a market: base catalog copy is not United States English,
 * and picking `en-us` would make every other English market a fallback from one
 * market's copy — the thing D4 forbids for legal text and would be merely
 * misleading for everything else.
 *
 * This is also why `category_localizations` may not hold a base-locale row: the
 * base text lives on `categories.name`, one place, and a CHECK rendered from
 * this constant makes the second representation unrepresentable rather than
 * merely discouraged.
 */
export const MERCARIA_BASE_LOCALE: SupportedLocale = 'en';

/**
 * How settled one localization row is.
 *
 * `missing` is a row that exists and holds no text — a translation somebody has
 * decided is owed. It is not the absence of a row, and the two are told apart by
 * a CHECK: `(status = 'missing') = (the primary text is null)`.
 *
 * `stale` is what a source-semantics change writes, and it never blanks the
 * text. A stale translation is still the best text available; withdrawing it
 * would show raw keys to shoppers, which is the failure the whole family exists
 * to prevent.
 */
export const LOCALIZATION_STATUSES = [
  'missing',
  'machine_translated',
  'reviewed',
  'approved',
  'stale',
  'deprecated',
] as const;

/** How settled one localization row is. */
export type LocalizationStatus = (typeof LOCALIZATION_STATUSES)[number];

/**
 * Statuses whose text may be SERVED to a reader.
 *
 * An explicit positive list rather than a subtraction, so a status added later
 * is un-servable until somebody decides otherwise — the direction that shows
 * less rather than more. `missing` has no text by construction and `deprecated`
 * is a translation somebody withdrew; both are skipped and the fallback chain
 * continues past them.
 *
 * `stale` and `machine_translated` ARE served, and the resolution reports which,
 * so a client can badge them. Serving nothing would be worse: the alternative to
 * an out-of-date Spanish name is an English one.
 */
export const SERVABLE_LOCALIZATION_STATUSES = [
  'machine_translated',
  'reviewed',
  'approved',
  'stale',
] as const;

/**
 * The statuses a machine translation may never land on.
 *
 * `stale` is deliberately NOT one of them, and it is the interesting case: a
 * stale row is human text that no longer describes the source, so a fresh
 * machine translation of the NEW source is a legitimate replacement for it. A
 * reviewer's decision about text that has since changed is not a decision about
 * the text that replaced it.
 *
 * `mercaria_localization_machine_write_guard` is written from this tuple, and
 * `catalog-localization.test.ts` reads the trigger's SQL back and asserts the
 * rendered list matches — the trigger body is hand-written SQL, so this is the
 * only thing standing between the two spellings drifting apart.
 */
export const HUMAN_SETTLED_LOCALIZATION_STATUSES = ['reviewed', 'approved'] as const;

/**
 * The statuses a source-semantics change rewrites to `stale`.
 *
 * `missing` has nothing to make stale and `deprecated` is already withdrawn;
 * rewriting either would turn a source edit into a status somebody has to undo.
 */
export const STALE_ON_SOURCE_CHANGE_STATUSES = [
  'machine_translated',
  'reviewed',
  'approved',
] as const;

/**
 * Where one localization's text came from.
 *
 * `imported_source` is a feed or a connector's own translation, which is a claim
 * by somebody outside Mercaria and is deliberately not `official_brand` — a
 * brand's own copy arrives through a verified relationship (#55), not through a
 * product feed that happens to carry a Spanish title.
 */
export const LOCALIZATION_PROVENANCES = [
  'mercaria',
  'official_brand',
  'professional',
  'community_reviewed',
  'machine',
  'imported_source',
] as const;

/** Where one localization's text came from. */
export type LocalizationProvenance = (typeof LOCALIZATION_PROVENANCES)[number];

/**
 * The one provenance the schema's trigger and CHECKs single out.
 *
 * Named rather than spelled, because it appears in three places — the guard
 * trigger, `<table>_machine_status_check` and `<table>_machine_reviewer_check` —
 * and a literal repeated three times is three chances to write `'machine '`.
 */
export const MACHINE_LOCALIZATION_PROVENANCE: LocalizationProvenance = 'machine';

/**
 * The status and provenance a base-locale string carries when it is resolved.
 *
 * A base-locale value is not a translation: it is the text the concept was
 * authored in, held on the entity's own column. Reporting it as `approved` /
 * `mercaria` states exactly that, and it is a constant rather than a stored row
 * precisely so no writer can claim a base string was machine translated.
 */
export const BASE_LOCALE_STATUS: LocalizationStatus = 'approved';
/** See {@link BASE_LOCALE_STATUS}. */
export const BASE_LOCALE_PROVENANCE: LocalizationProvenance = 'mercaria';

/**
 * What KIND of text a localized field holds, which is what decides its fallback.
 *
 * The classes exist so the exclusion D4 states — "legal text and seller-authored
 * text are excluded from cross-market fallback" — is a property of the field
 * rather than a discipline every caller has to remember. A caller names a field;
 * the field names its class; the class decides the chain.
 */
export const LOCALIZED_FIELD_CLASSES = [
  /** Mercaria's own catalog presentation: a category name, a value label. */
  'catalog_presentation',
  /** Market-specific legal or regulatory copy. Never another market's default. */
  'legal_text',
  /** Text a merchant or an individual seller wrote. Mercaria does not re-use it. */
  'seller_authored',
] as const;

/** What KIND of text a localized field holds. */
export type LocalizedFieldClass = (typeof LOCALIZED_FIELD_CLASSES)[number];

/**
 * The classes that MAY be answered from another locale.
 *
 * A grant list, so a class added later is excluded by omission and shows
 * nothing rather than showing somebody else's market's copy. The inverse
 * spelling — a list of excluded classes — makes a new class fall back by
 * default, which is exactly backwards for the one thing this rule protects.
 *
 * `catalog-localization.test.ts` asserts this list is a strict SUBSET of
 * {@link LOCALIZED_FIELD_CLASSES} and that at least one class is excluded, so
 * the rule cannot become vacuous by everything being granted.
 */
export const CROSS_MARKET_FALLBACK_FIELD_CLASSES = ['catalog_presentation'] as const;

/**
 * What a field's fallback chain is allowed to reach.
 *
 * `exact_locale_only` is not a degraded `language_then_base`: it is the whole
 * chain for a field whose text is a statement about ONE market, and its
 * `unavailable` answer is the correct one rather than a failure.
 */
export const LOCALIZATION_FALLBACK_POLICIES = ['language_then_base', 'exact_locale_only'] as const;

/** What a field's fallback chain is allowed to reach. */
export type LocalizationFallbackPolicy = (typeof LOCALIZATION_FALLBACK_POLICIES)[number];

/**
 * Which fallback policy a field class carries.
 *
 * The one derivation, so no descriptor states a policy and no caller can pass
 * one. Membership of the grant list is the whole rule.
 */
export function fallbackPolicyForFieldClass(
  fieldClass: LocalizedFieldClass,
): LocalizationFallbackPolicy {
  const granted: readonly string[] = CROSS_MARKET_FALLBACK_FIELD_CLASSES;
  return granted.includes(fieldClass) ? 'language_then_base' : 'exact_locale_only';
}

/**
 * The catalog concepts this issue localizes.
 *
 * `attribute_definition` is deliberately absent even though `attribute_labels`
 * is a member of the TABLE family below: that table carries no `status` and no
 * `provenance` yet, so a {@link LocalizationCandidate} built from one of its
 * rows would have to invent both. Nothing here can resolve an attribute label
 * until its owner adds the family columns, which is the honest state rather than
 * a resolver that reports a machine translation as approved.
 */
export const LOCALIZED_ENTITY_KINDS = ['category', 'product_type', 'attribute_value'] as const;

/** A catalog concept this issue localizes. */
export type LocalizedEntityKind = (typeof LOCALIZED_ENTITY_KINDS)[number];

/**
 * Every field a caller may ask the resolver for, `<entity>.<field>`.
 *
 * A literal union rather than a `string`, which is what makes an unregistered
 * field a compile error and what makes {@link CATALOG_LOCALIZED_FIELDS} the only
 * place a fallback policy exists.
 */
export const LOCALIZED_FIELD_KEYS = [
  'category.name',
  'category.description',
  'product_type.name',
  'product_type.description',
  'product_type.help_text',
  'attribute_value.label',
] as const;

/** Every field a caller may ask the resolver for. */
export type LocalizedFieldKey = (typeof LOCALIZED_FIELD_KEYS)[number];

/** One localizable field, and the policy its class implies. */
export interface LocalizedFieldDescriptor {
  readonly key: LocalizedFieldKey;
  readonly entity: LocalizedEntityKind;
  /** The column on the entity's localization table. */
  readonly column: string;
  readonly fieldClass: LocalizedFieldClass;
  /** Derived from {@link fieldClass}. Never stated by a caller or a descriptor. */
  readonly fallback: LocalizationFallbackPolicy;
}

function describeField(
  key: LocalizedFieldKey,
  entity: LocalizedEntityKind,
  column: string,
  fieldClass: LocalizedFieldClass,
): LocalizedFieldDescriptor {
  return { key, entity, column, fieldClass, fallback: fallbackPolicyForFieldClass(fieldClass) };
}

/**
 * The registry the resolver reads its policy out of.
 *
 * Every entry today is `catalog_presentation`, and that is worth stating
 * plainly rather than leaving a reader to infer it: **no field in this registry
 * carries `legal_text` or `seller_authored`**, so the exclusion above is
 * enforced and currently unexercised by production data. The first members that
 * will exercise it are the navigation and merchandising copy of ADR 0007 D3
 * (merge-order step 7) and the seller-authored listing text of D6/D7 — each
 * arrives with its own table and joins this registry with its class stated.
 * `catalog-localization.test.ts` exercises both policies directly, so the
 * mechanism is measured rather than assumed.
 */
export const CATALOG_LOCALIZED_FIELDS: Readonly<
  Record<LocalizedFieldKey, LocalizedFieldDescriptor>
> = Object.freeze({
  'category.name': describeField('category.name', 'category', 'name', 'catalog_presentation'),
  'category.description': describeField(
    'category.description',
    'category',
    'description',
    'catalog_presentation',
  ),
  'product_type.name': describeField(
    'product_type.name',
    'product_type',
    'name',
    'catalog_presentation',
  ),
  'product_type.description': describeField(
    'product_type.description',
    'product_type',
    'description',
    'catalog_presentation',
  ),
  'product_type.help_text': describeField(
    'product_type.help_text',
    'product_type',
    'helpText',
    'catalog_presentation',
  ),
  'attribute_value.label': describeField(
    'attribute_value.label',
    'attribute_value',
    'label',
    'catalog_presentation',
  ),
});

/**
 * Every table in the localization family, by SQL name.
 *
 * `catalog-localization.test.ts` walks the schema barrel and fails the build if
 * a table whose name ends in `_localizations` is missing from this list — the
 * `merge-plan-census` device, applied to a family whose whole point is that its
 * members carry identical columns. A new member (D4 names
 * `navigation_node_localizations`) therefore lands with a decision recorded
 * here rather than with a column set somebody copied approximately.
 */
export const CATALOG_LOCALIZATION_TEXT_TABLES = [
  'category_localizations',
  'product_type_localizations',
  'attribute_value_localizations',
  'attribute_labels',
  // ADR 0007 D3's navigation copy, which D4 names as a member and which landed
  // on a parallel branch. It joined this list on #367 step 2's rebase because
  // the census refused to pass without it — the mechanism working on somebody
  // else's table, which is what it was built for. It needs no exemption: it
  // arrived carrying all seven family columns independently, which is the
  // strongest evidence available that the shape is right.
  'navigation_node_localizations',
] as const;

/**
 * Family members that do NOT yet carry the family columns, each with the reason.
 *
 * Exactly one, and the count is asserted: a list of exemptions a gate skips is
 * how a gate stops being one. `attribute_labels` predates D4 and lives in
 * `db/schema/attributeRegistry.ts`, which #94's owner holds; adopting it means
 * adding `status`, `provenance`, `source_locale`, `source_revision`,
 * `reviewed_by` and `reviewed_at` to it in that file, plus the two triggers.
 * Until then it is a family member with a narrower shape, said out loud.
 */
export const LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS = [
  {
    table: 'attribute_labels',
    reason:
      'Predates ADR 0007 D4 and is owned by #94 (db/schema/attributeRegistry.ts). It gains the ' +
      'family columns and the two triggers in that file, not this one.',
  },
] as const;

/**
 * The columns every non-exempt member of the family carries, by SQL name.
 *
 * Stated once here and asserted against the real drizzle tables, so the four
 * tables cannot drift into four slightly different shapes — which is the failure
 * a per-entity family risks and a polymorphic table does not.
 */
export const LOCALIZATION_FAMILY_COLUMNS = [
  'locale',
  'status',
  'provenance',
  'source_locale',
  'source_revision',
  'reviewed_by_oxy_user_id',
  'reviewed_at',
] as const;

/**
 * The localized fields of one product-type version, derived from the registry.
 *
 * Derived rather than re-listed, so a field added to
 * {@link CATALOG_LOCALIZED_FIELDS} joins this set automatically and a copy
 * forward cannot silently ignore it — which is the direction that carries an
 * unchecked translation across a version bump.
 */
export const PRODUCT_TYPE_LOCALIZED_FIELD_KEYS: readonly LocalizedFieldKey[] =
  LOCALIZED_FIELD_KEYS.filter((key) => CATALOG_LOCALIZED_FIELDS[key].entity === 'product_type');

/**
 * What changed in MEANING between two product-type versions, as far as the
 * localized text is concerned.
 *
 * A published version's meaning is frozen (ADR 0007 D5), so a v2 is a new row
 * and its localizations start empty. Left there, every version bump ships
 * untranslated in every market — and the fix somebody reaches for is "fall back
 * to the previous version's text", which is precisely the inheritance the freeze
 * exists to prevent: a v2 that changed what a field asks for would inherit v1's
 * help text describing a question nobody is being asked any more, and it would
 * look completely fine on the screen.
 *
 * The shape that gives both: copy each locale's rows forward and mark `stale`
 * only the ones whose text no longer describes the version. `stale` already
 * means "still the best text available, needs review", which is exactly the
 * state an unchanged field's translation is in.
 *
 * **`unknown` is a first-class member and it is not an error.** A caller that
 * cannot diff the two versions has to be able to say so, and saying so must
 * mean "mark everything stale" rather than "mark nothing" — the safe direction
 * for a claim about somebody else's text. There is deliberately no way to omit
 * this: a copy forward that defaulted to "nothing changed" is the silent
 * inheritance arriving through a parameter nobody passed.
 *
 * `changedFields` MAY be empty, and that is a real claim rather than a hole: a
 * version that reordered its fields or tightened a validation rule changes
 * nothing about what its NAME means. A diff that returns empty because it is
 * broken is a bug in the diff, and it belongs there — only the code that
 * compares two versions can tell a genuine "nothing changed" from a comparison
 * that failed.
 */
export type ProductTypeSemanticChange =
  | {
      readonly kind: 'diffed';
      /** The localized fields whose meaning moved. May be empty. */
      readonly changedFields: readonly LocalizedFieldKey[];
    }
  | { readonly kind: 'unknown' };

/** What one copy forward did, for the caller to log. */
export interface LocalizationCopyForwardResult {
  /** Rows written against the new version. */
  readonly copied: number;
  /**
   * Of those, the ones that landed needing review — how much translation work
   * the bump created.
   *
   * `staleOnArrival` and not `markedStale`, because it counts rows that ARE
   * stale rather than rows this copy made stale: a source row already `stale`
   * before the bump carries its status across and is counted here too. The two
   * numbers differ, and the one a caller wants is this one — "how many need
   * review" rather than "how many I personally staled". It is counted off what
   * was WRITTEN, so it cannot report a copy that never happened.
   */
  readonly staleOnArrival: number;
  /** Locales left behind because the new version already had one. */
  readonly skippedExisting: number;
}

/** One stored localization row, reduced to what resolving one field needs. */
export interface LocalizationCandidate {
  /** Lowercase BCP 47. A row in the base locale is unrepresentable (a CHECK). */
  readonly locale: string;
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  /** The text for the field being resolved. NULL on a `missing` row. */
  readonly value: string | null;
}

/**
 * How the effective locale was reached.
 *
 * `base` wins over `language` when the two coincide (`en-us` → `en`, which IS
 * the base), because "we fell all the way back" is the fact a reader debugging a
 * gap needs; "and the base happens to be this locale's language" is not.
 */
export const LOCALIZATION_FALLBACK_STEPS = ['exact', 'language', 'base'] as const;

/** How the effective locale was reached. */
export type LocalizationFallbackStep = (typeof LOCALIZATION_FALLBACK_STEPS)[number];

/** Why a field could not be answered at all. */
export const LOCALIZATION_UNAVAILABLE_REASONS = [
  /** The chain was walked and no step held servable text. */
  'no_text_in_locale',
  /**
   * The requested locale is not one Mercaria authors in, and the field's class
   * forbids answering from another. Distinct from the reason above because the
   * remedy is different: one is a translation somebody owes, the other is a
   * market Mercaria does not serve this text in.
   */
  'unsupported_locale',
] as const;

/** Why a field could not be answered at all. */
export type LocalizationUnavailableReason = (typeof LOCALIZATION_UNAVAILABLE_REASONS)[number];

/**
 * What one field resolved to, or a statement that it did not.
 *
 * Discriminated on the STRING `outcome`. The `unavailable` branch has no
 * `value`, no `effectiveLocale` and no `status`, so a caller cannot render text
 * the resolver declined to produce — #94's refusal-as-an-outcome rule, applied
 * to presentation.
 */
export type LocalizedResolution =
  | {
      readonly outcome: 'resolved';
      readonly value: string;
      /** What the caller asked for, verbatim and folded. */
      readonly requestedLocale: string;
      /** What answered. Equal to `requestedLocale` exactly when `step` is `exact`. */
      readonly effectiveLocale: SupportedLocale;
      readonly step: LocalizationFallbackStep;
      readonly status: LocalizationStatus;
      readonly provenance: LocalizationProvenance;
    }
  | {
      readonly outcome: 'unavailable';
      readonly requestedLocale: string;
      readonly reason: LocalizationUnavailableReason;
    };

/**
 * One category's localized presentation, as a public read returns it.
 *
 * The slug is a SEPARATE resolution from the name and may land on a different
 * locale: a category can have an approved Spanish name and no Spanish slug, and
 * collapsing the two would either withhold the name or invent a slug.
 */
export interface LocalizedCategoryPresentation {
  readonly categoryId: string;
  readonly name: LocalizedResolution;
  readonly description: LocalizedResolution;
  readonly slug: LocalizedSlugResolution;
}

/** The current localized slug for one entity in one locale, or a statement that there is none. */
export type LocalizedSlugResolution =
  | {
      readonly outcome: 'resolved';
      readonly slug: string;
      readonly requestedLocale: string;
      readonly effectiveLocale: SupportedLocale;
      readonly step: LocalizationFallbackStep;
      readonly provenance: LocalizationProvenance;
    }
  | {
      readonly outcome: 'unavailable';
      readonly requestedLocale: string;
      readonly reason: LocalizationUnavailableReason;
    };

/** One row of a localized-slug table, reduced to what resolving one needs. */
export interface LocalizedSlugCandidate {
  readonly locale: string;
  readonly slug: string;
  readonly provenance: LocalizationProvenance;
  /** A superseded slug still resolves a shared link; it is never the current one. */
  readonly superseded: 'yes' | 'no';
}
