/**
 * Proposal rows, their duplicate-scan evidence and their references
 * (#367 step 6, ADR 0007 D9).
 *
 * Every mutating function takes a `DatabaseOrTransaction` and opens none of its
 * own: an approval is ONE transaction (the decision, the minted value, its alias
 * and the review event), so a repository that opened a second connection would
 * commit half of it — and, on a table the outer transaction has locked, would
 * deadlock against itself the way #59's merge runner did.
 *
 * ## The state move is a compare-and-swap, and the empty set IS the refusal
 *
 * `transitionProposal` carries the expected state in its predicate. Two
 * operators opening the same queue item and both pressing Approve is the
 * ordinary case, not the exotic one, and a read-then-write lets both through —
 * the second silently overwriting the first's decision, reason and decider on a
 * row that has already minted a value. Nothing here throws on a lost CAS; the
 * service turns `null` into a 409 that names the state the row is actually in.
 */

import { and, asc, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type {
  CatalogProposalRejectionReason,
  CatalogProposalState,
  CatalogProposalType,
} from '@mercaria/shared-types';
import { CATALOG_PROPOSAL_OPEN_STATES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  catalogProposalDuplicateCandidates,
  catalogProposalReferences,
  catalogProposals,
  catalogReviewEvents,
} from '../schema/catalogProposals.js';

export type CatalogProposalRow = typeof catalogProposals.$inferSelect;
export type CatalogProposalDuplicateCandidateRow =
  typeof catalogProposalDuplicateCandidates.$inferSelect;
export type CatalogProposalReferenceRow = typeof catalogProposalReferences.$inferSelect;
export type CatalogReviewEventRow = typeof catalogReviewEvents.$inferSelect;

/** Everything a new proposal states. Nothing is defaulted that a caller could mean. */
export interface NewCatalogProposal {
  readonly type: CatalogProposalType;
  readonly origin: CatalogProposalRow['origin'];
  readonly storeId: string | null;
  readonly submittedByOxyUserId: string;
  readonly proposedLabel: string;
  readonly sourceLocale: string;
  readonly normalizedLabel: string;
  readonly searchLabel: string;
  readonly proposedDescription: string | null;
  readonly submitterNote: string | null;
  readonly categoryId: string | null;
  readonly productTypeDefinitionId: string | null;
  readonly attributeDefinitionId: string | null;
  readonly attributeDefinitionVersion: number | null;
  /** The scan's own positive control — the size of the set the detector read. */
  readonly duplicateScanPopulation: number;
  readonly duplicateScanCandidates: number;
  readonly duplicateScanAt: Date;
}

/**
 * Insert a proposal, converging on the open one for the same concept.
 *
 * `ON CONFLICT DO NOTHING` on `catalog_proposals_open_convergence_key` and an
 * EMPTY result when it fires: two merchants asking for the same colour in the
 * same second must land on ONE row, and the loser reads the winner back and adds
 * a reference to it. A read-then-write lets both see "no open proposal" and both
 * insert, which the index would then refuse with a 23505 the surface cannot
 * attribute.
 *
 * @returns the inserted row, or `undefined` when an open proposal already
 *   covers this concept.
 */
export async function insertProposal(
  db: DatabaseOrTransaction,
  input: NewCatalogProposal,
): Promise<CatalogProposalRow | undefined> {
  const rows = await db
    .insert(catalogProposals)
    .values({
      type: input.type,
      origin: input.origin,
      storeId: input.storeId,
      submittedByOxyUserId: input.submittedByOxyUserId,
      proposedLabel: input.proposedLabel,
      sourceLocale: input.sourceLocale,
      normalizedLabel: input.normalizedLabel,
      searchLabel: input.searchLabel,
      proposedDescription: input.proposedDescription,
      submitterNote: input.submitterNote,
      categoryId: input.categoryId,
      productTypeDefinitionId: input.productTypeDefinitionId,
      attributeDefinitionId: input.attributeDefinitionId,
      attributeDefinitionVersion: input.attributeDefinitionVersion,
      duplicateScanPopulation: input.duplicateScanPopulation,
      duplicateScanCandidates: input.duplicateScanCandidates,
      duplicateScanAt: input.duplicateScanAt,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

export async function findProposal(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogProposalRow | null> {
  const rows = await db.select().from(catalogProposals).where(eq(catalogProposals.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The OPEN proposal covering a concept, by the same key the unique index holds.
 *
 * The predicate is rendered from `CATALOG_PROPOSAL_OPEN_STATES`, the tuple the
 * index's own `WHERE` reads, so the lookup and the constraint cannot disagree
 * about what "open" means — which is the only way this read and the convergence
 * it feeds can stay the same question.
 */
export async function findOpenProposalByConvergenceKey(
  db: DatabaseOrTransaction,
  convergenceKey: string,
): Promise<CatalogProposalRow | null> {
  const rows = await db
    .select()
    .from(catalogProposals)
    .where(
      and(
        eq(catalogProposals.convergenceKey, convergenceKey),
        inArray(catalogProposals.state, [...CATALOG_PROPOSAL_OPEN_STATES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Lock a proposal for a decision. `FOR UPDATE`, so two operators queue. */
export async function lockProposal(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogProposalRow | null> {
  const rows = await db
    .select()
    .from(catalogProposals)
    .where(eq(catalogProposals.id, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** What a decision writes. Every field a state move may set, and no other. */
export interface ProposalTransition {
  readonly toState: CatalogProposalState;
  readonly decidedByOxyUserId?: string;
  readonly decidedAt?: Date;
  readonly decisionReason?: string;
  readonly rejectionReason?: CatalogProposalRejectionReason;
  readonly resolvedEntityId?: string;
  readonly redirectedToProposalId?: string;
  readonly deferredUntil?: Date | null;
}

/**
 * Move a proposal's state, conditional on it still being where the caller read
 * it.
 *
 * @returns the moved row, or `null` when the state moved underneath the caller.
 */
export async function transitionProposal(
  db: DatabaseOrTransaction,
  id: string,
  expectedState: CatalogProposalState,
  next: ProposalTransition,
): Promise<CatalogProposalRow | null> {
  const rows = await db
    .update(catalogProposals)
    .set({
      state: next.toState,
      ...(next.decidedByOxyUserId === undefined
        ? {}
        : { decidedByOxyUserId: next.decidedByOxyUserId }),
      ...(next.decidedAt === undefined ? {} : { decidedAt: next.decidedAt }),
      ...(next.decisionReason === undefined ? {} : { decisionReason: next.decisionReason }),
      ...(next.rejectionReason === undefined ? {} : { rejectionReason: next.rejectionReason }),
      ...(next.resolvedEntityId === undefined ? {} : { resolvedEntityId: next.resolvedEntityId }),
      ...(next.redirectedToProposalId === undefined
        ? {}
        : { redirectedToProposalId: next.redirectedToProposalId }),
      ...(next.deferredUntil === undefined ? {} : { deferredUntil: next.deferredUntil }),
    })
    .where(and(eq(catalogProposals.id, id), eq(catalogProposals.state, expectedState)))
    .returning();
  return rows[0] ?? null;
}

/** Filters the queue and the merchant feed share. */
export interface ProposalListFilter {
  readonly states?: readonly CatalogProposalState[];
  readonly types?: readonly CatalogProposalType[];
  readonly storeId?: string;
  readonly limit: number;
  readonly offset: number;
}

export async function listProposals(
  db: DatabaseOrTransaction,
  filter: ProposalListFilter,
): Promise<CatalogProposalRow[]> {
  const predicates = [
    ...(filter.states === undefined || filter.states.length === 0
      ? []
      : [inArray(catalogProposals.state, [...filter.states])]),
    ...(filter.types === undefined || filter.types.length === 0
      ? []
      : [inArray(catalogProposals.type, [...filter.types])]),
    ...(filter.storeId === undefined ? [] : [eq(catalogProposals.storeId, filter.storeId)]),
  ];
  const query = db.select().from(catalogProposals);
  return (predicates.length === 0 ? query : query.where(and(...predicates)))
    .orderBy(desc(catalogProposals.createdAt))
    .limit(filter.limit)
    .offset(filter.offset);
}

/**
 * How many proposals an account (or a store) has submitted since an instant.
 *
 * The DURABLE half of the rate limit (#83's device). "How many has this store
 * asked for today, across every ECS task" is not a question a per-IP bucket can
 * answer, and the per-IP bucket is the one thing an abusive integration does not
 * have to share.
 */
export async function countProposalsSince(
  db: DatabaseOrTransaction,
  axis: { readonly submittedByOxyUserId?: string; readonly storeId?: string },
  since: Date,
): Promise<number> {
  const predicates = [
    gte(catalogProposals.createdAt, since),
    ...(axis.submittedByOxyUserId === undefined
      ? []
      : [eq(catalogProposals.submittedByOxyUserId, axis.submittedByOxyUserId)]),
    ...(axis.storeId === undefined ? [] : [eq(catalogProposals.storeId, axis.storeId)]),
  ];
  const rows = await db
    .select({ total: count() })
    .from(catalogProposals)
    .where(and(...predicates));
  return rows[0]?.total ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Duplicate-scan evidence                                                     */
/* -------------------------------------------------------------------------- */

export interface NewDuplicateCandidate {
  readonly proposalId: string;
  readonly kind: CatalogProposalDuplicateCandidateRow['kind'];
  readonly detector: CatalogProposalDuplicateCandidateRow['detector'];
  readonly candidateRef: string;
  readonly candidateLabel: string;
  readonly similarity: number | null;
}

/** Record what a scan found. `DO NOTHING`, so a re-scan converges. */
export async function insertDuplicateCandidates(
  db: DatabaseOrTransaction,
  rows: readonly NewDuplicateCandidate[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(catalogProposalDuplicateCandidates)
    .values(
      rows.map((row) => ({
        proposalId: row.proposalId,
        kind: row.kind,
        detector: row.detector,
        candidateRef: row.candidateRef,
        candidateLabel: row.candidateLabel,
        similarity: row.similarity,
      })),
    )
    .onConflictDoNothing();
}

export async function listDuplicateCandidates(
  db: DatabaseOrTransaction,
  proposalId: string,
): Promise<CatalogProposalDuplicateCandidateRow[]> {
  return db
    .select()
    .from(catalogProposalDuplicateCandidates)
    .where(eq(catalogProposalDuplicateCandidates.proposalId, proposalId))
    .orderBy(
      desc(catalogProposalDuplicateCandidates.similarity),
      asc(catalogProposalDuplicateCandidates.createdAt),
    );
}

/* -------------------------------------------------------------------------- */
/* References — who is waiting                                                 */
/* -------------------------------------------------------------------------- */

export interface NewProposalReference {
  readonly proposalId: string;
  readonly kind: CatalogProposalReferenceRow['kind'];
  readonly draftId?: string;
  readonly draftValueId?: string;
  readonly listingClaimId?: string;
}

/**
 * Attach a waiting draft value or listing claim to a proposal.
 *
 * `ON CONFLICT DO NOTHING`, because a merchant saving the same form twice, a
 * retry and two tabs all mean one reference. The genuine no-op matters here for
 * the same reason it does in the moderation outbox: the backfill reads
 * `backfilled_at IS NULL`, and a conflict branch that wrote the same values back
 * would move `updated_at` on a row a pass may be holding.
 */
export async function insertProposalReference(
  db: DatabaseOrTransaction,
  input: NewProposalReference,
): Promise<CatalogProposalReferenceRow | undefined> {
  const rows = await db
    .insert(catalogProposalReferences)
    .values({
      proposalId: input.proposalId,
      kind: input.kind,
      draftId: input.draftId ?? null,
      draftValueId: input.draftValueId ?? null,
      listingClaimId: input.listingClaimId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

export async function listProposalReferences(
  db: DatabaseOrTransaction,
  proposalId: string,
): Promise<CatalogProposalReferenceRow[]> {
  return db
    .select()
    .from(catalogProposalReferences)
    .where(eq(catalogProposalReferences.proposalId, proposalId))
    .orderBy(asc(catalogProposalReferences.createdAt));
}

/** One page of the references a backfill still owes, oldest first. */
export async function listPendingProposalReferences(
  db: DatabaseOrTransaction,
  proposalId: string,
  limit: number,
): Promise<CatalogProposalReferenceRow[]> {
  return db
    .select()
    .from(catalogProposalReferences)
    .where(
      and(
        eq(catalogProposalReferences.proposalId, proposalId),
        isNull(catalogProposalReferences.backfilledAt),
      ),
    )
    .orderBy(asc(catalogProposalReferences.createdAt))
    .limit(limit);
}

/**
 * Claim a reference for this backfill pass.
 *
 * The compare-and-swap that makes the backfill idempotent: the EMPTY result set
 * IS the "already applied" answer. A read-then-write lets two operators pressing
 * the same repair both see NULL and both apply, which for a draft value means
 * two writes racing on one answer and for a listing claim means a resolution
 * stamped twice with two different instants.
 */
export async function claimProposalReferenceForBackfill(
  db: DatabaseOrTransaction,
  referenceId: string,
  at: Date,
): Promise<CatalogProposalReferenceRow | null> {
  const rows = await db
    .update(catalogProposalReferences)
    .set({ backfilledAt: at })
    .where(
      and(
        eq(catalogProposalReferences.id, referenceId),
        isNull(catalogProposalReferences.backfilledAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * The backfill's own counters, read from the POPULATION rather than from what a
 * pass happened to do.
 *
 * `total` is what makes `backfilled` mean anything: a pass reporting "0 applied,
 * 0 remaining" over a proposal nobody is waiting on and one over a proposal
 * whose work is finished are the same numbers, and only `total` tells them
 * apart.
 */
export async function readProposalReferenceCounters(
  db: DatabaseOrTransaction,
  proposalId: string,
): Promise<{ readonly total: number; readonly backfilled: number; readonly remaining: number }> {
  const rows = await db
    .select({
      total: count(),
      remaining: sql<number>`count(*) filter (where ${catalogProposalReferences.backfilledAt} is null)::int`,
    })
    .from(catalogProposalReferences)
    .where(eq(catalogProposalReferences.proposalId, proposalId));
  const total = rows[0]?.total ?? 0;
  const remaining = rows[0]?.remaining ?? 0;
  return { total, backfilled: total - remaining, remaining };
}

/**
 * The OPEN proposals a draft is waiting on.
 *
 * The publication gate's one read. It joins on the reference's `draft_id` and
 * filters the proposal's state through `CATALOG_PROPOSAL_OPEN_STATES` — the same
 * tuple the convergence index reads — so a draft whose proposal was answered
 * stops being blocked in the statement that answered it, with no sweep in
 * between.
 */
export async function listOpenProposalsBlockingDraft(
  db: DatabaseOrTransaction,
  draftId: string,
): Promise<{ readonly proposalId: string; readonly draftValueId: string | null }[]> {
  return db
    .select({
      proposalId: catalogProposals.id,
      draftValueId: catalogProposalReferences.draftValueId,
    })
    .from(catalogProposalReferences)
    .innerJoin(catalogProposals, eq(catalogProposals.id, catalogProposalReferences.proposalId))
    .where(
      and(
        eq(catalogProposalReferences.draftId, draftId),
        inArray(catalogProposals.state, [...CATALOG_PROPOSAL_OPEN_STATES]),
      ),
    )
    .orderBy(asc(catalogProposals.createdAt));
}

/* -------------------------------------------------------------------------- */
/* The append-only timeline                                                    */
/* -------------------------------------------------------------------------- */

export interface NewReviewEvent {
  readonly proposalId: string;
  readonly action: CatalogReviewEventRow['action'];
  readonly actorKind: CatalogReviewEventRow['actorKind'];
  readonly actorOxyUserId: string | null;
  readonly fromState: CatalogProposalState | null;
  readonly toState: CatalogProposalState | null;
  readonly reason: string | null;
  readonly at: Date;
}

/**
 * Append one review event.
 *
 * No conflict target and no upsert: `catalog_review_events` is a LOG, so two
 * identical actions a minute apart are two facts. The table is append-only by
 * trigger against UPDATE and DELETE, so nothing here can rewrite one either.
 */
export async function insertReviewEvent(
  db: DatabaseOrTransaction,
  input: NewReviewEvent,
): Promise<CatalogReviewEventRow> {
  const rows = await db
    .insert(catalogReviewEvents)
    .values({
      proposalId: input.proposalId,
      action: input.action,
      actorKind: input.actorKind,
      actorOxyUserId: input.actorOxyUserId,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      at: input.at,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    // Unreachable for a plain insert that did not raise, and the only honest
    // answer if it somehow were: an audit trail that silently did not record is
    // worse than a failure nobody can miss.
    throw new Error(`catalog_review_events: insert for proposal ${input.proposalId} returned no row.`);
  }
  return row;
}

export async function listReviewEvents(
  db: DatabaseOrTransaction,
  proposalId: string,
): Promise<CatalogReviewEventRow[]> {
  return db
    .select()
    .from(catalogReviewEvents)
    .where(eq(catalogReviewEvents.proposalId, proposalId))
    .orderBy(
      asc(catalogReviewEvents.at),
      // #775. `at` alone cannot separate two events written from one `now` in
      // one transaction, and the uuid v7 tiebreak below is not monotonic within
      // a millisecond — so this order was a coin flip that usually landed right,
      // in the operator timeline as much as in a test.
      //
      // `sequence` is NULL for every row written before it existed, and Postgres
      // sorts NULLS LAST under `asc`. Those rows therefore keep EXACTLY today's
      // ordering — by `id`, through the tiebreak that is still here for them —
      // rather than becoming more arbitrary than they already were.
      asc(catalogReviewEvents.sequence),
      asc(catalogReviewEvents.id),
    );
}
