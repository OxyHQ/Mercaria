/**
 * `payment_discrepancies` — recording, listing and closing what reconciliation
 * found.
 *
 * ## The record is an UPSERT, and nothing here is a read-then-write
 *
 * A sweep sees an unresolved problem on every run, so the write below has to be
 * "note this, again" rather than "insert if absent". `on conflict (kind,
 * correlation_key) do update` makes that one statement: two tasks recording the
 * same finding concurrently produce one row with `occurrences = 2`, and neither
 * has to have seen the other's insert.
 *
 * A read-then-write would be wrong twice over — it would race (two tasks both
 * read "absent" and both insert, one crashing on the unique index) and it would
 * cost a round trip per finding on a job whose whole budget is a bounded number
 * of them.
 *
 * ## A repeat REOPENS a resolved row, and that is not a lost audit trail
 *
 * If the sweep sees a discrepancy somebody marked resolved, the resolution did
 * not hold, and a queue that kept it hidden would be a queue that lies. So the
 * upsert clears the resolution fields and puts the row back to `open`.
 *
 * Nothing is lost by that: `payment_repairs` is append-only and keeps every
 * attempt with its actor and reason, so the history lives in the table that
 * exists for history rather than in four columns on a row whose whole job is to
 * say what is true NOW.
 */

import { and, asc, count, desc, eq, gte, inArray, lte, min, sql } from 'drizzle-orm';
import type {
  PaymentDiscrepancyKind,
  PaymentDiscrepancySeverity,
  PaymentDiscrepancyStatus,
  PaymentProviderId,
} from '@mercaria/shared-types';
import { paymentDiscrepancies } from '../schema/reconciliation.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `payment_discrepancies`. */
export type PaymentDiscrepancyRow = typeof paymentDiscrepancies.$inferSelect;

/** What a detector reports. */
export interface RecordDiscrepancyInput {
  kind: PaymentDiscrepancyKind;
  severity: PaymentDiscrepancySeverity;
  provider: PaymentProviderId;
  /**
   * What makes this finding THIS finding, within its kind — composed from
   * durable ids only. A timestamp or a run id here would make every sighting
   * unique and defeat the dedupe index silently.
   */
  correlationKey: string;
  paymentId?: string;
  orderId?: string;
  checkoutGroupId?: string;
  providerObjectId?: string;
  /** The figures behind the finding. Mercaria's own ids and amounts, never a payload. */
  detail: Record<string, unknown>;
  now?: Date;
}

/**
 * Record a finding, or note that an existing one is still true.
 *
 * @returns The row as it now stands, and whether this call CREATED it. The
 *   second is what a caller logs on — a new critical discrepancy is news and the
 *   four-hundredth sighting of the same one is not.
 */
export async function recordDiscrepancy(
  db: DatabaseOrTransaction,
  input: RecordDiscrepancyInput,
): Promise<{ row: PaymentDiscrepancyRow; created: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(paymentDiscrepancies)
    .values({
      kind: input.kind,
      severity: input.severity,
      provider: input.provider,
      correlationKey: input.correlationKey,
      detail: input.detail,
      firstSeenAt: now,
      lastSeenAt: now,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.checkoutGroupId ? { checkoutGroupId: input.checkoutGroupId } : {}),
      ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
    })
    .onConflictDoUpdate({
      target: [paymentDiscrepancies.kind, paymentDiscrepancies.correlationKey],
      set: {
        // The freshest figures win: an amount mismatch that has grown is the
        // same finding with a worse number, and showing the first one forever
        // would send an operator to reconcile a difference that has moved.
        detail: input.detail,
        severity: input.severity,
        lastSeenAt: now,
        occurrences: sql`${paymentDiscrepancies.occurrences} + 1`,
        // Back to open, and the resolution cleared — see the file docblock.
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        resolvedReason: null,
        resolutionNote: null,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) {
    // `insert … on conflict do update … returning` returns a row in both
    // branches, so this is unreachable — and it is checked rather than asserted
    // because `!` is banned and a silent `undefined` in a financial detector
    // would surface as a discrepancy that was never recorded.
    throw new Error(
      `Recording a '${input.kind}' discrepancy for '${input.correlationKey}' returned no row.`,
    );
  }
  // A conflict always increments, so a returned row still on 1 can only be the
  // insert branch. Reading it off the row rather than off a second query is what
  // makes "created" free — and comparing timestamps instead would depend on a
  // `timestamptz` round trip preserving a millisecond it has no reason to.
  return { row, created: row.occurrences === 1 };
}

/**
 * Resolve or acknowledge a discrepancy, naming who decided and why.
 *
 * `acknowledged` deliberately shares this path with `resolved` even though it
 * writes no resolution: an operator who has read a row and decided it needs
 * watching has made a decision with an actor and a reason, and the alternative
 * is a queue that can only be quietened by resolving things that are not
 * resolved.
 *
 * @returns The updated row, or `undefined` when no such discrepancy exists.
 */
export async function closeDiscrepancy(
  db: DatabaseOrTransaction,
  input: {
    discrepancyId: string;
    status: Extract<PaymentDiscrepancyStatus, 'acknowledged' | 'resolved'>;
    actorOxyUserId: string;
    reason: string;
    note?: string;
    now?: Date;
  },
): Promise<PaymentDiscrepancyRow | undefined> {
  const now = input.now ?? new Date();
  const resolved = input.status === 'resolved';
  const [row] = await db
    .update(paymentDiscrepancies)
    .set({
      status: input.status,
      // The CHECK pins these three to the `resolved` status, so acknowledging
      // has to CLEAR them rather than leave a previous resolution behind — an
      // acknowledged row carrying a resolver would be a row that says it was
      // both dealt with and not.
      resolvedAt: resolved ? now : null,
      resolvedBy: resolved ? input.actorOxyUserId : null,
      resolvedReason: resolved ? input.reason : null,
      resolutionNote: input.note ?? null,
      updatedAt: now,
    })
    .where(eq(paymentDiscrepancies.id, input.discrepancyId))
    .returning();
  return row;
}

/** One discrepancy by id. */
export async function findDiscrepancyById(
  db: DatabaseOrTransaction,
  discrepancyId: string,
): Promise<PaymentDiscrepancyRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentDiscrepancies)
    .where(eq(paymentDiscrepancies.id, discrepancyId))
    .limit(1);
  return row;
}

