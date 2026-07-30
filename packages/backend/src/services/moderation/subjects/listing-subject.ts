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
 * ## Evidence: file ids are declared, not attached, and that is not laziness
 *
 * `AssetRef` requires a `sha256`. Mercaria stores images as
 * `{ fileId, alt, position }` and holds no digest for any of them, and the SDK
 * call that would resolve one (`getServiceAssetMetadataByIds`) requires a
 * SERVICE-configured Oxy client — `configureServiceAuth(apiKey, apiSecret)` —
 * which this deployment has never had. So the digest is not merely unread here,
 * it is not obtainable by this process today.
 *
 * Inventing one is out of the question: the digest is what pins the exact bytes
 * reviewed, and a fabricated value would make the snapshot claim to identify
 * material it does not.
 *
 * What travels instead is an honest declaration — how many images, and their bare
 * Oxy file ids. Bare ids, never a `mercaria.co` URL: a reviewer's browser fetching
 * a URL on Mercaria's own host would tell that host exactly when its content is
 * under review, which is an attack on the blind-jury property the whole design
 * rests on. A file id is inert — it identifies without dereferencing.
 *
 * **Closing this needs one thing, not a rewrite:** service credentials for the Oxy
 * client. With `configureServiceAuth` called at boot, one batched
 * `getServiceAssetMetadataByIds(fileIds)` returns `{sha256, mime, size, width,
 * height}` — `AssetRef` field-for-field — and `imageAttachments` below becomes a
 * map instead of a declaration. The trap to avoid when doing it: the digest MUST
 * enter the snapshot hash, because a seller who swaps the photo has published a
 * different version and the decision must stay attached to the one reviewed.
 */

import mongoose from 'mongoose';
import { Listing, type IListing } from '../../../models/listing.js';
import { Store } from '../../../models/store.js';
import { config } from '../../../config/index.js';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types.js';

/** Text length CrowdSource accepts inline. Beyond it the material is truncated. */
const MAX_TEXT_LENGTH = 4_000;

/** Only what a snapshot needs — never the whole catalogue row. */
const SNAPSHOT_PROJECTION =
  'title description condition status ownerType oxyUserId storeId images priceRange categorySlugs vendor productType createdAt';

type SnapshotListing = Pick<
  IListing,
  | '_id'
  | 'title'
  | 'description'
  | 'condition'
  | 'status'
  | 'ownerType'
  | 'oxyUserId'
  | 'storeId'
  | 'images'
  | 'priceRange'
  | 'categorySlugs'
  | 'vendor'
  | 'productType'
> & { createdAt?: Date };

async function loadListing(listingId: string): Promise<SnapshotListing | null> {
  if (!mongoose.isValidObjectId(listingId)) return null;
  return await Listing.findById(listingId)
    .select(SNAPSHOT_PROJECTION)
    .lean<SnapshotListing | null>();
}

/**
 * Who answers for this listing.
 *
 * A P2P listing is its seller's. A STORE listing belongs to the store, and the
 * principal is the store's OWNER — resolved server-side from the member list,
 * never taken from a request. A store with no owner row yields no principal at
 * all rather than a guessed one: a wrong principal binds a real person to someone
 * else's case, which is worse than an unattributed one.
 */
async function resolveOwnerOxyUserId(
  listing: SnapshotListing,
): Promise<string | undefined> {
  if (listing.ownerType === 'user') return listing.oxyUserId;
  if (listing.storeId === undefined) return undefined;
  if (!mongoose.isValidObjectId(listing.storeId)) return undefined;

  const store = await Store.findById(listing.storeId)
    .select('members.oxyUserId members.role')
    .lean<{ members?: { oxyUserId: string; role: string }[] } | null>();
  return store?.members?.find((member) => member.role === 'owner')?.oxyUserId;
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
function commercialContext(listing: SnapshotListing): ModerationContextResource {
  return {
    role: 'context',
    type: 'metadata',
    data: {
      condition: listing.condition,
      ownerType: listing.ownerType,
      priceMinMinorUnits: listing.priceRange.min.amount,
      priceMaxMinorUnits: listing.priceRange.max.amount,
      currency: listing.priceRange.min.currency,
      ...(listing.vendor === undefined ? {} : { vendor: listing.vendor }),
      ...(listing.productType === undefined ? {} : { productType: listing.productType }),
      ...(listing.categorySlugs.length > 0
        ? { category: listing.categorySlugs[listing.categorySlugs.length - 1] }
        : {}),
    },
  };
}

/**
 * What the listing's images ARE, since they cannot yet be what they show.
 *
 * File ids in `position` order — the order the buyer sees, and a stable one, so
 * two deliveries of the same report produce the same bytes.
 */
function declaredImages(listing: SnapshotListing): ModerationContextResource | null {
  const fileIds = [...listing.images]
    .sort((a, b) => a.position - b.position)
    .map((image) => image.fileId)
    .filter((fileId) => typeof fileId === 'string' && fileId.length > 0);
  if (fileIds.length === 0) return null;

  return {
    role: 'evidence',
    type: 'metadata',
    data: {
      imageCount: fileIds.length,
      // Bare Oxy file ids. NEVER a mercaria.co URL — see the module comment.
      oxyFileIds: fileIds.join(','),
      evidenceAttached: false,
      evidenceUnavailableReason: 'no_asset_digest_available',
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
function listingText(listing: SnapshotListing): string {
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
      const listing = await loadListing(reportedId);
      if (!listing) return null;

      const ownerOxyUserId = await resolveOwnerOxyUserId(listing);
      const listingId = listing._id.toHexString();

      const content: ModerationResource = {
        type: 'text',
        data: { text: listingText(listing) },
        ...(listing.createdAt === undefined
          ? {}
          : { createdAt: new Date(listing.createdAt) }),
      };

      const context: ModerationContextResource[] = [commercialContext(listing)];
      const images = declaredImages(listing);
      if (images) context.push(images);

      return {
        subject: {
          externalId: listingId,
          type: 'commerce.listing',
          permalink: permalink(listingId),
          ...(ownerOxyUserId === undefined
            ? {}
            : { author: { oxyUserId: ownerOxyUserId } }),
        },
        content,
        context,
      };
    },
  };
}
