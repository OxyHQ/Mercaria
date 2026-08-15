/**
 * The collection desk: marking a parcel ready, handing it over, and refusing to
 * hand it over twice.
 *
 * ## The desk moves NO money and NO stock, and that is a scanned gate
 *
 * `pickup-isolation.test.ts` fails the build if any module under
 * `services/pickup/` imports the inventory service, the refund service, the
 * payment domain or the order writer. It is what makes #93 acceptance 14
 * ("collection is idempotent and cannot commit inventory or mark the order
 * collected twice") true of code nobody has written yet, and it is correct
 * rather than merely cautious: the units were committed when the order was
 * PAID, so a collection that touched inventory would be committing them a
 * second time.
 *
 * The corollary is stated rather than hidden. Cancelling a collection does NOT
 * cancel the order, refund anything or restock anything — it withdraws the
 * handover and revokes the code, and the merchant's existing order-cancel path
 * is what returns the money and the units. Two steps, because they are two
 * decisions and one of them moves money.
 *
 * ## The order's STATUS is not moved either (#93 pickup rule 12)
 *
 * "Payment and pickup confirmation remain separate states", and #93 asks for
 * ready / collected / cancelled "without conflating them with payment state".
 * So `order_pickups.state` is the fulfilment truth for a collection and
 * `orders.status` is untouched by every function here. The consequence: a
 * merchant's order list must read the pickup state to know a handover is done —
 * which is exactly what the pickup projection on the merchant order is for, and
 * is why `shipped` was not reused. A parcel handed across a counter was never
 * shipped, and saying it was would put a carrier's word on a fact no carrier
 * touched.
 *
 * ## Idempotency is a CAS, not a prior read
 *
 * Every transition carries its own predicate and reports whether a row moved. A
 * second tap on a POS, a retry after a lost response and two members of staff
 * at two tills all converge on ONE transition and ONE audit entry. A
 * read-then-write would satisfy the words of acceptance 14 and fail all three.
 */

import type {
  CollectPickupInput,
  OrderPickup,
  PickupCollectionCode,
  PickupCollectionEvent,
} from '@mercaria/shared-types';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  appendCollectionEvent,
  ensureCollectionCredential,
  findCollectionCredential,
  listCollectionEvents,
  revokeCollectionCredential,
  rotateCollectionCredential,
} from '../../db/pickup/collectionRepository.js';
import {
  findOrderPickup,
  markCollected,
  markPickupCancelled,
  markReadyForPickup,
  type OrderPickupRow,
} from '../../db/pickup/orderPickupRepository.js';
import { notifyGuestOrderLifecycle } from '../guest-portal/message.service.js';
import {
  collectionCodesAvailable,
  deriveCollectionCode,
  verifyCollectionCode,
} from './collection-code.js';

/** The three order columns this domain needs, and no more. */
export interface CollectionOrderFacts {
  readonly id: string;
  readonly storeId: string | null;
  readonly buyerOrigin: 'oxy' | 'guest' | 'external';
  readonly checkoutGroupId: string | null;
}

/** One order's collection row, projected. */
export function projectOrderPickup(row: OrderPickupRow): OrderPickup {
  return {
    orderId: row.orderId,
    locationId: row.locationId,
    state: row.state,
    displayName: row.displayName,
    address: {
      ...(row.publicLine1 === null ? {} : { line1: row.publicLine1 }),
      ...(row.publicLine2 === null ? {} : { line2: row.publicLine2 }),
      ...(row.publicCity === null ? {} : { city: row.publicCity }),
      ...(row.publicRegion === null ? {} : { region: row.publicRegion }),
      ...(row.publicPostalCode === null ? {} : { postalCode: row.publicPostalCode }),
      country: row.publicCountry,
    },
    timezone: row.timezone,
    ...(row.pickupInstructions === null ? {} : { pickupInstructions: row.pickupInstructions }),
    identityRequirement: row.identityRequirement,
    paymentRequirement: row.paymentRequirement,
    ...(row.readyAt === null ? {} : { readyAt: row.readyAt.toISOString() }),
    ...(row.collectedAt === null ? {} : { collectedAt: row.collectedAt.toISOString() }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt.toISOString() }),
    ...(row.cancelReason === null ? {} : { cancelReason: row.cancelReason }),
  };
}

