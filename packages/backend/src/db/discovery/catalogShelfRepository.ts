/**
 * The CATALOGUE side of a discovery shelf: canonical products ordered by one
 * {@link DiscoverySignal}, for the slots a shelf has left after a Mercaria
 * store's listings (`services/discovery/shelf-products.service.ts`).
 *
 * Every product is ONE row of `canonical_products` — a store's listing and a
 * price-comparison product alike — and every way to buy it is a row of
 * `offers`. A shelf used to read `listings` alone, so the catalogue's products
 * (all but the few with a native offer) never appeared on the home, explore,
 * category or deals pages.
 *
 * A product qualifies when, right now:
 * - it is `active`;
 * - it SHOWS an image (an active `canonical_images` row holding an Oxy file) —
 *   a blank card is not discovery;
 * - it has a CURRENT priced offer that is not native (`status = 'active'` and
 *   `stale_at > now()`, the same currency rule search applies,
 *   `db/search/searchOfferRepository.ts`);
 * - it has NO active native offer: a product a Mercaria store sells is already
 *   on the shelf as that store's listing, ahead of the catalogue.
 *
 * The orderings a catalogue product has data for:
 * - `new` — when it entered the catalogue (`created_at`, the
 *   `canonical_products_status_created_at_idx` walk);
 * - `on-sale` — its CHEAPEST current offer carries a higher compare-at price in
 *   the same currency, deepest discount first (the price the card shows is that
 *   cheapest offer's, so a sale anywhere else would be a price the card cannot
 *   show);
 * - `top-rated` — the product-level rating, floored at the same review count a
 *   listing needs (`config.discovery.topRatedMinReviews`).
 *
 * `best-selling` and `most-viewed` are counted only for listings
 * (`discovery_signals`), so the catalogue adds nothing to them.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DiscoverySignal } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

export interface FindCatalogProductsBySignalInput {
  readonly signal: DiscoverySignal;
  /** The ACTIVE categories to scope to (a subtree, or the whole active taxonomy). */
  readonly categoryIds: readonly string[];
  /**
   * Also the products the catalogue has filed under NO category (the home and
   * explore's root): unfiled is not hidden, where a product filed under a
   * suppressed category is — that category is not among `categoryIds`.
   */
  readonly includeUncategorized: boolean;
  readonly limit: number;
  readonly offset: number;
}

/** One page of canonical product ids for a signal, in shelf order. */
export async function findCatalogProductIdsBySignal(
  input: FindCatalogProductsBySignalInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (input.limit < 1) return [];
  if (input.categoryIds.length === 0 && !input.includeUncategorized) return [];
  switch (input.signal) {
    case 'new':
      return pageOf(db, input, sql`p.created_at desc nulls last, p.id desc`);
    case 'top-rated':
      return pageOf(
        db,
        input,
        sql`p.rating desc, p.rating_count desc, p.id desc`,
        sql`p.rating_count >= ${config.discovery.topRatedMinReviews}`,
      );
    case 'on-sale':
      return findOnSaleCatalogProductIds(db, input);
    case 'best-selling':
    case 'most-viewed':
      return [];
  }
}

/** `p` shows on a public shelf: active, imaged, priced elsewhere, not sold natively. */
function shelfEligible(): SQL {
  return sql`p.status = 'active'
    and exists (
      select 1 from canonical_images ci
       where ci.product_id = p.id and ci.status = 'active' and ci.file_id is not null
    )
    and exists (
      select 1 from canonical_variants v
        join offers o on o.canonical_variant_id = v.id
       where v.product_id = p.id
         and o.status = 'active' and o.stale_at > now()
         and o.kind <> 'native' and o.price_amount is not null
    )
    and not exists (
      select 1 from canonical_variants v
        join offers o on o.canonical_variant_id = v.id
       where v.product_id = p.id and o.status = 'active' and o.kind = 'native'
    )`;
}

function categoryScope(input: FindCatalogProductsBySignalInput): SQL {
  const filed = sql`p.category_id = any(${sql.param([...input.categoryIds])}::text[])`;
  return input.includeUncategorized ? sql`(${filed} or p.category_id is null)` : filed;
}

