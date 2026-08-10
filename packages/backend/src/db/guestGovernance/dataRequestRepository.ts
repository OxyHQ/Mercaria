/**
 * Guest export, deletion and minimization requests (#111 "Guest data export and
 * deletion").
 *
 * The row is the AUDIT of a request — requirement 8 — and holds nothing the
 * request was about. An export's payload is handed to the requester through the
 * credential that authorized it and is never stored, because a stored export is
 * a second copy of everything the request concerned, sitting in a table with a
 * longer retention than the data it duplicates.
 */

import { and, desc, eq } from 'drizzle-orm';
import type {
  GuestDataClass,
  GuestDataDisposition,
  GuestDataRequestKind,
  GuestDataRequestProof,
  GuestDataRequestState,
  GuestDataRetentionReason,
} from '@mercaria/shared-types';
import {
  guestDataClassDispositions,
  guestDataRequests,
} from '../schema/guestGovernance.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One class's outcome, as the caller supplies it. */
export interface ClassDispositionInput {
  readonly dataClass: GuestDataClass;
  readonly disposition: GuestDataDisposition;
  readonly retainedReason?: GuestDataRetentionReason;
  readonly affectedRowCount: number;
}

/**
 * Record a request and its per-class outcomes in ONE transaction.
 *
 * One transaction because the receipt and the evidence are two views of one
 * decision: a request row with no dispositions reads as a request nobody
 * answered, and dispositions with no request row are unattributable. The caller
 * passes a transaction handle; there is no root-connection overload,
 * deliberately, so a caller that forgot cannot compile.
 */
export async function recordDataRequest(
  tx: DatabaseOrTransaction,
  input: {
    checkoutGroupId: string;
    kind: GuestDataRequestKind;
    proof: GuestDataRequestProof;
    sourceGrantId?: string;
    requestedByOxyUserId?: string;
    state: GuestDataRequestState;
    dispositions: readonly ClassDispositionInput[];
    now: Date;
  },
): Promise<string> {
  const retained = input.dispositions.filter(
    (entry) => entry.disposition === 'retained_under_obligation',
  );
  const [row] = await tx
    .insert(guestDataRequests)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      kind: input.kind,
      proof: input.proof,
      ...(input.sourceGrantId === undefined ? {} : { sourceGrantId: input.sourceGrantId }),
      ...(input.requestedByOxyUserId === undefined
        ? {}
        : { requestedByOxyUserId: input.requestedByOxyUserId }),
      state: input.state,
      erasedClasses: input.dispositions
        .filter((entry) => entry.disposition === 'deleted' || entry.disposition === 'minimized')
        .map((entry) => entry.dataClass),
      retainedClasses: retained.map((entry) => entry.dataClass),
      // Positionally aligned with `retainedClasses` — the CHECK enforces equal
      // cardinality, and building both from ONE filtered array is what makes
      // the alignment structural rather than a convention two `.map()` calls
      // would have to keep in step.
      retainedReasons: retained.map((entry) => entry.retainedReason ?? 'financial_record'),
      ...(input.state === 'received' ? {} : { completedAt: input.now }),
    })
    .returning({ id: guestDataRequests.id });
  if (row === undefined) {
    throw new Error('guest_data_requests insert returned no row');
  }
  await tx.insert(guestDataClassDispositions).values(
    input.dispositions.map((entry) => ({
      requestId: row.id,
      dataClass: entry.dataClass,
      disposition: entry.disposition,
      ...(entry.retainedReason === undefined ? {} : { retainedReason: entry.retainedReason }),
      affectedRowCount: entry.affectedRowCount,
    })),
  );
  return row.id;
}

/** One request as the operator trace and the requester's receipt read it. */
export interface DataRequestRow {
  readonly id: string;
  readonly checkoutGroupId: string;
  readonly kind: GuestDataRequestKind;
  readonly proof: GuestDataRequestProof;
  readonly state: GuestDataRequestState;
  readonly erasedClasses: readonly string[];
  readonly retainedClasses: readonly string[];
  readonly retainedReasons: readonly string[];
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Every request for one checkout group, newest first.
 *
 * Opens from a GROUP and nothing else. There is no lookup by email, by hash or
 * by Oxy account, which is what stops this surface answering "what has this
 * inbox ever asked us to delete" — the same shape #108's trace has, for the
 * same reason.
 */
export async function listDataRequestsForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<readonly DataRequestRow[]> {
  const rows = await db
    .select()
    .from(guestDataRequests)
    .where(eq(guestDataRequests.checkoutGroupId, checkoutGroupId))
    .orderBy(desc(guestDataRequests.createdAt));
  return rows.map((row) => ({
    id: row.id,
    checkoutGroupId: row.checkoutGroupId,
    kind: row.kind as GuestDataRequestKind,
    proof: row.proof as GuestDataRequestProof,
    state: row.state as GuestDataRequestState,
    erasedClasses: row.erasedClasses,
    retainedClasses: row.retainedClasses,
    retainedReasons: row.retainedReasons,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  }));
}

/** Whether this group already has a completed request of one kind. */
export async function findCompletedRequest(
  db: DatabaseOrTransaction,
  input: { checkoutGroupId: string; kind: GuestDataRequestKind },
): Promise<DataRequestRow | null> {
  const [row] = await db
    .select()
    .from(guestDataRequests)
    .where(
      and(
        eq(guestDataRequests.checkoutGroupId, input.checkoutGroupId),
        eq(guestDataRequests.kind, input.kind),
        eq(guestDataRequests.state, 'completed'),
      ),
    )
    .orderBy(desc(guestDataRequests.createdAt))
    .limit(1);
  return row === undefined
    ? null
    : {
        id: row.id,
        checkoutGroupId: row.checkoutGroupId,
        kind: row.kind as GuestDataRequestKind,
        proof: row.proof as GuestDataRequestProof,
        state: row.state as GuestDataRequestState,
        erasedClasses: row.erasedClasses,
        retainedClasses: row.retainedClasses,
        retainedReasons: row.retainedReasons,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
      };
}
