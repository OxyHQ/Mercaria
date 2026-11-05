/**
 * The repository of the paid store-page merchandising rules (#89,
 * `advanced_merchandising_rules`): the rule rows, their pins, and the ONE query
 * that orders a store's own listings by a rule.
 *
 * ## What this module reads, and what it never touches
 *
 * It READS `listings` (status, price, stock, publication), `listing_collections`
 * (membership, to restrict a collection's order to its members), `listing_images`
 * (a preview thumbnail) and paid `order_items` (units sold). It WRITES only its
 * own two tables. It never writes a listing, a collection or a membership row,
 * so a rule cannot change what the free catalogue says — and it is deliberately
 * not built on `listingRepository` or `catalog-hydration`, the ordering engines
 * marketplace discovery runs on: a rule orders ONE store's page, and nothing a
 * cross-store surface reads is reachable from here (`docs/merchandising-rules.md`).
 *
 * The visible set is the store page's own: `status = 'active'` and this
 * `store_id` (the predicate `GET /listings?storeId=` applies), plus membership
 * for a collection. A rule can reorder that set and never widen it — a pin on a
 * draft, archived or other-store listing has nothing to reorder.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  MerchandisingRuleKind,
  MerchandisingRuleTarget,
  MerchandisingSortStrategy,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingImages, listings } from '../schema/catalog.js';
import { listingCollections } from '../schema/merchandising.js';
import { merchandisingRulePins, merchandisingRules } from '../schema/merchandisingRules.js';
import { orderItems, orders } from '../schema/orders.js';

/** A rule row with its pins, in pin order. */
export type MerchandisingRuleRow = typeof merchandisingRules.$inferSelect & {
  pinnedListingIds: string[];
};

/** The columns a rule is written with. */
export interface MerchandisingRuleValues {
  kind: MerchandisingRuleKind;
  title: string;
  target: MerchandisingRuleTarget;
  collectionId: string | null;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  sortStrategy: MerchandisingSortStrategy | null;
  bestSellingWindowDays: number | null;
  inStockFirst: boolean;
  spotlightItemLimit: number | null;
}

