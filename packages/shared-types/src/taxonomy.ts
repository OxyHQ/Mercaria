/**
 * The universal catalogue taxonomy — identity, lifecycle, aliases and redirects
 * (#367 step 1, ADR 0007 D1/D2/D13).
 *
 * ## The one invariant this file exists to make representable
 *
 * ADR 0007 D1: a concept carries an opaque `id` and a stable machine `key`, and
 * **a label, name, description or slug is presentation and is never identity**.
 * `key` is what a seed, a fixture, an external mapping and an operator's tooling
 * name a category by; it is frozen after insert by a database trigger, so a
 * category whose key was wrong is deprecated and superseded rather than renamed.
 * A renamed key is indistinguishable from a different concept to everything that
 * cited it.
 *
 * ## The tuples here are the CHECKs
 *
 * Every closed value set below is the tuple `db/schema/taxonomy.ts` and
 * `db/schema/catalog.ts` render their CHECK constraints from (`text` + CHECK,
 * never a pg enum — `db/schema/CONVENTIONS.md`). Adding a value is a code change
 * plus an additive migration in the SAME pull request: the TypeScript union
 * widens immediately and the database CHECK does not.
 */

/**
 * `categories.lifecycle` — where a category sits in its life, ADR 0007 D2.
 *
 * The five states answer five different questions and none substitutes for
 * another:
 *
 * - `draft` — authored, never published. Nothing shopper-facing reads it.
 * - `published` — live. The ONE state {@link isCategoryLifecycleActive} admits,
 *   and therefore the one `categories.is_active` is true for.
 * - `deprecated` — was live, should no longer be assigned, has no successor.
 * - `merged` — was live and its identity ENDED in another category, named by
 *   `merged_into_category_id`. Set exactly when the lifecycle is this value (a
 *   biconditional CHECK), so "merged into nothing" and "merged into something
 *   while claiming another lifecycle" both have no row shape.
 * - `suppressed` — deliberately withheld from the shopper-visible tree while
 *   remaining resolvable and assignable. Mercaria's connector holding pen is
 *   exactly this: `lifecycle = 'suppressed'` with `selectable = true`.
 *
 * `suppressed` and `selectable = false` are NOT two spellings of one fact.
 * Suppression is about whether shoppers see the node; selectability is about
 * whether a product may be filed under it. A structural grouping level is
 * `published` and NOT selectable; the holding pen is `suppressed` and IS
 * selectable. Collapsing them makes one of the two unrepresentable.
 */
export type CategoryLifecycle = 'draft' | 'published' | 'deprecated' | 'merged' | 'suppressed';

/** The tuple `categories_lifecycle_check` is rendered from. */
export const CATEGORY_LIFECYCLES: readonly CategoryLifecycle[] = [
  'draft',
  'published',
  'deprecated',
  'merged',
  'suppressed',
];

/**
 * The lifecycle values `categories.is_active` is true for — exactly one.
 *
 * ADR 0007 D2 retires `is_active` as an authority and retains it as a v1 read
 * contract (D13). This constant is the DERIVATION, stated once, and
 * `db/taxonomy/taxonomyRepository.ts` is the only writer that applies it.
 */
export const CATEGORY_ACTIVE_LIFECYCLES: readonly CategoryLifecycle[] = ['published'];

/** Whether a lifecycle renders as the v1 `is_active` column's `true`. */
export function isCategoryLifecycleActive(lifecycle: CategoryLifecycle): boolean {
  return CATEGORY_ACTIVE_LIFECYCLES.includes(lifecycle);
}

