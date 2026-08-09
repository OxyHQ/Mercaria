/**
 * The listing-side condition tables (#90): structured details, photographic
 * evidence and the append-only revision trail.
 *
 * ## Everything here writes in a caller-supplied transaction
 *
 * A condition is a listing's disclosure, and the disclosure must land with the
 * listing or not at all: a listing that committed as `used_fair` while its
 * defect rows rolled back is a seller's item advertised as worse than they said
 * with nothing on the page explaining why. Every writer therefore takes a
 * `DatabaseOrTransaction` and the services pass the listing's own handle.
 *
 * ## What this module deliberately cannot do
 *
 * There is no `updateRevision` and no `deleteRevision`. The audit trail is
 * append-only by trigger as well, so the absence here is a convenience for the
 * reader rather than the enforcement — but a helper that existed would be the
 * first thing somebody reached for when a correction looked wrong.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  ConditionAssertion,
  ConditionDetailKind,
  ConditionDetailSeverity,
  ConditionPhotoModerationState,
  ConditionPhotoProvenance,
  ConditionRevisionActor,
  ItemConditionKey,
} from '@mercaria/shared-types';
import { EVIDENTIAL_CONDITION_PHOTO_STATES } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  listingConditionDetails,
  listingConditionPhotos,
  listingConditionRevisions,
} from '../schema/condition.js';

export type ConditionDetailRecord = InferSelectModel<typeof listingConditionDetails>;
export type ConditionPhotoRecord = InferSelectModel<typeof listingConditionPhotos>;
export type ConditionRevisionRecord = InferSelectModel<typeof listingConditionRevisions>;

/** One structured condition fact, as the writer supplies it. */
export interface NewConditionDetail {
  listingId: string;
  kind: ConditionDetailKind;
  severity?: ConditionDetailSeverity | null;
  note?: string | null;
  position: number;
}

/** One piece of photographic evidence, as the writer supplies it. */
export interface NewConditionPhoto {
  listingId: string;
  fileId: string;
  provenance: ConditionPhotoProvenance;
  uploadedByOxyUserId: string;
  uploadedAt: Date;
  showsDefect: boolean;
  conditionDetailId?: string | null;
}

/** One condition change, as the writer supplies it. */
export interface NewConditionRevision {
  listingId: string;
  fromCondition?: ItemConditionKey | null;
  toCondition: ItemConditionKey;
  fromAssertion?: ConditionAssertion | null;
  toAssertion: ConditionAssertion;
  actorKind: ConditionRevisionActor;
  actorOxyUserId?: string | null;
  reason: string;
}

/**
 * Replace a listing's structured condition details, returning the new rows in
 * the order they were supplied.
 *
 * A wholesale replace rather than a diff, and the ordering matters: the delete
 * runs first and cascades to any photo annotation pointing at a detail that is
 * going away, so a seller who removes a defect does not leave a photo claiming
 * to show it. The photo ROWS survive — only the annotation's parent is gone, and
 * the composite foreign key's `cascade` removes the annotation with it.
 *
 * Callers re-annotate afterwards, which is why {@link replaceConditionPhotos}
 * runs second in every service that calls both.
 */
export async function replaceConditionDetails(
  tx: DatabaseOrTransaction,
  listingId: string,
  details: readonly NewConditionDetail[],
): Promise<ConditionDetailRecord[]> {
  await tx.delete(listingConditionDetails).where(eq(listingConditionDetails.listingId, listingId));

  if (details.length === 0) return [];

  return tx
    .insert(listingConditionDetails)
    .values(
      details.map((detail) => ({
        listingId: detail.listingId,
        kind: detail.kind,
        severity: detail.severity ?? null,
        note: detail.note ?? null,
        position: detail.position,
      })),
    )
    .returning();
}

/**
 * Replace a listing's condition evidence.
 *
 * Also a wholesale replace: the evidence set is a statement about the listing as
 * it stands now, and merging would leave a photo of a defect the seller has
 * since removed sitting in the gallery as proof of it.
 *
 * `moderation_state` is NOT carried across a replace, and that is deliberate:
 * re-submitting evidence is re-submitting it, so a seller cannot launder a
 * rejected photograph by re-uploading the same file id. The `pending` default
 * puts it back in the queue.
 */
export async function replaceConditionPhotos(
  tx: DatabaseOrTransaction,
  listingId: string,
  photos: readonly NewConditionPhoto[],
): Promise<ConditionPhotoRecord[]> {
  await tx.delete(listingConditionPhotos).where(eq(listingConditionPhotos.listingId, listingId));

  if (photos.length === 0) return [];

  return tx
    .insert(listingConditionPhotos)
    .values(
      photos.map((photo) => ({
        listingId: photo.listingId,
        fileId: photo.fileId,
        provenance: photo.provenance,
        uploadedByOxyUserId: photo.uploadedByOxyUserId,
        uploadedAt: photo.uploadedAt,
        showsDefect: photo.showsDefect,
        conditionDetailId: photo.conditionDetailId ?? null,
      })),
    )
    .returning();
}

