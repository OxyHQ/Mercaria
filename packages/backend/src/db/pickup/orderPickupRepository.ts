/**
 * `order_pickups` — the only writer of an order's collection snapshot and its
 * operational state.
 *
 * ## Every state move is a CAS, and that is what "idempotent" means here
 *
 * #93 acceptance 14 asks that collection "cannot commit inventory or mark the
 * order collected twice". The first half is a property of the CALL GRAPH — this
 * domain imports no inventory function at all, and `pickup-isolation.test.ts`
 * fails the build if it starts to, because the stock was committed when the
 * order was paid and a collection is a handover rather than a stock movement.
 * The second half is here: `markCollected` carries `state <> 'collected'` in
 * its own predicate and reports whether a row moved, so a double tap on a POS,
 * a retry after a lost response and two members of staff at two tills all
 * converge on ONE transition and ONE audit entry.
 *
 * A read-then-write would satisfy the words and fail exactly those three cases,
 * which is the `insertProductSave` lesson one domain over.
 *
 * ## The snapshot is written once and frozen by trigger
 *
 * `insertOrderPickup` runs inside the order's own transaction, so an order and
 * its collection details commit together or not at all — the
 * `guest_checkouts` arrangement, for the same reason: a converging idempotency
 * replay must never find an order whose pickup row is missing.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { PickupIdentityRequirement, PickupPaymentRequirement } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { orderPickups } from '../schema/pickup.js';

/** One row of `order_pickups`. */
export type OrderPickupRow = InferSelectModel<typeof orderPickups>;

/** The snapshot, taken from the PUBLICATION and never from `locations`. */
export interface NewOrderPickup {
  readonly orderId: string;
  readonly locationId: string;
  readonly publicationId: string;
  readonly displayName: string;
  readonly publicLine1: string | null;
  readonly publicLine2: string | null;
  readonly publicCity: string | null;
  readonly publicRegion: string | null;
  readonly publicPostalCode: string | null;
  readonly publicCountry: string;
  readonly timezone: string;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
}

/**
 * Write one order's collection snapshot.
 *
 * `ON CONFLICT DO NOTHING` plus a read, the `ensureGuestCheckout` shape: a
 * converging checkout replay must not replace the snapshot the placed order was
 * made against, because the merchant may have edited the publication in
 * between and the buyer agreed to what they were shown.
 */
export async function insertOrderPickup(
  input: NewOrderPickup,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow> {
  const [inserted] = await db
    .insert(orderPickups)
    .values({
      orderId: input.orderId,
      locationId: input.locationId,
      publicationId: input.publicationId,
      displayName: input.displayName,
      publicLine1: input.publicLine1,
      publicLine2: input.publicLine2,
      publicCity: input.publicCity,
      publicRegion: input.publicRegion,
      publicPostalCode: input.publicPostalCode,
      publicCountry: input.publicCountry,
      timezone: input.timezone,
      pickupInstructions: input.pickupInstructions,
      identityRequirement: input.identityRequirement,
      paymentRequirement: input.paymentRequirement,
    })
    .onConflictDoNothing({ target: orderPickups.orderId })
    .returning();
  if (inserted) return inserted;

  const existing = await findOrderPickup(input.orderId, db);
  if (!existing) {
    // Unreachable through the unique: a conflict means a row exists. Raising
    // rather than retrying, because the alternative explanation is that
    // something deleted it inside this transaction.
    throw new Error(`order_pickups row for ${input.orderId} vanished after a conflict`);
  }
  return existing;
}

/** One order's collection row. */
export async function findOrderPickup(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow | null> {
  const [row] = await db
    .select()
    .from(orderPickups)
    .where(eq(orderPickups.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/** Several orders' collection rows, in one statement — the order-list read. */
export async function findOrderPickupsByOrderIds(
  orderIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow[]> {
  if (orderIds.length === 0) return [];
  return db.select().from(orderPickups).where(inArray(orderPickups.orderId, [...orderIds]));
}

/**
 * Move a collection to `ready_for_pickup`.
 *
 * The predicate excludes both terminal states rather than naming the one legal
 * source state: a collected order and a cancelled one must not be re-armed, and
 * an order already ready converges silently, which is what a merchant tapping
 * "ready" twice needs.
 */
export async function markReadyForPickup(
  input: { orderId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow | null> {
  const [row] = await db
    .update(orderPickups)
    .set({ state: 'ready_for_pickup', readyAt: input.at })
    .where(
      and(
        eq(orderPickups.orderId, input.orderId),
        ne(orderPickups.state, 'collected'),
        ne(orderPickups.state, 'pickup_cancelled'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Move a collection to `collected`, exactly once.
 *
 * `null` means the CAS lost — already collected, or cancelled — and the caller
 * turns that into a converging success rather than an error, because the second
 * of two tills is not doing anything wrong.
 *
 * `ready_at` is coalesced rather than left alone: a shop that hands a parcel
 * over without pressing "ready" first still owes a ready instant, and the
 * table's CHECK on `ready_for_pickup` deliberately does not cover the collected
 * state, so the value would otherwise be permanently absent for exactly the
 * orders that moved fastest.
 */
export async function markCollected(
  input: { orderId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow | null> {
  const [row] = await db
    .update(orderPickups)
    .set({
      state: 'collected',
      collectedAt: input.at,
      // The ISO string with an explicit cast, NEVER the bare `Date`:
      // postgres.js cannot infer a wire type for a `Date` interpolated into a
      // raw `sql` template and throws in the DRIVER, before the server ever
      // sees the statement. Caught by the real-server suite on its first run —
      // `tsc` accepts the `Date` happily and a mocked update never binds
      // anything (`~/Oxy/AGENTS.md` §Drizzle `sql` templates).
      readyAt: sql`coalesce(${orderPickups.readyAt}, ${input.at.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(orderPickups.orderId, input.orderId),
        ne(orderPickups.state, 'collected'),
        ne(orderPickups.state, 'pickup_cancelled'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Cancel a collection.
 *
 * A COLLECTED order cannot be cancelled: the goods are gone, and the remedy is
 * a return through #110 rather than a state change that would make the trail
 * say the handover never happened.
 */
export async function markPickupCancelled(
  input: { orderId: string; reason: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow | null> {
  const [row] = await db
    .update(orderPickups)
    .set({ state: 'pickup_cancelled', cancelledAt: input.at, cancelReason: input.reason })
    .where(
      and(
        eq(orderPickups.orderId, input.orderId),
        ne(orderPickups.state, 'collected'),
        ne(orderPickups.state, 'pickup_cancelled'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Every open collection at one location, for a counter's own queue.
 *
 * Scoped by LOCATION rather than by store: a member of staff at one branch
 * should see the parcels in their own stockroom, and #93 merchant rule 5 ("one
 * staff action cannot expose or mutate another store's sibling order") is one
 * predicate stronger when the read cannot cross a branch either.
 */
export async function listOpenPickupsAtLocation(
  input: { locationId: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<OrderPickupRow[]> {
  return db
    .select()
    .from(orderPickups)
    .where(
      and(
        eq(orderPickups.locationId, input.locationId),
        inArray(orderPickups.state, ['awaiting_preparation', 'ready_for_pickup']),
      ),
    )
    .orderBy(orderPickups.createdAt)
    .limit(input.limit);
}
