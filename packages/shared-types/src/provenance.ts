/**
 * Provenance vocabulary for the canonical commerce graph (ADR 0002 D19, #53).
 *
 * Two tables sit under every canonical entity: `catalog_sources` — the registry
 * of places facts come from — and `source_records` — one observed external
 * object from one of them. Canonical rows own NOTHING about sources; the link
 * tables (`<entity>_source_links`) are downstream of both, which is what lets
 * either side be written, merged or superseded without touching the other.
 *
 * The tuples here are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — see
 * `db/schema/CONVENTIONS.md`). Every value is bound by ADR 0002; adding one is
 * an ADR amendment first, then a code change plus an additive migration.
 */

/**
 * What kind of place a fact came from.
 *
 * `operator` and `backfill` are deliberately sources like any other: provenance
 * is uniform, so every imported or minted fact traces to a `catalog_sources`
 * row with no "no source" special case (ADR 0002 D19).
 */
export type CatalogSourceKind =
  | 'connector'
  | 'feed'
  | 'marketplace_api'
  | 'affiliate_network'
  | 'operator'
  | 'backfill';

export const CATALOG_SOURCE_KINDS: readonly CatalogSourceKind[] = [
  'connector',
  'feed',
  'marketplace_api',
  'affiliate_network',
  'operator',
  'backfill',
];

/**
 * The type of the observed EXTERNAL object, in the source's own terms.
 *
 * This is the ADR-bound set. It describes what the source said it was looking
 * at, not which canonical entity a link later attached it to — a `brand`-typed
 * observation can legitimately end up linked to an organization when review
 * decides the source was describing the accountable actor.
 */
export type SourceRecordExternalType =
  | 'product'
  | 'offer'
  | 'merchant'
  | 'brand'
  | 'category'
  | 'relationship';

export const SOURCE_RECORD_EXTERNAL_TYPES: readonly SourceRecordExternalType[] = [
  'product',
  'offer',
  'merchant',
  'brand',
  'category',
  'relationship',
];

/**
 * How a source record was matched to a canonical entity (ADR 0002 D19).
 *
 * `match_rule` beside it names the explainable rule id; #58 owns the full rule
 * vocabulary. `deterministic_identifier` and `operator` links carry NULL
 * confidence — a number appears only on heuristic/machine-matched links.
 */
export type SourceLinkMethod =
  | 'deterministic_identifier'
  | 'connector_declared'
  | 'operator'
  | 'heuristic';

export const SOURCE_LINK_METHODS: readonly SourceLinkMethod[] = [
  'deterministic_identifier',
  'connector_declared',
  'operator',
  'heuristic',
];

/** The lifecycle of one source-record → entity link (ADR 0002 D19). */
export type SourceLinkStatus = 'active' | 'superseded' | 'rejected';

export const SOURCE_LINK_STATUSES: readonly SourceLinkStatus[] = [
  'active',
  'superseded',
  'rejected',
];

/**
 * The SAFE public projection of an entity's source freshness.
 *
 * Public read DTOs expose verified facts plus this — never source ids, internal
 * review notes, confidences or match rules (#53 API rule 2). It answers "how
 * fresh is what you are seeing", nothing else.
 */
export interface SourceFreshness {
  /** What kind of place the most recent observation came from. */
  sourceKind: CatalogSourceKind;
  /** ISO-8601 time of the most recent observation backing this entity. */
  observedAt: string;
  /** ISO-8601 time after which that observation should be considered stale. */
  staleAt?: string;
}