async function pageOf(
  db: DatabaseOrTransaction,
  input: FindCatalogProductsBySignalInput,
  orderBy: SQL,
  extra: SQL = sql`true`,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select p.id
      from canonical_products p
     where ${categoryScope(input)}
       and ${extra}
       and ${shelfEligible()}
     order by ${orderBy}
     limit ${input.limit} offset ${input.offset}`);
  return rows.map((row) => String(row.id));
}

/** The first window of discounted offers `on-sale` walks; it doubles while short. */
const ON_SALE_FIRST_WINDOW = 200;

/**
 * `on-sale`: products whose CHEAPEST current non-native offer is discounted, by
 * the depth of that discount.
 *
 * Walks the discounted offers deepest discount first along
 * `offers_sale_discount_idx`, one WINDOW at a time, keeping an offer only when
 * no cheaper current offer of its product exists and the product is on the
 * shelf. A product appears once, at its deepest such discount (the first time
 * the walk meets it). The walk stops as soon as `offset + limit` products are
 * found, so the per-offer checks run on the head of the ranking — never on
 * every discounted offer, which is what made the cold home feed take 30 s
 * (2026-10-20). A window that comes back short of its size is the end of the
 * ranking.
 */
async function findOnSaleCatalogProductIds(
  db: DatabaseOrTransaction,
  input: FindCatalogProductsBySignalInput,
): Promise<string[]> {
  const wanted = input.offset + input.limit;
  for (let window = Math.max(ON_SALE_FIRST_WINDOW, wanted * 4); ; window *= 2) {
    const rows = await db.execute<{ offer_id: string; product_id: string | null }>(sql`
      select sale.id as offer_id, p.id as product_id
        from (
          select o.id, v.product_id, o.price_amount, o.price_currency,
                 (1 - o.price_amount::numeric / o.compare_at_price_amount) as discount
            from offers o
            join canonical_variants v on v.id = o.canonical_variant_id
           where o.status = 'active' and o.kind <> 'native'
             and o.price_amount is not null
             and o.compare_at_price_amount > o.price_amount
             and o.compare_at_price_currency = o.price_currency
             and o.stale_at > now()
           order by (1 - o.price_amount::numeric / o.compare_at_price_amount) desc, o.id desc
           limit ${window}
        ) sale
        left join lateral (
          select p.id
            from canonical_products p
           where p.id = sale.product_id
             and ${categoryScope(input)}
             and ${shelfEligible()}
             and not exists (
               select 1 from canonical_variants v2
                 join offers o2 on o2.canonical_variant_id = v2.id
                where v2.product_id = sale.product_id
                  and o2.status = 'active' and o2.stale_at > now() and o2.kind <> 'native'
                  and o2.price_currency = sale.price_currency
                  and o2.price_amount < sale.price_amount
             )
        ) p on true
       order by sale.discount desc, sale.id desc`);
    const products: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.product_id === null) continue;
      const id = String(row.product_id);
      if (seen.has(id)) continue;
      seen.add(id);
      products.push(id);
    }
    if (products.length >= wanted || rows.length < window) {
      return products.slice(input.offset, wanted);
    }
  }
}

/** The compare-at price of each product's cheapest current non-native offer, when discounted. */
export async function findCatalogCompareAtPrices(
  productIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, { price: number; compareAt: number; currency: string }>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.execute<{
    product_id: string;
    price_amount: string | number;
    compare_at_price_amount: string | number | null;
    price_currency: string;
    compare_at_price_currency: string | null;
  }>(sql`
    select distinct on (v.product_id)
           v.product_id, o.price_amount, o.compare_at_price_amount,
           o.price_currency, o.compare_at_price_currency
      from offers o
      join canonical_variants v on v.id = o.canonical_variant_id
     where v.product_id = any(${sql.param([...productIds])}::text[])
       and o.status = 'active' and o.stale_at > now() and o.kind <> 'native'
       and o.price_amount is not null
     order by v.product_id, o.price_amount asc, o.id asc`);
  const byProduct = new Map<string, { price: number; compareAt: number; currency: string }>();
  for (const row of rows) {
    const price = Number(row.price_amount);
    const compareAt =
      row.compare_at_price_amount === null ? null : Number(row.compare_at_price_amount);
    if (
      compareAt !== null &&
      compareAt > price &&
      row.compare_at_price_currency === row.price_currency
    ) {
      byProduct.set(String(row.product_id), {
        price,
        compareAt,
        currency: row.price_currency,
      });
    }
  }
  return byProduct;
}
