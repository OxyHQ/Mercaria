/**
 * A seller choosing which gallery photographs each variant shows — the shared
 * half of a two-mount surface (#855).
 *
 * #853 landed `product_variant_images` with two composite foreign keys,
 * `findVariantImages`, and hydration that falls back to the listing gallery for
 * a variant with no selections. It landed no writer that production could
 * reach: `replaceVariantImages` had its own definition and five test references
 * and nothing else, so epic #367's "variant-level images" box named a table a
 * seller had no door onto. This is that door.
 *
 * ## One factory, two mounts, and NO third answer to "who owns this listing"
 *
 * The `listing-localizations` shape (#814), which took it from
 * `referral-partner`, for its reason. Mercaria already has two doors onto one
 * listing and each already knows how to answer ownership:
 * `/seller/listings/:id` compares `listings.oxy_user_id` against the verified
 * caller, and `/admin/stores/:storeId/products/:id` lets `loadStore` plus
 * `requireStorePermission` answer it and then compares `listings.store_id`.
 * Those two answers arrive here as a RESOLVER — the SAME `loadOwnedListing` and
 * `loadStoreProduct` the base `PATCH` handlers use — so this module contains no
 * ownership logic at all and cannot become a third answer that disagrees with
 * either.
 *
 * The resolver returns the loaded listing, so it has already thrown 404 (no such
 * listing) or 403 (somebody else's) before any variant or gallery row is read.
 *
 * ## Two lookups, both scoped by the listing the resolver already authorized
 *
 * Neither is an ownership check; both are containment lookups whose scope is a
 * listing the caller has already been proved to own, and each closes a hazard
 * that the composite foreign keys alone do NOT close:
 *
 *  - The VARIANT is resolved through `findVariantsByListing`, because
 *    `replaceVariantImages` opens with `delete … where variant_id = $1` and that
 *    statement is not scoped by listing. Handed a variant id belonging to
 *    somebody else's listing it would clear THAT variant's selections and only
 *    then fail on the insert — and with an empty `fileIds` it would return
 *    before there was any insert to fail. The foreign key cannot see this: it
 *    constrains rows being written, and this is a deletion.
 *
 *  - Each FILE ID is resolved against this listing's own gallery, which is what
 *    makes the surface a SELECTION rather than a second upload channel. A file
 *    the gallery does not hold is a 400 naming it, not a silently-dropped entry
 *    and not a new `listing_images` row.
 *
 * `product_variant_images_listing_image_fk` remains the authority on
 * cross-listing selection and is deliberately not restated as a service-layer
 * compare: a pre-check that could disagree with a constraint is worse than no
 * pre-check. What the gallery lookup adds is the honest 400 in front of it, and
 * a `23503` is still what would answer if this module were ever wrong.
 */

import { Router, type Request, type Response } from 'express';
import type { ListingImage } from '@mercaria/shared-types';
import type { ListingRecord } from '../db/catalog/listingRepository.js';
import { findListingGallery } from '../db/catalog/listingRepository.js';
import {
  findVariantImages,
  findVariantInListing,
  replaceVariantImages,
} from '../db/catalog/variantRepository.js';
import { validateBody } from '../middleware/validate.js';
import { replaceVariantImagesSchema } from '../middleware/variant-image-schemas.js';
import { resolveMedia } from '../services/catalog-hydration.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, notFound, validationError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/**
 * How a mount answers "which listing is this request about, and may this caller
 * act on it".
 *
 * Returning the LISTING rather than an id is the load-bearing part: it makes the
 * ownership read a precondition of reaching any handler body, so there is no
 * shape in which a handler runs having skipped it.
 */
export type VariantImageOwnerResolver = (req: Request) => Promise<ListingRecord>;

/**
 * Confirm `:variantId` is one of this listing's variants, and answer 404 if not.
 *
 * 404 rather than 403 because the subject is a variant of a listing the caller
 * DOES own — from where they stand, a variant id that is not in it does not
 * exist. Distinguishing "somebody else has it" would answer a question they did
 * not ask about a listing they cannot see.
 */
async function requireVariantId(req: Request, listing: ListingRecord): Promise<string> {
  const variantId = routeParam(req, 'variantId');
  // `findVariantInListing` — the SAME read `assertVariantInListing` uses for the
  // sibling variant routes, rather than a scan of `findVariantsByListing`. One
  // question, one answer: a second spelling of "is this variant in this listing"
  // is a second thing to get wrong.
  if (!(await findVariantInListing(listing.id, variantId))) {
    throw notFound('This listing has no such variant.');
  }
  return variantId;
}

/**
 * Turn the caller's file ids into the gallery ROW ids `product_variant_images`
 * stores, in the order they were given.
 *
 * ## The duplicate-file rule, stated because the gallery permits it
 *
 * `replaceListingImages` keeps two rows when a gallery legitimately holds one
 * file twice, so `file_id -> listing_images.id` is not injective. A named file
 * therefore resolves to its FIRST row by `(position, id)` — the same ordering
 * `findVariantImages` reads back by, so the row a selection lands on is the one
 * a client saw first in the gallery. Deterministic rather than arbitrary, which
 * is the property that matters; the two rows render the same photograph.
 *
 * Naming one file twice is not an error either: `replaceVariantImages`
 * de-duplicates in order, and `product_variant_images_variant_id_listing_image_id_key`
 * would refuse the second copy regardless. It resolves to one selection at its
 * first position.
 *
 * An unresolvable file is a 400 that NAMES it. A selection surface silently
 * dropping an entry is a caller believing a photograph is on a variant that is
 * not, with nothing anywhere saying so.
 */