/** How the operator queue is filtered. Every field narrows; none widens. */
export interface DiscrepancyQuery {
  status?: readonly PaymentDiscrepancyStatus[];
  kind?: readonly PaymentDiscrepancyKind[];
  severity?: readonly PaymentDiscrepancySeverity[];
  paymentId?: string;
  orderId?: string;
  limit?: number;
}

/** Never return more than this, whatever a caller asks for. */
const MAX_DISCREPANCY_PAGE = 200;

/**
 * The operator queue: what is outstanding, most recently seen first.
 *
 * Ordered by `last_seen_at` rather than `first_seen_at` deliberately — a problem
 * that is still happening is more urgent than an older one that has stopped, and
 * `first_seen_at` is on the row for whoever needs to know how long it has run.
 */
export async function listDiscrepancies(
  db: DatabaseOrTransaction,
  query: DiscrepancyQuery = {},
): Promise<PaymentDiscrepancyRow[]> {
  const filters = [
    ...(query.status && query.status.length > 0
      ? [inArray(paymentDiscrepancies.status, [...query.status])]
      : []),
    ...(query.kind && query.kind.length > 0
      ? [inArray(paymentDiscrepancies.kind, [...query.kind])]
      : []),
    ...(query.severity && query.severity.length > 0
      ? [inArray(paymentDiscrepancies.severity, [...query.severity])]
      : []),
    ...(query.paymentId ? [eq(paymentDiscrepancies.paymentId, query.paymentId)] : []),
    ...(query.orderId ? [eq(paymentDiscrepancies.orderId, query.orderId)] : []),
  ];

  return await db
    .select()
    .from(paymentDiscrepancies)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(paymentDiscrepancies.lastSeenAt))
    .limit(Math.min(Math.max(1, query.limit ?? 50), MAX_DISCREPANCY_PAGE));
}

/** Every discrepancy naming one payment, newest sighting first. */
export async function listDiscrepanciesForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
  limit = 50,
): Promise<PaymentDiscrepancyRow[]> {
  return await db
    .select()
    .from(paymentDiscrepancies)
    .where(eq(paymentDiscrepancies.paymentId, paymentId))
    .orderBy(desc(paymentDiscrepancies.lastSeenAt))
    .limit(Math.min(Math.max(1, limit), MAX_DISCREPANCY_PAGE));
}

/** The shape the metrics endpoint reports, and `/health` a subset of. */
export interface DiscrepancyStats {
  /** Everything not `resolved`, by kind. Kinds with no open rows are absent. */
  openByKind: Record<string, number>;
  /** Everything not `resolved`, by severity. */
  openBySeverity: Record<string, number>;
  open: number;
  critical: number;
  /**
   * When the OLDEST outstanding discrepancy was first seen — the age issue #50's
   * metric 5 asks for. `first_seen_at`, not `last_seen_at`: the question is how
   * long something has been wrong, and the most recent sighting of a month-old
   * problem is minutes ago.
   */
  oldestOpenAt: string | null;
}

/**
 * Count what is outstanding, in one pass.
 *
 * Three aggregates over the same partial index rather than three queries: the
 * open set is small by construction, and if it is not, that IS the alert.
 */
