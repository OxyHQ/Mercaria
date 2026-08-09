/**
 * Reads and writes for `catalog_sources` and `source_records` (ADR 0002 D19/D22).
 *
 * `db` is the FIRST parameter everywhere, the payment-domain convention: a
 * helper typed only as `Database` would silently force its caller outside a
 * transaction, and every write here has callers that must be atomic with an
 * entity write (an observation and its link commit together or not at all).
 *
 * ## The insert IS the idempotency claim
 *
 * Both writers converge on natural uniques rather than deterministic uuids
 * (D22): `catalog_sources` on `name`, `source_records` on
 * `(source, external_type, external_id, content_hash)`. A replayed delivery, a
 * retried job or a re-run backfill batch is `ON CONFLICT DO NOTHING` — the
 * moderation-event pattern, where the empty RETURNING set IS the "already
 * there" answer and a real failure (dropped connection, pool exhaustion) still
 * propagates instead of being read as a duplicate.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  CatalogSourceKind,
  SourceRecordExternalType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';

/** A source-registry row as the services read it back. */
export type CatalogSourceRow = typeof catalogSources.$inferSelect;

/** An observation row as the services read it back. */
export type SourceRecordRow = typeof sourceRecords.$inferSelect;

export interface EnsureCatalogSourceInput {
  kind: CatalogSourceKind;
  name: string;
  connectionId?: string;
  mayDisplay: boolean;
  mayStore: boolean;
  attributionRequired: boolean;
  rightsNote?: string;
}

/**
 * Register a source, converging on `name`.
 *
 * A repeat with the same name returns the EXISTING row untouched — rights are
 * properties of the agreement with the source and a re-run of an ingestion loop
 * has no authority to rewrite them; changing rights is an explicit update by
 * whoever renegotiated the agreement.
 */
export async function ensureCatalogSource(
  db: DatabaseOrTransaction,
  input: EnsureCatalogSourceInput,
): Promise<CatalogSourceRow> {
  const inserted = await db
    .insert(catalogSources)
    .values({
      kind: input.kind,
      name: input.name,
      connectionId: input.connectionId ?? null,
      mayDisplay: input.mayDisplay,
      mayStore: input.mayStore,
      attributionRequired: input.attributionRequired,
      rightsNote: input.rightsNote ?? null,
    })
    .onConflictDoNothing({ target: catalogSources.name })
    .returning();

  if (inserted.length === 1 && inserted[0]) return inserted[0];

  const existing = await db
    .select()
    .from(catalogSources)
    .where(eq(catalogSources.name, input.name))
    .limit(1);
  const row = existing[0];
  if (!row) {
    // The insert conflicted, so the row existed — a read that then finds nothing
    // is a real failure (concurrent delete of a registry row), not a race to hide.
    throw new Error(`catalog_sources row '${input.name}' vanished between claim and read.`);
  }
  return row;
}

export async function findCatalogSourceById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogSourceRow | undefined> {
  const rows = await db.select().from(catalogSources).where(eq(catalogSources.id, id)).limit(1);
  return rows[0];
}

export async function findCatalogSourceByName(
  db: DatabaseOrTransaction,
  name: string,
): Promise<CatalogSourceRow | undefined> {
  const rows = await db.select().from(catalogSources).where(eq(catalogSources.name, name)).limit(1);
  return rows[0];
}

export interface RecordSourceObservationInput {
  sourceId: string;
  externalType: SourceRecordExternalType;
  externalId: string;
  observedAt: Date;
  staleAt?: Date;
  /** sha-256 hex of the normalized payload — computed by the service, stated once. */
  contentHash: string;
  /** Stored only when the source's `may_store` right allows it. */
  payload?: unknown;
}

export interface RecordSourceObservationResult {
  record: SourceRecordRow;
  /** `false` when identical content had already been observed — a genuine no-op. */
  inserted: boolean;
}

/**
 * Record one observation, converging on the content-hash identity.
 *
 * Identical content re-delivered writes NOTHING — no tuple churn, no timestamp
 * movement — and hands back the existing row. Changed content is a new row; the
 * sequence of rows is the observation history.
 */
export async function recordSourceObservation(
  db: DatabaseOrTransaction,
  input: RecordSourceObservationInput,
): Promise<RecordSourceObservationResult> {
  const inserted = await db
    .insert(sourceRecords)
    .values({
      sourceId: input.sourceId,
      externalType: input.externalType,
      externalId: input.externalId,
      observedAt: input.observedAt,
      staleAt: input.staleAt ?? null,
      contentHash: input.contentHash,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing({
      target: [
        sourceRecords.sourceId,
        sourceRecords.externalType,
        sourceRecords.externalId,
        sourceRecords.contentHash,
      ],
    })
    .returning();

  if (inserted.length === 1 && inserted[0]) return { record: inserted[0], inserted: true };

  const existing = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.sourceId, input.sourceId),
        eq(sourceRecords.externalType, input.externalType),
        eq(sourceRecords.externalId, input.externalId),
        eq(sourceRecords.contentHash, input.contentHash),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new Error(
      `source_records row for ${input.externalType}:${input.externalId} vanished between claim and read.`,
    );
  }
  return { record: row, inserted: false };
}

export async function findSourceRecordById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<SourceRecordRow | undefined> {
  const rows = await db.select().from(sourceRecords).where(eq(sourceRecords.id, id)).limit(1);
  return rows[0];
}

export async function findSourceRecordsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<SourceRecordRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(sourceRecords).where(inArray(sourceRecords.id, [...ids]));
}

/**
 * Every observation of one external object, newest first — the reverse-lookup
 * entry point: an entity is found FROM a source id by walking these rows'
 * links, whichever observation the link was made against.
 */
export async function listSourceRecordsForObject(
  db: DatabaseOrTransaction,
  sourceId: string,
  externalType: SourceRecordExternalType,
  externalId: string,
): Promise<SourceRecordRow[]> {
  return db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.sourceId, sourceId),
        eq(sourceRecords.externalType, externalType),
        eq(sourceRecords.externalId, externalId),
      ),
    )
    .orderBy(desc(sourceRecords.observedAt));
}

/** The most recent observation of one external object, by observation time. */
export async function findLatestSourceRecord(
  db: DatabaseOrTransaction,
  sourceId: string,
  externalType: SourceRecordExternalType,
  externalId: string,
): Promise<SourceRecordRow | undefined> {
  const rows = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.sourceId, sourceId),
        eq(sourceRecords.externalType, externalType),
        eq(sourceRecords.externalId, externalId),
      ),
    )
    .orderBy(desc(sourceRecords.observedAt))
    .limit(1);
  return rows[0];
}