async function attachPins(
  rows: (typeof merchandisingRules.$inferSelect)[],
  db: DatabaseOrTransaction,
): Promise<MerchandisingRuleRow[]> {
  if (rows.length === 0) return [];
  const pins = await db
    .select({ ruleId: merchandisingRulePins.ruleId, listingId: merchandisingRulePins.listingId })
    .from(merchandisingRulePins)
    .where(
      inArray(
        merchandisingRulePins.ruleId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(merchandisingRulePins.ruleId), asc(merchandisingRulePins.position));
  const byRule = new Map<string, string[]>();
  for (const pin of pins) {
    const list = byRule.get(pin.ruleId) ?? [];
    list.push(pin.listingId);
    byRule.set(pin.ruleId, list);
  }
  return rows.map((row) => ({ ...row, pinnedListingIds: byRule.get(row.id) ?? [] }));
}

/** Every rule of a store, oldest first, with pins. The admin list and the storefront read. */
export async function findMerchandisingRulesByStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchandisingRuleRow[]> {
  const rows = await db
    .select()
    .from(merchandisingRules)
    .where(eq(merchandisingRules.storeId, storeId))
    .orderBy(asc(merchandisingRules.createdAt), asc(merchandisingRules.id));
  return attachPins(rows, db);
}

/** One rule of a store, with pins; `null` when it is not this store's. */
export async function findMerchandisingRule(
  storeId: string,
  ruleId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchandisingRuleRow | null> {
  const rows = await db
    .select()
    .from(merchandisingRules)
    .where(and(eq(merchandisingRules.id, ruleId), eq(merchandisingRules.storeId, storeId)));
  const [row] = await attachPins(rows, db);
  return row ?? null;
}

/** Replace a rule's pins wholesale, in the caller's transaction. */
async function replacePins(
  tx: DatabaseOrTransaction,
  ruleId: string,
  listingIds: readonly string[],
): Promise<void> {
  await tx.delete(merchandisingRulePins).where(eq(merchandisingRulePins.ruleId, ruleId));
  if (listingIds.length > 0) {
    await tx
      .insert(merchandisingRulePins)
      .values(listingIds.map((listingId, position) => ({ ruleId, listingId, position })));
  }
}

/**
 * Insert a rule and its pins in the CALLER's transaction — the one that also
 * takes the plan allowance, so the row and the counter commit together.
 */
export async function insertMerchandisingRule(
  tx: DatabaseOrTransaction,
  storeId: string,
  values: MerchandisingRuleValues,
  pinnedListingIds: readonly string[],
): Promise<MerchandisingRuleRow> {
  const [row] = await tx
    .insert(merchandisingRules)
    .values({ storeId, ...values })
    .returning();
  await replacePins(tx, row.id, pinnedListingIds);
  return { ...row, pinnedListingIds: [...pinnedListingIds] };
}

/**
 * Update a rule's mutable columns (and, when given, its pins) in the caller's
 * transaction. `null` when no such rule belongs to the store.
 */
export async function updateMerchandisingRule(
  tx: DatabaseOrTransaction,
  storeId: string,
  ruleId: string,
  values: Omit<MerchandisingRuleValues, 'kind' | 'target' | 'collectionId'>,
  pinnedListingIds: readonly string[] | undefined,
): Promise<MerchandisingRuleRow | null> {
  const [row] = await tx
    .update(merchandisingRules)
    .set(values)
    .where(and(eq(merchandisingRules.id, ruleId), eq(merchandisingRules.storeId, storeId)))
    .returning();
  if (!row) return null;
  if (pinnedListingIds !== undefined) await replacePins(tx, row.id, pinnedListingIds);
  const [withPins] = await attachPins([row], tx);
  return withPins;
}

/**
 * Delete a rule in the caller's transaction, answering whether a row went.
 *
 * The answer is what lets the caller give the allowance back exactly once: two
 * concurrent deletes of one rule delete one row between them, and only the one
 * that did releases.
 */
export async function deleteMerchandisingRule(
  tx: DatabaseOrTransaction,
  storeId: string,
  ruleId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(merchandisingRules)
    .where(and(eq(merchandisingRules.id, ruleId), eq(merchandisingRules.storeId, storeId)))
    .returning({ id: merchandisingRules.id });
  return rows.length > 0;
}

/** The ids of `listingIds` that are NOT listings of this store — a pin's write check. */
export async function findListingIdsOutsideStore(
  storeId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (listingIds.length === 0) return [];
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.storeId, storeId), inArray(listings.id, [...listingIds])));
  const found = new Set(rows.map((row) => row.id));
  return listingIds.filter((id) => !found.has(id));
}

/** How one ordering is asked for. */
export interface StoreListingOrderRequest {
  storeId: string;
  /** `null` orders the whole store page. */
  collectionId: string | null;
  strategy: MerchandisingSortStrategy;
  /** Required for `best_selling`; ignored otherwise. */
  bestSellingWindowDays: number | null;
  inStockFirst: boolean;
  pinnedListingIds: readonly string[];
  /** The instant the best-selling window ends at — injected, never `new Date()` here. */
  at: Date;
  offset: number;
  limit: number;
}