async function resolveGalleryRowIds(
  listing: ListingRecord,
  fileIds: readonly string[],
): Promise<string[]> {
  if (fileIds.length === 0) return [];

  const gallery = await findListingGallery(listing.id);
  const byFileId = new Map<string, string>();
  for (const row of gallery) {
    // First wins; the rows arrive ordered by `(position, id)`.
    if (!byFileId.has(row.fileId)) byFileId.set(row.fileId, row.id);
  }

  const resolved: string[] = [];
  for (const fileId of fileIds) {
    const rowId = byFileId.get(fileId);
    if (rowId === undefined) {
      throw validationError(
        `'${fileId}' is not a photograph in this listing's gallery. ` +
          'Add it to the listing first, then select it for this variant.',
      );
    }
    resolved.push(rowId);
  }
  return resolved;
}

/**
 * One variant's selections, through the media chokepoint.
 *
 * `resolveMedia` for the reason `toVariantImageDTO` makes the same hop in
 * hydration: these rows come off `listing_images` by a different query, so a
 * variant's gallery would otherwise carry raw file ids while the listing's
 * carried resolved URLs — one screen, two spellings of one address.
 *
 * The listing-gallery FALLBACK is deliberately NOT applied here. Hydration owns
 * that rule and this is an AUTHORING view: a seller needs to see that this
 * variant has no selections of its own, which an answer showing the listing's
 * gallery would make indistinguishable from having selected all of it.
 */
function projectSelections(rows: readonly { fileId: string; alt: string | null; position: number }[]): ListingImage[] {
  return rows.map((row) => {
    const dto: ListingImage = { fileId: resolveMedia(row.fileId), position: row.position };
    if (row.alt) {
      dto.alt = row.alt;
    }
    return dto;
  });
}

/**
 * Build the sub-router. Mounted twice; see the header.
 *
 * `mergeParams` so the parent's `:id`, `:variantId` (and, on the store mount,
 * `:storeId`) are visible to the resolver and the handlers.
 *
 * ## Both mounts name the WHOLE path, and that is not cosmetic
 *
 * The routes here are `/`, so each mount is
 * `…/variants/:variantId/images` rather than the tidier-looking
 * `…/variants` with `/:variantId/images` inside. `router.use(prefix, mw)` runs
 * its middleware for EVERY request matching that prefix, whether or not any
 * route in the sub-router matches — and `/admin/stores/:storeId/products` has
 * four established siblings under `/:id/variants/:variantId`
 * (`PATCH`, `DELETE`, `…/inventory`, `…/levels`) whose permissions are NOT this
 * one: the inventory writes are `inventory:write` and the level read is
 * `products:read`. Mounting on the shorter prefix therefore silently puts
 * `products:write` in front of all four, so a member holding `inventory:write`
 * alone would stop being able to restock. Nothing would fail at build time and
 * the sub-router would still behave correctly, which is why the mount path is
 * spelled out.
 */
export function makeVariantImageRouter(resolveListing: VariantImageOwnerResolver): Router {
  const router = Router({ mergeParams: true });

  /**
   * GET — which photographs this variant has SELECTED.
   *
   * Empty means it has selected none and therefore shows the listing's gallery.
   * See `projectSelections` for why that is not spelled out by returning the
   * gallery.
   */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const listing = await resolveListing(req);
      const variantId = await requireVariantId(req, listing);
      const grouped = await findVariantImages([variantId]);
      sendSuccess(res, projectSelections(grouped.get(variantId) ?? []));
    } catch (err) {
      log.general.error({ err }, 'Failed to read variant images');
      respondWithError(res, err, 'Failed to read variant images');
    }
  });

  /**
   * PUT — replace which photographs this variant shows.
   *
   * PUT and a whole-list replace, not POST-one/DELETE-one: the ORDER is part of
   * the fact being stored and `replaceVariantImages` assigns positions from the
   * array, so a per-item surface would need a second way to express order and
   * the two could disagree. It also makes the surface idempotent — a retrying
   * client converges instead of colliding with
   * `product_variant_images_variant_id_listing_image_id_key`.
   *
   * The whole write is ONE call into a repository that deletes and re-inserts.
   * That is #853's deliberate shape and is left exactly as it is: nothing
   * references `product_variant_images.id`, so re-minting it loses nothing. It
   * is `replaceListingImages` that had to become convergent, because
   * `listing_images.id` IS referenced — by this very table — and a wholesale
   * replace there would take every variant's selections with it on every
   * connector sync.
   */
  router.put(
    '/',
    validateBody(replaceVariantImagesSchema),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const listing = await resolveListing(req);
        const variantId = await requireVariantId(req, listing);
        const body = req.body as { fileIds: string[] };
        const listingImageIds = await resolveGalleryRowIds(listing, body.fileIds);

        // `listing.id` is the VARIANT's own listing — `requireVariantId` proved
        // it — which is what the composite pair is checked against.
        await replaceVariantImages(listing.id, variantId, listingImageIds);

        const grouped = await findVariantImages([variantId]);
        sendSuccess(res, projectSelections(grouped.get(variantId) ?? []));
      } catch (err) {
        log.general.error({ err }, 'Failed to write variant images');
        respondWithError(res, err, 'Failed to write variant images');
      }
    },
  );

  return router;
}
