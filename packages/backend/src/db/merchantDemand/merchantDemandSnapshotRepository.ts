/**
 * Writing and reading `merchant_demand_snapshots` and its two child tables
 * (#86 §MerchantDemandSnapshot).
 *
 * ## One transaction, or the report is not a report
 *
 * A snapshot header whose metric rows are missing is a report claiming a
 * coverage its rows cannot support, and the CHECK that makes the coverage
 * counters add up would not catch it — the counters are about PRODUCTS. So the
 * header, its metrics and its product rows are written in ONE transaction, and
 * superseding the previous live snapshot happens inside it: the partial unique
 * on `(merchant_id, market, window_from, window_to) WHERE superseded_at IS NULL`
 * is what makes two concurrent rebuilds converge rather than both succeed.
 *
 * ## The supersede runs BEFORE the insert, and that is why the id is minted here
 *
 * The partial unique forbids two LIVE snapshots for one window, so the previous
 * one has to be stamped superseded before the replacement can exist. And
 * `superseded_at`/`superseded_by_id` travel together by CHECK — a supersede
 * instant naming no successor is not a record of anything — so the successor's
 * id must be known before the successor is inserted. Hence `uuidv7()` here and
 * an explicit `id` on the insert, which is also why `superseded_by_id` carries
 * no foreign key: the row it names does not exist yet at the moment it is
 * written, one statement earlier in the same transaction.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type {
  MerchantDemandAggregateBasis,
  MerchantDemandMetricKind,
  MerchantDemandUnavailableReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  merchantDemandMetrics,
  merchantDemandProducts,
  merchantDemandSnapshots,
  type MerchantDemandMetricStoredRow,
  type MerchantDemandProductStoredRow,
  type MerchantDemandSnapshotRow,
} from '../schema/merchantDemand.js';

/** The header a build hands over, before it has an id. */
export interface NewMerchantDemandSnapshot {
  readonly merchantId: string;
  readonly market: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly dataFreshAsOf: Date;
  readonly eventPolicyVersion: string;
  readonly attributionPolicyVersion: string;
  readonly collectionMode: string;
  readonly aggregateFloor: number;
  readonly productFloor: number;
  readonly productsOffered: number;
  readonly productRowsDisclosed: number;
  readonly productRowsSuppressed: number;
  readonly expiresAt: Date;
}

/** One metric row a build hands over. */
export interface NewMerchantDemandMetric {
  readonly metricKey: string;
  readonly kind: MerchantDemandMetricKind;
  readonly channel: string;
  readonly storefrontId: string;
  readonly sourceId: string;
  readonly countValue?: number;
  readonly amountValue?: number;
  readonly amountCurrency?: string;
  readonly rateNumerator?: number;
  readonly rateDenominator?: number;
  readonly aggregateBasis?: MerchantDemandAggregateBasis;
  readonly suppressedBelow?: number;
  readonly unavailableReason?: MerchantDemandUnavailableReason;
  readonly unavailableSeam?: string;
}

/** One product row a build hands over. */
export interface NewMerchantDemandProduct {
  readonly canonicalProductId: string;
  readonly productPageViews: number;
  readonly offerImpressions: number;
  readonly hasNativeOffer: boolean;
  readonly offerFreshness: string;
}

/** A snapshot and everything under it. */
export interface StoredMerchantDemandSnapshot {
  readonly snapshot: MerchantDemandSnapshotRow;
  readonly metrics: readonly MerchantDemandMetricStoredRow[];
  readonly products: readonly MerchantDemandProductStoredRow[];
}

/**
 * Persist a snapshot, superseding whichever live one it replaces.
 *
 * Returns the snapshot that is LIVE afterwards — this build's, or the one a
 * concurrent build committed first.
 */
