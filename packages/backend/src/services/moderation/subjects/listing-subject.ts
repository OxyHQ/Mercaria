/**
 * Mercaria listings, as universal material.
 *
 * A listing is the marketplace's whole reason to exist and the object nearly every
 * report is about, so this provider is the one worth reading first.
 *
 * ## What a jury is given, and why it is more than the text
 *
 * A social post can be judged from its words. A listing usually cannot: the
 * commerce allegations turn on the relationship between the DESCRIPTION and the
 * COMMERCIAL TERMS. "Misleading listing" is a claim about a gap between what the
 * text promises and what the price, condition or stock say; "counterfeit" is a
 * claim about a brand-name item at an impossible price. Hand a reviewer the
 * description alone and they can only answer `insufficient_context` — correctly,
 * and uselessly.
 *
 * So the title and description are the subject, and price, currency, condition,
 * category and owner type travel as ONE `metadata` context resource. That is
 * context in the contract's sense — the minimum extra that makes the question
 * answerable — not extra exposure.
 *
 * ## Evidence: the gallery is attached by digest, as the bytes Oxy holds
 *
 * Each image travels as an `image` attachment whose `AssetRef` is filled from
 * ONE `oxyClient.assets.metadataByIds` call over the gallery — Oxy's own
 * `{sha256, mime, size, width, height}` for the file, read with Mercaria's
 * workload token. The digest is what pins the exact bytes reviewed, and it
 * enters the snapshot hash: a seller who swaps a photo has published a different
 * version, and a decision stays attached to the one reviewed.
 *
 * Bare Oxy file ids, never a `mercaria.co` URL: a reviewer's browser fetching a
 * URL on Mercaria's own host would tell that host exactly when its content is
 * under review, which is an attack on the blind-jury property the whole design
 * rests on. A file id is inert — it identifies without dereferencing.
 *
 * A file Oxy no longer has (deleted there) cannot be attached and is never given
 * an invented digest: its id is declared instead, with the reason. A metadata
 * read that FAILS throws — the delivery is retried — because a snapshot sent
 * without the images it should carry would ask a jury about less than was
 * reported.
 */

import { isLiveEntityId } from '@oxy.so/db';
import {
  findListingById,
  findListingChildren,
  type ListingImageRecord,
  type ListingRecord,
} from '../../../db/catalog/listingRepository.js';
import { findStoreById } from '../../../db/stores/storeRepository.js';
import { config } from '../../../config/index.js';
import { oxyClient } from '../../../middleware/auth.js';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/** Text length CrowdSource accepts inline. Beyond it the material is truncated. */
const MAX_TEXT_LENGTH = 4_000;

/**
 * A listing row plus the gallery the snapshot declares.
 *
 * The images are a child table, so they are loaded alongside the row rather
 * than projected out of it.
 */
interface SnapshotListing {
  listing: ListingRecord;
  images: ListingImageRecord[];
}

async function loadListing(listingId: string): Promise<SnapshotListing | null> {
  // `isLiveEntityId`, NOT a 24-hex ObjectId check: a listing created today
  // carries a uuid v7, and an ObjectId check REJECTS one — so that guard would
  // silently refuse to snapshot every new listing, and a
  // report against one would be stored with no subject to send.
  if (!isLiveEntityId(listingId)) return null;
  const listing = await findListingById(listingId);
  if (!listing) return null;
  const { images } = await findListingChildren([listingId]);
  return { listing, images: images.get(listingId) ?? [] };
}

/**
 * Who answers for this listing.
 *
 * A P2P listing is its seller's. A STORE listing belongs to the store, and the
 * principal is the Oxy account that OWNS the store (ADR 0012) — read
 * server-side from the store row, never taken from a request. A missing store
 * yields no principal at all rather than a guessed one: a wrong principal binds
 * a real person to someone else's case, which is worse than an unattributed one.
 */
async function resolveOwnerOxyUserId({ listing }: SnapshotListing): Promise<string | undefined> {
  if (listing.ownerType === 'user') return listing.oxyUserId ?? undefined;
  if (listing.storeId === null) return undefined;

  const store = await findStoreById(listing.storeId);
  return store?.oxyAccountId;
}

/**
 * The commercial terms, as one typed metadata resource.
 *
 * Values only — no free text and nothing a seller wrote beyond what is already in
 * the subject. Prices are integer minor units in the listing's own NATIVE
 * currency, which is what the catalogue actually stores; converting to a display
 * currency here would put an FX rate inside a hashed snapshot and make two
 * deliveries of one report differ.
 */
