/**
 * `seller_listing_drafts` and its two child tables (#91).
 *
 * The write shapes worth knowing about before adding one:
 *
 *  - **`ensureDraft` is `ON CONFLICT DO NOTHING` plus a read**, not an upsert.
 *    A retried "start selling" tap must resume the draft it already created and
 *    must NOT overwrite the entry path or the match a later step recorded on it
 *    — the `ensureGuestCheckout` decision (#105), for its reason.
 *  - **`stampPublication` is a CAS** on `published_listing_id IS NULL`. Its
 *    rowcount IS the answer: zero means somebody else published this draft, and
 *    the caller reads the winner's listing id rather than creating a second one.
 *  - **Coordinates are coarsened by the CALLER**, at the service boundary, so a
 *    precise position never reaches a column. This module writes what it is
 *    given, which is why it takes the already-rounded pair.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  ConditionDetailKind,
  ConditionDetailSeverity,
  ConditionPhotoProvenance,
  CurrencyCode,
  ItemConditionKey,
  SellerDraftEntryPath,
  SellerDraftMatchState,
  SellerDraftStatus,
  SellerDraftStep,
  SellerMatchActor,
  SellerPickupAvailability,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  sellerDraftConditionDetails,
  sellerDraftImages,
  sellerListingDrafts,
} from '../schema/sellYours.js';

export type SellerDraftRecord = InferSelectModel<typeof sellerListingDrafts>;
export type SellerDraftDetailRecord = InferSelectModel<typeof sellerDraftConditionDetails>;
export type SellerDraftImageRecord = InferSelectModel<typeof sellerDraftImages>;

/** A draft plus its children, which every read of one needs. */
export interface SellerDraftWithChildren {
  readonly draft: SellerDraftRecord;
  readonly details: readonly SellerDraftDetailRecord[];
  readonly images: readonly SellerDraftImageRecord[];
}

/** The columns a caller may set when the draft is first created. */
export interface NewSellerDraft {
  readonly oxyUserId: string;
  readonly clientDraftKey: string;
  readonly entryPath: SellerDraftEntryPath;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly matchState: SellerDraftMatchState;
  readonly matchActor: SellerMatchActor | null;
}

/**
 * Create the draft for this (owner, client key), or return the one that already
 * exists.
 *
 * `DO NOTHING` and then a read: a conflict is not an error and the existing row
 * is the answer. An upsert here would let the second tap of a double tap
 * overwrite an entry path — and with it the funnel's record of how the seller
 * arrived — with whatever the retry happened to carry.
 */
