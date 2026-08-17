/**
 * Change requests and their impact counts (#367 Workstream 12).
 *
 * Every mutating function takes a `DatabaseOrTransaction` and opens none of its
 * own: a plan is ONE transaction — the request row, its N impact rows and the
 * `change_requested` audit event — and a repository opening a second connection
 * would commit part of it, and on a row the outer transaction has locked would
 * deadlock against itself the way #59's merge runner did.
 *
 * ## The state move is a compare-and-swap, and the empty set IS the refusal
 *
 * Two operators opening the same queue and both pressing Approve is the
 * ordinary case. A read-then-write lets both through, the second silently
 * replacing the first's attribution on a request that may already have acted.
 * Nothing here throws on a lost CAS; the service turns `null` into a 409 naming
 * the state the row is actually in.
 *
 * ## `insertChangeRequest` is where the total is checked against its parts
 *
 * `impact_total = sum(child rows)` cannot be a CHECK — a CHECK may not contain
 * a subquery — so the equality is asserted here, in the single writer, before
 * the statement is issued. The relation COUNT is checked the same way and is
 * the load-bearing half: a sum over zeroes is satisfied by a read that found
 * nothing and by one that never ran, and only the row count can tell them
 * apart.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  CatalogGovernanceAction,
  CatalogGovernanceChangeState,
  CatalogGovernanceDomain,
  CatalogGovernanceImpactCoverage,
  CatalogGovernanceReferenceDisposition,
  CatalogGovernanceSubjectKind,
} from '@mercaria/shared-types';
import { conflict } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  catalogGovernanceChangeRequests,
  catalogGovernanceImpactCounts,
} from '../schema/catalogGovernance.js';

export type CatalogGovernanceChangeRequestRow =
  typeof catalogGovernanceChangeRequests.$inferSelect;
export type CatalogGovernanceImpactCountRow = typeof catalogGovernanceImpactCounts.$inferSelect;

/** One measured relation, as the plan hands it to the writer. */
export interface NewImpactCount {
  readonly referenceTable: string;
  readonly referenceColumn: string;
  readonly disposition: CatalogGovernanceReferenceDisposition;
  readonly rowCount: number;
}

/** Everything a new change request states. Nothing is defaulted that a caller could mean. */
export interface NewChangeRequest {
  readonly domain: CatalogGovernanceDomain;
  readonly action: CatalogGovernanceAction;
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly subjectId: string;
  readonly parameters: Record<string, unknown>;
  readonly reason: string;
  readonly requestedByOxyUserId: string;
  readonly requestedAt: Date;
  readonly requiresSecondApproval: boolean;
  readonly impactCoverage: CatalogGovernanceImpactCoverage;
  readonly impactRelationsDeclared: number | null;
  readonly impactMeasuredAt: Date | null;
  readonly impactUnmeasuredReason: string | null;
  /** Empty exactly when the coverage is `unmeasured`. */
  readonly counts: readonly NewImpactCount[];
}

/**
 * Write a plan and its measurements together.
 *
 * The caller must already be inside a transaction. Splitting these two writes
 * would allow a request row with no impact rows, which is the exact shape the
 * `apply` gate refuses — so it would present as a permanently unapplicable
 * request rather than as the write bug it is.
 */
