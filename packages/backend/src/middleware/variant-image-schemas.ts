/**
 * Request schema for a seller's own variant image selections (#855).
 *
 * `.strict()`, this repository's standing decision everywhere a surface takes
 * input: an undeclared key is REFUSED rather than stripped, because a stripped
 * key is a caller believing it asked for something it did not get.
 *
 * Here that is load-bearing rather than tidy. `position` is a real column on
 * the row this body writes and it is a SERVER decision — assigned from the
 * caller's array order by `replaceVariantImages`, so that a selection cannot be
 * stored with two photographs at position 0 and a non-deterministic render.
 * Because the schema is strict and declares no `position`, a request carrying
 * one is a 400 naming the key rather than an opinion silently dropped.
 *
 * `alt` is likewise absent, and for a stronger reason: alt text belongs to the
 * GALLERY entry, not to one variant's use of it. A variant image row carries no
 * `alt` column at all — `findVariantImages` reads it across the join from
 * `listing_images` — so accepting one here could only ever mean editing the
 * listing's gallery through a variant's door, which is the second write channel
 * this table's shape exists to prevent.
 */

import { z } from 'zod';

/**
 * Which of the listing's OWN gallery photographs this variant shows.
 *
 * ## Why `fileIds` and not gallery-row ids
 *
 * `product_variant_images.listing_image_id` names a `listing_images` ROW, and
 * that is the mechanism keeping cross-listing selections unrepresentable. But
 * no client can name one: `ListingImage` (`@mercaria/shared-types`) is
 * `{fileId, alt, position}` and carries no `id`, deliberately — #853's own
 * `VariantImageRecord` header argues that returning the join row "would invite
 * the second upload channel the table exists to prevent". Nothing in any DTO,
 * on either the listing read or the variant read, exposes a gallery row id.
 *
 * So the wire speaks the vocabulary the rest of the catalog write path already
 * speaks — `updateListing` takes `imageFileIds` — and the controller resolves
 * each file id against THIS LISTING'S gallery before any row is written. That
 * keeps every property the row-id spelling would have bought:
 *
 *  - a file that is not already in this listing's gallery is refused, so this
 *    is a SELECTION surface and not a second upload channel;
 *  - a foreign listing's photograph resolves to nothing here and, had it
 *    somehow reached the writer, is still refused by
 *    `product_variant_images_listing_image_fk`, which stays the authority.
 *
 * An EMPTY array is accepted and means "this variant shows the listing's
 * gallery again" — `resolveVariantImages`' fallback, which is the state every
 * variant starts in. It is the only way to clear a selection, so refusing it
 * would make the surface one-way.
 *
 * The 100 ceiling is not arithmetic about galleries; it is a bound on the
 * statement this becomes. `listing_images` has no cardinality limit, so an
 * unbounded array is an unbounded multi-row INSERT driven by one request.
 */
export const replaceVariantImagesSchema = z
  .object({
    fileIds: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();
