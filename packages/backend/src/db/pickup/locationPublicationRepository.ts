/**
 * `location_publications` and its three children — the only writer.
 *
 * The publication is an UPSERT keyed on `location_id` rather than a
 * create-then-patch pair, because a merchant editing a shop front is editing
 * one object: a form that can create and a form that can update are two code
 * paths that will eventually disagree about which fields a partial save
 * clears. `upsertLocationPublication` takes the whole public profile and writes
 * it, and the caller is the one place that decides what a partial edit means.
 *
 * ## The audit is written HERE, in the same transaction
 *
 * #93 operations rule 5 asks for publication and geocoding changes to be
 * audited, and an audit written by the caller is one a second caller forgets.
 * Every state change and every coordinate move appends a
 * `location_publication_events` row inside the same transaction as the change
 * it records, so the trail cannot be missing an entry for a change that
 * committed.
 *
 * ## The store id is written from the location, never from the request
 *
 * `location_publications.store_id` is denormalized so a tenant predicate is one
 * column. That makes it exactly the shape a mass-assignment bug reaches for, so
 * it is never taken from an input object: the caller passes the LOCATION row it
 * already authorized, and this module reads the owner off that.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  LocationGeocodeProvenance,
  LocationInventorySource,
  LocationPublicationState,
  PickupIdentityRequirement,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  locationClosures,
  locationOpeningHours,
  locationPublicationEvents,
  locationPublications,
} from '../schema/pickup.js';

/** One row of `location_publications`. */
export type LocationPublicationRow = InferSelectModel<typeof locationPublications>;
/** One row of `location_opening_hours`. */
export type LocationOpeningHourRow = InferSelectModel<typeof locationOpeningHours>;
/** One row of `location_closures`. */
export type LocationClosureRow = InferSelectModel<typeof locationClosures>;
/** One row of `location_publication_events`. */
export type LocationPublicationEventRow = InferSelectModel<typeof locationPublicationEvents>;

/** The public profile a merchant saves, as the repository takes it. */
export interface LocationPublicationWrite {
  readonly locationId: string;
  readonly storeId: string;
  readonly storefrontId: string | null;
  readonly displayName: string;
  readonly publicLine1: string | null;
  readonly publicLine2: string | null;
  readonly publicCity: string | null;
  readonly publicRegion: string | null;
  readonly publicPostalCode: string | null;
  readonly publicCountry: string;
  readonly timezone: string;
  readonly publicPhone: string | null;
  readonly publicUrl: string | null;
  readonly accessibilityStepFree: boolean | null;
  readonly accessibilityToilet: boolean | null;
  readonly accessibilityParking: boolean | null;
  readonly accessibilityHearingLoop: boolean | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geocodeProvenance: LocationGeocodeProvenance | null;
  readonly geocodedAt: Date | null;
  readonly pickupOffered: boolean;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly inventorySource: LocationInventorySource;
  readonly stockConfirmationIntervalSeconds: number;
  readonly disclosesExactStock: boolean;
  readonly lowStockThreshold: number;
  readonly profileConfirmedAt: Date;
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
    .orderBy(asc(locationPublications.displayName));
}

/**
 * Create or replace one location's public profile, auditing a coordinate move.
 *
 * The publication STATE is deliberately not writable here. Publishing is a
 * separate act with its own audit entry and its own permission check, and
 * folding it into the profile save would mean every edit re-asserted a
 * publication decision — so a merchant fixing a typo on a withdrawn location
 * would silently republish it.
 */