export async function insertChangeRequest(
  db: DatabaseOrTransaction,
  input: NewChangeRequest,
): Promise<CatalogGovernanceChangeRequestRow> {
  const measured = input.impactCoverage === 'measured';

  if (measured) {
    // The row-count floor, checked before anything is written. A report with
    // fewer measurements than the plan declared measured less than it claims,
    // and the number an operator would read is the number that decides whether
    // a merge is safe.
    if (input.impactRelationsDeclared === null) {
      throw conflict('A measured impact report must state how many relations the plan declared.');
    }
    if (input.counts.length < input.impactRelationsDeclared) {
      throw conflict(
        `Impact measurement is incomplete: ${String(input.counts.length)} of ${String(
          input.impactRelationsDeclared,
        )} declared relations were counted. A partial count reads exactly like a small change.`,
      );
    }
    const keys = new Set(input.counts.map((entry) => `${entry.referenceTable}.${entry.referenceColumn}`));
    if (keys.size !== input.counts.length) {
      throw conflict('Impact measurement counted one relation twice, which doubles it into the total.');
    }
  } else if (input.counts.length > 0) {
    throw conflict('An unmeasured impact report cannot carry counts.');
  }

  const total = input.counts.reduce((sum, entry) => sum + entry.rowCount, 0);

  const [row] = await db
    .insert(catalogGovernanceChangeRequests)
    .values({
      domain: input.domain,
      action: input.action,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      parameters: input.parameters,
      reason: input.reason,
      requestedByOxyUserId: input.requestedByOxyUserId,
      requestedAt: input.requestedAt,
      requiresSecondApproval: input.requiresSecondApproval,
      state: 'planned',
      impactCoverage: input.impactCoverage,
      impactRelationsDeclared: measured ? input.impactRelationsDeclared : null,
      impactRelationsCounted: measured ? input.counts.length : null,
      impactTotal: measured ? total : null,
      impactMeasuredAt: measured ? input.impactMeasuredAt : null,
      impactUnmeasuredReason: measured ? null : input.impactUnmeasuredReason,
    })
    .returning();

  if (input.counts.length > 0) {
    await db.insert(catalogGovernanceImpactCounts).values(
      input.counts.map((entry) => ({
        changeRequestId: row.id,
        referenceTable: entry.referenceTable,
        referenceColumn: entry.referenceColumn,
        disposition: entry.disposition,
        rowCount: entry.rowCount,
      })),
    );
  }

  return row;
}