/**
 * The code, for an ALREADY-AUTHORIZED order surface.
 *
 * The signature is the security boundary and it is deliberately narrow: it
 * takes an order id and nothing that could authorize one. Every caller is a
 * route that has already established the reader is the buyer (`orders.ts`, via
 * #106's `authorizeOrderAccess`) or holds a portal credential for the group
 * (`guest-orders.ts`, via #108's resolver). There is no email parameter, no
 * order NUMBER parameter and no lookup by code, so #93 verification rules 2, 3
 * and 8 are held by what this function cannot be asked rather than by a branch.
 *
 * A REVOKED credential answers `null` rather than a fresh code: revocation is
 * terminal, and silently re-issuing would make "revoke this code" a no-op.
 */
export async function readCollectionCode(
  orderId: string,
  at: Date,
): Promise<PickupCollectionCode | null> {
  if (!collectionCodesAvailable()) return null;

  const pickup = await findOrderPickup(orderId);
  if (!pickup) return null;
  if (pickup.identityRequirement === 'order_number_only') return null;
  if (pickup.state === 'pickup_cancelled') return null;

  const credential = await ensureCollectionCredential({ orderId, at });
  if (credential.revokedAt !== null) return null;

  return {
    code: deriveCollectionCode(orderId, credential.version),
    version: credential.version,
    issuedAt: credential.issuedAt.toISOString(),
  };
}

/**
 * Mark a parcel ready to collect.
 *
 * Converges: a second press on an already-ready collection changes nothing and
 * enqueues no second message, because the CAS excludes the terminal states and
 * `enqueueGuestMessage`'s id is deterministic. #108's `order_ready_for_pickup`
 * kind — dark since it shipped, because nothing could reach the state — fires
 * from here.
 */
export async function markPickupReady(input: {
  order: CollectionOrderFacts;
  actorOxyUserId: string;
  at: Date;
}): Promise<OrderPickup> {
  const storeId = requireStore(input.order);
  const existing = await requirePickup(input.order.id);
  if (existing.state === 'collected' || existing.state === 'pickup_cancelled') {
    throw conflict('This collection is already finished.');
  }

  const moved = await getDb().transaction(async (tx) => {
    const row = await markReadyForPickup({ orderId: input.order.id, at: input.at }, tx);
    if (!row) return null;
    await appendCollectionEvent(
      {
        orderId: input.order.id,
        storeId,
        kind: 'marked_ready',
        actorOxyUserId: input.actorOxyUserId,
        occurredAt: input.at,
      },
      tx,
    );
    return row;
  });

  const row = moved ?? existing;

  // Best-effort and unawaitable, the `notifyGuestOrderLifecycle` guarantee: a
  // message failure must not roll back a fulfilment act a shop already
  // performed. Only a GUEST order has a `guest_checkouts` row to send to; an
  // Oxy buyer's transactional channel is Oxy's own notifications.
  notifyGuestOrderLifecycle(
    {
      id: input.order.id,
      buyerOrigin: input.order.buyerOrigin,
      checkoutGroupId: input.order.checkoutGroupId,
    },
    'ready_for_pickup',
  );

  return projectOrderPickup(row);
}

/**
 * Hand the parcel over.
 *
 * Two ways in, and the second is audited: a matching code, or an explicit
 * override with a reason (#93 verification rule 7). The override is not a
 * back door — it is the answer to a code that will not scan, and the
 * alternative is a customer stranded at a counter while somebody looks for a
 * developer. `pickup_collection_events_override_reason_check` makes the reason
 * mandatory at the row.
 *
 * A location whose requirement is `order_number_only` needs neither: the
 * merchant chose the weakest setting deliberately, and demanding a code they
 * never showed the buyer would make that setting unusable.
 */
