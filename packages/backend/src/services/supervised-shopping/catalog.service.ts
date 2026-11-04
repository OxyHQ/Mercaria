import { asc, gt } from 'drizzle-orm';
import type { ReviewedShoppingCart, ReviewedShoppingListing } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { catalogSafetyReviews } from '../../db/schema/supervisedShopping.js';
import { oxyClient } from '../../middleware/auth.js';
import { conflict, serviceUnavailable, validationError } from '../../lib/errors/error-codes.js';
import { getCart } from '../cart.service.js';
import { readCatalogReviewSources, reviewedShoppingProjection } from './catalog-review.service.js';

/** The bearer is the original verified user token. No local age/guardian policy or viewer-id shortcut. */
export async function readableShoppingListings(
  ids: readonly string[],
  accessToken: string,
): Promise<Map<string, ReviewedShoppingListing>> {
  const unique = [...new Set(ids)];
  const readable = new Map<string, ReviewedShoppingListing>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const sources = await readCatalogReviewSources(unique.slice(offset, offset + 100));
    const reviewed = sources
      .map((source) => reviewedShoppingProjection(source.candidate))
      .filter((item): item is ReviewedShoppingListing => item !== null);
    if (!reviewed.length) continue;
    const authors = new Map(
      sources.flatMap((source) =>
        'unavailableReason' in source.candidate
          ? []
          : [[source.candidate.listing.id, source.authorAccountId] as const],
      ),
    );
    const withAuthor = reviewed.flatMap((item) => {
      const authorAccountId = authors.get(item.id);
      return authorAccountId ? [{ item, authorAccountId }] : [];
    });
    if (!withAuthor.length) continue;
    let result: Awaited<ReturnType<typeof oxyClient.safety.contentAccessBatch>>;
    try {
      result = await oxyClient.safety.contentAccessBatch(
        {
          items: withAuthor.map(({ item, authorAccountId }) => ({
            resourceId: `mercaria:listing:${item.id}:${item.reviewDigest}`,
            classification: 'general',
            audience: 'public',
            authorAccountId,
          })),
        },
        { accessToken },
      );
    } catch {
      throw serviceUnavailable('Reviewed shopping is temporarily unavailable.');
    }
    const allowed = new Set(
      result.items.filter((item) => item.decision.allowed).map((item) => item.resourceId),
    );
    for (const { item } of withAuthor) {
      if (allowed.has(`mercaria:listing:${item.id}:${item.reviewDigest}`))
        readable.set(item.id, item);
    }
  }
  return readable;
}

export async function browseReviewedShopping(accessToken: string, cursor?: string) {
  if (cursor !== undefined && cursor.length > 128)
    throw validationError('Invalid shopping cursor.');
  // Scan reviewed IDs only, with stable pagination. Revocations/edits are checked
  // after this bounded page, so an empty page may still have a next cursor.
  const rows = await getDb()
    .selectDistinct({ id: catalogSafetyReviews.listingId })
    .from(catalogSafetyReviews)
    .where(cursor ? gt(catalogSafetyReviews.listingId, cursor) : undefined)
    .orderBy(asc(catalogSafetyReviews.listingId))
    .limit(51);
  const readable = await readableShoppingListings(
    rows.slice(0, 50).map(({ id }) => id),
    accessToken,
  );
  return { items: [...readable.values()], nextCursor: rows.length > 50 ? rows[49].id : null };
}

export async function readReviewedShoppingCart(
  buyerOxyUserId: string,
  accessToken: string,
): Promise<ReviewedShoppingCart> {
  const cart = await getCart({ owner: { kind: 'oxy_user', oxyUserId: buyerOxyUserId } });
  const lines = cart.groups.flatMap((group) => group.items);
  const readable = await readableShoppingListings(
    lines.map((line) => line.listingId),
    accessToken,
  );
  const items: ReviewedShoppingCart['items'] = lines.map((line) => {
    const listing = readable.get(line.listingId);
    const variant = listing?.variants.find((item) => item.id === line.variantId);
    // Text comes from the checked revision, never from an earlier cart read.
    return {
      listingId: line.listingId,
      variantId: line.variantId,
      quantity: line.quantity,
      selection:
        listing && variant
          ? {
              title: listing.title,
              variantTitle: variant.title,
              options: variant.options,
              unitPrice: line.unitPrice,
              lineTotal: line.lineTotal,
              stale: !!line.stale,
            }
          : null,
    };
  });
  return {
    items,
    subtotal: items.every((item) => item.selection !== null) ? cart.subtotal : null,
    checkoutAvailable:
      items.length > 0 && items.every((item) => item.selection !== null && !item.selection.stale),
  };
}

export async function assertReviewedShoppingCart(
  buyerOxyUserId: string,
  accessToken: string,
): Promise<void> {
  const cart = await readReviewedShoppingCart(buyerOxyUserId, accessToken);
  if (cart.items.length > 200 || cart.items.some((item) => item.quantity > 1_000_000)) {
    throw conflict('The basket exceeds the purchase approval limits.');
  }
  if (!cart.checkoutAvailable)
    throw conflict(
      'Some items are unavailable for supervised shopping. Remove them before continuing.',
    );
}
