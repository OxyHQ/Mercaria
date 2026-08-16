/**
 * `referral_earning_discrepancies` — what the reconciliation sweep found (#145,
 * ADR 0005's gate on this issue).
 *
 * The `payment_discrepancies` posture, ported: DETECTION and REPAIR are separate
 * acts, this table is the first and there is no second in this domain. Every
 * kind it can record is a decision about a financial record — a ledger posting
 * that never landed, a paid batch that booked nothing, a partner balance that is
 * negative without a liability to explain it — and an automatic repair for any
 * of them would book money nobody authorised.
 *
 * ## The upsert must not REOPEN a resolved row, and the predicate is why
 *
 * `recordEarningDiscrepancy` carries `setWhere: ne(status, 'resolved')`. Without
 * it, a sweep re-observing a finding an operator has already answered reopens
 * it — which is precisely the failure `payment_discrepancies` hit in the shared
 * test database, presenting in a SIBLING file as `expected 'open' to be
 * 'resolved'` and naming nothing about its cause.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReferralEarningDiscrepancyKind,
  ReferralEarningDiscrepancyStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralEarningDiscrepancies } from '../schema/referralEarnings.js';

/** A discrepancy row as the services read it back. */
export type ReferralEarningDiscrepancyRow = typeof referralEarningDiscrepancies.$inferSelect;

/**
 * The deterministic dedupe key of one finding — stated ONCE, here.
 *
 * Keyed on the SUBJECT and the kind, never on a clock or a sweep run: a
 * condition that is still true on the next pass is the same finding, and a key
 * carrying the run would pile up one row per pass until the table was the sweep's
 * log rather than its findings.
 */
export function referralEarningDiscrepancyKey(input: {
  kind: ReferralEarningDiscrepancyKind;
  subjectId: string;
  currency: CurrencyCode;
}): string {
  return `refdisc:${input.kind}:${input.subjectId}:${input.currency}`;
}

/** Everything a finding is born with. */
export interface RecordEarningDiscrepancyInput {
  kind: ReferralEarningDiscrepancyKind;
  subjectId: string;
  partnerId: string;
  rewardId?: string;
  payoutBatchId?: string;
  currency: CurrencyCode;
  expectedMinor: number;
  observedMinor: number;
  detail: string;
  observedAt: Date;
}

/**
 * Record a finding, converging on the row a previous pass already wrote.
 *
 * @returns the row as it now stands, and whether this pass CREATED it. A finding
 *   an operator has resolved is returned unchanged — its `last_seen_at` does not
 *   move either, deliberately: a resolved row whose timestamp keeps advancing
 *   reads as an unresolved one that somebody keeps re-observing.
 */
export async function recordEarningDiscrepancy(
  db: DatabaseOrTransaction,
  input: RecordEarningDiscrepancyInput,
): Promise<{ row: ReferralEarningDiscrepancyRow; created: boolean }> {
  const dedupeKey = referralEarningDiscrepancyKey({
    kind: input.kind,
    subjectId: input.subjectId,
    currency: input.currency,
  });

  const [upserted] = await db
    .insert(referralEarningDiscrepancies)
    .values({
      kind: input.kind,
      partnerId: input.partnerId,
      rewardId: input.rewardId ?? null,
      payoutBatchId: input.payoutBatchId ?? null,
      currency: input.currency,
      expectedMinor: input.expectedMinor,
      observedMinor: input.observedMinor,
      detail: input.detail,
      status: 'open',
      dedupeKey,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
    })
    .onConflictDoUpdate({
      target: referralEarningDiscrepancies.dedupeKey,
      set: {
        lastSeenAt: input.observedAt,
        expectedMinor: input.expectedMinor,
        observedMinor: input.observedMinor,
        detail: input.detail,
      },
      // See the docblock: a resolved finding is left exactly as the operator
      // left it.
      setWhere: ne(referralEarningDiscrepancies.status, 'resolved'),
    })
    .returning();

  if (upserted) {
    return { row: upserted, created: upserted.firstSeenAt.getTime() === input.observedAt.getTime() };
  }

  // The `setWhere` matched nothing, which means the row exists and is resolved.
  const [existing] = await db
    .select()
    .from(referralEarningDiscrepancies)
    .where(eq(referralEarningDiscrepancies.dedupeKey, dedupeKey));
  if (!existing) {
    throw new Error(
      `referral_earning_discrepancies upsert for ${dedupeKey} matched no row and could not be ` +
        'read back.',
    );
  }
  return { row: existing, created: false };
}

/** Move a finding to `acknowledged` or `resolved`, attributably. */
export async function transitionEarningDiscrepancy(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralEarningDiscrepancyStatus[];
    to: ReferralEarningDiscrepancyStatus;
    at: Date;
    actorOxyUserId: string;
    note: string;
  },
): Promise<ReferralEarningDiscrepancyRow | undefined> {
  const [row] = await db
    .update(referralEarningDiscrepancies)
    .set({
      status: input.to,
      ...(input.to === 'resolved'
        ? {
            resolvedAt: input.at,
            resolvedByOxyUserId: input.actorOxyUserId,
            resolutionNote: input.note,
          }
        : {}),
    })
    .where(
      and(
        eq(referralEarningDiscrepancies.id, input.id),
        inArray(referralEarningDiscrepancies.status, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/** Findings, newest activity first — the operator surface's list. */
export async function listEarningDiscrepancies(
  db: DatabaseOrTransaction,
  input: {
    statuses?: readonly ReferralEarningDiscrepancyStatus[];
    partnerId?: string;
    limit: number;
  },
): Promise<ReferralEarningDiscrepancyRow[]> {
  const filters = [
    ...(input.statuses && input.statuses.length > 0
      ? [inArray(referralEarningDiscrepancies.status, [...input.statuses])]
      : []),
    ...(input.partnerId ? [eq(referralEarningDiscrepancies.partnerId, input.partnerId)] : []),
  ];
  return await db
    .select()
    .from(referralEarningDiscrepancies)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(referralEarningDiscrepancies.lastSeenAt), asc(referralEarningDiscrepancies.id))
    .limit(input.limit);
}

/** How many findings are open, by kind — the operator metrics. */
export async function countOpenEarningDiscrepancies(
  db: DatabaseOrTransaction,
): Promise<{ kind: string; count: number }[]> {
  const rows = await db
    .select({
      kind: referralEarningDiscrepancies.kind,
      total: sql<string>`count(*)`,
    })
    .from(referralEarningDiscrepancies)
    .where(eq(referralEarningDiscrepancies.status, 'open'))
    .groupBy(referralEarningDiscrepancies.kind);
  // `count(*)` is `bigint`, which postgres.js hands back as a STRING.
  return rows.map((row) => ({ kind: row.kind, count: Number(row.total) }));
}
