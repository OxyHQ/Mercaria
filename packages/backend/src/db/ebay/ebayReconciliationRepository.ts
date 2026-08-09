/**
 * What a live re-read of a representative sample said, beside what Mercaria was
 * serving — issue #65 reliability 7.
 *
 * The `payment_discrepancies` posture, and for its reason: DETECTION and REPAIR
 * are separate acts. Every finding here already has an idempotent remedy —
 * a refresh for drift, a verification pass for a vanished item, an EPN check for
 * lost attribution — and a sweep that quietly corrected itself would destroy the
 * only evidence that the cadence is too slow or that the campaign id stopped
 * working. Nothing in this file updates an offer, an observation or a source.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { EbayReconciliationFinding } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { EBAY_MAX_TEXT_LENGTH, ebayReconciliationSamples } from '../schema/ebay.js';

export type EbayReconciliationSampleRow = typeof ebayReconciliationSamples.$inferSelect;

export interface RecordReconciliationSampleInput {
  sourceId: string;
  externalId: string;
  finding: EbayReconciliationFinding;
  checkedAt: Date;
  storedPriceAmount: number | null;
  storedPriceCurrency: string | null;
  storedAvailability: string | null;
  storedCondition: string | null;
  providerPriceAmount: number | null;
  providerPriceCurrency: string | null;
  providerAvailability: string | null;
  providerCondition: string | null;
  providerAffiliateUrlPresent: boolean | null;
  note: string | null;
}

/** Record one sample's verdict and the evidence for it. */
export async function recordEbayReconciliationSample(
  db: DatabaseOrTransaction = getDb(),
  input: RecordReconciliationSampleInput,
): Promise<void> {
  await db.insert(ebayReconciliationSamples).values({
    sourceId: input.sourceId,
    externalId: input.externalId,
    finding: input.finding,
    checkedAt: input.checkedAt,
    storedPriceAmount: input.storedPriceAmount,
    storedPriceCurrency: input.storedPriceCurrency,
    storedAvailability: input.storedAvailability,
    storedCondition: input.storedCondition,
    providerPriceAmount: input.providerPriceAmount,
    providerPriceCurrency: input.providerPriceCurrency,
    providerAvailability: input.providerAvailability,
    providerCondition: input.providerCondition,
    providerAffiliateUrlPresent: input.providerAffiliateUrlPresent,
    note: input.note === null ? null : input.note.slice(0, EBAY_MAX_TEXT_LENGTH),
  });
}

/** One source's samples, newest first — the operator read. */
export async function listEbayReconciliationSamples(
  db: DatabaseOrTransaction = getDb(),
  input: { sourceId: string; limit: number },
): Promise<EbayReconciliationSampleRow[]> {
  return db
    .select()
    .from(ebayReconciliationSamples)
    .where(eq(ebayReconciliationSamples.sourceId, input.sourceId))
    .orderBy(desc(ebayReconciliationSamples.checkedAt))
    .limit(input.limit);
}

/**
 * One source's findings since an instant, counted by kind.
 *
 * The shape that makes a sweep readable: three `price_drift`s out of fifty is a
 * cadence question and fifty out of fifty is an incident, and a flat list of
 * rows cannot express the difference at a glance. The `since` bound exists
 * because these rows accumulate per sweep — a lifetime total would be dominated
 * by whatever the integration was doing in its first week.
 */
export async function summarizeEbayReconciliation(
  db: DatabaseOrTransaction = getDb(),
  input: { sourceId: string; since: Date },
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      finding: ebayReconciliationSamples.finding,
      total: sql<number>`count(*)::int`,
    })
    .from(ebayReconciliationSamples)
    .where(
      and(
        eq(ebayReconciliationSamples.sourceId, input.sourceId),
        gte(ebayReconciliationSamples.checkedAt, input.since),
      ),
    )
    .groupBy(ebayReconciliationSamples.finding);

  const result: Record<string, number> = {};
  for (const row of rows) result[row.finding] = row.total;
  return result;
}
