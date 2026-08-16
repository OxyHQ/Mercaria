/**
 * External taxonomy, attribute and value mappings (#367 Workstream 11, ADR 0007
 * D1/D13/D14).
 *
 * An external provider — a marketplace, an affiliate network, a merchant feed —
 * publishes its own vocabulary: an item type called `Smartphones`, a field
 * called `memory_size`, a value spelled `Cor`, a unit written `GB`, a size chart
 * called `EU`. This vocabulary is how one of those tokens becomes a Mercaria
 * concept, and — much more of it — how it is stopped from becoming one by
 * accident.
 *
 * The CATEGORY dimension is deliberately absent: ADR 0007 D2 assigns
 * `category_external_mappings` to the taxonomy module and the taxonomy
 * workstream built it. See {@link CATALOG_EXTERNAL_MAPPING_DIMENSIONS}.
 *
 * **Mercaria never exposes a provider's structure as its canonical model.** The
 * mapping points INWARD: an external key resolves to a Mercaria product-type
 * key, a Mercaria attribute key, a Mercaria controlled value, a Mercaria unit.
 * There is no shape here in which a provider's vocabulary becomes Mercaria's,
 * and no column anywhere that could hold a provider's concept as a Mercaria
 * one.
 *
 * ## What is structurally impossible here, and why each one is
 *
 * - **A name can never establish a mapping.** ADR 0007 D1's single invariant is
 *   that a label, name, description or slug is presentation and is never
 *   identity. So the TARGET side of a mapping is an id or a stable machine key
 *   and nothing else — there is no `target_name`, `target_label` or
 *   `target_slug` column in the domain, and a gate fails the build if one
 *   appears. {@link CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES} additionally
 *   names `name_match` and `slug_match` as VALUES, disjoint from
 *   {@link CATALOG_EXTERNAL_MAPPING_PROVENANCES}, so the plausible-looking
 *   future addition fails the build rather than being reviewed on its wording.
 *   This is #55's `verification_method` device: the reason that domain has no
 *   `name_match` member is the reason this one does not either.
 *
 * - **A source-supplied string can never be executed.** A transformation is a
 *   REFERENCE to a rule Mercaria ships, by key and version
 *   ({@link CATALOG_EXTERNAL_TRANSFORM_RULES}), never an embedded pattern,
 *   template or expression. #63 states the reason exactly: a source-supplied
 *   pattern is a small language and a DoS primitive, which is why its own
 *   transform vocabulary excludes `regex_replace`.
 *   {@link CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS} names ten such shapes and no
 *   column in the domain could hold one.
 *
 * - **Confidence is information for a reviewer and never an authority.** There
 *   is no confidence at which a mapping applies without approval: the resolver
 *   reads {@link CatalogExternalMappingState} and does not read confidence at
 *   all, which a gate asserts. #58's failure mode is the reason — a false merge
 *   looks exactly like a correct one and is found by a customer.
 *
 * - **A silent one-to-many is unrepresentable.** Many external keys mapping onto
 *   one Mercaria concept is ordinary and needs no ceremony. One external key
 *   fanning out onto several is a reviewed decision with two named operators
 *   behind it, and the database refuses the un-reviewed version through a
 *   partial unique index rather than a service check. The read side keeps them
 *   apart with a THIRD branch — {@link CatalogExternalResolution}'s
 *   `fanned_out` — so a caller that handles one target cannot silently discard
 *   the others; it fails `tsc`.
 *
 * - **An unmapped or ambiguous token is a review row, never a guess.** There is
 *   no default mapping, no nearest-match fallback and no "map to the parent
 *   parent concept" rule. {@link CATALOG_EXTERNAL_UNRESOLVED_REASONS} has seven
 *   members and every one of them BLOCKS.
 *
 * ## The raw value survives the transformation, always
 *
 * Every table in this domain that records an external token records the source's
 * own spelling verbatim beside the normalized lookup form, and the normalized
 * form is a GENERATED column so the two cannot disagree — the
 * `attribute_value_aliases.normalized_alias` device. Normalizing what a source
 * said never destroys what it said.
 */

