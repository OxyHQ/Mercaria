/**
 * Reads and writes for `catalog_source_objects` — the CURRENT fact about one
 * external object (#62 §"SourceRecord persistence" 10–13, §"PostgreSQL
 * concurrency" 1–3).
 *
 * ## The upsert is where "an older observation cannot overwrite a newer fact"
 * actually lives
 *
 * The `ON CONFLICT DO UPDATE … WHERE` predicate is the ordering rule, and an
 * out-of-order delivery makes it FALSE — so the statement writes nothing, the
 * `RETURNING` set is empty, and that empty set IS the answer, exactly as the
 * moderation-event claim reads its own. A legitimate replay is therefore quiet
 * rather than an error, and there is no read-then-write window for a concurrent
 * delivery to land in.
 *
 * The trigger `mercaria_catalog_source_object_monotonic` states the same rule at
 * the row, which is not redundant: the predicate protects this statement and
 * the trigger protects every other one, including a repair somebody writes in
 * `psql` at three in the morning during the incident that made them want to.
 *
 * ## The ordering key is `source_updated_at` when both sides have one
 *
 * A provider that publishes its own last-modified is telling you the order of
 * its own facts, and it is more reliable than when Mercaria happened to read
 * them — two workers reading two pages concurrently produce `observed_at`
 * values whose order says nothing. When either side lacks it, `observed_at` is
 * the only thing left and is used alone.
 */