export async function insertMerchantDemandSnapshot(
  input: {
    readonly header: NewMerchantDemandSnapshot;
    readonly metrics: readonly NewMerchantDemandMetric[];
    readonly products: readonly NewMerchantDemandProduct[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<StoredMerchantDemandSnapshot> {
  return db.transaction(async (tx) => {
    const snapshotId = uuidv7();

    // Stamp the outgoing snapshot FIRST, naming its successor. `WHERE
    // superseded_at IS NULL` is the compare-and-swap: a concurrent builder that
    // got here first has already moved the row, this update matches nothing,
    // and the insert below then collides on the partial unique — which is the
    // correct outcome for two builds of one window, since the caller retries by
    // reading the live snapshot rather than writing a rival.
    await tx
      .update(merchantDemandSnapshots)
      .set({ supersededAt: new Date(), supersededById: snapshotId })
      .where(
        and(
          eq(merchantDemandSnapshots.merchantId, input.header.merchantId),
          eq(merchantDemandSnapshots.market, input.header.market),
          eq(merchantDemandSnapshots.windowFrom, input.header.windowFrom),
          eq(merchantDemandSnapshots.windowTo, input.header.windowTo),
          isNull(merchantDemandSnapshots.supersededAt),
        ),
      );

    const inserted = await tx
      .insert(merchantDemandSnapshots)
      .values({
        id: snapshotId,
        merchantId: input.header.merchantId,
        market: input.header.market,
        windowFrom: input.header.windowFrom,
        windowTo: input.header.windowTo,
        dataFreshAsOf: input.header.dataFreshAsOf,
        eventPolicyVersion: input.header.eventPolicyVersion,
        attributionPolicyVersion: input.header.attributionPolicyVersion,
        collectionMode: input.header.collectionMode,
        aggregateFloor: input.header.aggregateFloor,
        productFloor: input.header.productFloor,
        productsOffered: input.header.productsOffered,
        productRowsDisclosed: input.header.productRowsDisclosed,
        productRowsSuppressed: input.header.productRowsSuppressed,
        expiresAt: input.header.expiresAt,
      })
      .returning();

    const metrics =
      input.metrics.length === 0
        ? []
        : await tx
            .insert(merchantDemandMetrics)
            .values(
              input.metrics.map((metric) => ({
                snapshotId,
                metricKey: metric.metricKey,
                kind: metric.kind,
                channel: metric.channel,
                storefrontId: metric.storefrontId,
                sourceId: metric.sourceId,
                countValue: metric.countValue ?? null,
                amountValue: metric.amountValue ?? null,
                amountCurrency: metric.amountCurrency ?? null,
                rateNumerator: metric.rateNumerator ?? null,
                rateDenominator: metric.rateDenominator ?? null,
                aggregateBasis: metric.aggregateBasis ?? null,
                suppressedBelow: metric.suppressedBelow ?? null,
                unavailableReason: metric.unavailableReason ?? null,
                unavailableSeam: metric.unavailableSeam ?? null,
              })),
            )
            .returning();

    const products =
      input.products.length === 0
        ? []
        : await tx
            .insert(merchantDemandProducts)
            .values(
              input.products.map((product) => ({
                snapshotId,
                canonicalProductId: product.canonicalProductId,
                productPageViews: product.productPageViews,
                offerImpressions: product.offerImpressions,
                hasNativeOffer: product.hasNativeOffer,
                offerFreshness: product.offerFreshness,
              })),
            )
            .returning();

    return { snapshot: inserted[0], metrics, products };
  });
}

/** One snapshot and its children, or `undefined`. */
export async function readSnapshotById(
  snapshotId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<StoredMerchantDemandSnapshot | undefined> {
  const headers = await db
    .select()
    .from(merchantDemandSnapshots)
    .where(eq(merchantDemandSnapshots.id, snapshotId))
    .limit(1);
  const snapshot = headers[0];
  if (snapshot === undefined) return undefined;

  const [metrics, products] = await Promise.all([
    db
      .select()
      .from(merchantDemandMetrics)
      .where(eq(merchantDemandMetrics.snapshotId, snapshotId))
      .orderBy(merchantDemandMetrics.metricKey),
    db
      .select()
      .from(merchantDemandProducts)
      .where(eq(merchantDemandProducts.snapshotId, snapshotId))
      .orderBy(desc(merchantDemandProducts.productPageViews)),
  ]);

  return { snapshot, metrics, products };
}

/**
 * The live snapshot for a merchant and market, if one exists.
 *
 * "Live" is `superseded_at IS NULL`, which is the same predicate the partial
 * unique uses — so a reader and the index can never disagree about which row is
 * current.
 */
export async function findLiveSnapshot(
  input: { merchantId: string; market: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<StoredMerchantDemandSnapshot | undefined> {
  const headers = await db
    .select({ id: merchantDemandSnapshots.id })
    .from(merchantDemandSnapshots)
    .where(
      and(
        eq(merchantDemandSnapshots.merchantId, input.merchantId),
        eq(merchantDemandSnapshots.market, input.market),
        isNull(merchantDemandSnapshots.supersededAt),
      ),
    )
    .orderBy(desc(merchantDemandSnapshots.createdAt))
    .limit(1);
  const id = headers[0]?.id;
  return id === undefined ? undefined : readSnapshotById(id, db);
}

/**
 * How many snapshots one merchant has, live and superseded.
 *
 * The operator health read. A merchant whose superseded count climbs while its
 * live one stays at one is being rebuilt repeatedly, which is the signature of
 * a network revising its reports — the attribution-correction case #86
 * acceptance 8 asks for a test of.
 */
export async function countMerchantSnapshots(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ live: number; superseded: number }> {
  const rows = await db
    .select({
      live: sql<string>`count(*) filter (where ${merchantDemandSnapshots.supersededAt} is null)`,
      superseded: sql<string>`count(*) filter (where ${merchantDemandSnapshots.supersededAt} is not null)`,
    })
    .from(merchantDemandSnapshots)
    .where(eq(merchantDemandSnapshots.merchantId, merchantId));
  return {
    live: Number(rows[0]?.live ?? 0),
    superseded: Number(rows[0]?.superseded ?? 0),
  };
}