/**
 * `category_aliases.kind` — what an alternate name IS.
 *
 * An alias is an INTERNAL and SEARCH-TIME alternate name and is never rendered
 * as the category's name (ADR 0007 D2). There is deliberately no `primary`,
 * `preferred` or `display` member and no boolean beside it: an alias that could
 * claim to be the name would be a second answer to what `categories.name` — and,
 * from step 2, the localization family — already answers.
 *
 * Nothing READS this column: `findActiveCategoriesByAliases` selects
 * `normalized_alias`, `locale`, `category_id` and `slug`, and the interpreter's
 * `CategoryAliasMatch` has no `kind` field to receive one. So a kind is
 * authoring and operator-review metadata — recording what an alias IS, for
 * whoever later has to judge a bad one — and adding a member changes no search
 * result. That is why the three below could be added without a reader change.
 *
 * ## The three added for #367's "regional terms, abbreviations, transliterations"
 *
 * The epic asks for "localized aliases, synonyms, regional terms, abbreviations,
 * common misspellings and transliterations". `synonym` and `misspelling` already
 * answered two of those words. The other three were added here because the two
 * kinds a reader reaches for do NOT cover them, and `product_type_aliases`
 * already made exactly this call one table over — its
 * `ProductTypeAliasKind` carries the same three, and
 * `db/__tests__/product-type-alias-seam.test.ts` names them as "words #367 lists
 * by hand".
 *
 * - **`search_term` does not cover `abbreviation`.** `search_term` is a phrase
 *   somebody TYPES that should land here and that nobody would call a name —
 *   it says nothing about the phrase's relationship to the name. `tv` is a
 *   contraction OF "television" and `4k` is not; folding both into one kind
 *   loses the only thing an operator reviewing a bad alias needs to know, which
 *   is whether the alias is derived from the name or merely associated with it.
 * - **`external_label` does not cover `regional_term`.** `external_label` is
 *   what a SOURCE called it — it belongs to a feed, an importer or a partner
 *   taxonomy and carries that provenance. `movil` (ES) against `celular`
 *   (es-419) is Mercaria's own vocabulary for one shelf in two markets, with no
 *   source behind it. Recording it as an external label would make an
 *   importer's words indistinguishable from Mercaria's own, which is the
 *   "imported source taxonomies leaking into Mercaria's public model" failure
 *   the epic is written against — and `product_type_aliases` refuses
 *   `external_label` for that same reason.
 *
 * `external_label` is nonetheless RETAINED here, unlike in the product-type
 * tuple, and the honest reason is scope rather than use: nothing has ever
 * written one (measured — no seed package, no test and no production caller
 * emits it, and `legacy_name` is in the same position). Removing a member is a
 * clean cut needing its own migration and its own decision about what a stored
 * row becomes; this change only ADDS vocabulary. That both are unwritten is the
 * fact whoever takes that decision should start from.
 *
 * ## `transliteration` and #854, which is a real defect and is ORTHOGONAL
 *
 * #854 is open: `normalizeCatalogAlias` folds `NFD` + strips `U+0300–U+036F`,
 * which merges DISTINCT Cyrillic words — `мой`→`мои`, `ёлка`→`елка`, `йорк`→
 * `иорк` — into the stored `normalized_alias` that
 * `category_aliases_category_locale_normalized_key` is defined over. So a
 * transliteration `айфон` and the misspelling `аифон` of one category in `ru`
 * are ONE key and the second write fails.
 *
 * That is worth knowing and it does not gate this member, for a structural
 * reason: **`kind` is not a column in that unique index.** No addition to this
 * tuple can change which alias STRINGS collide. The pair above is already
 * writable today as `synonym` + `misspelling`, so withholding `transliteration`
 * prevents no failure — it only stops a correctly-labelled row being stored.
 * Measured, and the direction the brief for this change assumed is the reverse
 * of the truth: a Cyrillic alias and its LATIN transliteration never collide
 * (`телефон`→`телефон` against `telefon`→`telefon`), because the fold strips
 * combining marks and performs no script conversion. #854 is a defect in the
 * NORMALIZER, reachable from every kind, and is fixed there.
 */
export type CategoryAliasKind =
  | 'synonym'
  | 'search_term'
  | 'legacy_name'
  | 'external_label'
  | 'misspelling'
  | 'transliteration'
  | 'abbreviation'
  | 'regional_term';

