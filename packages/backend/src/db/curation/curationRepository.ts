/**
 * The audit timeline, the review queue and the suppression register (#59).
 *
 * Three tables, three access patterns, one file, because every one of them is a
 * small, closed set of statements whose whole job is to keep a property the
 * schema already enforces reachable from the service layer without a second
 * spelling of it.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type {
  CatalogRevisionAction,
  CatalogRevisionActorKind,
  CatalogSuppressibleType,
  CatalogSuppressionReason,
  CatalogSuppressionScope,
  CurationDetector,
  CurationReasonCode,
  CurationResolution,
  CurationReviewKind,
  CurationReviewState,
  CurationSubjectType,
} from '@mercaria/shared-types';
import { CURATION_ORDERED_PAIR_REVIEW_KINDS } from '../schema/curation.js';
import {
  catalogEntitySuppressions,
  catalogReviewItems,
  catalogRevisions,
  type CatalogEntitySuppressionRow,
  type CatalogReviewItemRow,
  type CatalogRevisionRow,
} from '../schema/curation.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

// ── The audit timeline ─────────────────────────────────────────────────────

export interface InsertRevisionInput {
  readonly entityType: CurationSubjectType;
  readonly entityId: string;
  readonly action: CatalogRevisionAction;
  readonly actorKind: CatalogRevisionActorKind;
  readonly actorOxyUserId: string | null;
  readonly reason: string;
  readonly note?: string | null;
  readonly sourceRecordId?: string | null;
  readonly policyVersionId?: string | null;
  readonly mergeJobId?: string | null;
  readonly splitJobId?: string | null;
  readonly reviewItemId?: string | null;
  readonly compensatesRevisionId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Append ONE revision.
 *
 * There is deliberately no update and no delete in this file: the trigger would
 * refuse them, and a function that exists only to raise an exception is an
 * invitation to try. A mistake is corrected by a COMPENSATING revision, which
 * is an ordinary insert naming the row it undoes.
 */
export async function insertRevision(
  input: InsertRevisionInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogRevisionRow> {
  const rows = await db
    .insert(catalogRevisions)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorKind: input.actorKind,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      note: input.note ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      policyVersionId: input.policyVersionId ?? null,
      mergeJobId: input.mergeJobId ?? null,
      splitJobId: input.splitJobId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      compensatesRevisionId: input.compensatesRevisionId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('catalog_revisions insert returned no row');
  }
  return row;
}