export async function collectPickup(input: {
  order: CollectionOrderFacts;
  actorOxyUserId: string;
  at: Date;
  body: CollectPickupInput;
}): Promise<OrderPickup> {
  const storeId = requireStore(input.order);
  const pickup = await requirePickup(input.order.id);

  if (pickup.state === 'pickup_cancelled') {
    throw conflict('This collection was cancelled and cannot be handed over.');
  }
  if (pickup.state === 'collected') {
    // The converging answer, not an error: the second till is not doing
    // anything wrong, and reporting a conflict would send staff looking for a
    // problem that does not exist. Nothing is written — no second audit entry,
    // no second transition.
    return projectOrderPickup(pickup);
  }

  const credential = await ensureCollectionCredential({ orderId: input.order.id, at: input.at });

  if (pickup.identityRequirement !== 'order_number_only') {
    const authorized = await authorizeHandover({
      orderId: input.order.id,
      storeId,
      credentialVersion: credential.version,
      revoked: credential.revokedAt !== null,
      actorOxyUserId: input.actorOxyUserId,
      at: input.at,
      body: input.body,
    });
    if (!authorized) {
      throw forbidden('That collection code is not valid for this order.');
    }
  }

  const row = await getDb().transaction(async (tx) => {
    const moved = await markCollected({ orderId: input.order.id, at: input.at }, tx);
    if (!moved) return null;
    await appendCollectionEvent(
      {
        orderId: input.order.id,
        storeId,
        kind: 'collected',
        actorOxyUserId: input.actorOxyUserId,
        credentialVersion: credential.version,
        occurredAt: input.at,
      },
      tx,
    );
    return moved;
  });

  // The CAS lost to a concurrent till. Re-read and answer with whatever won —
  // the same converging answer the early return above gives.
  if (!row) return projectOrderPickup(await requirePickup(input.order.id));

  return projectOrderPickup(row);
}

/**
 * Validate the presented credential, recording BOTH outcomes.
 *
 * A refusal is written down. #93 merchant rule 10 asks for collection overrides
 * to be audited and a trail that kept only successes could not answer the one
 * question a support call opens with — "somebody came in and you turned them
 * away, why".
 */
async function authorizeHandover(input: {
  orderId: string;
  storeId: string;
  credentialVersion: number;
  revoked: boolean;
  actorOxyUserId: string;
  at: Date;
  body: CollectPickupInput;
}): Promise<boolean> {
  if (input.body.override !== undefined) {
    const reason = input.body.override.reason.trim();
    if (reason === '') {
      throw validationError('An override needs a reason — it is the whole of the audit.');
    }
    await appendCollectionEvent({
      orderId: input.orderId,
      storeId: input.storeId,
      kind: 'fallback_override',
      actorOxyUserId: input.actorOxyUserId,
      credentialVersion: input.credentialVersion,
      reason,
      occurredAt: input.at,
    });
    return true;
  }

  const presented = input.body.code?.trim();
  if (presented === undefined || presented === '') {
    throw validationError('Enter the collection code, or record an override with a reason.');
  }

  const valid =
    !input.revoked &&
    verifyCollectionCode({
      orderId: input.orderId,
      version: input.credentialVersion,
      presented,
    });

  await appendCollectionEvent({
    orderId: input.orderId,
    storeId: input.storeId,
    kind: valid ? 'code_validated' : 'code_rejected',
    actorOxyUserId: input.actorOxyUserId,
    credentialVersion: input.credentialVersion,
    occurredAt: input.at,
  });
  return valid;
}

/**
 * Withdraw a collection.
 *
 * Revokes the code in the same transaction, which is #93 verification rule 5:
 * a cancelled handover must not leave a working credential behind. It moves NO
 * money and NO stock — see the module docblock.
 */