function commercialContext({ listing }: SnapshotListing): ModerationContextResource {
  return {
    role: 'context',
    type: 'metadata',
    data: {
      condition: listing.condition,
      ownerType: listing.ownerType,
      // The price range columns are nullable — a listing with no variant has no
      // range at all. Omitting the three keys together is what keeps the snapshot
      // hashable: a `null` and an absent key are different bytes, and a partial
      // range would let two deliveries of one report disagree.
      ...(listing.priceRangeMinAmount !== null &&
      listing.priceRangeMaxAmount !== null &&
      listing.priceRangeMinCurrency !== null
        ? {
            priceMinMinorUnits: listing.priceRangeMinAmount,
            priceMaxMinorUnits: listing.priceRangeMaxAmount,
            currency: listing.priceRangeMinCurrency,
          }
        : {}),
      ...(listing.vendor === null ? {} : { vendor: listing.vendor }),
      ...(listing.productType === null ? {} : { productType: listing.productType }),
      ...(listing.categorySlugs.length > 0
        ? { category: listing.categorySlugs[listing.categorySlugs.length - 1] }
        : {}),
    },
  };
}

/**
 * The gallery, as attachments Oxy can vouch for plus a declaration of any file
 * it no longer holds.
 *
 * Position order — the order the buyer sees, and a stable one, so two
 * deliveries of the same report produce the same bytes.
 */
async function galleryEvidence({ images }: SnapshotListing): Promise<{
  attachments: ModerationResource[];
  unavailable: ModerationContextResource | null;
}> {
  // `findListingChildren` already returns them in `position` order; sorting again
  // costs nothing and keeps the stability requirement stated where it matters.
  const fileIds = [...images]
    .sort((a, b) => a.position - b.position)
    .map((image) => image.fileId)
    .filter((fileId) => fileId.length > 0);
  if (fileIds.length === 0) return { attachments: [], unavailable: null };

  const metadata = new Map(
    (await oxyClient.assets.metadataByIds(fileIds)).map((file) => [file.id, file]),
  );
  const attachments: ModerationResource[] = [];
  const missing: string[] = [];
  for (const fileId of fileIds) {
    const file = metadata.get(fileId);
    if (!file) {
      missing.push(fileId);
      continue;
    }
    attachments.push({
      type: 'image',
      asset: {
        fileId,
        mimeType: file.mime,
        sha256: file.sha256,
        sizeBytes: file.size,
        ...(file.width === undefined ? {} : { width: file.width }),
        ...(file.height === undefined ? {} : { height: file.height }),
      },
    });
  }
  return {
    attachments,
    unavailable:
      missing.length === 0
        ? null
        : {
            role: 'evidence',
            type: 'metadata',
            data: {
              unavailableImageCount: missing.length,
              // Bare Oxy file ids. NEVER a mercaria.co URL — see the module comment.
              oxyFileIds: missing.join(','),
              evidenceUnavailableReason: 'asset_not_found',
            },
          },
  };
}

/** Where Mercaria's own buyers see it. Never fetched by a jury. */
function permalink(listingId: string): string {
  return `${config.web.origin}/products/${listingId}`;
}

/**
 * The listing body.
 *
 * Title and description together, because a listing's claim is split across both
 * and a jury reading only one is reading half the allegation.
 */
function listingText({ listing }: SnapshotListing): string {
  const title = listing.title.trim();
  const description = listing.description.trim();
  const body = description ? `${title}\n\n${description}` : title;
  return body.slice(0, MAX_TEXT_LENGTH);
}

export function createListingSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'listing',
    subjectType: 'commerce.listing',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const snapshot = await loadListing(reportedId);
      if (!snapshot) return null;

      const ownerOxyUserId = await resolveOwnerOxyUserId(snapshot);
      const listingId = snapshot.listing.id;

      const content: ModerationResource = {
        type: 'text',
        data: { text: listingText(snapshot) },
        createdAt: snapshot.listing.createdAt,
      };

      const context: ModerationContextResource[] = [commercialContext(snapshot)];
      const gallery = await galleryEvidence(snapshot);
      if (gallery.unavailable) context.push(gallery.unavailable);

      return {
        subject: {
          externalId: listingId,
          type: 'commerce.listing',
          permalink: permalink(listingId),
          ...(ownerOxyUserId === undefined ? {} : { author: { oxyUserId: ownerOxyUserId } }),
        },
        content,
        ...(gallery.attachments.length === 0 ? {} : { attachments: gallery.attachments }),
        context,
      };
    },
  };
}