export async function ensureSellerDraft(
  input: NewSellerDraft,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftRecord> {
  await db
    .insert(sellerListingDrafts)
    .values({
      oxyUserId: input.oxyUserId,
      clientDraftKey: input.clientDraftKey,
      entryPath: input.entryPath,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId,
      matchState: input.matchState,
      matchActor: input.matchActor,
    })
    .onConflictDoNothing({
      target: [sellerListingDrafts.oxyUserId, sellerListingDrafts.clientDraftKey],
    });

  const [row] = await db
    .select()
    .from(sellerListingDrafts)
    .where(
      and(
        eq(sellerListingDrafts.oxyUserId, input.oxyUserId),
        eq(sellerListingDrafts.clientDraftKey, input.clientDraftKey),
      ),
    )
    .limit(1);
  if (!row) {
    // Unreachable through the insert above; a missing row here means the write
    // and the read disagreed, which is a real fault rather than a duplicate.
    throw new Error('Draft insert reported a conflict but no row could be read back');
  }
  return row;
}

/** The columns a step may patch. Every one is the SELLER's own statement. */
export interface SellerDraftPatch {
  currentStep?: SellerDraftStep;
  completedSteps?: SellerDraftStep[];
  canonicalProductId?: string | null;
  canonicalVariantId?: string | null;
  matchState?: SellerDraftMatchState;
  matchActor?: SellerMatchActor | null;
  matchConfidence?: number | null;
  title?: string | null;
  description?: string | null;
  categoryId?: string | null;
  tags?: string[];
  conditionKey?: ItemConditionKey | null;
  defectsAcknowledgedAt?: Date | null;
  includedAccessories?: string[];
  quantity?: number;
  priceAmount?: number | null;
  priceCurrency?: CurrencyCode | null;
  pickup?: SellerPickupAvailability;
  locationOptIn?: boolean;
  locationLongitude?: number | null;
  locationLatitude?: number | null;
  status?: SellerDraftStatus;
}

/**
 * Patch a draft the caller has already established they own.
 *
 * The ownership predicate is repeated in the `WHERE` anyway — a service that
 * checked the owner and then patched by id alone is one refactor away from an
 * IDOR, and repeating it costs nothing.
 */
export async function updateSellerDraft(
  id: string,
  oxyUserId: string,
  patch: SellerDraftPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftRecord | null> {
  if (Object.keys(patch).length === 0) {
    return findSellerDraft(id, oxyUserId, db);
  }
  const [row] = await db
    .update(sellerListingDrafts)
    .set(patch)
    .where(
      and(
        eq(sellerListingDrafts.id, id),
        eq(sellerListingDrafts.oxyUserId, oxyUserId),
        // A published draft is finished. Refusing the write here rather than in
        // the service means a second submit cannot edit what was published.
        isNull(sellerListingDrafts.publishedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** One draft belonging to this owner, or null. */
export async function findSellerDraft(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftRecord | null> {
  const [row] = await db
    .select()
    .from(sellerListingDrafts)
    .where(and(eq(sellerListingDrafts.id, id), eq(sellerListingDrafts.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/**
 * Lock one draft for publication.
 *
 * `FOR UPDATE` on the draft row is what serialises two concurrent submits: the
 * loser blocks here, and by the time it reads the row the winner has stamped the
 * listing id. The lock is the mechanism; the CAS in {@link stampPublication} is
 * the guarantee, and neither substitutes for the other.
 */
export async function lockSellerDraftForPublication(
  id: string,
  oxyUserId: string,
  tx: DatabaseOrTransaction,
): Promise<SellerDraftRecord | null> {
  const [row] = await tx
    .select()
    .from(sellerListingDrafts)
    .where(and(eq(sellerListingDrafts.id, id), eq(sellerListingDrafts.oxyUserId, oxyUserId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Stamp the listing this draft became, exactly once.
 *
 * A CAS on `published_listing_id IS NULL`, and the rowcount IS the answer — zero
 * means the draft was already published and the caller must return THAT listing
 * rather than the one it just created. The trigger refusing value→value is the
 * second layer: even a caller that ignored this result cannot overwrite it.
 */
export async function stampPublication(
  id: string,
  listingId: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(sellerListingDrafts)
    .set({
      publishedListingId: listingId,
      publishedAt: now,
      status: 'published',
      currentStep: 'review',
    })
    .where(and(eq(sellerListingDrafts.id, id), isNull(sellerListingDrafts.publishedListingId)))
    .returning({ id: sellerListingDrafts.id });
  return rows.length === 1;
}

/** This owner's drafts, newest activity first — the resume surface. */
export async function listSellerDrafts(
  oxyUserId: string,
  status: SellerDraftStatus,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftRecord[]> {
  return db
    .select()
    .from(sellerListingDrafts)
    .where(
      and(eq(sellerListingDrafts.oxyUserId, oxyUserId), eq(sellerListingDrafts.status, status)),
    )
    .orderBy(desc(sellerListingDrafts.updatedAt), desc(sellerListingDrafts.id))
    .limit(limit);
}

/** A draft with its details and images, in the order a client renders them. */
export async function findSellerDraftWithChildren(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftWithChildren | null> {
  const draft = await findSellerDraft(id, oxyUserId, db);
  if (!draft) return null;

  const [details, images] = await Promise.all([
    db
      .select()
      .from(sellerDraftConditionDetails)
      .where(eq(sellerDraftConditionDetails.draftId, id))
      .orderBy(asc(sellerDraftConditionDetails.position), asc(sellerDraftConditionDetails.id)),
    db
      .select()
      .from(sellerDraftImages)
      .where(eq(sellerDraftImages.draftId, id))
      .orderBy(asc(sellerDraftImages.position), asc(sellerDraftImages.id)),
  ]);

  return { draft, details, images };
}

/** One structured disclosure, as a client supplies it. */
export interface SellerDraftDetailInput {
  readonly kind: ConditionDetailKind;
  readonly severity?: ConditionDetailSeverity;
  readonly note?: string;
}

/**
 * Replace the draft's disclosures wholesale.
 *
 * A replace rather than a merge because the client edits the whole list and
 * sends it back: a partial update would need a stable client-side id per row for
 * a list somebody is still writing.
 *
 * The handle is REQUIRED rather than defaulted, because the delete and the
 * insert must commit together — a draft briefly holding no disclosures is a
 * draft that briefly fails its own condition's evidence gate, and the caller is
 * the only one that knows whether the gallery write belongs in the same
 * transaction.
 */
export async function replaceSellerDraftDetails(
  tx: DatabaseOrTransaction,
  draftId: string,
  details: readonly SellerDraftDetailInput[],
): Promise<SellerDraftDetailRecord[]> {
  await tx
    .delete(sellerDraftConditionDetails)
    .where(eq(sellerDraftConditionDetails.draftId, draftId));
  if (details.length === 0) return [];
  return tx
    .insert(sellerDraftConditionDetails)
    .values(
      details.map((detail, position) => ({
        draftId,
        kind: detail.kind,
        severity: detail.severity ?? null,
        note: detail.note ?? null,
        position,
      })),
    )
    .returning();
}

/** One seller-owned photograph, as a client supplies it. */
export interface SellerDraftImageInput {
  readonly fileId: string;
  readonly alt?: string;
  readonly provenance: ConditionPhotoProvenance;
  readonly showsDefect?: boolean;
}

/**
 * Replace the draft's gallery wholesale.
 *
 * The `conditionDetailId` link is deliberately NOT settable here: it points at a
 * row this same request may be replacing, so the service resolves it by POSITION
 * after both writes land. Accepting an id from a client would let one draft's
 * photograph cite another draft's disclosure, which the composite foreign key on
 * the published listing would then refuse at exactly the wrong moment.
 */
export async function replaceSellerDraftImages(
  tx: DatabaseOrTransaction,
  draftId: string,
  images: readonly SellerDraftImageInput[],
): Promise<SellerDraftImageRecord[]> {
  await tx.delete(sellerDraftImages).where(eq(sellerDraftImages.draftId, draftId));
  if (images.length === 0) return [];
  return tx
    .insert(sellerDraftImages)
    .values(
      images.map((image, position) => ({
        draftId,
        fileId: image.fileId,
        alt: image.alt ?? null,
        provenance: image.provenance,
        showsDefect: image.showsDefect ?? false,
        position,
      })),
    )
    .returning();
}

/** Point photographs at the disclosures they evidence, by row id. */
export async function linkSellerDraftImageDetails(
  tx: DatabaseOrTransaction,
  draftId: string,
  links: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [imageId, detailId] of links) {
    await tx
      .update(sellerDraftImages)
      .set({ conditionDetailId: detailId })
      .where(and(eq(sellerDraftImages.id, imageId), eq(sellerDraftImages.draftId, draftId)));
  }
}

/**
 * Which of these file ids a `canonical_images` row already claims, or another
 * account's listing already shows.
 *
 * A READ used to answer the client with a field-level 400 naming the offending
 * photograph. The database trigger is the authority and refuses the write
 * regardless; this exists so the seller gets "that picture is the catalogue's,
 * please add one of your own" instead of a constraint name.
 */
export async function findReusedImageFileIds(
  oxyUserId: string,
  fileIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await db.execute<{ file_id: string }>(sql`
    select distinct ci.file_id as file_id
      from canonical_images ci
     where ci.file_id = any(${sql.param([...fileIds])}::text[])
     union
    select distinct li.file_id as file_id
      from listing_images li
      join listings l on l.id = li.listing_id
     where li.file_id = any(${sql.param([...fileIds])}::text[])
       and (l.owner_type <> 'user' or l.oxy_user_id is distinct from ${oxyUserId})
  `);
  return [...rows].map((row) => row.file_id);
}

/** Every draft that named one of these listings — used by the publication probe. */
export async function findDraftsByPublishedListing(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerDraftRecord[]> {
  if (listingIds.length === 0) return [];
  return db
    .select()
    .from(sellerListingDrafts)
    .where(inArray(sellerListingDrafts.publishedListingId, [...listingIds]));
}
