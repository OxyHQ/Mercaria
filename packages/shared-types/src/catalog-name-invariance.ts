/**
 * Which catalogue names may be translated, and which may never be (#367,
 * Translation model L2).
 *
 * ## This is a DECISION, and it is anchored rather than invented
 *
 * ADR 0007 contains no invariance policy — the word `invariant` appears in it
 * exactly once, on an unrelated subject. So "official names that should remain
 * invariant" had to be decided before it could be code. What the ADR DOES state,
 * as the single invariant the whole epic exists to establish, is:
 *
 * > A **label, name, description or slug is presentation and is never
 * > identity**.
 *
 * That settles the general case in the PERMISSIVE direction: a canonical
 * product's `name` is presentation, so translating it is not merely allowed, it
 * is the point. Identity on `canonical_products` is `id` and `slug` — the slug
 * is unique FOREVER, a merged tombstone keeps it — and NOT a `key` column, which
 * that table does not have. (`categories` has one; the two are different shapes
 * and the distinction matters here, because the invariant field on a product is
 * the slug rather than a key.)
 *
 * ## What this decision FALSIFIES, and why it has to exist at all
 *
 * `docs/storefront-catalog.md` currently states the invariance guarantee as
 * structural: official brand and model names stay unchanged, "held by there
 * being NO PATH through which a name reaches a translator". A
 * `canonical_product_localizations` table IS that path. So L2 cannot ship
 * without an explicit policy — the previous guarantee was an absence, and this
 * table ends it. That doc is amended in the same change rather than left to
 * describe a repository that no longer exists.
 *
 * What remains are the fields that are NOT presentation despite reading like a
 * name, and the decision here is that each of them is unrepresentable as a
 * translation rather than discouraged by a convention.
 *
 * ## Four different reasons, stated as data
 *
 * The reasons genuinely differ, and collapsing them into "these are invariant"
 * is what would make the rule a slogan a later reader argues with:
 *
 * - a **derived resolution key** (`normalized_name`) is computed FROM the name
 *   for matching. A per-locale one would make one product resolve differently
 *   per market, which is the identity failure ADR 0007 D1 exists to prevent.
 * - a **manufacturer's designation** (`model_code`) is that manufacturer's own
 *   string. Translating it names a different part, or nothing.
 * - an **issued identifier** (GTIN, EAN, UPC, MPN) is a number somebody else
 *   assigned. An identifier is not a name and has no language.
 * - a **proper noun under trademark** (a brand's name) is not Mercaria's to
 *   restate in another language.
 *
 * ## The enforcement is ABSENCE, and the tuple is what makes the absence checkable
 *
 * `canonical_product_localizations` has no column for any of these. A
 * prohibition held by a missing column is stronger than one held by a CHECK —
 * there is no value to refuse because there is nowhere to put one — but a
 * missing column is also invisible, and "nobody added it yet" and "it may never
 * be added" look identical in a schema.
 *
 * So the prohibition is stated as a VALUE here and the two tuples are asserted
 * DISJOINT, with a gate that walks the real drizzle table and fails the build if
 * a column named after any invariant field appears on it. That is the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device: the vocabulary and the schema each
 * carry half of one rule, and the test is what stops them drifting apart.
 */

/**
 * The canonical-product fields a translation may carry.
 *
 * Presentation, per ADR 0007's own invariant. Both are registered in
 * `CATALOG_LOCALIZED_FIELDS` as `catalog_presentation`, so both fall back
 * across markets — a Mexican shopper reading the Spanish name of a product is
 * reading Mercaria's own catalogue copy, not a claim about their market.
 */
export const CANONICAL_PRODUCT_LOCALIZABLE_FIELDS = ['name', 'description'] as const;

export type CanonicalProductLocalizableField =
  (typeof CANONICAL_PRODUCT_LOCALIZABLE_FIELDS)[number];

/** Why one field may never be translated. The four reasons are not one reason. */
export const NAME_INVARIANCE_REASONS = [
  'derived_resolution_key',
  'manufacturer_designation',
  'issued_identifier',
  'trademarked_proper_noun',
] as const;

export type NameInvarianceReason = (typeof NAME_INVARIANCE_REASONS)[number];

export interface InvariantCatalogName {
  /** The column or concept, as it is spelled where it lives. */
  readonly field: string;
  /** The table it lives on — NOT always the product. */
  readonly owner: string;
  readonly reason: NameInvarianceReason;
  readonly note: string;
}