import type { UnitFamily } from './attribute-registry';

// ─── The five dimensions ─────────────────────────────────────────────────────

/**
 * What kind of Mercaria concept an external token maps onto.
 *
 * Five dimensions, one table, one set of governance semantics. Five
 * near-identical tables would be five copies of the versioning, confidence,
 * review, validity and reprocessing machinery, and the copy that drifted would
 * be the one nobody was reading. The target is discriminated by a CHECK that
 * makes every non-selected pointer NULL — ADR 0007 D3's `navigation_nodes`
 * device, so "a mapping that means two things" has no row shape.
 *
 * ## `category` is deliberately NOT a member
 *
 * ADR 0007 D2 names `category_external_mappings` under "New tables, each owned
 * by the taxonomy module", and the taxonomy workstream built it — versioned,
 * with confidence, review state and validity dates, in `db/schema/taxonomy.ts`.
 * Adding a `category` member here would be the rival table this epic exists to
 * remove, so there is no member and no `target_category_id` column.
 *
 * The cost of the split is stated rather than hidden, because it is real: one
 * dimension is modelled in the taxonomy module's shape and five in this one, and
 * the two are free to diverge on confidence, review state, validity and
 * provenance. Removing it is an ADR 0007 amendment plus a move migration, in one
 * change — see `docs/catalog-external-mappings.md` §"The category dimension".
 */
export const CATALOG_EXTERNAL_MAPPING_DIMENSIONS = [
  /** An external product type / item type → a Mercaria product type KEY. */
  'product_type',
  /** An external field or specification name → a Mercaria attribute KEY. */
  'attribute',
  /** An external enumerated value → a Mercaria controlled value of one attribute. */
  'controlled_value',
  /** An external unit token → a Mercaria canonical unit within its family. */
  'unit',
  /** An external size chart or system → a Mercaria size system KEY. */
  'size_system',
] as const;