/** The timeline of one entity, newest first (#59 acceptance 4). */
export async function findRevisionsForEntity(
  entityType: CurationSubjectType,
  entityId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogRevisionRow[]> {
  return db
    .select()
    .from(catalogRevisions)
    .where(and(eq(catalogRevisions.entityType, entityType), eq(catalogRevisions.entityId, entityId)))
    .orderBy(desc(catalogRevisions.createdAt), desc(catalogRevisions.id))
    .limit(limit);
}

export async function findRevisionById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogRevisionRow | undefined> {
  const rows = await db.select().from(catalogRevisions).where(eq(catalogRevisions.id, id)).limit(1);
  return rows[0];
}

/** Every revision a job produced — the "what did this merge actually do" read. */
export async function findRevisionsForJob(
  job: { readonly mergeJobId?: string; readonly splitJobId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogRevisionRow[]> {
  const predicate = job.mergeJobId
    ? eq(catalogRevisions.mergeJobId, job.mergeJobId)
    : job.splitJobId
      ? eq(catalogRevisions.splitJobId, job.splitJobId)
      : undefined;
  if (!predicate) return [];
  return db
    .select()
    .from(catalogRevisions)
    .where(predicate)
    .orderBy(asc(catalogRevisions.createdAt));
}

/** Whether a revision has already been undone — the compensator's own lookup. */
export async function findCompensationFor(
  revisionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogRevisionRow | undefined> {
  const rows = await db
    .select()
    .from(catalogRevisions)
    .where(eq(catalogRevisions.compensatesRevisionId, revisionId))
    .limit(1);
  return rows[0];
}

// ── The review queue ───────────────────────────────────────────────────────

export interface UpsertReviewItemInput {
  readonly kind: CurationReviewKind;
  readonly detector: CurationDetector;
  readonly subjectType: CurationSubjectType;
  readonly subjectId: string;
  readonly counterpartType?: CurationSubjectType | null;
  readonly counterpartId?: string | null;
  readonly reasonCodes: readonly CurationReasonCode[];
  readonly confidence?: number | null;
  readonly matchDecisionId?: string | null;
  readonly policyVersionId?: string | null;
  readonly sourceRecordId?: string | null;
  readonly note?: string | null;
}

/**
 * Put a pair in the ORDER the schema requires, for the kinds that require one.
 *
 * `catalog_review_items_pair_order_check` refuses `(B, A)` for the duplicate
 * kinds, and this is the function that keeps a detector from tripping it: the
 * two ids describe one symmetric proposition, so which one a scan happened to
 * read first must not decide whether it converges with an existing item.
 */
function orderedPair(input: UpsertReviewItemInput): {
  subjectType: CurationSubjectType;
  subjectId: string;
  counterpartType: CurationSubjectType | null;
  counterpartId: string | null;
} {
  const counterpartId = input.counterpartId ?? null;
  const counterpartType = input.counterpartType ?? null;
  const ordered = (CURATION_ORDERED_PAIR_REVIEW_KINDS as readonly string[]).includes(input.kind);
  if (!ordered || counterpartId === null || counterpartType === null) {
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      counterpartType,
      counterpartId,
    };
  }
  return input.subjectId < counterpartId
    ? {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        counterpartType,
        counterpartId,
      }
    : {
        subjectType: counterpartType,
        subjectId: counterpartId,
        counterpartType: input.subjectType,
        counterpartId: input.subjectId,
      };
}

/**
 * Raise an item, or converge on the one already open for the same problem.
 *
 * `ON CONFLICT DO UPDATE` on the partial unique over `dedupe_key`, so the
 * arbiter's predicate is repeated verbatim — a partial unique that is not given
 * its own predicate is not inferable and Postgres refuses the statement outright
 * (the `carts` lesson, one domain over).
 *
 * The update deliberately bumps only `last_detected_at`, `detection_count` and
 * the explanation: an item somebody has CLAIMED must not lose its assignee
 * because a scan ran again, and its `first_detected_at` is what the inbox
 * orders by.
 */
export async function upsertReviewItem(
  input: UpsertReviewItemInput,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogReviewItemRow> {
  const pair = orderedPair(input);
  const rows = await db
    .insert(catalogReviewItems)
    .values({
      kind: input.kind,
      detector: input.detector,
      subjectType: pair.subjectType,
      subjectId: pair.subjectId,
      counterpartType: pair.counterpartType,
      counterpartId: pair.counterpartId,
      reasonCodes: [...input.reasonCodes],
      confidence: input.confidence ?? null,
      matchDecisionId: input.matchDecisionId ?? null,
      policyVersionId: input.policyVersionId ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      note: input.note ?? null,
      firstDetectedAt: now,
      lastDetectedAt: now,
    })
    .onConflictDoUpdate({
      target: catalogReviewItems.dedupeKey,
      targetWhere: inArray(catalogReviewItems.state, ['open', 'in_review']),
      set: {
        detectionCount: sql`${catalogReviewItems.detectionCount} + 1`,
        lastDetectedAt: now,
        reasonCodes: [...input.reasonCodes],
        confidence: input.confidence ?? null,
      },
    })
    .returning();
  const row = rows[0];
  if (row) return row;
  // The conflict landed on a row the partial index does not cover, which can
  // only happen if the item closed between the read and the write. Re-read the
  // open one rather than inventing a second: a closed item is history and a
  // recurrence is a NEW item, which the next detection produces.
  const existing = await findOpenReviewItem(
    input.kind,
    pair.subjectType,
    pair.subjectId,
    pair.counterpartId,
    db,
  );
  if (!existing) {
    throw new Error('review item upsert wrote nothing and found no open item to converge on');
  }
  return existing;
}

export async function findOpenReviewItem(
  kind: CurationReviewKind,
  subjectType: CurationSubjectType,
  subjectId: string,
  counterpartId: string | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogReviewItemRow | undefined> {
  const rows = await db
    .select()
    .from(catalogReviewItems)
    .where(
      and(
        eq(catalogReviewItems.kind, kind),
        eq(catalogReviewItems.subjectType, subjectType),
        eq(catalogReviewItems.subjectId, subjectId),
        counterpartId === null
          ? isNull(catalogReviewItems.counterpartId)
          : eq(catalogReviewItems.counterpartId, counterpartId),
        inArray(catalogReviewItems.state, ['open', 'in_review']),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function findReviewItemById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogReviewItemRow | undefined> {
  const rows = await db.select().from(catalogReviewItems).where(eq(catalogReviewItems.id, id)).limit(1);
  return rows[0];
}

export interface ReviewQueueFilter {
  readonly kind?: CurationReviewKind;
  readonly state?: CurationReviewState;
  readonly assignedToOxyUserId?: string;
  readonly limit: number;
}

/** The inbox. Oldest FIRST — the queue's age is what an operator is behind on. */
export async function listReviewItems(
  filter: ReviewQueueFilter,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogReviewItemRow[]> {
  const predicates: SQL[] = [];
  if (filter.kind) predicates.push(eq(catalogReviewItems.kind, filter.kind));
  if (filter.state) {
    predicates.push(eq(catalogReviewItems.state, filter.state));
  } else {
    predicates.push(inArray(catalogReviewItems.state, ['open', 'in_review']));
  }
  if (filter.assignedToOxyUserId) {
    predicates.push(eq(catalogReviewItems.assignedToOxyUserId, filter.assignedToOxyUserId));
  }
  return db
    .select()
    .from(catalogReviewItems)
    .where(and(...predicates))
    .orderBy(asc(catalogReviewItems.firstDetectedAt), asc(catalogReviewItems.id))
    .limit(filter.limit);
}

/**
 * Claim an item.
 *
 * A CAS on `state = 'open'`, so two operators opening the same item produce one
 * claim and one refusal rather than two people doing the same merge.
 */
export async function claimReviewItem(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogReviewItemRow | undefined> {
  const rows = await db
    .update(catalogReviewItems)
    .set({ state: 'in_review', assignedToOxyUserId: oxyUserId, assignedAt: now })
    .where(and(eq(catalogReviewItems.id, id), eq(catalogReviewItems.state, 'open')))
    .returning();
  return rows[0];
}

/** Hand an item back to the queue. The inverse CAS, on the claimant's own id. */
export async function releaseReviewItem(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogReviewItemRow | undefined> {
  const rows = await db
    .update(catalogReviewItems)
    .set({ state: 'open', assignedToOxyUserId: null, assignedAt: null })
    .where(
      and(
        eq(catalogReviewItems.id, id),
        eq(catalogReviewItems.state, 'in_review'),
        eq(catalogReviewItems.assignedToOxyUserId, oxyUserId),
      ),
    )
    .returning();
  return rows[0];
}

export interface CloseReviewItemInput {
  readonly id: string;
  readonly state: Extract<CurationReviewState, 'resolved' | 'dismissed'>;
  readonly resolution: CurationResolution;
  readonly resolutionReason: string;
  readonly resolvedByOxyUserId: string;
}

/**
 * Close an item.
 *
 * The CAS refuses a second close, so two operators finishing the same review
 * produce one closure — and the trigger refuses re-opening whatever anybody
 * writes afterwards.
 */
export async function closeReviewItem(
  input: CloseReviewItemInput,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogReviewItemRow | undefined> {
  const rows = await db
    .update(catalogReviewItems)
    .set({
      state: input.state,
      resolution: input.resolution,
      resolutionReason: input.resolutionReason,
      resolvedByOxyUserId: input.resolvedByOxyUserId,
      resolvedAt: now,
    })
    .where(
      and(eq(catalogReviewItems.id, input.id), inArray(catalogReviewItems.state, ['open', 'in_review'])),
    )
    .returning();
  return rows[0];
}

/** Queue health, in one round trip: depth per kind and the oldest open item. */
export async function summarizeReviewQueue(
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly { readonly kind: CurationReviewKind; readonly open: number; readonly oldestAgeSeconds: number | null }[]
> {
  const rows = await db
    .select({
      kind: catalogReviewItems.kind,
      open: sql<number>`count(*)::int`,
      oldestAgeSeconds: sql<
        number | null
      >`extract(epoch from (now() - min(${catalogReviewItems.firstDetectedAt})))::double precision`,
    })
    .from(catalogReviewItems)
    .where(inArray(catalogReviewItems.state, ['open', 'in_review']))
    .groupBy(catalogReviewItems.kind);
  return rows;
}

// ── Suppression ────────────────────────────────────────────────────────────

export interface SuppressEntityInput {
  readonly entityType: CatalogSuppressibleType;
  readonly entityId: string;
  readonly scope: CatalogSuppressionScope;
  readonly reason: CatalogSuppressionReason;
  readonly note: string | null;
  readonly suppressedByOxyUserId: string;
}

/**
 * Hide an entity, or converge on the suppression already covering it.
 *
 * `ON CONFLICT DO NOTHING` plus a read, the `guest_checkouts` shape: a second
 * suppression must not replace the first one's actor and reason, because the
 * first is who actually made the decision.
 */
export async function insertSuppression(
  input: SuppressEntityInput,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogEntitySuppressionRow> {
  await db
    .insert(catalogEntitySuppressions)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      scope: input.scope,
      reason: input.reason,
      note: input.note,
      suppressedByOxyUserId: input.suppressedByOxyUserId,
      suppressedAt: now,
    })
    .onConflictDoNothing();
  const existing = await findOpenSuppression(input.entityType, input.entityId, input.scope, db);
  if (!existing) {
    throw new Error('suppression insert wrote nothing and no open suppression was found');
  }
  return existing;
}

export async function findOpenSuppression(
  entityType: CatalogSuppressibleType,
  entityId: string,
  scope: CatalogSuppressionScope,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogEntitySuppressionRow | undefined> {
  const rows = await db
    .select()
    .from(catalogEntitySuppressions)
    .where(
      and(
        eq(catalogEntitySuppressions.entityType, entityType),
        eq(catalogEntitySuppressions.entityId, entityId),
        eq(catalogEntitySuppressions.scope, scope),
        isNull(catalogEntitySuppressions.liftedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Lift a suppression. Attributable and reasoned, or the CHECK refuses it. */
export async function liftSuppression(
  id: string,
  liftedByOxyUserId: string,
  liftReason: string,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<CatalogEntitySuppressionRow | undefined> {
  const rows = await db
    .update(catalogEntitySuppressions)
    .set({ liftedAt: now, liftedByOxyUserId, liftReason })
    .where(and(eq(catalogEntitySuppressions.id, id), isNull(catalogEntitySuppressions.liftedAt)))
    .returning();
  return rows[0];
}

/** Every suppression ever applied to one entity, newest first. */
export async function listSuppressionsForEntity(
  entityType: CatalogSuppressibleType,
  entityId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogEntitySuppressionRow[]> {
  return db
    .select()
    .from(catalogEntitySuppressions)
    .where(
      and(
        eq(catalogEntitySuppressions.entityType, entityType),
        eq(catalogEntitySuppressions.entityId, entityId),
      ),
    )
    .orderBy(desc(catalogEntitySuppressions.createdAt));
}

/**
 * The stale-claim sweep's own predicate — items claimed and abandoned.
 *
 * Exported for the dispatcher rather than inlined there, so "what counts as
 * abandoned" is one expression instead of one per caller.
 */
export function abandonedClaimPredicate(before: Date): SQL {
  return and(
    eq(catalogReviewItems.state, 'in_review'),
    lt(catalogReviewItems.assignedAt, before),
  ) as SQL;
}

/** Return abandoned claims to the queue, so a queue cannot silently stall. */
export async function releaseAbandonedClaims(
  before: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(catalogReviewItems)
    .set({ state: 'open', assignedToOxyUserId: null, assignedAt: null })
    .where(
      or(
        sql`${catalogReviewItems.id} in (
          select ${catalogReviewItems.id} from ${catalogReviewItems}
          where ${abandonedClaimPredicate(before)}
          limit ${limit}
        )`,
      ),
    )
    .returning({ id: catalogReviewItems.id });
  return rows.length;
}
