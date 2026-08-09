/**
 * The only writer of `supplier_reservations` (#122 acceptance 3).
 *
 * ## A reservation nobody made cannot be written from here, by TYPE
 *
 * {@link NewSupplierReservation} takes the RESERVED branch of
 * `SupplierReservationOutcome` — `Extract<…, { state: 'reserved' }>` — so a
 * caller holding an `unsupported` or `refused` outcome cannot call this
 * function at all: there is no member on those branches to fill
 * `providerReservationId` or `providerExpiresAt` from, and `tsc` says so at the
 * call site rather than at the insert.
 *
 * That is the third of the three layers. The first is the union itself (only
 * the `reserved` branch carries a provider id and an expiry, both
 * non-optional); the second is `applyDeclaredCapabilities`, which removes any
 * reservation an adapter returned without declaring the capability; the third
 * is this signature plus the table's own CHECK requiring
 * `inventory_reservation` in `declared_capabilities` and NOT NULL on both
 * provider facts. Each is independently sufficient, which is what makes the
 * guarantee survive whoever writes the next caller.
 *
 * ## Consumption and release are compare-and-swaps, and release is idempotent
 *
 * Both are `UPDATE … WHERE <target> IS NULL … RETURNING`. A single-use
 * reservation therefore cannot be consumed twice (#122 concurrency 2) — the
 * loser updates zero rows and is told — and releasing twice converges rather
 * than failing (#122 concurrency 9), because the second call finding nothing to
 * release is the correct outcome, not an error.
 */

import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type {
  SupplierAdapterCapability,
  SupplierReservationOutcome,
  SupplierReservationReleaseReason,
} from '@mercaria/shared-types';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { supplierReservations } from '../schema/supplierPreflight.js';

/** Every column a caller may see — the supplier's own reservation id withheld. */
const PUBLIC_RESERVATION_COLUMNS = publicColumns(supplierReservations, PROTECTED_COLUMNS);

/** One reservation row, without the live provider handle. */
export type SupplierReservationRow = SelectedRow<typeof PUBLIC_RESERVATION_COLUMNS>;

/**
 * The ONLY outcome shape that can become a row.
 *
 * A type alias rather than a re-declared interface, so the two can never drift:
 * if the union's `reserved` branch gains a field, this gains it too, and if the
 * branch is ever removed the writer stops compiling.
 */
export type ReservedSupplierOutcome = Extract<SupplierReservationOutcome, { state: 'reserved' }>;

/** What one supplier-side hold records. */
export interface NewSupplierReservation {
  quoteId: string;
  supplierId: string;
  supplierAccountId: string;
  procurementOfferId: string | null;
  supplierSku: string;
  quantity: number;
  reservedAt: Date;
  /** The adapter's declaration. Must contain `inventory_reservation` — a CHECK. */
  declaredCapabilities: readonly SupplierAdapterCapability[];
  /** The supplier's own commitment. Nothing else can supply these two. */
  outcome: ReservedSupplierOutcome;
}

/**
 * Record a hold the supplier actually made.
 *
 * `on conflict do nothing` on the quote key, then a read: a retried preflight
 * that already reserved converges on the existing row rather than minting a
 * second Mercaria record for one supplier hold — the `moderation_events` claim
 * shape. The second unique, on `(supplier_account_id, provider_reservation_id)`,
 * catches the same convergence arriving from the other direction.
 */
