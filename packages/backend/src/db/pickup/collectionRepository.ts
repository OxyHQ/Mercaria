/**
 * `pickup_collection_credentials` and `pickup_collection_events` — the only
 * writer of a collection code's lifecycle and of the desk's audit trail.
 *
 * Neither table holds a code. See `services/pickup/collection-code.ts` for why
 * the credential is derived rather than stored; what lives here is the ROTATION
 * COUNTER a derivation reads, the four instants that describe its life, and an
 * append-only record of everything anybody did with it.
 *
 * ## Issuance is idempotent and rotation is not
 *
 * `ensureCollectionCredential` is `ON CONFLICT DO NOTHING` plus a read, so a
 * buyer opening their order twice gets the same code and a retrying client
 * mints nothing. `rotateCollectionCredential` is deliberately the opposite: it
 * is an explicit act with a version increment, and making it converge would
 * mean a second "this code has leaked" press did nothing.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { PickupCollectionEventKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { pickupCollectionCredentials, pickupCollectionEvents } from '../schema/pickup.js';

/** One row of `pickup_collection_credentials`. */
export type PickupCollectionCredentialRow = InferSelectModel<typeof pickupCollectionCredentials>;
/** One row of `pickup_collection_events`. */
export type PickupCollectionEventRow = InferSelectModel<typeof pickupCollectionEvents>;

/**
 * The credential row for one order, creating it on first ask.
 *
 * Lazy rather than written at checkout, for the reason #104 gives about guest
 * sessions: a row created by a READ is a row created for every order nobody
 * ever collects. The first authorized surface that needs to show a code mints
 * the counter, and the counter is all there is to mint.
 */
export async function ensureCollectionCredential(
  input: { orderId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionCredentialRow> {
  const [inserted] = await db
    .insert(pickupCollectionCredentials)
    .values({ orderId: input.orderId, version: 1, issuedAt: input.at })
    .onConflictDoNothing({ target: pickupCollectionCredentials.orderId })
    .returning();
  if (inserted) return inserted;

  const existing = await findCollectionCredential(input.orderId, db);
  if (!existing) {
    throw new Error(`pickup_collection_credentials row for ${input.orderId} vanished after a conflict`);
  }
  return existing;
}

/** One order's credential row, or none. */
export async function findCollectionCredential(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionCredentialRow | null> {
  const [row] = await db
    .select()
    .from(pickupCollectionCredentials)
    .where(eq(pickupCollectionCredentials.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/**
 * Advance the rotation, invalidating every outstanding copy of the code.
 *
 * The increment is done IN SQL (`version + 1`) rather than read-then-write, so
 * two concurrent rotations produce two rotations rather than one — which is the
 * correct behaviour for a credential nobody should be holding: the second press
 * is somebody who is not sure the first worked.
 *
 * A REVOKED credential is not rotatable. Revocation is terminal — the order is
 * cancelled, or an operator has decided no code should work — and rotating one
 * would quietly bring it back.
 */
export async function rotateCollectionCredential(
  input: { orderId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionCredentialRow | null> {
  const [row] = await db
    .update(pickupCollectionCredentials)
    .set({ version: sql`${pickupCollectionCredentials.version} + 1`, rotatedAt: input.at })
    .where(
      and(
        eq(pickupCollectionCredentials.orderId, input.orderId),
        isNull(pickupCollectionCredentials.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Revoke a credential permanently. Converges if it was already revoked. */
export async function revokeCollectionCredential(
  input: { orderId: string; reason: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionCredentialRow | null> {
  const [row] = await db
    .update(pickupCollectionCredentials)
    .set({ revokedAt: input.at, revokeReason: input.reason })
    .where(
      and(
        eq(pickupCollectionCredentials.orderId, input.orderId),
        isNull(pickupCollectionCredentials.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Append one desk event.
 *
 * Every caller supplies the STORE, so the trail is queryable per tenant without
 * a join through orders — and a query for one store's trail cannot widen to a
 * sibling's by forgetting a predicate, because the predicate is on this table.
 */
export async function appendCollectionEvent(
  input: {
    orderId: string;
    storeId: string;
    kind: PickupCollectionEventKind;
    actorOxyUserId?: string | null;
    credentialVersion?: number | null;
    reason?: string | null;
    occurredAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionEventRow> {
  const [row] = await db
    .insert(pickupCollectionEvents)
    .values({
      orderId: input.orderId,
      storeId: input.storeId,
      kind: input.kind,
      actorOxyUserId: input.actorOxyUserId ?? null,
      credentialVersion: input.credentialVersion ?? null,
      reason: input.reason ?? null,
      occurredAt: input.occurredAt,
    })
    .returning();
  return row;
}

/** One order's desk trail, newest first. */
export async function listCollectionEvents(
  input: { orderId: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<PickupCollectionEventRow[]> {
  return db
    .select()
    .from(pickupCollectionEvents)
    .where(eq(pickupCollectionEvents.orderId, input.orderId))
    .orderBy(desc(pickupCollectionEvents.occurredAt))
    .limit(input.limit);
}
