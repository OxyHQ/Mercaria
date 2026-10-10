/**
 * Stage `reference_promotion` — a seeded draft becomes shopper-visible once
 * there is something to compare on it (ADR 0014 D3).
 *
 * `reference_products` mints DRAFTS, which no shopper sees
 * (`SHOPPER_VISIBLE_CATALOG_STATUSES`). A reference record with a name, a
 * photo and no price anywhere is a catalogue entry, not a comparison, and a
 * page full of them is noise. So a draft is promoted only when ALL hold:
 *
 * 1. `reference_products` minted it — the page reads that stage's own APPLY
 *    records, so a provisional draft minted from a seller's listing is never
 *    examined here (its review is #59's);
 * 2. it is still a `draft` (an operator who suppressed or activated it has
 *    decided already);
 * 3. one of its variants still holds an ACTIVE identifier;
 * 4. at least one ACTIVE offer of it carries a price — a price is persisted
 *    on an offer only under the source's `display_price` right, so this is
 *    "a price somebody may be shown".
 *
 * Promotion goes through `updateCanonicalProduct` via the writer, which stamps
 * the review. A dry run reports what it would promote.
 */

import { and, asc, eq, gt, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { catalogBackfillRecords } from '../../../db/schema/backfill.js';
import { canonicalProducts, canonicalVariants, productIdentifiers } from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import {
  examineAll,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

export async function runReferencePromotionPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const keyset: SQL | undefined = context.cursor === null ? undefined : gt(canonicalProducts.id, context.cursor);

  // Rules 1 and 2 as the page: drafts this stage's sibling minted under APPLY.
  const rows = await db
    .selectDistinct({ id: canonicalProducts.id })
    .from(catalogBackfillRecords)
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, catalogBackfillRecords.canonicalProductId))
    .where(and(
      eq(catalogBackfillRecords.stage, 'reference_products'),
      eq(catalogBackfillRecords.mode, 'apply'),
      eq(catalogBackfillRecords.reasonCode, 'reference_product_minted'),
      eq(canonicalProducts.status, 'draft'),
      keyset,
    ))
    .orderBy(asc(canonicalProducts.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'canonical_product', canonicalProductId: row.id }),
    (row) => decideProduct(context, row.id),
  );
  return { counters, nextCursor: rows.length < context.limit ? null : (rows[rows.length - 1]?.id ?? null) };
}

async function decideProduct(context: StageContext, productId: string): Promise<SubjectVerdict> {
  const db = getDb();
  const variantIds = (
    await db.select({ id: canonicalVariants.id }).from(canonicalVariants).where(eq(canonicalVariants.productId, productId))
  ).map((row) => row.id);
  if (variantIds.length === 0) {
    return { reasonCode: 'promotion_awaiting_offer', detail: `product ${productId} has no variant` };
  }

  // Rule 3.
  const [identifier] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productIdentifiers)
    .where(and(inArray(productIdentifiers.variantId, variantIds), eq(productIdentifiers.status, 'active')));
  if ((identifier?.count ?? 0) === 0) {
    return { reasonCode: 'promotion_awaiting_offer', detail: `product ${productId} holds no active identifier` };
  }

  // Rule 4.
  const [priced] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(offers)
    .where(and(
      inArray(offers.canonicalVariantId, variantIds),
      eq(offers.status, 'active'),
      isNotNull(offers.priceAmount),
    ));
  const pricedOffers = priced?.count ?? 0;
  if (pricedOffers === 0) {
    return { reasonCode: 'promotion_awaiting_offer', detail: `product ${productId} has no active priced offer yet` };
  }

  await context.writer.promoteProduct({ productId, actorOxyUserId: context.actorOxyUserId });
  return {
    reasonCode: 'reference_product_promoted',
    detail: `product ${productId} promoted with ${String(pricedOffers)} priced offer(s)`,
    canonicalProductId: productId,
  };
}