export async function recordSupplierReservation(
  input: NewSupplierReservation,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReservationRow> {
  const providerExpiresAt = new Date(input.outcome.providerExpiresAt);
  if (Number.isNaN(providerExpiresAt.getTime())) {
    throw new Error(
      'A supplier reservation must carry the supplier’s own expiry as an ISO-8601 instant; ' +
        `received \`${input.outcome.providerExpiresAt}\`.`,
    );
  }

  await db
    .insert(supplierReservations)
    .values({
      quoteId: input.quoteId,
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      procurementOfferId: input.procurementOfferId,
      providerReservationId: input.outcome.providerReservationId,
      declaredCapabilities: [...input.declaredCapabilities],
      supplierSku: input.supplierSku,
      quantity: input.quantity,
      reservedAt: input.reservedAt,
      providerExpiresAt,
      singleUse: input.outcome.singleUse,
    })
    .onConflictDoNothing({ target: supplierReservations.quoteId });

  const stored = await findSupplierReservationByQuote(input.quoteId, db);
  if (!stored) {
    throw new Error(
      `Supplier reservation for quote ${input.quoteId} was neither inserted nor found. ` +
        'That means the conflict was on the provider key rather than the quote key — two ' +
        'quotes claiming one supplier hold, which is a supplier-adapter bug.',
    );
  }
  return stored;
}

/** The hold attached to one quote, without the provider handle. */
export async function findSupplierReservationByQuote(
  quoteId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReservationRow | undefined> {
  const [row] = await db
    .select(PUBLIC_RESERVATION_COLUMNS)
    .from(supplierReservations)
    .where(eq(supplierReservations.quoteId, quoteId))
    .limit(1);
  return row;
}

/**
 * The supplier's own reservation id, for the ONE path that must present it back
 * to the supplier.
 *
 * Named explicitly rather than reached through a whole-row read, exactly as
 * `readCredentialReference` is: the release call needs the live handle and
 * nothing else does, and an explicit selection reads differently from an
 * ordinary one and stays greppable.
 */
export async function readSupplierReservationProviderId(
  reservationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | undefined> {
  const [row] = await db
    .select({ providerReservationId: supplierReservations.providerReservationId })
    .from(supplierReservations)
    .where(eq(supplierReservations.id, reservationId))
    .limit(1);
  return row?.providerReservationId;
}

/**
 * Spend a hold on one checkout — the compare-and-swap (#122 concurrency 2).
 *
 * The predicate carries the supplier's own expiry, so a lapsed hold cannot be
 * consumed at all: the supplier has already released the stock, and recording
 * that Mercaria consumed it would be a local fiction about somebody else's
 * warehouse.
 *
 * @returns `true` when THIS call consumed it. A `false` is a refusal a caller
 *   must act on — another checkout took it, it was released, or it lapsed.
 */
export async function consumeSupplierReservation(
  input: {
    reservationId: string;
    checkoutGroupId: string;
    orderId?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const consumed = await db
    .update(supplierReservations)
    .set({
      consumedAt: now,
      consumedByCheckoutGroupId: input.checkoutGroupId,
      consumedOrderId: input.orderId ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(supplierReservations.id, input.reservationId),
        isNull(supplierReservations.consumedAt),
        isNull(supplierReservations.releasedAt),
        // A hold past the SUPPLIER's own deadline is gone whatever Mercaria
        // writes, so the expiry is IN the predicate rather than checked after:
        // consuming and then noticing would leave a row claiming Mercaria spent
        // stock the supplier had already handed to somebody else, and
        // `consumed_at` is one-way, so there would be nothing to take back.
        gt(supplierReservations.providerExpiresAt, now),
      ),
    )
    .returning({ id: supplierReservations.id });
  return consumed.length === 1;
}

/**
 * Hand a hold back — idempotent (#122 concurrency 9).
 *
 * @returns `true` when THIS call released it, `false` when it was already
 *   released or consumed. Both are success: a release that finds nothing to do
 *   has converged.
 */
export async function releaseSupplierReservation(
  input: { reservationId: string; reason: SupplierReservationReleaseReason; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const released = await db
    .update(supplierReservations)
    .set({ releasedAt: now, releaseReason: input.reason, updatedAt: now })
    .where(
      and(
        eq(supplierReservations.id, input.reservationId),
        isNull(supplierReservations.consumedAt),
        isNull(supplierReservations.releasedAt),
      ),
    )
    .returning({ id: supplierReservations.id });
  return released.length === 1;
}

/**
 * Record a failed release attempt.
 *
 * Separate from the release itself, because a provider refusing the call is not
 * the same event as the hold being handed back, and collapsing them would let a
 * failed call mark a hold released that the supplier still holds. The attempt
 * count is what the sweep's bounded retry reads.
 */
export async function recordSupplierReleaseFailure(
  input: { reservationId: string; error: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(supplierReservations)
    .set({
      // Incremented in SQL rather than read-modify-written, so two concurrent
      // sweep tasks retrying one hold both count — the `payment_outboxes`
      // attempts rule.
      releaseAttempts: sql`${supplierReservations.releaseAttempts} + 1`,
      lastReleaseError: input.error.slice(0, MAX_RELEASE_ERROR_LENGTH),
      updatedAt: now,
    })
    .where(eq(supplierReservations.id, input.reservationId));
}

/** Longest release error kept — matches the column's own CHECK. */
const MAX_RELEASE_ERROR_LENGTH = 2_000;

/**
 * Live holds past the supplier's own deadline — the release sweep's page.
 *
 * Bounded and ordered by deadline, so the sweep makes progress from the oldest.
 * A lapsed hold usually needs no call at all (the supplier released it when its
 * own clock ran out), but recording the release closes Mercaria's side of the
 * fact so the operator surface stops reporting a hold nobody holds.
 *
 * `maxReleaseAttempts` bounds the retry IN the page rather than in the sweep:
 * a hold whose release keeps failing is left visible with its error rather than
 * re-picked forever, which is the `dead_letter` posture without a second status
 * column — the row's own `release_attempts` and `last_release_error` already
 * say it, and the operator surface reads them.
 */
export async function listLapsedSupplierReservations(
  input: { limit: number; maxReleaseAttempts: number; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReservationRow[]> {
  const now = input.now ?? new Date();
  return db
    .select(PUBLIC_RESERVATION_COLUMNS)
    .from(supplierReservations)
    .where(
      and(
        lte(supplierReservations.providerExpiresAt, now),
        isNull(supplierReservations.consumedAt),
        isNull(supplierReservations.releasedAt),
        lte(supplierReservations.releaseAttempts, input.maxReleaseAttempts),
      ),
    )
    .orderBy(asc(supplierReservations.providerExpiresAt))
    .limit(input.limit);
}

/** One account's most recent holds — the operator trace. */
export async function listSupplierReservationsForAccount(
  input: { supplierAccountId: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReservationRow[]> {
  return db
    .select(PUBLIC_RESERVATION_COLUMNS)
    .from(supplierReservations)
    .where(eq(supplierReservations.supplierAccountId, input.supplierAccountId))
    .orderBy(desc(supplierReservations.reservedAt))
    .limit(input.limit);
}

/** The hold-outcome counters the operator metrics surface reports. */
export interface SupplierReservationMetrics {
  total: number;
  live: number;
  consumed: number;
  released: number;
  /**
   * Holds Mercaria took and never used, past the supplier's own deadline — the
   * closest honest measure of stock discrepancy this domain can compute on its
   * own (#122 operations 1). A hold that lapsed unconsumed means Mercaria
   * reserved stock a checkout then did not buy, which is either an abandonment
   * or a quote that expired under a slow buyer.
   *
   * The OTHER half of stock discrepancy — a supplier accepting a quote and then
   * refusing the purchase order — is learned only when a PO is submitted, which
   * is #124's path, and is deliberately not guessed at here.
   */
  lapsedUnconsumed: number;
  releaseFailures: number;
}

/** Count hold outcomes over a window. ONE statement, one snapshot. */
export async function readSupplierReservationMetrics(
  input: { since: Date; supplierAccountId?: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierReservationMetrics> {
  const now = input.now ?? new Date();
  const scope = input.supplierAccountId
    ? and(
        gt(supplierReservations.reservedAt, input.since),
        eq(supplierReservations.supplierAccountId, input.supplierAccountId),
      )
    : gt(supplierReservations.reservedAt, input.since);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (
        where ${supplierReservations.consumedAt} is null
          and ${supplierReservations.releasedAt} is null
          and ${supplierReservations.providerExpiresAt} > ${now}
      )::int`,
      consumed: sql<number>`count(*) filter (where ${supplierReservations.consumedAt} is not null)::int`,
      released: sql<number>`count(*) filter (where ${supplierReservations.releasedAt} is not null)::int`,
      lapsedUnconsumed: sql<number>`count(*) filter (
        where ${supplierReservations.consumedAt} is null
          and ${supplierReservations.providerExpiresAt} <= ${now}
      )::int`,
      releaseFailures: sql<number>`count(*) filter (where ${supplierReservations.releaseAttempts} > 0)::int`,
    })
    .from(supplierReservations)
    .where(scope);

  return (
    row ?? {
      total: 0,
      live: 0,
      consumed: 0,
      released: 0,
      lapsedUnconsumed: 0,
      releaseFailures: 0,
    }
  );
}