/** One of {@link CATALOG_EXTERNAL_MAPPING_DIMENSIONS}. */
export type CatalogExternalMappingDimension =
  (typeof CATALOG_EXTERNAL_MAPPING_DIMENSIONS)[number];

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * A mapping's lifecycle. `approved` is the ONLY state the resolver reads.
 *
 * `rejected` is retained rather than deleted for the `match_blocked_pairs`
 * reason (#58): a rejection that evaporates lets the same proposal come back on
 * the next crawl and be reviewed again forever. `superseded` is what a mapping
 * CHANGE produces — a new version plus a `valid_to` on the old one — because a
 * mapping that was edited in place would silently reinterpret every observation
 * recorded under its previous meaning, which is the exact failure ADR 0007 D5
 * pins version immutability against.
 */
export const CATALOG_EXTERNAL_MAPPING_STATES = [
  /** Recorded and never applied. The state every proposal starts in. */
  'proposed',
  /** A person has it. Still never applied. */
  'in_review',
  /** Approved by a named operator, within its validity window: it resolves. */
  'approved',
  /** A person refused it. Never resolves, and the record blocks a re-proposal loop. */
  'rejected',
  /** Replaced by a later version. Never resolves; its history stays readable. */
  'superseded',
] as const;

/** One of {@link CATALOG_EXTERNAL_MAPPING_STATES}. */
export type CatalogExternalMappingState = (typeof CATALOG_EXTERNAL_MAPPING_STATES)[number];

/**
 * Where a mapping came from. Five members, all of which still require approval.
 *
 * `heuristic_suggestion` is deliberately IN the list: a suggester is a
 * legitimate way for a mapping to be PROPOSED, and pretending otherwise would
 * push the same suggestions in under an operator's name. What it may never be is
 * approved by itself, which the state machine holds and no provenance can dodge.
 */
export const CATALOG_EXTERNAL_MAPPING_PROVENANCES = [
  /** A Mercaria operator recorded the correspondence. */
  'operator',
  /** The source itself published it — a feed shipping both its key and a standard one. */
  'source_declared',
  /** A published crosswalk from the standards body or the provider. */
  'official_crosswalk',
  /** Carried over from #94's `attribute_source_mappings` when this layer adopted it. */
  'imported_legacy',
  /** A suggester proposed it. Never approves itself. */
  'heuristic_suggestion',
] as const;

/** One of {@link CATALOG_EXTERNAL_MAPPING_PROVENANCES}. */
export type CatalogExternalMappingProvenance =
  (typeof CATALOG_EXTERNAL_MAPPING_PROVENANCES)[number];

/**
 * Nine bases on which a mapping may NEVER be established, named as VALUES and
 * DISJOINT from {@link CATALOG_EXTERNAL_MAPPING_PROVENANCES} by a test.
 *
 * The first four are ADR 0007 D1: presentation is not identity, and a
 * translation of a label is a name match with an extra step. The last five are
 * the commercial ones — a mapping that could be bought is a taxonomy that can be
 * bought, and #74 keeps ranking behind a versioned policy precisely so that no
 * other domain becomes a quieter place to put a thumb on the scale.
 */
export const CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES = [
  'name_match',
  'slug_match',
  'label_similarity',
  'machine_translation',
  'ranking_position',
  'commission_rate',
  'fee_schedule_tier',
  'merchant_plan_tier',
  'paid_placement',
] as const;

/** One of {@link CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES}. */
export type CatalogExternalMappingForbiddenProvenance =
  (typeof CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES)[number];

// ─── Transformation: a reference, never a rule ───────────────────────────────

/**
 * The transformation rules Mercaria SHIPS, cited by key plus version.
 *
 * A mapping row names one of these and a version integer; it does not carry a
 * pattern, a template, an expression or a lookup table. That is the whole of
 * "transformation and normalization rule REFERENCES with versions — a reference,
 * never an embedded executable rule", and it is the `CATALOG_BACKFILL_MAPPING_VERSION`
 * decision applied one domain over: the mapping is a PROCEDURE, and a table
 * would let somebody publish a version whose rules nobody shipped.
 *
 * A rule is pure, total and takes no parameter a row could supply. A key and
 * version pair that no registered rule implements is REFUSED at resolution
 * (`transform_refused`), never silently treated as `identity` — a transformation
 * that quietly did nothing is how a magnitude in grams gets stored as kilograms.
 */
export const CATALOG_EXTERNAL_TRANSFORM_RULES = [
  /** Pass the source's value through unchanged. */
  'identity',
  /** Strip leading and trailing whitespace. */
  'trim',
  /** Trim and lower-case — the lookup form for a case-varying source. */
  'case_fold',
  /** Trim and collapse every internal whitespace run to one space. */
  'collapse_whitespace',
  /** Case-fold and remove combining marks, for a source that varies on accents. */
  'strip_diacritics',
  /** Take the last segment of a delimited taxonomy path (`A > B > C` → `C`). */
  'path_leaf',
  /** Read a magnitude plus a unit token and express it in the family's base unit. */
  'unit_magnitude_to_base',
  /** Read a number written with either decimal convention into a canonical form. */
  'decimal_separator_normalize',
] as const;

/** One of {@link CATALOG_EXTERNAL_TRANSFORM_RULES}. */
export type CatalogExternalTransformRule = (typeof CATALOG_EXTERNAL_TRANSFORM_RULES)[number];

/**
 * Ten transformation shapes that may never exist here, DISJOINT from
 * {@link CATALOG_EXTERNAL_TRANSFORM_RULES} by a test.
 *
 * Every one of them takes its behaviour from a value somebody else supplied.
 * `lookup_table_from_row` is the subtle one: a mapping row carrying its own
 * value table is a second, ungoverned mapping layer hiding inside the governed
 * one, with no version, no review and no validity window.
 */
export const CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS = [
  'regex_replace',
  'template_render',
  'script_eval',
  'jsonpath_expression',
  'sql_fragment',
  'shell_command',
  'xslt',
  'lookup_table_from_row',
  'source_supplied_function',
  'dynamic_import',
] as const;

/** One of {@link CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS}. */
export type CatalogExternalForbiddenTransform =
  (typeof CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS)[number];

/**
 * The outcome of applying a shipped transform rule to a source's raw value.
 *
 * A STRING discriminant, not a boolean: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — `if (!x.ok)`
 * leaves the caller holding the whole union. Measured in #68 and again in #110.
 */
export type CatalogExternalTransformOutcome =
  | { readonly outcome: 'normalized'; readonly value: string }
  | { readonly outcome: 'refused'; readonly reason: CatalogExternalTransformRefusal };

/** Why a shipped rule declined to transform a value. Each one BLOCKS. */
export const CATALOG_EXTERNAL_TRANSFORM_REFUSALS = [
  /** No registered rule implements this key at this version. */
  'rule_not_registered',
  /** The value is empty once the rule's own normalization ran. */
  'empty_result',
  /** The rule expects a magnitude and the value is not one. */
  'unparsed',
  /** A unit token the canonical unit table does not know. */
  'unknown_unit',
  /** A number written so that neither decimal convention resolves it. */
  'ambiguous_number',
  /** Longer than the domain permits — a bound, never a truncation. */
  'too_long',
] as const;

/** One of {@link CATALOG_EXTERNAL_TRANSFORM_REFUSALS}. */
export type CatalogExternalTransformRefusal =
  (typeof CATALOG_EXTERNAL_TRANSFORM_REFUSALS)[number];

/**
 * The longest external token this domain will read.
 *
 * A bound rather than a truncation, for #63's reason: a truncated key hashes and
 * normalizes differently on every delivery, so the convergence key stops
 * converging and one external concept becomes many.
 */
export const CATALOG_EXTERNAL_TOKEN_MAX_LENGTH = 512;

// ─── Resolution ──────────────────────────────────────────────────────────────

/** Where a resolution's authority came from. */
export const CATALOG_EXTERNAL_RESOLUTION_ORIGINS = [
  /** A reviewed, approved, in-window mapping in this domain. */
  'governed',
  /**
   * #94's `attribute_source_mappings`, read as a lower-precedence LEGACY input.
   *
   * That table predates this layer and carries no version, confidence, review
   * state, provenance or validity window. It is read so that adopting this
   * domain does not silently un-map fields a deployment already configured, it
   * is never written here, and a disagreement between the two is RECORDED as a
   * review rather than resolved by a rule about which wins.
   */
  'legacy_registry',
] as const;

/** One of {@link CATALOG_EXTERNAL_RESOLUTION_ORIGINS}. */
export type CatalogExternalResolutionOrigin =
  (typeof CATALOG_EXTERNAL_RESOLUTION_ORIGINS)[number];

/**
 * Whether one recorded observation of a token resolved.
 *
 * Two members and a CHECK, rather than a boolean column: `resolution_outcome`
 * pairs with `unresolved_reason` and with `resolved_mapping_id` through two
 * biconditional CHECKs, and a nullable boolean would give the pair a third state
 * neither of them can describe.
 */
export const CATALOG_EXTERNAL_RESOLUTION_OUTCOMES = ['resolved', 'unresolved'] as const;

/** One of {@link CATALOG_EXTERNAL_RESOLUTION_OUTCOMES}. */
export type CatalogExternalResolutionOutcome =
  (typeof CATALOG_EXTERNAL_RESOLUTION_OUTCOMES)[number];

/** Why an external token did not resolve. Every member BLOCKS. */
export const CATALOG_EXTERNAL_UNRESOLVED_REASONS = [
  /** No mapping names this token. The ordinary first sighting. */
  'unmapped',
  /** Several candidates and no reviewed fan-out decision between them. */
  'ambiguous',
  /** A mapping exists and has not been approved. */
  'mapping_not_approved',
  /** A mapping exists and its validity window does not cover the instant asked about. */
  'mapping_expired',
  /** The mapping names a Mercaria concept that no longer resolves. */
  'target_unresolvable',
  /** This dimension's Mercaria-side registry is not available in this deployment. */
  'registry_unavailable',
  /** The named transform rule refused the source's value. */
  'transform_refused',
] as const;

/** One of {@link CATALOG_EXTERNAL_UNRESOLVED_REASONS}. */
export type CatalogExternalUnresolvedReason =
  (typeof CATALOG_EXTERNAL_UNRESOLVED_REASONS)[number];

/**
 * What a mapping points at, per dimension.
 *
 * A discriminated union rather than six nullable fields on one object, so a
 * consumer reading `attributeKey` off a unit mapping is a `tsc` error. The
 * dimension is the discriminant and is a string for the `strict: false` reason
 * given on {@link CatalogExternalTransformOutcome}.
 *
 * ## Every target is a stable machine KEY, and none is an id
 *
 * That is exactly what ADR 0007 D1 says a key exists for — "so seeds, fixtures,
 * **external mappings** and operator tooling can name a concept without
 * embedding a uuid".
 *
 * It is also the only choice available, for two independent reasons that each
 * hold on their own:
 *
 * - **Semantics.** `product_type_definitions` and `attribute_definitions` are
 *   both keyed `(key, version)` and each row is ONE version. An id-valued target
 *   would tie a reviewed governance decision to a version that will be
 *   deprecated: the mapping would be cascaded away with it or would block the
 *   deprecation, and neither is what "this source's `memory_size` field means
 *   `ram_capacity`" meant. #94's own `attribute_source_mappings.attribute_key`
 *   made the same call.
 * - **Mechanics, and this one is permanent.** Neither table has a unique
 *   constraint on `key` alone, and neither will get one — the one-live-version
 *   index is PARTIAL (`WHERE lifecycle = 'published'` / `= 'active'`),
 *   PostgreSQL will not accept a foreign key onto a partial unique index, and
 *   the house rule additionally forbids a foreign key onto a `uniqueIndex()`
 *   rather than a `unique()` constraint. So a key-valued target is FK-less by
 *   DESIGN rather than until some table lands.
 *
 * What makes that safe is that a key is frozen from INSERT by a trigger on both
 * registries (D1 rule 2: a renamed key is indistinguishable from a different
 * concept to every mapping that cited it), so a mapping keyed on one cannot be
 * silently re-pointed. Resolution reads the single live version — a single-row
 * lookup on the partial unique, never an `ORDER BY … LIMIT 1`, which is a query
 * with a bug in it the moment two rows exist — and FAILS CLOSED when there is
 * none.
 *
 * Which version a mapping was REVIEWED against is a separate provenance fact,
 * carried on the row as `reviewed_product_type_definition_id` and never applied.
 * See {@link CatalogExternalMappingView.reviewedProductTypeDefinitionId}.
 */
export type CatalogExternalTarget =
  | { readonly dimension: 'product_type'; readonly productTypeKey: string }
  | { readonly dimension: 'attribute'; readonly attributeKey: string }
  | {
      readonly dimension: 'controlled_value';
      readonly attributeKey: string;
      /** The canonical, already-normalized value — an `attribute_enum_values.value`. */
      readonly controlledValue: string;
    }
  | {
      readonly dimension: 'unit';
      /**
       * The family, from the registry's own tuple rather than a free string —
       * so a mapping cannot name a unit in one family and a code from another,
       * and `catalog_external_mappings_unit_family_check` renders its CHECK from
       * the same list.
       */
      readonly unitFamily: UnitFamily;
      readonly unitCode: string;
    }
  | { readonly dimension: 'size_system'; readonly sizeSystemKey: string };

/** One resolved target plus the mapping that authorized it. */
export interface CatalogExternalResolvedTarget {
  readonly mappingId: string;
  readonly target: CatalogExternalTarget;
  readonly origin: CatalogExternalResolutionOrigin;
  /** The transform rule the mapping cites, applied to the raw value when one was given. */
  readonly transformRule: CatalogExternalTransformRule;
  readonly transformRuleVersion: number;
  /** The transformed value, when a raw value was supplied. */
  readonly normalizedValue?: string;
}

/**
 * The answer to "what does this source's token mean".
 *
 * THREE branches, and the third is the point. `fanned_out` is a reviewed
 * one-to-many: two named operators decided one external key legitimately covers
 * several Mercaria concepts. It is a separate branch rather than a `targets`
 * array on `resolved` because a caller written for the ordinary case would
 * otherwise take `targets[0]` and silently drop the rest, which is precisely the
 * silent fan-out the review exists to prevent. Here it is a compile error.
 */
export type CatalogExternalResolution =
  | { readonly outcome: 'resolved'; readonly resolved: CatalogExternalResolvedTarget }
  | {
      readonly outcome: 'fanned_out';
      /** At least two, each individually approved as a fan-out. */
      readonly resolved: readonly CatalogExternalResolvedTarget[];
    }
  | {
      readonly outcome: 'unresolved';
      readonly reason: CatalogExternalUnresolvedReason;
      /** Set when the refusal came from the transform rule rather than the mapping. */
      readonly transformRefusal?: CatalogExternalTransformRefusal;
    };

// ─── The review queue ────────────────────────────────────────────────────────

/** Why a person has to settle an external token. */
export const CATALOG_EXTERNAL_REVIEW_REASONS = [
  /** Nothing maps it. The ordinary reason, and the one that must never be guessed past. */
  'unmapped',
  /** Several plausible targets and no decision between them. */
  'ambiguous_candidates',
  /** A second target was proposed for a key that already resolves. */
  'fan_out_unapproved',
  /** The approved mapping names a Mercaria concept that no longer resolves. */
  'target_unresolvable',
  /** #94's `attribute_source_mappings` says something different from the governed mapping. */
  'legacy_disagreement',
  /** The cited transform rule refused this source's value. */
  'transform_refused',
  /** This dimension has no Mercaria-side registry in this deployment. */
  'registry_unavailable',
] as const;

/** One of {@link CATALOG_EXTERNAL_REVIEW_REASONS}. */
export type CatalogExternalReviewReason = (typeof CATALOG_EXTERNAL_REVIEW_REASONS)[number];

/**
 * A review row's state.
 *
 * `dismissed` is not `resolved`: an operator saying "this source publishes a
 * field we do not model and never will" is a different fact from "here is what
 * it maps to", and collapsing them would make the queue's throughput
 * indistinguishable from its abandonment rate.
 */
export const CATALOG_EXTERNAL_REVIEW_STATES = ['open', 'resolved', 'dismissed'] as const;

/** One of {@link CATALOG_EXTERNAL_REVIEW_STATES}. */
export type CatalogExternalReviewState = (typeof CATALOG_EXTERNAL_REVIEW_STATES)[number];

// ─── Observations and reprocessing ───────────────────────────────────────────

/** What carried an external token into Mercaria. */
export const CATALOG_EXTERNAL_SUBJECT_KINDS = [
  /** A `catalog_source_objects` row — the current state of one external object. */
  'catalog_source_object',
  /** A `source_records` row — one observation. */
  'source_record',
  /** An operator asking the resolver a question. Counted, never reprocessed. */
  'operator_probe',
] as const;

/** One of {@link CATALOG_EXTERNAL_SUBJECT_KINDS}. */
export type CatalogExternalSubjectKind = (typeof CATALOG_EXTERNAL_SUBJECT_KINDS)[number];

/**
 * Whether a reprocessing run may write.
 *
 * `mode` is part of the run's identity, not a parameter beside it — #60's
 * decision, for #60's reason: a dry run must never be able to overwrite the
 * record of the apply it predicted, or the prediction and the outcome become one
 * row and the comparison that justifies the whole mechanism is gone.
 */
export const CATALOG_EXTERNAL_REPROCESS_MODES = ['dry_run', 'apply'] as const;

/** One of {@link CATALOG_EXTERNAL_REPROCESS_MODES}. */
export type CatalogExternalReprocessMode = (typeof CATALOG_EXTERNAL_REPROCESS_MODES)[number];

/** A reprocessing run's lifecycle. */
export const CATALOG_EXTERNAL_REPROCESS_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
] as const;