/** One ordered listing, with the facts that put it there. */
export interface OrderedStoreListing {
  listingId: string;
  title: string;
  pinned: boolean;
  inStock: boolean;
  unitsSold: number | null;
  priceMinAmount: number | null;
  priceCurrency: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A text array literal built from bound parameters.
 *
 * Not `${ids}::text[]`: postgres.js EXPANDS a JavaScript array into one bind
 * parameter per element, so the short form binds a list where Postgres expects
 * one array (`listingRepository`'s `arrayContains` note). `array[]::text[]` is a
 * valid empty array, so no pins needs no special case.
 */
function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`array[]::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * One page of a store's own visible listings, in a rule's order, plus the total.
 *
 * Pins first (in pin order), then in-stock before out-of-stock when asked, then
 * the strategy, then `id desc` so every page boundary is deterministic. Units
 * sold are summed over PAID orders of THIS store whose paid moment
 * (`coalesce(payment_paid_at, created_at)`, the sales report's anchor) falls in
 * `[at - window, at]`.
 */
export async function orderStoreListings(
  request: StoreListingOrderRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: OrderedStoreListing[]; total: number }> {
  const visible: SQL[] = [eq(listings.storeId, request.storeId), eq(listings.status, 'active')];
  if (request.collectionId !== null) {
    visible.push(
      inArray(
        listings.id,
        db
          .select({ listingId: listingCollections.listingId })
          .from(listingCollections)
          .where(eq(listingCollections.collectionId, request.collectionId)),
      ),
    );
  }
  const where = and(...visible);

  const pinRank = sql`array_position(${textArray(request.pinnedListingIds)}, ${listings.id})`;
  const bestSelling = request.strategy === 'best_selling';

  const order: SQL[] = [sql`${pinRank} asc nulls last`];
  if (request.inStockFirst) order.push(desc(listings.hasInventory));

  let sales: ReturnType<typeof salesSubquery> | null = null;
  if (bestSelling) {
    const days = request.bestSellingWindowDays ?? 30;
    sales = salesSubquery(db, request.storeId, {
      from: new Date(request.at.getTime() - days * DAY_MS),
      to: request.at,
    });
    order.push(sql`coalesce(${sales.units}, 0) desc`);
  }
  switch (request.strategy) {
    case 'price_asc':
      order.push(sql`${listings.priceRangeMinAmount} asc nulls last`);
      break;
    case 'price_desc':
      order.push(sql`${listings.priceRangeMinAmount} desc nulls last`);
      break;
    default:
      // `newest`, and the tie-break of `best_selling`: the store page's own
      // newest-first order.
      order.push(sql`${listings.publishedAt} desc nulls last`);
  }
  order.push(desc(listings.id));

  const fields = {
    listingId: listings.id,
    title: listings.title,
    hasInventory: listings.hasInventory,
    priceMinAmount: listings.priceRangeMinAmount,
    priceCurrency: listings.priceRangeMinCurrency,
    pinRank: sql<number | null>`${pinRank}`,
  };

  const base = sales
    ? db
        .select({ ...fields, units: sql<string | null>`${sales.units}` })
        .from(listings)
        .leftJoin(sales, eq(sales.listingId, listings.id))
    : db.select({ ...fields, units: sql<string | null>`null` }).from(listings);

  const [rows, [totals]] = await Promise.all([
    base
      .where(where)
      .orderBy(...order)
      .limit(request.limit)
      .offset(request.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(listings).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      listingId: row.listingId,
      title: row.title,
      pinned: row.pinRank !== null,
      inStock: row.hasInventory,
      unitsSold: bestSelling ? Number(row.units ?? 0) : null,
      priceMinAmount: row.priceMinAmount === null ? null : Number(row.priceMinAmount),
      priceCurrency: row.priceCurrency ?? null,
    })),
    total: totals?.count ?? 0,
  };
}

/**
 * Units sold per listing in PAID orders of one store over a window.
 *
 * The bounds are ISO strings cast to `timestamptz`, not `Date`s: the paid moment
 * is an EXPRESSION, so drizzle has no column type to encode a `Date` with and the
 * driver refuses it (`orderRepository.sumPaidRevenueByBucket`).
 */
function salesSubquery(
  db: DatabaseOrTransaction,
  storeId: string,
  window: { from: Date; to: Date },
) {
  const paidMoment = sql`coalesce(${orders.paymentPaidAt}, ${orders.createdAt})`;
  return db
    .select({
      listingId: orderItems.listingId,
      units: sql<string>`sum(${orderItems.quantity})`.as('units'),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.paymentStatus, 'paid'),
        sql`${paidMoment} >= ${window.from.toISOString()}::timestamptz`,
        sql`${paidMoment} <= ${window.to.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(orderItems.listingId)
    .as('merchandising_sales');
}

/** The first image of each listing, for a preview's thumbnails. */
export async function findFirstImageFileIds(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  if (listingIds.length === 0) return first;
  const rows = await db
    .select({ listingId: listingImages.listingId, fileId: listingImages.fileId })
    .from(listingImages)
    .where(and(inArray(listingImages.listingId, [...listingIds]), eq(listingImages.kind, 'image')))
    .orderBy(asc(listingImages.listingId), asc(listingImages.position), asc(listingImages.id));
  for (const row of rows) {
    if (!first.has(row.listingId)) first.set(row.listingId, row.fileId);
  }
  return first;
}