/** Append one condition change to the audit trail. */
export async function insertConditionRevision(
  tx: DatabaseOrTransaction,
  revision: NewConditionRevision,
): Promise<ConditionRevisionRecord> {
  const [row] = await tx
    .insert(listingConditionRevisions)
    .values({
      listingId: revision.listingId,
      fromCondition: revision.fromCondition ?? null,
      toCondition: revision.toCondition,
      fromAssertion: revision.fromAssertion ?? null,
      toAssertion: revision.toAssertion,
      actorKind: revision.actorKind,
      actorOxyUserId: revision.actorOxyUserId ?? null,
      reason: revision.reason,
    })
    .returning();

  if (!row) {
    throw new Error('Condition revision insert returned no row');
  }
  return row;
}

/** Every structured detail on one listing, in display order. */
export async function findConditionDetails(listingId: string): Promise<ConditionDetailRecord[]> {
  return getDb()
    .select()
    .from(listingConditionDetails)
    .where(eq(listingConditionDetails.listingId, listingId))
    .orderBy(asc(listingConditionDetails.position), asc(listingConditionDetails.id));
}

/** Every structured detail across a batch of listings — the feed-shaped read. */
export async function findConditionDetailsForListings(
  listingIds: readonly string[],
): Promise<ConditionDetailRecord[]> {
  if (listingIds.length === 0) return [];
  return getDb()
    .select()
    .from(listingConditionDetails)
    .where(inArray(listingConditionDetails.listingId, [...listingIds]))
    .orderBy(asc(listingConditionDetails.position), asc(listingConditionDetails.id));
}

/** Every evidence photo on one listing, oldest upload first. */
export async function findConditionPhotos(listingId: string): Promise<ConditionPhotoRecord[]> {
  return getDb()
    .select()
    .from(listingConditionPhotos)
    .where(eq(listingConditionPhotos.listingId, listingId))
    .orderBy(asc(listingConditionPhotos.uploadedAt), asc(listingConditionPhotos.id));
}

/** Every evidence photo across a batch of listings. */
export async function findConditionPhotosForListings(
  listingIds: readonly string[],
): Promise<ConditionPhotoRecord[]> {
  if (listingIds.length === 0) return [];
  return getDb()
    .select()
    .from(listingConditionPhotos)
    .where(inArray(listingConditionPhotos.listingId, [...listingIds]))
    .orderBy(asc(listingConditionPhotos.uploadedAt), asc(listingConditionPhotos.id));
}

/**
 * How many photos currently COUNT as evidence for one listing.
 *
 * The filter is the whole point and it is applied in SQL rather than by the
 * caller: only `EVIDENTIAL_CONDITION_PHOTO_STATES` count, so a listing whose
 * photographs were rejected stops satisfying its own condition's requirement
 * instead of keeping a pass it earned once. A caller counting rows itself would
 * be one forgotten predicate away from re-admitting them.
 *
 * There is deliberately no parameter for which states to count.
 */
export async function countEvidentialConditionPhotos(
  tx: DatabaseOrTransaction,
  listingId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(listingConditionPhotos)
    .where(
      and(
        eq(listingConditionPhotos.listingId, listingId),
        inArray(listingConditionPhotos.moderationState, [...EVIDENTIAL_CONDITION_PHOTO_STATES]),
      ),
    );

  return row?.total ?? 0;
}

/** One listing's condition history, newest first. */
export async function findConditionRevisions(
  listingId: string,
  limit: number,
): Promise<ConditionRevisionRecord[]> {
  return getDb()
    .select()
    .from(listingConditionRevisions)
    .where(eq(listingConditionRevisions.listingId, listingId))
    .orderBy(desc(listingConditionRevisions.createdAt), desc(listingConditionRevisions.id))
    .limit(limit);
}

/** Move one photo's moderation state, stamping the decision time with it. */
export async function setConditionPhotoModeration(
  tx: DatabaseOrTransaction,
  photoId: string,
  state: ConditionPhotoModerationState,
  decidedAt: Date,
): Promise<void> {
  await tx
    .update(listingConditionPhotos)
    .set({
      moderationState: state,
      // The CHECK pairs the two, so `pending` must clear the timestamp rather
      // than leave a stale decision time on a re-opened photo.
      moderatedAt: state === 'pending' ? null : decidedAt,
    })
    .where(eq(listingConditionPhotos.id, photoId));
}
