/**
 * `location_publications` and its audit trail — the only writer, and the only
 * writer of a location's GoWay place link (`locations.go_way_place_id`).
 *
 * The publication is an UPSERT keyed on `location_id` rather than a
 * create-then-patch pair, because a merchant editing a shop front is editing
 * one object: a form that can create and a form that can update are two code
 * paths that will eventually disagree about which fields a partial save
 * clears. `upsertLocationPublication` takes the whole commerce profile and
 * writes it, and the caller is the one place that decides what a partial edit
 * means. Where the shop IS — its name, address, hours — is the GoWay place's
 * and is not written here at all (ADR 0013).
 *
 * ## The audit is written HERE, in the same transaction
 *
 * #93 operations rule 5 asks for publication changes to be audited, and an
 * audit written by the caller is one a second caller forgets. Every state
 * change and every place-link change appends a `location_publication_events`
 * row inside the same transaction as the change it records, so the trail
 * cannot be missing an entry for a change that committed.
 *
 * ## The store id is written from the location, never from the request
 *
 * `location_publications.store_id` is denormalized so a tenant predicate is one
 * column. That makes it exactly the shape a mass-assignment bug reaches for, so
 * it is never taken from an input object: the caller passes the LOCATION row it
 * already authorized, and this module reads the owner off that.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  LocationInventorySource,
  LocationPublicationState,
  PickupIdentityRequirement,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { locationPublicationEvents, locationPublications } from '../schema/pickup.js';
import { locations } from '../schema/stores.js';

/** One row of `location_publications`. */
export type LocationPublicationRow = InferSelectModel<typeof locationPublications>;
/** One row of `location_publication_events`. */
export type LocationPublicationEventRow = InferSelectModel<typeof locationPublicationEvents>;

/** The commerce profile a merchant saves, as the repository takes it. */
export interface LocationPublicationWrite {
  readonly locationId: string;
  readonly storeId: string;
  readonly storefrontId: string | null;
  readonly pickupOffered: boolean;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly inventorySource: LocationInventorySource;
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock: boolean;
  readonly lowStockThreshold: number;
}