export async function upsertLocationPublication(
  input: LocationPublicationWrite,
  actorOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationPublicationRow> {
  const existing = await findPublicationByLocationId(input.locationId, db);

  const [row] = await db
    .insert(locationPublications)
    .values({
      locationId: input.locationId,
      storeId: input.storeId,
      storefrontId: input.storefrontId,
      displayName: input.displayName,
      publicLine1: input.publicLine1,
      publicLine2: input.publicLine2,
      publicCity: input.publicCity,
      publicRegion: input.publicRegion,
      publicPostalCode: input.publicPostalCode,
      publicCountry: input.publicCountry,
      timezone: input.timezone,
      publicPhone: input.publicPhone,
      publicUrl: input.publicUrl,
      accessibilityStepFree: input.accessibilityStepFree,
      accessibilityToilet: input.accessibilityToilet,
      accessibilityParking: input.accessibilityParking,
      accessibilityHearingLoop: input.accessibilityHearingLoop,
      latitude: input.latitude,
      longitude: input.longitude,
      geocodeProvenance: input.geocodeProvenance,
      geocodedAt: input.geocodedAt,
      pickupOffered: input.pickupOffered,
      pickupInstructions: input.pickupInstructions,
      identityRequirement: input.identityRequirement,
      inventorySource: input.inventorySource,
      stockConfirmationIntervalSeconds: input.stockConfirmationIntervalSeconds,
      disclosesExactStock: input.disclosesExactStock,
      lowStockThreshold: input.lowStockThreshold,
      profileConfirmedAt: input.profileConfirmedAt,
    })
    // `location_id` is the arbiter and it is a PLAIN unique index with no
    // predicate, so no `where` is needed to infer it — unlike `carts`, whose
    // partial uniques force every `ON CONFLICT` to repeat the predicate.
    .onConflictDoUpdate({
      target: locationPublications.locationId,
      set: {
        storefrontId: input.storefrontId,
        displayName: input.displayName,
        publicLine1: input.publicLine1,
        publicLine2: input.publicLine2,
        publicCity: input.publicCity,
        publicRegion: input.publicRegion,
        publicPostalCode: input.publicPostalCode,
        publicCountry: input.publicCountry,
        timezone: input.timezone,
        publicPhone: input.publicPhone,
        publicUrl: input.publicUrl,
        accessibilityStepFree: input.accessibilityStepFree,
        accessibilityToilet: input.accessibilityToilet,
        accessibilityParking: input.accessibilityParking,
        accessibilityHearingLoop: input.accessibilityHearingLoop,
        latitude: input.latitude,
        longitude: input.longitude,
        geocodeProvenance: input.geocodeProvenance,
        geocodedAt: input.geocodedAt,
        pickupOffered: input.pickupOffered,
        pickupInstructions: input.pickupInstructions,
        identityRequirement: input.identityRequirement,
        inventorySource: input.inventorySource,
        stockConfirmationIntervalSeconds: input.stockConfirmationIntervalSeconds,
        disclosesExactStock: input.disclosesExactStock,
        lowStockThreshold: input.lowStockThreshold,
        profileConfirmedAt: input.profileConfirmedAt,
      },
    })
    .returning();

  const moved =
    existing !== null &&
    (existing.latitude !== input.latitude || existing.longitude !== input.longitude);
  if (moved || (existing === null && input.latitude !== null)) {
    await appendPublicationEvent(
      {
        publicationId: row.id,
        kind: 'geocode_changed',
        actorOxyUserId,
        previousLatitude: existing?.latitude ?? null,
        previousLongitude: existing?.longitude ?? null,
        nextLatitude: input.latitude,
        nextLongitude: input.longitude,
        occurredAt: input.profileConfirmedAt,
      },
      db,
    );
  }

  return row;
}

/** Move a publication's editorial state, auditing the move. */
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

  const [row] = await db
    .update(locationPublications)
    .set({ publicationState: input.state })
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

/**
 * Replace a publication's whole weekly schedule.
 *
 * Delete-then-insert rather than a diff: a schedule is a SET, an edit that
 * removed Wednesday has no row to update, and reconciling a diff against a
 * unique on `(publication, weekday, opens)` is three code paths where one
 * suffices. The pair runs in the caller's transaction so a half-replaced week
 * is not a state anything can observe.
 */
export async function replaceOpeningHours(
  input: {
    publicationId: string;
    hours: readonly { weekday: number; opensMinute: number; closesMinute: number }[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(locationOpeningHours)
    .where(eq(locationOpeningHours.publicationId, input.publicationId));
  if (input.hours.length === 0) return;
  await db.insert(locationOpeningHours).values(
    input.hours.map((hour) => ({
      publicationId: input.publicationId,
      weekday: hour.weekday,
      opensMinute: hour.opensMinute,
      closesMinute: hour.closesMinute,
    })),
  );
}

/** Every opening interval for a set of publications, in one statement. */
export async function listOpeningHours(
  publicationIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationOpeningHourRow[]> {
  if (publicationIds.length === 0) return [];
  return db
    .select()
    .from(locationOpeningHours)
    .where(inArray(locationOpeningHours.publicationId, [...publicationIds]))
    .orderBy(asc(locationOpeningHours.weekday), asc(locationOpeningHours.opensMinute));
}

/**
 * Every closure for a set of publications that has not fully elapsed.
 *
 * Bounded on `through_date >= today` so a shop with ten years of past holidays
 * does not carry them into every nearby response. Past closures stay in the
 * table — they are what a "why was this shut on the 6th" question reads.
 */
export async function listActiveClosures(
  publicationIds: readonly string[],
  today: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationClosureRow[]> {
  if (publicationIds.length === 0) return [];
  return db
    .select()
    .from(locationClosures)
    .where(
      and(
        inArray(locationClosures.publicationId, [...publicationIds]),
        sql`${locationClosures.throughDate} >= ${today}::date`,
      ),
    )
    .orderBy(asc(locationClosures.fromDate));
}

/** Add one dated closure. */
export async function insertClosure(
  input: { publicationId: string; fromDate: string; throughDate: string; note: string | null },
  db: DatabaseOrTransaction = getDb(),
): Promise<LocationClosureRow> {
  const [row] = await db
    .insert(locationClosures)
    .values({
      publicationId: input.publicationId,
      fromDate: input.fromDate,
      throughDate: input.throughDate,
      note: input.note,
    })
    .returning();
  return row;
}

/** Remove one closure. Returns whether a row was actually removed. */
export async function deleteClosure(
  input: { publicationId: string; closureId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const removed = await db
    .delete(locationClosures)
    .where(
      and(
        eq(locationClosures.id, input.closureId),
        eq(locationClosures.publicationId, input.publicationId),
      ),
    )
    .returning({ id: locationClosures.id });
  return removed.length > 0;
}

/** Append one audit entry. The trail is append-only by trigger. */
export async function appendPublicationEvent(
  input: {
    publicationId: string;
    kind: string;
    actorOxyUserId?: string | null;
    previousLatitude?: number | null;
    previousLongitude?: number | null;
    nextLatitude?: number | null;
    nextLongitude?: number | null;
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
    previousLatitude: input.previousLatitude ?? null,
    previousLongitude: input.previousLongitude ?? null,
    nextLatitude: input.nextLatitude ?? null,
    nextLongitude: input.nextLongitude ?? null,
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
