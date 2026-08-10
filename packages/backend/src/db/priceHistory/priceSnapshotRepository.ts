/**
 * `offer_price_snapshots` — the immutable observation store (#78).
 *
 * There is deliberately NO update and NO delete in this module. The table's
 * trigger refuses an UPDATE outright, so an `update()` here would be a
 * statement that can only ever throw; a DELETE belongs to the shared expiry
 * sweep, which reads `db/expiryTargets.ts` and is the one path a source's own
 * retention right travels. A repository offering either would be a second way
 * to reach a decision only those two make.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { offerPriceSnapshots } from '../schema/priceHistory.js';
import { offers } from '../schema/offers.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { catalogSourceRunQuarantines } from '../schema/offerFreshness.js';

export type OfferPriceSnapshotRow = typeof offerPriceSnapshots.$inferSelect;
export type InsertOfferPriceSnapshot = typeof offerPriceSnapshots.$inferInsert;

/** Write one observation. The only writer of this table. */
export async function insertPriceSnapshot(
  values: InsertOfferPriceSnapshot,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSnapshotRow> {
  const rows = await db.insert(offerPriceSnapshots).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('insertPriceSnapshot returned no row.');
  return row;
}

/**
 * The newest observation of one offer — what the dedup interval and the change
 * detector both compare against.
 *
 * Newest by `observed_at` and NOT by id: a uuid v7 primary key is not monotonic
 * within a millisecond, so ordering by id would pick a coin flip between two
 * observations taken in the same tick, and the whole point of this read is to
 * know what the source last said.
 */
export async function findLatestPriceSnapshot(
  offerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSnapshotRow | undefined> {
  const rows = await db
    .select()
    .from(offerPriceSnapshots)
    .where(eq(offerPriceSnapshots.offerId, offerId))
    .orderBy(desc(offerPriceSnapshots.observedAt), desc(offerPriceSnapshots.id))
    .limit(1);
  return rows[0];
}

/** Every observation of one offer, oldest first — the operator trace. */
export async function listPriceSnapshotsForOffer(
  offerId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<OfferPriceSnapshotRow[]> {
  return db
    .select()
    .from(offerPriceSnapshots)
    .where(eq(offerPriceSnapshots.offerId, offerId))
    .orderBy(asc(offerPriceSnapshots.observedAt), asc(offerPriceSnapshots.id))
    .limit(limit);
}

/** What the derivation needs about one observation and the offer behind it. */
export interface PriceObservationRow {
  readonly snapshotId: string;
  readonly offerId: string;
  readonly observedAt: Date;
  readonly itemPriceAmount: number;
  readonly itemPriceCurrency: string;
  readonly shippingCostAmount: number | null;
  readonly shippingCostCurrency: string | null;
  readonly conditionKey: string;
  readonly market: string | null;
  readonly freshnessLevel: string;
  readonly anomalies: string[];
  readonly supersededByCorrection: boolean;
  readonly quarantined: boolean;
  readonly offerKind: string;
  readonly offerStatus: string;
  readonly offerMerchantId: string | null;
  readonly offerStorefrontId: string | null;
  readonly offerStaleAt: Date;
  readonly offerLastSeenAt: Date;
  readonly offerSourceId: string | null;
}

/** How a series' input set is narrowed. */
export interface PriceObservationScope {
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly market?: string;
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

/**
 * Every observation a series might be built from, oldest first.
 *
 * ### The canonical scope is resolved through the OFFER, live
 *
 * An observation carries no canonical id at all (see the schema docblock), so
 * this join is what makes issue operations 4 work without a single write: a
 * merge repoints `offers.canonical_variant_id`, and the next rebuild finds the
 * loser's whole history under the winner. It is also what makes a corrected
 * match move history to the product it was always about.
 *
 * ### Two exclusions are applied HERE and the rest in the derivation
 *
 * A correction that has been superseded and an observation whose ingestion run
 * is under an OPEN quarantine are both decided by rows this query already has
 * to reach, and both would otherwise pull large sets into the process only to
 * drop them. Everything else — freshness, rights, segment, currency — is
 * decided by the pure derivation, because those decisions need the FX map and
 * #68's policy resolution and are the ones an operator asks to have explained.
 *
 * `quarantined` is computed rather than filtered, so the derivation can report
 * it as an exclusion REASON instead of the row simply being absent.
 */
export async function listPriceObservationsForScope(
  scope: PriceObservationScope,
  db: DatabaseOrTransaction = getDb(),
): Promise<PriceObservationRow[]> {
  const correction = db.$with('corrections').as(
    db
      .select({ supersedes: offerPriceSnapshots.supersedesSnapshotId })
      .from(offerPriceSnapshots)
      .where(sql`${offerPriceSnapshots.supersedesSnapshotId} is not null`),
  );

  const scopeFilters = [
    gte(offerPriceSnapshots.observedAt, scope.from),
    lte(offerPriceSnapshots.observedAt, scope.to),
  ];
  if (scope.canonicalVariantId) {
    scopeFilters.push(eq(offers.canonicalVariantId, scope.canonicalVariantId));
  }
  if (scope.canonicalProductId) {
    scopeFilters.push(eq(canonicalVariants.productId, scope.canonicalProductId));
  }
  if (scope.merchantId) scopeFilters.push(eq(offers.merchantId, scope.merchantId));
  if (scope.storefrontId) scopeFilters.push(eq(offers.storefrontId, scope.storefrontId));
  if (scope.market) {
    // A market-scoped series admits an offer published for NO particular market
    // as well as one published for this one: an offer with no country is not a
    // statement that it is unavailable here, and dropping it would make a
    // market series systematically report higher prices than the unscoped one.
    scopeFilters.push(
      or(eq(offerPriceSnapshots.market, scope.market), isNull(offerPriceSnapshots.market)) ??
        sql`true`,
    );
  }

  const rows = await db
    .with(correction)
    .select({
      snapshotId: offerPriceSnapshots.id,
      offerId: offerPriceSnapshots.offerId,
      observedAt: offerPriceSnapshots.observedAt,
      itemPriceAmount: offerPriceSnapshots.itemPriceAmount,
      itemPriceCurrency: offerPriceSnapshots.itemPriceCurrency,
      shippingCostAmount: offerPriceSnapshots.shippingCostAmount,
      shippingCostCurrency: offerPriceSnapshots.shippingCostCurrency,
      conditionKey: offerPriceSnapshots.conditionKey,
      market: offerPriceSnapshots.market,
      freshnessLevel: offerPriceSnapshots.freshnessLevel,
      anomalies: offerPriceSnapshots.anomalies,
      supersededByCorrection: sql<boolean>`(${correction.supersedes} is not null)`,
      quarantined: sql<boolean>`(${catalogSourceRunQuarantines.id} is not null)`,
      offerKind: offers.kind,
      offerStatus: offers.status,
      offerMerchantId: offers.merchantId,
      offerStorefrontId: offers.storefrontId,
      offerStaleAt: offers.staleAt,
      offerLastSeenAt: offers.lastSeenAt,
      offerSourceId: offerPriceSnapshots.sourceId,
    })
    .from(offerPriceSnapshots)
    .innerJoin(offers, eq(offers.id, offerPriceSnapshots.offerId))
    .leftJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .leftJoin(correction, eq(correction.supersedes, offerPriceSnapshots.id))
    // An OPEN quarantine only. A released or corrected one has been answered,
    // and the next rebuild is what publishes the observations it was holding —
    // issue snapshot policy 6's "until released", with no sweep in between.
    .leftJoin(
      catalogSourceRunQuarantines,
      and(
        eq(catalogSourceRunQuarantines.runId, offerPriceSnapshots.sourceRunId),
        isNull(catalogSourceRunQuarantines.resolution),
      ),
    )
    .where(and(...scopeFilters))
    .orderBy(asc(offerPriceSnapshots.observedAt), asc(offerPriceSnapshots.id))
    .limit(scope.limit);

  return rows;
}

/** Which of these observations have been superseded by a correction. */
export async function findSupersededSnapshotIds(
  snapshotIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (snapshotIds.length === 0) return new Set();
  const rows = await db
    .select({ supersedes: offerPriceSnapshots.supersedesSnapshotId })
    .from(offerPriceSnapshots)
    .where(inArray(offerPriceSnapshots.supersedesSnapshotId, [...snapshotIds]));
  return new Set(rows.flatMap((row) => (row.supersedes ? [row.supersedes] : [])));
}