/** Read one location's publication, whatever state it is in. */
export async function findPublicationByLocationId(
  locationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow | null> {
  const [row] = await db
    .select()
    .from(locationPublications)
    .where(eq(locationPublications.locationId, locationId))
    .limit(1);
  return row ?? null;
}

/** Read one publication by its own id. */
export async function findPublicationById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow | null> {
  const [row] = await db
    .select()
    .from(locationPublications)
    .where(eq(locationPublications.id, id))
    .limit(1);
  return row ?? null;
}

/** Every publication a store owns, for its dashboard. */
export async function listPublicationsForStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow[]> {
  return db
    .select()
    .from(locationPublications)
    .where(eq(locationPublications.storeId, storeId))
    .orderBy(asc(locationPublications.createdAt), asc(locationPublications.id));
}

/**
 * Create or replace one location's commerce profile.
 *
 * The publication STATE is deliberately not writable here. Publishing is a
 * separate act with its own audit entry and its own permission check, and
 * folding it into the profile save would mean every edit re-asserted a
 * publication decision — so a merchant fixing a typo on a withdrawn location
 * would silently republish it.
 */
export async function upsertLocationPublication(
  input: LocationPublicationWrite,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow> {
  const profile = {
    storefrontId: input.storefrontId,
    pickupOffered: input.pickupOffered,
    pickupInstructions: input.pickupInstructions,
    identityRequirement: input.identityRequirement,
    inventorySource: input.inventorySource,
    stockConfirmationIntervalSeconds: input.stockConfirmationIntervalSeconds,
    disclosesExactStock: input.disclosesExactStock,
    lowStockThreshold: input.lowStockThreshold,
  };
  const [row] = await db
    .insert(locationPublications)
    .values({ locationId: input.locationId, storeId: input.storeId, ...profile })
    // `location_id` is the arbiter and it is a PLAIN unique index with no
    // predicate, so no `where` is needed to infer it — unlike `carts`, whose
    // partial uniques force every `ON CONFLICT` to repeat the predicate.
    .onConflictDoUpdate({ target: locationPublications.locationId, set: profile })
    .returning();
  return row;
}

/**
 * Point a location at a GoWay place, auditing the change against its
 * publication.
 *
 * Written from the location the caller already authorized (`storeId` is in
 * the predicate, never trusted from a body), and a no-op when the id is
 * unchanged, so re-saving a form leaves no trail entry. `kind` says why the
 * link moved: the merchant chose a place, or a verify followed GoWay's merge.
 */
export async function setLocationPlaceLink(
  input: {
    storeId: string;
    locationId: string;
    publicationId: string;
    goWayPlaceId: string;
    previousGoWayPlaceId: string | null;
    kind: 'place_linked' | 'place_merge_followed';
    actorOxyUserId: string | null;
    at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (input.previousGoWayPlaceId === input.goWayPlaceId) return;
  await db
    .update(locations)
    .set({ goWayPlaceId: input.goWayPlaceId })
    .where(and(eq(locations.id, input.locationId), eq(locations.storeId, input.storeId)));
  await appendPublicationEvent(
    {
      publicationId: input.publicationId,
      kind: input.kind,
      actorOxyUserId: input.actorOxyUserId,
      previousGoWayPlaceId: input.previousGoWayPlaceId,
      nextGoWayPlaceId: input.goWayPlaceId,
      occurredAt: input.at,
    },
    db,
  );
}

/**
 * Move a publication's editorial state, auditing the move.
 *
 * The ONE writer of `published_at`: the first publication, kept forever. It is
 * stamped on a move INTO `published` and also on a move OUT of it, so a
 * location published by an image that never wrote the column still reads as
 * "was published" (a 410, not a 404, on the public surface) once withdrawn.
 * `coalesce` in the statement rather than off the row read above, so two
 * concurrent publishes cannot both believe they were first.
 */
export async function setPublicationState(
  input: {
    publicationId: string;
    state: LocationPublicationState;
    actorOxyUserId: string;
    at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow | null> {
  const existing = await findPublicationById(input.publicationId, db);
  if (!existing) return null;

  const touchesPublished = input.state === 'published' || existing.publicationState === 'published';
  const [row] = await db
    .update(locationPublications)
    .set({
      publicationState: input.state,
      // An ISO string cast in the statement: a `Date` bound into a raw `sql`
      // fragment bypasses the column's mapper and postgres.js refuses it.
      ...(touchesPublished
        ? {
            publishedAt: sql`coalesce(${locationPublications.publishedAt}, ${input.at.toISOString()}::timestamptz)`,
          }
        : {}),
    })
    .where(eq(locationPublications.id, input.publicationId))
    .returning();

  if (existing.publicationState !== input.state) {
    await appendPublicationEvent(
      {
        publicationId: input.publicationId,
        kind: input.state === 'published' ? 'published' : `state_${input.state}`,
        actorOxyUserId: input.actorOxyUserId,
        previousState: existing.publicationState,
        nextState: input.state,
        occurredAt: input.at,
      },
      db,
    );
  }
  return row ?? null;
}

/**
 * Pause or resume collection at ONE location (#93 operations rule 2).
 *
 * The instant and the reason move together, which the row's own CHECK also
 * demands: a paused location with no stated reason is the state neither the
 * merchant nor an operator can act on.
 */
export async function setPickupPause(
  input: { publicationId: string; paused: boolean; reason: string | null; actorOxyUserId: string; at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow | null> {
  const [row] = await db
    .update(locationPublications)
    .set({
      pickupPausedAt: input.paused ? input.at : null,
      pickupPauseReason: input.paused ? input.reason : null,
    })
    .where(eq(locationPublications.id, input.publicationId))
    .returning();
  if (!row) return null;

  await appendPublicationEvent(
    {
      publicationId: input.publicationId,
      kind: input.paused ? 'pickup_paused' : 'pickup_resumed',
      actorOxyUserId: input.actorOxyUserId,
      note: input.reason,
      occurredAt: input.at,
    },
    db,
  );
  return row;
}

/**
 * Raise or lift an OPERATOR restriction.
 *
 * Deliberately a different pair of columns from the merchant's pause: one is a
 * shop shutting its collection desk, the other is Mercaria withdrawing a place,
 * and a merchant must not be able to lift the second by un-pausing the first.
 */
export async function setPublicationRestriction(
  input: {
    publicationId: string;
    restricted: boolean;
    reason: string | null;
    actorOxyUserId: string;
    at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow | null> {
  const [row] = await db
    .update(locationPublications)
    .set({
      restrictedAt: input.restricted ? input.at : null,
      restrictionReason: input.restricted ? input.reason : null,
      restrictedByOxyUserId: input.restricted ? input.actorOxyUserId : null,
    })
    .where(eq(locationPublications.id, input.publicationId))
    .returning();
  if (!row) return null;

  await appendPublicationEvent(
    {
      publicationId: input.publicationId,
      kind: input.restricted ? 'restricted' : 'restriction_lifted',
      actorOxyUserId: input.actorOxyUserId,
      note: input.reason,
      occurredAt: input.at,
    },
    db,
  );
  return row;
}

/** Append one audit entry. The trail is append-only by trigger. */
export async function appendPublicationEvent(
  input: {
    publicationId: string;
    kind: string;
    actorOxyUserId?: string | null;
    previousGoWayPlaceId?: string | null;
    nextGoWayPlaceId?: string | null;
    previousState?: string | null;
    nextState?: string | null;
    note?: string | null;
    occurredAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(locationPublicationEvents).values({
    publicationId: input.publicationId,
    kind: input.kind,
    actorOxyUserId: input.actorOxyUserId ?? null,
    previousGoWayPlaceId: input.previousGoWayPlaceId ?? null,
    nextGoWayPlaceId: input.nextGoWayPlaceId ?? null,
    previousState: input.previousState ?? null,
    nextState: input.nextState ?? null,
    note: input.note ?? null,
    occurredAt: input.occurredAt,
  });
}

/** One publication's audit trail, newest first. */
export async function listPublicationEvents(
  publicationId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationEventRow[]> {
  return db
    .select()
    .from(locationPublicationEvents)
    .where(eq(locationPublicationEvents.publicationId, publicationId))
    .orderBy(desc(locationPublicationEvents.occurredAt))
    .limit(limit);
}