import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type {
  CatalogSourceObjectState,
  CatalogSourceQuarantineReason,
  CatalogSourceRetirementKind,
  SourceRecordExternalType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { CATALOG_SOURCE_MAX_TEXT_LENGTH, catalogSourceObjects } from '../schema/ingestion.js';

export type CatalogSourceObjectRow = typeof catalogSourceObjects.$inferSelect;

/** How one delivery landed against the object's current fact. */
export type ObjectUpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale';

export interface UpsertSourceObjectInput {
  sourceId: string;
  externalType: SourceRecordExternalType;
  externalId: string;
  sourceRecordId: string;
  contentHash: string;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  staleAt: Date;
  price: { amount: number; currency: string } | null;
  now: Date;
}

export interface UpsertSourceObjectResult {
  readonly row: CatalogSourceObjectRow | undefined;
  readonly outcome: ObjectUpsertOutcome;
}

/**
 * Record one delivery against an object's current fact.
 *
 * `unchanged` still moves `last_seen_at` and `observation_count`: the source
 * MENTIONED the object, which is what the retirement sweep reads, and treating
 * an unchanged re-delivery as a no-op would retire everything a stable feed
 * publishes. Only the current-observation pointer and the content hash are held
 * back, through a `CASE` rather than a second statement, so a concurrent
 * changed delivery cannot be overwritten between the two.
 */
export async function upsertSourceObject(
  db: DatabaseOrTransaction,
  input: UpsertSourceObjectInput,
): Promise<UpsertSourceObjectResult> {
  // Advisory only: the predicate below is what actually decides, and this read
  // exists to classify the outcome for the run's counters. A concurrent writer
  // between the two is handled by the empty `RETURNING`, which re-classifies.
  const existing = await findSourceObject(db, input.sourceId, input.externalType, input.externalId);

  const changed = existing === undefined || existing.currentContentHash !== input.contentHash;

  const rows = await db
    .insert(catalogSourceObjects)
    .values({
      sourceId: input.sourceId,
      externalType: input.externalType,
      externalId: input.externalId,
      currentSourceRecordId: input.sourceRecordId,
      lastSuccessfulSourceRecordId: input.sourceRecordId,
      currentObservedAt: input.observedAt,
      currentSourceUpdatedAt: input.sourceUpdatedAt,
      currentContentHash: input.contentHash,
      firstObservedAt: input.observedAt,
      lastSeenAt: input.now,
      staleAt: input.staleAt,
      state: 'observed',
      observationCount: 1,
      lastPriceAmount: input.price?.amount ?? null,
      lastPriceCurrency: input.price?.currency ?? null,
    })
    .onConflictDoUpdate({
      target: [
        catalogSourceObjects.sourceId,
        catalogSourceObjects.externalType,
        catalogSourceObjects.externalId,
      ],
      set: {
        // The current-fact pointers move ONLY when the content actually
        // changed. An unchanged re-delivery keeps pointing at the observation
        // that established the fact, which is what makes "when was this price
        // first published" answerable after a year of identical refreshes.
        currentSourceRecordId: sql`case when excluded.current_content_hash
              is distinct from ${catalogSourceObjects.currentContentHash}
            then excluded.current_source_record_id
            else ${catalogSourceObjects.currentSourceRecordId} end`,
        currentContentHash: sql`excluded.current_content_hash`,
        currentObservedAt: sql`excluded.current_observed_at`,
        currentSourceUpdatedAt: sql`coalesce(excluded.current_source_updated_at,
            ${catalogSourceObjects.currentSourceUpdatedAt})`,
        lastSuccessfulSourceRecordId: sql`excluded.last_successful_source_record_id`,
        lastSeenAt: sql`excluded.last_seen_at`,
        staleAt: sql`excluded.stale_at`,
        observationCount: sql`${catalogSourceObjects.observationCount} + 1`,
        lastPriceAmount: sql`coalesce(excluded.last_price_amount, ${catalogSourceObjects.lastPriceAmount})`,
        lastPriceCurrency: sql`coalesce(excluded.last_price_currency, ${catalogSourceObjects.lastPriceCurrency})`,
        // A source that re-publishes a retired object revives it; a quarantined
        // one is NOT revived here, because the quarantine is a decision about
        // content and the same content arriving again does not answer it.
        // `releaseQuarantine` is the explicit path out.
        state: sql`case when ${catalogSourceObjects.state} = 'retired'
            then 'observed' else ${catalogSourceObjects.state} end`,
        retiredAt: sql`case when ${catalogSourceObjects.state} = 'retired'
            then null else ${catalogSourceObjects.retiredAt} end`,
      },
      /**
       * THE MONOTONICITY PREDICATE (issue concurrency 3).
       *
       * `>=` and not `>`: a source that re-delivers the same instant with new
       * content is converging, not going backwards, and refusing it would strand
       * every feed that stamps one timestamp across a whole batch. The
       * `source_updated_at` clause only bites when BOTH sides publish one —
       * comparing a value against a NULL yields NULL, which a `WHERE` treats as
       * false, so a source that starts publishing timestamps mid-life would
       * otherwise stop converging entirely.
       */
      setWhere: sql`excluded.current_observed_at >= ${catalogSourceObjects.currentObservedAt}
        and (
          ${catalogSourceObjects.currentSourceUpdatedAt} is null
          or excluded.current_source_updated_at is null
          or excluded.current_source_updated_at >= ${catalogSourceObjects.currentSourceUpdatedAt}
        )`,
    })
    .returning();

  const row = rows[0];
  if (!row) return { row: existing, outcome: 'stale' };
  if (existing === undefined) return { row, outcome: 'inserted' };
  return { row, outcome: changed ? 'updated' : 'unchanged' };
}

export async function findSourceObject(
  db: DatabaseOrTransaction,
  sourceId: string,
  externalType: SourceRecordExternalType,
  externalId: string,
): Promise<CatalogSourceObjectRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourceObjects)
    .where(
      and(
        eq(catalogSourceObjects.sourceId, sourceId),
        eq(catalogSourceObjects.externalType, externalType),
        eq(catalogSourceObjects.externalId, externalId),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function findSourceObjectById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogSourceObjectRow | undefined> {
  const rows = await db
    .select()
    .from(catalogSourceObjects)
    .where(eq(catalogSourceObjects.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Record where an object reached in the pipeline.
 *
 * `lastMatchDecisionId` is required for every state past `observed`, which the
 * `catalog_source_objects_decision_shape_check` enforces — so a service bug
 * cannot write `review_required` with nothing behind it, and the #59 review
 * queue is always reachable FROM the object.
 */
export async function setSourceObjectState(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    state: CatalogSourceObjectState;
    matchDecisionId?: string | null;
    offerId?: string | null;
  },
): Promise<void> {
  await db
    .update(catalogSourceObjects)
    .set({
      state: input.state,
      ...(input.matchDecisionId === undefined ? {} : { lastMatchDecisionId: input.matchDecisionId }),
      ...(input.offerId === undefined ? {} : { offerId: input.offerId }),
    })
    .where(eq(catalogSourceObjects.id, input.id));
}

/** Hold an object out of the pipeline, with a reason and a time. */
export async function quarantineSourceObject(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    reason: CatalogSourceQuarantineReason;
    detail: string | null;
    now: Date;
  },
): Promise<void> {
  await db
    .update(catalogSourceObjects)
    .set({
      state: 'quarantined',
      quarantineReason: input.reason,
      quarantinedAt: input.now,
      quarantineDetail:
        input.detail === null ? null : input.detail.slice(0, CATALOG_SOURCE_MAX_TEXT_LENGTH),
    })
    .where(eq(catalogSourceObjects.id, input.id));
}

/**
 * Let a quarantined object back into the pipeline.
 *
 * An explicit operator act rather than something the next delivery does, since
 * a quarantine is a decision about CONTENT and the same content arriving again
 * does not answer it. The state returns to `observed`, so the next run
 * re-examines it from the top.
 */
export async function releaseSourceObjectQuarantine(
  db: DatabaseOrTransaction,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceObjects)
    .set({ state: 'observed', quarantineReason: null, quarantinedAt: null, quarantineDetail: null })
    .where(and(eq(catalogSourceObjects.id, id), eq(catalogSourceObjects.state, 'quarantined')))
    .returning({ id: catalogSourceObjects.id });
  return rows.length === 1;
}

/**
 * Objects of one source that the current run did not mention.
 *
 * Bounded and read BEFORE anything is retired, so the caller can act on each
 * one and count them. `state <> 'retired'` keeps a second complete pass from
 * re-retiring what the first already did, which is what makes the retirement
 * step idempotent — and the count it reports honest rather than cumulative.
 *
 * The caller is `retireUnseen`, which is reached ONLY through
 * `mayRetireUnseen`. This function has no opinion about whether retiring is
 * allowed; asking it to would put the rule in two places.
 */
export async function listUnseenSourceObjects(
  db: DatabaseOrTransaction,
  input: { sourceId: string; seenSince: Date; limit: number },
): Promise<CatalogSourceObjectRow[]> {
  return db
    .select()
    .from(catalogSourceObjects)
    .where(
      and(
        eq(catalogSourceObjects.sourceId, input.sourceId),
        lt(catalogSourceObjects.lastSeenAt, input.seenSince),
        ne(catalogSourceObjects.state, 'retired'),
      ),
    )
    .orderBy(asc(catalogSourceObjects.lastSeenAt))
    .limit(input.limit);
}

/**
 * Stamp one object retired. The row, its history and its offer pointer stay.
 *
 * `kind` is REQUIRED, not defaulted, since #68:
 * `catalog_source_objects_retirement_evidence_check` is a biconditional, so a
 * caller that omitted it would fail the write rather than store a retirement
 * nobody can account for. The three kinds are genuinely different evidence —
 * see the column's docblock — and a default would make the commonest one look
 * like the answer to a question nobody asked.
 */
export async function retireSourceObject(
  db: DatabaseOrTransaction,
  input: { id: string; kind: CatalogSourceRetirementKind; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(catalogSourceObjects)
    .set({ state: 'retired', retiredAt: input.now, retirementKind: input.kind })
    .where(and(eq(catalogSourceObjects.id, input.id), ne(catalogSourceObjects.state, 'retired')))
    .returning({ id: catalogSourceObjects.id });
  return rows.length === 1;
}

/**
 * How many of one source's objects are NOT retired (#68 anomaly 1).
 *
 * The denominator the mass-disappearance detector divides by. Counted at the
 * moment a baseline is captured and STORED beside it, rather than read live at
 * detection time — a half-finished retirement sweep would otherwise shrink the
 * denominator between the two reads and make the share look smaller exactly
 * when a catalogue is vanishing.
 */
export async function countActiveSourceObjects(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogSourceObjects)
    .where(
      and(eq(catalogSourceObjects.sourceId, sourceId), ne(catalogSourceObjects.state, 'retired')),
    );
  return rows[0]?.total ?? 0;
}

/**
 * The objects one source names, by external id — what an explicit removal
 * resolves through (#68 acceptance 2).
 *
 * Batched, because a page can declare twenty removals and a lookup per removal
 * would make a deletion notice more expensive than the fetch that carried it.
 */
export async function findSourceObjectsByExternalIds(
  db: DatabaseOrTransaction,
  input: { sourceId: string; externalIds: readonly string[] },
): Promise<CatalogSourceObjectRow[]> {
  if (input.externalIds.length === 0) return [];
  return db
    .select()
    .from(catalogSourceObjects)
    .where(
      and(
        eq(catalogSourceObjects.sourceId, input.sourceId),
        inArray(catalogSourceObjects.externalId, [...input.externalIds]),
      ),
    );
}

/** One source's objects by state — the review backlog and quarantine board. */
export async function countSourceObjectsByState(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      state: catalogSourceObjects.state,
      total: sql<number>`count(*)::int`,
    })
    .from(catalogSourceObjects)
    .where(eq(catalogSourceObjects.sourceId, sourceId))
    .groupBy(catalogSourceObjects.state);
  const result: Record<string, number> = {};
  for (const row of rows) result[row.state] = row.total;
  return result;
}

/** How many of one source's objects are past their freshness deadline. */
export async function countStaleSourceObjects(
  db: DatabaseOrTransaction,
  sourceId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogSourceObjects)
    .where(
      and(
        eq(catalogSourceObjects.sourceId, sourceId),
        ne(catalogSourceObjects.state, 'retired'),
        lt(catalogSourceObjects.staleAt, now),
      ),
    );
  return rows[0]?.total ?? 0;
}

/** Every object of one source carrying an offer — the linkage read. */
export async function listSourceObjectsWithOffers(
  db: DatabaseOrTransaction,
  sourceId: string,
  limit: number,
): Promise<CatalogSourceObjectRow[]> {
  return db
    .select()
    .from(catalogSourceObjects)
    .where(and(eq(catalogSourceObjects.sourceId, sourceId), isNotNull(catalogSourceObjects.offerId)))
    .orderBy(asc(catalogSourceObjects.lastSeenAt))
    .limit(limit);
}