/** One of {@link CATALOG_EXTERNAL_REPROCESS_STATES}. */
export type CatalogExternalReprocessState =
  (typeof CATALOG_EXTERNAL_REPROCESS_STATES)[number];

/**
 * What a run concluded about one subject. The six are EXHAUSTIVE and their sum
 * equals `scanned` — a CHECK, by equality rather than `<=`.
 *
 * #60's vacuity floor: a page that swallowed a subject cannot write a row that
 * balances, so "the run went fine" and "the run read nothing" stop looking
 * identical.
 */
export const CATALOG_EXTERNAL_REPROCESS_OUTCOMES = [
  /** Resolved to the same target it already had. */
  'unchanged',
  /** Resolved to a DIFFERENT target than it had. */
  'retargeted',
  /** Was unresolved and now resolves. */
  'newly_mapped',
  /** Resolved before and does not now. */
  'unmapped_now',
  /** The transform or the target refused it; a review row carries the detail. */
  'refused',
  /** Out of scope for this run — a different dimension, a different source. */
  'skipped',
] as const;

/** One of {@link CATALOG_EXTERNAL_REPROCESS_OUTCOMES}. */
export type CatalogExternalReprocessOutcome =
  (typeof CATALOG_EXTERNAL_REPROCESS_OUTCOMES)[number];