export async function cancelPickup(input: {
  order: CollectionOrderFacts;
  actorOxyUserId: string;
  reason: string;
  at: Date;
}): Promise<OrderPickup> {
  const storeId = requireStore(input.order);
  const reason = input.reason.trim();
  if (reason === '') {
    throw validationError('Say why the collection is being cancelled.');
  }

  const pickup = await requirePickup(input.order.id);
  if (pickup.state === 'collected') {
    throw conflict(
      'This order was already collected. Handle it as a return rather than a cancellation.',
    );
  }
  if (pickup.state === 'pickup_cancelled') return projectOrderPickup(pickup);

  const row = await getDb().transaction(async (tx) => {
    const moved = await markPickupCancelled({ orderId: input.order.id, reason, at: input.at }, tx);
    if (!moved) return null;
    await revokeCollectionCredential({ orderId: input.order.id, reason, at: input.at }, tx);
    await appendCollectionEvent(
      {
        orderId: input.order.id,
        storeId,
        kind: 'pickup_cancelled',
        actorOxyUserId: input.actorOxyUserId,
        reason,
        occurredAt: input.at,
      },
      tx,
    );
    return moved;
  });

  if (!row) return projectOrderPickup(await requirePickup(input.order.id));
  return projectOrderPickup(row);
}

/**
 * Rotate the code (#93 verification rule 5).
 *
 * Every outstanding copy stops working at once, because the code is derived
 * from the version. There is no grace period and no acceptance of `version - 1`:
 * a rotation happens precisely because the previous code should stop working,
 * and a window would be the one thing it must not have.
 */
export async function rotateCollectionCode(input: {
  order: CollectionOrderFacts;
  actorOxyUserId: string;
  reason: string;
  at: Date;
}): Promise<PickupCollectionCode> {
  const storeId = requireStore(input.order);
  await ensureCollectionCredential({ orderId: input.order.id, at: input.at });

  const rotated = await getDb().transaction(async (tx) => {
    const row = await rotateCollectionCredential({ orderId: input.order.id, at: input.at }, tx);
    if (!row) return null;
    await appendCollectionEvent(
      {
        orderId: input.order.id,
        storeId,
        kind: 'code_rotated',
        actorOxyUserId: input.actorOxyUserId,
        credentialVersion: row.version,
        reason: input.reason.trim() || null,
        occurredAt: input.at,
      },
      tx,
    );
    return row;
  });

  if (!rotated) throw conflict('This collection code was revoked and cannot be rotated.');

  log.general.info(
    { orderId: input.order.id, version: rotated.version },
    '[Pickup] collection code rotated',
  );
  return {
    code: deriveCollectionCode(input.order.id, rotated.version),
    version: rotated.version,
    issuedAt: rotated.issuedAt.toISOString(),
  };
}

/** One order's desk trail, for the merchant surface and the operator trace. */
export async function readCollectionTrail(input: {
  orderId: string;
  limit: number;
}): Promise<readonly PickupCollectionEvent[]> {
  const rows = await listCollectionEvents(input);
  return rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    ...(row.actorOxyUserId === null ? {} : { actorOxyUserId: row.actorOxyUserId }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  }));
}

/** Whether an order has a code at all — the client renders nothing when it does not. */
export async function hasCollectionCredential(orderId: string): Promise<boolean> {
  return (await findCollectionCredential(orderId)) !== null;
}

async function requirePickup(orderId: string): Promise<OrderPickupRow> {
  const row = await findOrderPickup(orderId);
  if (!row) throw notFound('This order is not a collection.');
  return row;
}

/**
 * A P2P order has no store and therefore no collection desk.
 *
 * Unreachable through checkout — `derivePickupEligibility` refuses a `user`
 * seller for every actor — and stated here anyway, because the merchant routes
 * are mounted under a store and a null owner reaching them would mean something
 * upstream had changed.
 */
function requireStore(order: CollectionOrderFacts): string {
  if (order.storeId === null) {
    throw conflict('Collection is only available for store orders.');
  }
  return order.storeId;
}
