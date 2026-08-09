/**
 * Canonical-graph provenance: `catalog_sources`, `source_records` (ADR 0002 D19).
 *
 * `catalog_sources` is the registry of places facts come from — connectors,
 * feeds, marketplace APIs, affiliate networks, AND operator entry and the
 * backfill, so provenance is uniform: every imported or minted fact traces to a
 * source row, with no "no source" special case. Rights (`may_display`,
 * `may_store`, `attribution_required`) live at this grain because they are
 * properties of the agreement with the source, not of one observation.
 *
 * `source_records` is one observed external object: payload, content hash,
 * observation time. A re-delivery of IDENTICAL content converges to a no-op on
 * the content-hash unique; changed content is a NEW row — the sequence of rows
 * IS the observation history, which is why rows are append-only (`created_at`
 * with no `updated_at`, the moderation `order_status_history` contract).
 *
 * Source records reference canonical entities ONLY through the
 * `<entity>_source_links` tables downstream of both (see
 * `canonicalSupport.ts`) — no canonical row carries a source id, and nothing
 * here names an entity.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { CATALOG_SOURCE_KINDS, SOURCE_RECORD_EXTERNAL_TYPES } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { connections } from './connectors';

/**
 * `catalog_sources` — the registry of places facts come from.
 *
 * `name` is unique so ensure-source operations converge on ONE row (ADR 0002
 * D22: deterministic convergence keys, not deterministic uuids) — the backfill
 * and every ingestion loop re-run against the same registry row instead of
 * minting a new source per run.
 *
 * ## The three rights columns become a PROJECTION once #62 configures a source
 *
 * They stay exactly what they were for a source with no ingestion config — an
 * `operator` or `backfill` source states its own coarse rights and nothing
 * derives them. For a source that HAS a `catalog_source_configs` row, they are
 * a projection of `resolveSourceRights(config, activePolicy)`, and the deferred
 * constraint trigger `mercaria_catalog_source_rights_agree` refuses any commit
 * in which they disagree with that derivation.
 *
 * That is not "one writer by convention": the constraint is on the VALUE, so a
 * service bug, a replay or a hand-written `UPDATE` in `psql` is refused just
 * the same. It is the `review_aggregates` → entity `rating` relationship (#76)
 * — one authority, one derivation, a projection nothing else may contradict —
 * and it is why the offer projection's existing read of `may_display` needed no
 * change when nine rights arrived.
 */
export const catalogSources = pgTable(
  'catalog_sources',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(CATALOG_SOURCE_KINDS) }).notNull(),
    name: text().notNull(),
    /**
     * Set when the source IS an existing connector connection. `restrict`: the
     * provenance registry must survive a connection's deletion — records citing
     * this source outlive the connection they came through.
     */
    connectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    /** Whether facts from this source may be shown to buyers at all. */
    mayDisplay: boolean().notNull(),
    /** Whether raw payloads from this source may be stored. */
    mayStore: boolean().notNull(),
    /** Whether displaying this source's facts requires naming the source. */
    attributionRequired: boolean().notNull(),
    rightsNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_sources_kind_check', t.kind, CATALOG_SOURCE_KINDS),
    uniqueIndex('catalog_sources_name_key').on(t.name),
  ],
);

/**
 * `source_records` — one observed external object from one source.
 *
 * The four-column unique is the idempotency claim (ADR 0002 D22): identical
 * content re-delivered is `ON CONFLICT DO NOTHING`, in the moderation-event
 * pattern where the empty RETURNING set IS the "already observed" answer.
 *
 * `payload` is the canonical legitimate `jsonb` (see the CONVENTIONS register):
 * source-shaped by definition — projecting it into columns would drop whatever
 * the source adds next. It is nullable because storage is a RIGHT
 * (`catalog_sources.may_store`), not a given; a record from a store-forbidden
 * source keeps its hash and its observation time with no payload.
 */
export const sourceRecords = pgTable(
  'source_records',
  {
    id: generatedId(),
    sourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    externalType: text({ enum: asEnumValues(SOURCE_RECORD_EXTERNAL_TYPES) }).notNull(),
    /** The source's own id for the observed object — a foreign system's key. */
    externalId: text().notNull(),
    /** When the source was READ — an observation time, not a row time. */
    observedAt: timestamptz().notNull(),
    /** When this observation should stop being trusted; swept by #68. */
    staleAt: timestamptz(),
    /** sha-256 hex of the normalized payload — the convergence key's fourth column. */
    contentHash: text().notNull(),
    payload: jsonb(),

    // ── #62's four additions: what the observation was READ UNDER ─────────────
    /**
     * The source's OWN "last modified", when it publishes one (#62 observation
     * 7).
     *
     * Distinct from `observed_at`, which is when Mercaria looked. A feed
     * re-delivered unchanged moves neither; a feed re-delivered with an older
     * `source_updated_at` than the current fact is a source publishing out of
     * order, and `catalog_source_objects` refuses to move backwards on it.
     */
    sourceUpdatedAt: timestamptz(),
    /**
     * sha-256 hex of the RAW provider payload (#62 observation 4).
     *
     * The raw payload itself is never stored — `payload` holds the normalized,
     * allow-listed projection — so this is what makes a stored observation
     * still traceable to the bytes that produced it: a provider replaying a
     * delivery can be shown to have sent identical bytes even though Mercaria
     * kept none of them.
     *
     * Nullable: every row written before #62, and every row from a writer that
     * has no raw payload at all (the operator and backfill sources).
     */
    rawPayloadDigest: text(),
    /**
     * The normalization ruleset version that produced `payload` (#62
     * observation 9). `NORMALIZATION_VERSION` in
     * `services/ingestion/normalization.ts` is the code constant, and it is a
     * constant rather than a table for `CATALOG_BACKFILL_MAPPING_VERSION`'s
     * reason: the mapping is a procedure, and a table would let somebody
     * publish a version whose rules nobody shipped.
     */
    normalizationVersion: integer(),
    /**
     * The rights version the observation was read under (#62 observation 8).
     *
     * The VERSION NUMBER and not a row id, deliberately: `catalog_source_policies`
     * lives in `ingestion.ts`, which imports this module, so a foreign key here
     * would close a module cycle drizzle-kit has no reason to survive. The pair
     * `(source_id, policy_version)` resolves it exactly, and the policy table's
     * own `UNIQUE(source_id, version)` is what makes that resolution total.
     */
    policyVersion: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('source_records_external_type_check', t.externalType, SOURCE_RECORD_EXTERNAL_TYPES),
    // A hash that is not 64 lowercase hex characters is not a sha-256 and would
    // silently disable the convergence unique for every row that carries it.
    check('source_records_content_hash_shape_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'source_records_raw_payload_digest_shape_check',
      sql`${t.rawPayloadDigest} is null or ${t.rawPayloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'source_records_normalization_version_check',
      sql`${t.normalizationVersion} is null or ${t.normalizationVersion} >= 1`,
    ),
    check(
      'source_records_policy_version_check',
      sql`${t.policyVersion} is null or ${t.policyVersion} >= 1`,
    ),
    uniqueIndex('source_records_identity_key').on(
      t.sourceId,
      t.externalType,
      t.externalId,
      t.contentHash,
    ),
    // The observation history of one external object, newest first — what the
    // latest-observation read and the reverse lookup from a source id both walk.
    index('source_records_source_object_observed_at_idx').on(
      t.sourceId,
      t.externalType,
      t.externalId,
      t.observedAt.desc(),
    ),
  ],
);