/**
 * How much of a preview's impact figure is actually MEASURED.
 *
 * #82's three-state rule applied to a count. `no_observations_recorded` is not
 * zero impact: it means nothing has yet asked this domain to resolve a token for
 * this source, so the honest answer to "what would this change" is that Mercaria
 * cannot say — and a preview that printed `0` there would be a confident number
 * computed off nothing, which is the failure the whole preview exists against.
 */
export const CATALOG_EXTERNAL_IMPACT_COVERAGES = [
  /** Observations exist for this source and dimension; the counts below are exact. */
  'measured',
  /** No observation has ever been recorded here. The counts are not zero, they are unknown. */
  'no_observations_recorded',
] as const;

/** One of {@link CATALOG_EXTERNAL_IMPACT_COVERAGES}. */
export type CatalogExternalImpactCoverage =
  (typeof CATALOG_EXTERNAL_IMPACT_COVERAGES)[number];

/**
 * What a candidate mapping would change, counted, before anybody applies it.
 *
 * Every field is a count over rows this domain owns, so every one of them is
 * exact when `coverage` is `measured`. Nothing here is estimated, extrapolated
 * or sampled: a preview that guessed would be a worse input to a decision than
 * no preview, because it would be believed.
 */
export interface CatalogExternalMappingImpact {
  readonly coverage: CatalogExternalImpactCoverage;
  /** Live approved mappings this candidate would supersede. */
  readonly supersededMappings: number;
  /** Live approved mappings for the same key pointing SOMEWHERE ELSE — a fan-out unless reviewed. */
  readonly conflictingMappings: number;
  /** Open review rows this candidate would answer. */
  readonly openReviewsAnswered: number;
  /** Recorded observations of this exact token, across every subject. */
  readonly observationsAffected: number;
  /** Of those, how many currently resolve to a DIFFERENT target. */
  readonly observationsRetargeted: number;
  /** Of those, how many currently do not resolve at all. */
  readonly observationsNewlyMapped: number;
  /** Whether the Mercaria concept this candidate names resolves right now. */
  readonly targetResolves: boolean;
  /** Set when the target does not resolve, so a reviewer sees why. */
  readonly targetUnresolvedReason?: CatalogExternalUnresolvedReason;
  /** True when approving this candidate requires a second operator (a fan-out). */
  readonly requiresFanOutApproval: boolean;
}