/** One request, or `null`. */
export async function findChangeRequest(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogGovernanceChangeRequestRow | null> {
  const [row] = await db
    .select()
    .from(catalogGovernanceChangeRequests)
    .where(eq(catalogGovernanceChangeRequests.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * One request with a row lock, for the approve/apply path.
 *
 * `FOR UPDATE` and not a bare read: the state CAS below is sufficient for
 * correctness, but the lock is what makes the LOSER of a race able to read the
 * winner's decision and report it, rather than failing on a constraint and
 * leaving an operator to guess what happened.
 */
export async function lockChangeRequest(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogGovernanceChangeRequestRow | null> {
  const [row] = await db
    .select()
    .from(catalogGovernanceChangeRequests)
    .where(eq(catalogGovernanceChangeRequests.id, id))
    .for('update')
    .limit(1);
  return row ?? null;
}

/** The measured relations behind one request. */
export async function listImpactCounts(
  db: DatabaseOrTransaction,
  changeRequestId: string,
): Promise<CatalogGovernanceImpactCountRow[]> {
  return db
    .select()
    .from(catalogGovernanceImpactCounts)
    .where(eq(catalogGovernanceImpactCounts.changeRequestId, changeRequestId))
    .orderBy(asc(catalogGovernanceImpactCounts.referenceTable), asc(catalogGovernanceImpactCounts.referenceColumn));
}

/** The measured relations behind several requests, for a queue read. */
export async function listImpactCountsForRequests(
  db: DatabaseOrTransaction,
  changeRequestIds: readonly string[],
): Promise<CatalogGovernanceImpactCountRow[]> {
  if (changeRequestIds.length === 0) return [];
  return db
    .select()
    .from(catalogGovernanceImpactCounts)
    .where(inArray(catalogGovernanceImpactCounts.changeRequestId, [...changeRequestIds]));
}

/** What a state move carries. */
export interface ChangeRequestTransition {
  readonly state: CatalogGovernanceChangeState;
  readonly approvedByOxyUserId?: string;
  readonly approvedAt?: Date;
  readonly appliedAt?: Date;
  readonly failureDetail?: string;
}

/**
 * Move a request, refusing a state it is no longer in.
 *
 * `null` means the CAS lost — the row was decided by somebody else between the
 * read and this statement. The service reads the row back and reports the state
 * it actually reached, because "somebody already applied this" and "this
 * request does not exist" are different answers.
 */
export async function transitionChangeRequest(
  db: DatabaseOrTransaction,
  id: string,
  expected: readonly CatalogGovernanceChangeState[],
  next: ChangeRequestTransition,
): Promise<CatalogGovernanceChangeRequestRow | null> {
  const [row] = await db
    .update(catalogGovernanceChangeRequests)
    .set({
      state: next.state,
      approvedByOxyUserId: next.approvedByOxyUserId ?? undefined,
      approvedAt: next.approvedAt ?? undefined,
      appliedAt: next.appliedAt ?? undefined,
      failureDetail: next.failureDetail ?? undefined,
    })
    .where(
      and(
        eq(catalogGovernanceChangeRequests.id, id),
        inArray(catalogGovernanceChangeRequests.state, [...expected]),
      ),
    )
    .returning();
  return row ?? null;
}

/** A queue filter. Every field narrows; omitting all of them reads everything. */
export interface ChangeRequestFilter {
  readonly states?: readonly CatalogGovernanceChangeState[];
  readonly domains?: readonly CatalogGovernanceDomain[];
  readonly subjectKind?: CatalogGovernanceSubjectKind;
  readonly subjectId?: string;
  readonly limit: number;
  readonly offset: number;
}

/** The operator queue, newest first. */
export async function listChangeRequests(
  db: DatabaseOrTransaction,
  filter: ChangeRequestFilter,
): Promise<CatalogGovernanceChangeRequestRow[]> {
  const predicates = [];
  if (filter.states && filter.states.length > 0) {
    predicates.push(inArray(catalogGovernanceChangeRequests.state, [...filter.states]));
  }
  if (filter.domains && filter.domains.length > 0) {
    predicates.push(inArray(catalogGovernanceChangeRequests.domain, [...filter.domains]));
  }
  if (filter.subjectKind) {
    predicates.push(eq(catalogGovernanceChangeRequests.subjectKind, filter.subjectKind));
  }
  if (filter.subjectId) {
    predicates.push(eq(catalogGovernanceChangeRequests.subjectId, filter.subjectId));
  }

  return db
    .select()
    .from(catalogGovernanceChangeRequests)
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(desc(catalogGovernanceChangeRequests.requestedAt))
    .limit(filter.limit)
    .offset(filter.offset);
}

/**
 * How many requests are waiting on somebody.
 *
 * Counted rather than derived from a page, so the depth is the real depth and
 * not "how many fitted on the first screen".
 */
export async function countOpenChangeRequests(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(catalogGovernanceChangeRequests)
    .where(inArray(catalogGovernanceChangeRequests.state, ['planned', 'approved']));
  return Number(row?.total ?? 0);
}

/**
 * Whether an open request already targets this subject.
 *
 * Not a unique index: two DIFFERENT changes to one category can legitimately be
 * planned at once (a rename and a redirect), and a database constraint would
 * refuse the second. What the service does with this is warn, in the plan
 * response, so an operator sees that somebody else is already mid-change on the
 * thing they are about to move.
 */
export async function listOpenRequestsForSubject(
  db: DatabaseOrTransaction,
  subjectKind: CatalogGovernanceSubjectKind,
  subjectId: string,
): Promise<CatalogGovernanceChangeRequestRow[]> {
  return db
    .select()
    .from(catalogGovernanceChangeRequests)
    .where(
      and(
        eq(catalogGovernanceChangeRequests.subjectKind, subjectKind),
        eq(catalogGovernanceChangeRequests.subjectId, subjectId),
        inArray(catalogGovernanceChangeRequests.state, ['planned', 'approved']),
        isNull(catalogGovernanceChangeRequests.appliedAt),
      ),
    )
    .orderBy(desc(catalogGovernanceChangeRequests.requestedAt));
}

/** Queue depth by state, for the data-quality dashboard. */
export async function countChangeRequestsByState(
  db: DatabaseOrTransaction,
): Promise<{ state: CatalogGovernanceChangeState; total: number }[]> {
  const rows = await db
    .select({ state: catalogGovernanceChangeRequests.state, total: count() })
    .from(catalogGovernanceChangeRequests)
    .groupBy(catalogGovernanceChangeRequests.state)
    .orderBy(sql`1`);
  return rows.map((row) => ({ state: row.state, total: Number(row.total) }));
}