/**
 * Names that may never carry a locale, each with the reason it may not.
 *
 * `owner` is worth reading before assuming this list is about one table. A
 * brand's name is not a column on `canonical_products` at all — it is reached
 * through `brand_id` — so the prohibition on translating it is a prohibition on
 * a `brand_localizations` table that does not exist, not on a column somebody
 * might add here. Stating it anyway is the point: the list is the set of names a
 * reader might reasonably think are translatable.
 */
export const INVARIANT_CATALOG_NAMES: readonly InvariantCatalogName[] = [
  {
    field: 'normalized_name',
    owner: 'canonical_products',
    reason: 'derived_resolution_key',
    note:
      'Computed FROM `name` for matching and search. A per-locale normalized name would make ' +
      'one product resolve differently per market, which is the identity failure ADR 0007 D1 ' +
      'exists to prevent.',
  },
  {
    field: 'model_code',
    owner: 'canonical_products',
    reason: 'manufacturer_designation',
    note:
      "The manufacturer's own string for this model. Translating it names a different part, or " +
      'nothing at all, and it is what a buyer types into search when they know exactly what they ' +
      'want.',
  },
  {
    field: 'slug',
    owner: 'canonical_products',
    reason: 'derived_resolution_key',
    note:
      'A URL somebody may have shared. A LOCALIZED slug is legitimate and is its own table with ' +
      'its own retirement and redirect rules — the `category_localized_slugs` shape — never a ' +
      'column on a localization row. Deferred rather than refused: see the doc.',
  },
  {
    field: 'name',
    owner: 'brands',
    reason: 'trademarked_proper_noun',
    note:
      "A brand is a proper noun under trademark and is not Mercaria's to restate in another " +
      'language. Reached from a product through `brand_id`, so there is no product-side column ' +
      'to refuse — the prohibition is on a `brand_localizations` table, which does not exist.',
  },
  {
    field: 'value',
    owner: 'product_identifiers',
    reason: 'issued_identifier',
    note:
      'A GTIN, EAN, UPC or MPN is a number somebody else assigned. An identifier is not a name ' +
      'and has no language; a translated one names a different product or nothing.',
  },
];

/**
 * `canonical_product_aliases` is NOT existing localization coverage.
 *
 * Worth stating because it looks like it is: the table carries a
 * `localized_name` KIND and an actual `language` column
 * (`db/schema/canonicalSupport.ts`), and three vertical seeds populate it with
 * `{kind: 'localized_name', language: 'es'}`. A reader could reasonably conclude
 * product name localization already exists.
 *
 * It does not, for three measured reasons — and the useful one is the third:
 *
 * 1. `language` is not in any unique index. The key is
 *    `(product_id, normalized_alias)`, so two locales cannot hold the SAME
 *    string and one locale cannot hold two fields.
 * 2. The row carries no `status`, no `provenance` and no reviewer, so it cannot
 *    express the difference between a machine suggestion and approved copy —
 *    which is the whole of what the localization family is for.
 * 3. **No reader filters on `language`.** Verified across `db/canonical/`,
 *    `services/matching/` and `services/search/`: every reference is a
 *    pass-through write. The readers are the matcher's candidate generation and
 *    a relevance score; nothing renders an alias as display text.
 *
 * So an alias answers "what might somebody call this" — resolution, alias to
 * product — and can never answer "what is this called in es-MX". The two
 * coexist: L2 adds presentation, and the alias stays search input.
 */
export const ALIAS_LOCALIZED_NAME_IS_RESOLUTION_NOT_PRESENTATION = true;

/** Just the field names, for a gate that walks a table's columns. */
export const INVARIANT_CATALOG_NAME_FIELDS: readonly string[] = INVARIANT_CATALOG_NAMES.map(
  (entry) => entry.field,
);

/**
 * The invariant fields that would live on `canonical_products` itself.
 *
 * The subset a gate over `canonical_product_localizations`' columns can
 * meaningfully assert, since a `brands.name` column was never going to appear
 * there. Derived rather than re-listed, so an entry added above joins it.
 */
export const CANONICAL_PRODUCT_INVARIANT_FIELDS: readonly string[] = INVARIANT_CATALOG_NAMES.filter(
  (entry) => entry.owner === 'canonical_products',
).map((entry) => entry.field);