export async function discrepancyStats(db: DatabaseOrTransaction): Promise<DiscrepancyStats> {
  const outstanding = inArray(paymentDiscrepancies.status, ['open', 'acknowledged']);

  const [byKind, bySeverity, oldest] = await Promise.all([
    db
      .select({ kind: paymentDiscrepancies.kind, total: count() })
      .from(paymentDiscrepancies)
      .where(outstanding)
      .groupBy(paymentDiscrepancies.kind),
    db
      .select({ severity: paymentDiscrepancies.severity, total: count() })
      .from(paymentDiscrepancies)
      .where(outstanding)
      .groupBy(paymentDiscrepancies.severity),
    db
      .select({ oldest: min(paymentDiscrepancies.firstSeenAt) })
      .from(paymentDiscrepancies)
      .where(outstanding),
  ]);

  const openByKind: Record<string, number> = {};
  let open = 0;
  for (const row of byKind) {
    openByKind[row.kind] = row.total;
    open += row.total;
  }

  const openBySeverity: Record<string, number> = {};
  for (const row of bySeverity) {
    openBySeverity[row.severity] = row.total;
  }

  const oldestOpenAt = oldest[0]?.oldest ?? null;
  return {
    openByKind,
    openBySeverity,
    open,
    critical: openBySeverity.critical ?? 0,
    // `min()` over a `timestamptz` comes back as a Date through drizzle's own
    // mapper; the string form is what the JSON surface carries.
    oldestOpenAt: oldestOpenAt instanceof Date ? oldestOpenAt.toISOString() : oldestOpenAt,
  };
}

/**
 * Discrepancies of one kind, first seen inside a window.
 *
 * Only the reconciliation sweeps use this, to decide whether a condition they
 * have just re-derived was already known — which the upsert would answer anyway.
 * It exists for the ledger audit, which has to ask the opposite question: which
 * previously-recorded imbalances no longer hold, so it can resolve them itself
 * rather than leaving an operator to close rows the system has already fixed.
 */
export async function listDiscrepanciesOfKind(
  db: DatabaseOrTransaction,
  input: {
    kind: PaymentDiscrepancyKind;
    status?: readonly PaymentDiscrepancyStatus[];
    seenSince?: Date;
    seenBefore?: Date;
    limit?: number;
  },
): Promise<PaymentDiscrepancyRow[]> {
  const filters = [
    eq(paymentDiscrepancies.kind, input.kind),
    ...(input.status && input.status.length > 0
      ? [inArray(paymentDiscrepancies.status, [...input.status])]
      : []),
    ...(input.seenSince ? [gte(paymentDiscrepancies.lastSeenAt, input.seenSince)] : []),
    ...(input.seenBefore ? [lte(paymentDiscrepancies.lastSeenAt, input.seenBefore)] : []),
  ];
  return await db
    .select()
    .from(paymentDiscrepancies)
    .where(and(...filters))
    .orderBy(asc(paymentDiscrepancies.firstSeenAt))
    .limit(Math.min(Math.max(1, input.limit ?? 100), MAX_DISCREPANCY_PAGE));
}

/**
 * Close a discrepancy the SYSTEM has satisfied itself no longer holds.
 *
 * Distinct from `closeDiscrepancy` in exactly one way that matters: the actor is
 * a machine, so the reason is a code rather than prose and the caller cannot
 * supply one. Sharing the operator path would put `resolvedBy: 'system'` into a
 * column an audit reads as a person.
 *
 * Only ever called with evidence the condition is gone — a live provider read
 * that converged, or an aggregate that now nets to zero. Never on a timer.
 */
export async function resolveDiscrepancyAutomatically(
  db: DatabaseOrTransaction,
  input: { discrepancyId: string; reason: string; note?: string; now?: Date },
): Promise<PaymentDiscrepancyRow | undefined> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(paymentDiscrepancies)
    .set({
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: SYSTEM_ACTOR,
      resolvedReason: input.reason,
      resolutionNote: input.note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentDiscrepancies.id, input.discrepancyId),
        // Never overwrite a person's resolution with a machine's. An operator
        // who has already closed this row decided something; a sweep agreeing
        // with them afterwards is not a reason to restate it in the machine's
        // name.
        inArray(paymentDiscrepancies.status, ['open', 'acknowledged']),
      ),
    )
    .returning();
  return row;
}

/**
 * The `resolved_by` value a machine writes.
 *
 * Deliberately not an Oxy user id shape: an audit reading this column must be
 * able to tell a sweep from a person at a glance, and the prefix is what makes
 * that true without a second column nobody would populate consistently.
 */
export const SYSTEM_ACTOR = 'system:reconciliation';