// ─── Projections ─────────────────────────────────────────────────────────────

/**
 * One mapping, as an operator surface reads it.
 *
 * The external side carries the source's own spelling and label verbatim; the
 * Mercaria side carries an id or a key and NEVER a name, a label or a slug —
 * ADR 0007 D1, held here by the absence of a field to put one in.
 */
export interface CatalogExternalMappingView {
  readonly id: string;
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  /** Verbatim, as the source spells it. */
  readonly externalKey: string;
  /** The lookup form. Derived from `externalKey` and never stored independently. */
  readonly externalKeyNormalized: string;
  /** The source's own display text for this token, when it published one. */
  readonly externalLabel?: string;
  /** The source's own path to this token, verbatim, outermost first. */
  readonly externalPath: readonly string[];
  readonly target: CatalogExternalTarget;
  /**
   * Which `product_type_definitions` VERSION this mapping was reviewed against.
   *
   * Provenance, never the resolution target: resolution reads the KEY and the
   * live published version (see {@link CatalogExternalTarget}). Recording the id
   * as well answers "what did the schema look like when somebody approved this",
   * which is the question a later correction actually asks — and stating that it
   * is never applied is what stops the two becoming a second answer to one
   * question.
   */
  readonly reviewedProductTypeDefinitionId?: string;
  readonly transformRule: CatalogExternalTransformRule;
  readonly transformRuleVersion: number;
  readonly version: number;
  readonly state: CatalogExternalMappingState;
  readonly provenance: CatalogExternalMappingProvenance;
  readonly confidence: number;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly approvedByOxyUserId?: string;
  readonly approvedAt?: string;
  /** Present exactly when this mapping is an approved fan-out from a shared key. */
  readonly fanOut?: {
    readonly approvedByOxyUserId: string;
    readonly approvedAt: string;
    readonly rationale: string;
  };
}