/** The tuple `category_aliases_kind_check` is rendered from. */
export const CATEGORY_ALIAS_KINDS: readonly CategoryAliasKind[] = [
  'synonym',
  'search_term',
  'legacy_name',
  'external_label',
  'misspelling',
  'transliteration',
  'abbreviation',
  'regional_term',
];

/**
 * `category_redirects.subject_kind` — what the OLD handle was.
 *
 * Two, because ADR 0007 D2 names two: "old id or old localized slug → current
 * category". They are a discriminated pair with a shape CHECK forcing the
 * non-selected pointers NULL, so a redirect that means two things has no row
 * shape.
 */
export type CategoryRedirectSubjectKind = 'category_id' | 'localized_slug';

/** The tuple `category_redirects_subject_kind_check` is rendered from. */
export const CATEGORY_REDIRECT_SUBJECT_KINDS: readonly CategoryRedirectSubjectKind[] = [
  'category_id',
  'localized_slug',
];

/**
 * `category_redirects.reason` — why the old handle stopped resolving.
 *
 * Recorded because the four lead an operator to different next actions: a
 * `merged` redirect has a `merged_into_category_id` beside it on the subject
 * category, a `renamed` one does not, and `operator` is a decision somebody made
 * that the taxonomy's own shape cannot explain.
 */
export type CategoryRedirectReason =
  | 'merged'
  | 'deprecated'
  | 'renamed'
  | 'reparented'
  | 'operator';

/** The tuple `category_redirects_reason_check` is rendered from. */
export const CATEGORY_REDIRECT_REASONS: readonly CategoryRedirectReason[] = [
  'merged',
  'deprecated',
  'renamed',
  'reparented',
  'operator',
];

/**
 * `category_external_mappings.review_state` — the ingestion framework's posture
 * (ADR 0007 D2): an unmapped external key goes to REVIEW, never to a guess.
 *
 * `unreviewed` is not a soft yes. A mapping only carries authority once somebody
 * approved it, and `superseded` exists so a corrected mapping keeps the one it
 * replaced rather than overwriting it.
 */
export type CategoryMappingReviewState = 'unreviewed' | 'approved' | 'rejected' | 'superseded';

/** The tuple `category_external_mappings_review_state_check` is rendered from. */
export const CATEGORY_MAPPING_REVIEW_STATES: readonly CategoryMappingReviewState[] = [
  'unreviewed',
  'approved',
  'rejected',
  'superseded',
];

/**
 * The review states that record a DECISION a person took, and therefore the ones
 * a reviewer id and a review instant are required beside.
 *
 * `unreviewed` has had no decision and `superseded` is a consequence of another
 * mapping being opened, which the system does — so demanding a reviewer for
 * either would force one to be invented.
 */
export const CATEGORY_MAPPING_DECIDED_STATES: readonly CategoryMappingReviewState[] = [
  'approved',
  'rejected',
];

/**
 * The shape of a category `key` — lowercase segments joined by dots
 * (`electronics.phones.smartphones`).
 *
 * A segment starts alphanumeric and may then carry `_` or `-`, so no segment is
 * empty and a key neither starts nor ends with a dot. Hyphens are ADMITTED on
 * purpose: #367's backfill derives every pre-existing category's key from its
 * own slug path by plain concatenation (`men` + `.` + `mens-pants`), and a
 * derivation with no transformation in it is the only one that produces the same
 * key in a restored production database and in a freshly seeded developer one.
 * Categories created after the backfill get a key somebody chose.
 *
 * ## The character class carries no backslash, deliberately
 *
 * This same source string is rendered into `categories_key_format_check`. A
 * backslash inside a template literal is consumed by the JS parser before
 * drizzle ever sees it, so `\.` would reach Postgres as a bare `.` — which
 * matches ANY character and turns the constraint into one that admits
 * `Electronics/Phones`. `[.]` needs no escape and cannot be silently undone.
 */
export const CATEGORY_KEY_PATTERN = '^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$';

/** Whether a string is a well-formed category key. */
export function isCategoryKey(value: string): boolean {
  return new RegExp(CATEGORY_KEY_PATTERN, 'u').test(value);
}

