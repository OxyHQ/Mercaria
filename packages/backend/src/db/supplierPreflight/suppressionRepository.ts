/**
 * The supplier and market kill switches, and the automatic health stop (#122
 * operations 4 and 6).
 *
 * The `retail_suppressions` repository (#121), in the domain that owns supply
 * OPERATIONS. A raise is one INSERT that blocks the next sourcing decision with
 * no sweep having run — because selection READS this table live rather than
 * consulting a cached verdict, which is what makes an emergency stop actually
 * immediate.
 *
 * ## Two operators reacting to one incident converge
 *
 * `on conflict do nothing` against the partial unique on the generated
 * `suppression_key` `WHERE lifted_at IS NULL`, then a read. So a second raise
 * against a live stop returns the incumbent instead of stacking a duplicate,
 * and the health loop racing an operator produces one row rather than two —
 * the `moderation_events` claim shape.
 */

import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type {
  SupplierSuppressionKind,
  SupplierSuppressionOrigin,
  SupplierSuppressionScope,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { supplierPreflightSuppressions } from '../schema/supplierPreflight.js';

/** One suppression row. */
export type SupplierPreflightSuppressionRow = typeof supplierPreflightSuppressions.$inferSelect;

/** What a raise records. */
export interface NewSupplierPreflightSuppression {
  scope: SupplierSuppressionScope;
  supplierId: string | null;
  supplierAccountId: string | null;
  marketCountry: string | null;
  kind: SupplierSuppressionKind;
  origin: SupplierSuppressionOrigin;
  reason: string;
  /** Required for an automatic stop — the thresholds it was raised under. */
  sourcingPolicyId: string | null;
  /** Required for an operator's stop, forbidden on an automatic one — a CHECK. */
  raisedByOxyUserId: string | null;
  effectiveFrom: Date;
  /** Required for an automatic stop, so it lapses without anybody remembering. */
  expiresAt: Date | null;
}

/**
 * Raise a stop, converging on any live one for the same subject and kind.
 *
 * @returns the live row — this call's, or the one that was already there.
 */
export async function raiseSupplierPreflightSuppression(
  input: NewSupplierPreflightSuppression,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightSuppressionRow> {
  await db
    .insert(supplierPreflightSuppressions)
    .values({
      scope: input.scope,
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      marketCountry: input.marketCountry,
      kind: input.kind,
      origin: input.origin,
      reason: input.reason.slice(0, MAX_REASON_LENGTH),
      sourcingPolicyId: input.sourcingPolicyId,
      raisedByOxyUserId: input.raisedByOxyUserId,
      effectiveFrom: input.effectiveFrom,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing();

  const live = await findLiveSupplierPreflightSuppression(
    {
      scope: input.scope,
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      marketCountry: input.marketCountry,
      kind: input.kind,
    },
    db,
  );
  if (!live) {
    throw new Error(
      'Supplier preflight suppression was neither inserted nor found live. That means the ' +
        'insert was refused by a CHECK rather than by the live-uniqueness index — an ' +
        'automatic stop with no policy or an operator stop with no operator.',
    );
  }
  return live;
}

/** Longest reason or lift explanation kept — matches the column CHECKs. */
const MAX_REASON_LENGTH = 2_000;

/** The subject one suppression covers. */
export interface SuppressionSubject {
  scope: SupplierSuppressionScope;
  supplierId: string | null;
  supplierAccountId: string | null;
  marketCountry: string | null;
  kind: SupplierSuppressionKind;
}

/** The live stop for one exact subject and kind, if any. */
export async function findLiveSupplierPreflightSuppression(
  subject: SuppressionSubject,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightSuppressionRow | undefined> {
  const [row] = await db
    .select()
    .from(supplierPreflightSuppressions)
    .where(
      and(
        eq(supplierPreflightSuppressions.scope, subject.scope),
        eq(supplierPreflightSuppressions.kind, subject.kind),
        matchesNullable(supplierPreflightSuppressions.supplierId, subject.supplierId),
        matchesNullable(supplierPreflightSuppressions.supplierAccountId, subject.supplierAccountId),
        matchesNullable(supplierPreflightSuppressions.marketCountry, subject.marketCountry),
        isNull(supplierPreflightSuppressions.liftedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A nullable column matching a nullable value.
 *
 * `eq(column, null)` renders `= NULL`, which is NULL and never true, so a
 * `market` suppression would never be found by a lookup that left the supplier
 * columns unset. `IS NULL` is the only thing that matches an absent subject
 * column — the trap `CONVENTIONS.md` records for `NOT IN` and row comparison,
 * one operator over.
 */
function matchesNullable(column: PgColumn, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

/**
 * Every live stop that covers one route, right now (#122 selection 9).
 *
 * ONE query for all four scopes, so a sourcing decision makes one round trip
 * rather than four. Expiry is applied HERE, against the clock, rather than by a
 * sweep: an automatic stop that has run out must stop blocking in the statement
 * that reads it, whether or not anything has run since — the
 * `commerce_relationships` validity-window rule.
 */
export async function listLiveSuppressionsForRoute(
  input: {
    supplierId: string;
    supplierAccountId: string;
    marketCountry: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightSuppressionRow[]> {
  const now = input.now ?? new Date();
  return db
    .select()
    .from(supplierPreflightSuppressions)
    .where(
      and(
        isNull(supplierPreflightSuppressions.liftedAt),
        // `lte(column, date)` and NOT a `sql` template: drizzle knows the
        // column's type and encodes the `Date`, while a template has no column
        // to take a type from and postgres.js refuses the raw `Date` with
        // `ERR_INVALID_ARG_TYPE` — `CONVENTIONS.md`, "A `Date` is not a safe
        // parameter against an EXPRESSION". tsc cannot see the difference.
        lte(supplierPreflightSuppressions.effectiveFrom, now),
        or(
          isNull(supplierPreflightSuppressions.expiresAt),
          gt(supplierPreflightSuppressions.expiresAt, now),
        ),
        or(
          eq(supplierPreflightSuppressions.supplierId, input.supplierId),
          eq(supplierPreflightSuppressions.supplierAccountId, input.supplierAccountId),
          and(
            eq(supplierPreflightSuppressions.scope, 'market'),
            eq(supplierPreflightSuppressions.marketCountry, input.marketCountry),
          ),
          and(
            eq(supplierPreflightSuppressions.scope, 'supplier_account_market'),
            eq(supplierPreflightSuppressions.supplierAccountId, input.supplierAccountId),
            eq(supplierPreflightSuppressions.marketCountry, input.marketCountry),
          ),
        ),
      ),
    );
}

/**
 * Put a route back into service.
 *
 * The row survives, which is the `retail_suppressions` rule: the history of
 * what was stopped and why is exactly what somebody investigating a later
 * incident needs, and a delete would take it. An operator's lift names the
 * operator; an automatic lapse names nobody, which the CHECK permits and which
 * is how the trail tells the two apart.
 */
export async function liftSupplierPreflightSuppression(
  input: {
    suppressionId: string;
    liftedByOxyUserId: string | null;
    liftReason: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightSuppressionRow | undefined> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(supplierPreflightSuppressions)
    .set({
      liftedAt: now,
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.liftReason.slice(0, MAX_REASON_LENGTH),
      updatedAt: now,
    })
    .where(
      and(
        eq(supplierPreflightSuppressions.id, input.suppressionId),
        isNull(supplierPreflightSuppressions.liftedAt),
      ),
    )
    .returning();
  return row;
}

/** Every suppression, newest first — the operator list. */
export async function listSupplierPreflightSuppressions(
  input: { includeLifted: boolean; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierPreflightSuppressionRow[]> {
  const query = db.select().from(supplierPreflightSuppressions);
  const scoped = input.includeLifted
    ? query
    : query.where(isNull(supplierPreflightSuppressions.liftedAt));
  return scoped.orderBy(desc(supplierPreflightSuppressions.effectiveFrom)).limit(input.limit);
}
