/**
 * What Mercaria's own sellers actually GOT for a canonical variant (#91 price
 * guidance 3).
 *
 * ## Why this is a raw statement and not a repository composition
 *
 * The question spans four tables and reduces to two aggregates over the same
 * rows: the sale amounts and the number of DISTINCT sellers behind them. Reading
 * the order lines into the process and counting sellers in JavaScript would be
 * the same query with the privacy floor computed somewhere a reviewer would not
 * think to look for it, and would pull every matching line across the wire to
 * throw most of them away.
 *
 * ## Three things this read deliberately does NOT return
 *
 * No seller id, no buyer id, no order id. The caller's only legitimate outputs
 * are a range and a sample size, and a function that returned the identifiers
 * would let a future caller build "who sold this, and for how much" out of a
 * price-guidance endpoint. `distinctSellers` is a COUNT, computed in the
 * database, precisely so the ids never leave it.
 *
 * ## The condition group is matched on the ORDER LINE's snapshot, never the
 * listing's current one
 *
 * #90 froze the condition a buyer was shown onto the order item and refuses
 * every UPDATE to it. Reading the listing's condition instead would let a
 * seller's later correction retroactively move an old sale between segments,
 * which is exactly the rewriting that snapshot exists to prevent. Lines with no
 * snapshot (orders placed before #90) are excluded rather than guessed at.
 */

import { sql } from 'drizzle-orm';
import type { ConditionGroup, CurrencyCode, Money } from '@mercaria/shared-types';
import { conditionKeysInGroup } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** The whole of what a guidance caller may learn about other people's sales. */
export interface RecentNativeSales {
  readonly amounts: readonly Money[];
  readonly distinctSellers: number;
}

/**
 * Paid P2P sales of one canonical variant, in one condition group, in a window.
 *
 * The SHOP side of the line's `DualMoney` is what a seller got — the presentment
 * side is what one particular buyer saw in their own display currency, which is
 * a fact about that buyer's preferences rather than about the market.
 */
export async function readRecentNativeSales(
  input: {
    readonly canonicalVariantId: string;
    readonly conditionGroup: ConditionGroup;
    readonly from: Date;
    readonly to: Date;
    /** Bounds the scan. A guidance range does not get better past a few hundred. */
    readonly limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RecentNativeSales> {
  const keys = conditionKeysInGroup(input.conditionGroup);
  if (keys.length === 0) return { amounts: [], distinctSellers: 0 };
  const limit = input.limit;

  /**
   * The CTE is what keeps the seller ids inside the database.
   *
   * `count(distinct …)` cannot be a window function in PostgreSQL, so the
   * obvious single-statement form would have to select the id and count it in
   * this process — which would put every matching seller's account id into a
   * price-guidance code path. Naming the set once and asking it two questions
   * costs one extra scan of a small, indexed result and returns no identifier at
   * all.
   */
  const rows = await db.execute<{
    unit_price_shop_amount: string | number;
    unit_price_shop_currency: string;
    distinct_sellers: string | number;
  }>(sql`
    with sales as (
      select oi.unit_price_shop_amount,
             oi.unit_price_shop_currency,
             o.seller_oxy_user_id
        from order_items oi
        join orders o on o.id = oi.order_id
        join native_listing_links nll on nll.product_variant_id = oi.variant_id
       where nll.canonical_variant_id = ${input.canonicalVariantId}
         and nll.status = 'active'
         and o.seller_type = 'user'
         and o.seller_oxy_user_id is not null
         and o.status in ('paid', 'processing', 'shipped', 'delivered')
         and o.payment_paid_at >= ${input.from.toISOString()}::timestamptz
         and o.payment_paid_at <= ${input.to.toISOString()}::timestamptz
         and oi.condition_key = any(${sql.param([...keys])}::text[])
       limit ${limit}
    )
    select s.unit_price_shop_amount as unit_price_shop_amount,
           s.unit_price_shop_currency as unit_price_shop_currency,
           (select count(distinct seller_oxy_user_id) from sales) as distinct_sellers
      from sales s
  `);

  const amounts: Money[] = [];
  let distinctSellers = 0;
  for (const row of rows) {
    // postgres.js decodes `bigint` and `count(...)` as STRINGS; `Number(...)` at
    // the boundary is what stops a later sum becoming string concatenation.
    amounts.push({
      amount: Number(row.unit_price_shop_amount),
      currency: row.unit_price_shop_currency as CurrencyCode,
    });
    distinctSellers = Number(row.distinct_sellers);
  }

  return { amounts, distinctSellers };
}