/**
 * One category, as the taxonomy owns it.
 *
 * `ancestorIds` is the authority and `ancestorSlugs` is the v1 read contract
 * beside it (ADR 0007 D13) — retained, superseded, and retired in a later `post`
 * migration once no reader remains. Both are ROOT-FIRST and exclude the category
 * itself, so a breadcrumb is `[...ancestors, self]`.
 */
export interface TaxonomyCategory {
  id: string;
  /** The stable machine key (D1). Frozen after insert by a database trigger. */
  key: string;
  name: string;
  slug: string;
  parentId: string | null;
  /** Root-first, excluding this category. The authority. */
  ancestorIds: string[];
  /** Root-first, excluding this category. The v1 read contract (D13). */
  ancestorSlugs: string[];
  lifecycle: CategoryLifecycle;
  /** Whether a product may be filed under this node. A structural node is not. */
  selectable: boolean;
  /** Set exactly when `lifecycle === 'merged'`. */
  mergedIntoCategoryId: string | null;
  /** A dated cutover, stated on the row rather than in a job's memory. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  position: number;
  imageUrl: string | null;
}

/** One step of a breadcrumb. Identity plus the two presentation fields. */
export interface CategoryBreadcrumbStep {
  id: string;
  key: string;
  name: string;
  slug: string;
}

/**
 * What resolving an old handle produced.
 *
 * A discriminated union rather than a nullable category, because "this handle
 * names a live category", "this handle was redirected here" and "nothing here"
 * are three answers a caller renders differently — the first needs no
 * `Location` header, the second does, and the third is a 404. A STRING
 * discriminant: this repository compiles with `strict: false`, so without
 * `strictNullChecks` TypeScript does not narrow a union on the truthiness of a
 * boolean-literal discriminant.
 */
export type CategoryRedirectResolution =
  | { readonly outcome: 'current'; readonly category: TaxonomyCategory }
  | {
      readonly outcome: 'redirected';
      readonly category: TaxonomyCategory;
      readonly reason: CategoryRedirectReason;
      /** How many redirect hops were followed. Always at least one. */
      readonly hops: number;
    }
  /**
   * The chain was longer than the resolver will follow, so where it ends is
   * unknown.
   *
   * It carries NO category, deliberately. The obvious alternative — returning
   * the category the walk happened to stop on, as `redirected` — is a silent
   * wrong answer: that category is itself redirected, may be `merged` or
   * `deprecated`, and the response is indistinguishable from a fully resolved
   * one. A caller renders this as "not found", the same as `unresolved`, but an
   * operator reading a trace can tell the two apart, and only one of them means
   * somebody should shorten a chain.
   *
   * Reachable, not theoretical: `mercaria_category_redirect_cycle_guard` bounds
   * the chain a single insert can see AHEAD of itself, and cannot see the chain
   * BEHIND its subject. Nine redirects added one at a time, each extending the
   * tail and each individually legitimate, build a chain past the bound.
   */
  | { readonly outcome: 'chain_exhausted'; readonly hops: number }
  | { readonly outcome: 'unresolved' };

/** One internal or search-time alternate name for a category. */
export interface CategoryAlias {
  id: string;
  categoryId: string;
  /** A BCP-47 tag. The localization FAMILY arrives in step 2; this is its key. */
  locale: string;
  alias: string;
  /** Service-maintained normalization of `alias`, for lookup. */
  normalizedAlias: string;
  kind: CategoryAliasKind;
}

/** One external taxonomy's key, mapped to a Mercaria category. */
export interface CategoryExternalMapping {
  id: string;
  sourceId: string;
  externalKey: string;
  categoryId: string;
  /** Monotonic per `(source_id, external_key)`; only one row is live. */
  version: number;
  /** `[0, 1]`, or absent when the mapping was stated rather than inferred. */
  confidence: number | null;
  reviewState: CategoryMappingReviewState;
  validFrom: string;
  validTo: string | null;
}