/** One open question about a source's token. */
export interface CatalogExternalReviewView {
  readonly id: string;
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  readonly externalKey: string;
  readonly externalLabel?: string;
  readonly externalPath: readonly string[];
  /** The source's value verbatim, before any transformation ran. */
  readonly observedRawValue?: string;
  readonly reason: CatalogExternalReviewReason;
  readonly state: CatalogExternalReviewState;
  readonly priority: number;
  readonly occurrences: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly candidateMappingIds: readonly string[];
  readonly summary: string;
}

/**
 * How the governed mappings and #94's `attribute_source_mappings` compare for
 * one source.
 *
 * Detection and repair are separate acts — the `payment_discrepancies` posture.
 * Nothing in this domain rewrites, deletes or migrates a legacy row; the report
 * counts, names the disagreements and stops.
 */
export interface CatalogExternalLegacyReconciliation {
  readonly catalogSourceId: string;
  /** Legacy rows with an approved governed mapping that agrees. */
  readonly agreeing: number;
  /** Legacy rows with no governed mapping at all — the migration backlog. */
  readonly legacyOnly: number;
  /** Governed mappings with no legacy row. Ordinary, and counted so the report is not one-sided. */
  readonly governedOnly: number;
  /** The ones that disagree, named. Each has an open review row. */
  readonly disagreements: readonly {
    readonly sourceField: string;
    readonly legacyAttributeKey: string;
    readonly governedAttributeKey: string;
    readonly governedMappingId: string;
  }[];
}
