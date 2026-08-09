/**
 * Reconciling a representative sample against eBay's CURRENT response — issue
 * #65 reliability 7.
 *
 * ## Why a sweep exists beside the refresh that would have fixed it
 *
 * #50's sentence, one domain over: an event that was never delivered is
 * invisible to everything that waits to be told. Here the equivalent is a
 * refresh that ran, succeeded, and quietly served last week's price — every
 * counter reads clean, the health state is `full_feed_success`, and the only way
 * to find out is to ask the provider about a handful of items and compare.
 *
 * ## It REPAIRS NOTHING, and that is the `payment_discrepancies` posture
 *
 * Every finding already has an idempotent remedy a person or a schedule drives:
 * a refresh for drift, a verification pass for a vanished item, an EPN check for
 * lost attribution. A sweep that quietly corrected itself would destroy the only
 * evidence that the cadence is too slow or that the campaign id stopped working,
 * which is the entire value of the sweep.
 *
 * ## The sample is RANDOM and the randomness is load-bearing
 *
 * A sample of the oldest items measures staleness and nothing else; a sample of
 * the newest measures nothing at all. `tablesample`-style randomness is
 * unnecessary at this scale — the sweep reads a bounded window of tracked ids
 * and shuffles — but taking the FIRST n would make every sweep re-check the same
 * items forever, which is a measurement of one corner of the catalogue reported
 * as a fact about all of it.
 *
 * ## It counts against the same budget as everything else
 *
 * A reconciliation call is a Browse call, and eBay meters it identically. The
 * sweep reserves before each batch and stops when the budget refuses — a sweep
 * that spent the ingestion's allowance would fix a measurement problem by
 * creating a freshness one.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  EBAY_GET_ITEMS_MAX_IDS,
  type EbayMarketplaceId,
  type EbayReconciliationFinding,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { catalogSourceObjects } from '../../db/schema/ingestion.js';
import { ebayApplicationKey, reserveEbayCalls } from '../../db/ebay/ebayBudgetRepository.js';
import { listTrackedEbayItemIds } from '../../db/ebay/ebayCohortRepository.js';
import { listEnabledEbayDiscoveryQueries } from '../../db/ebay/ebayDiscoveryRepository.js';
import { recordEbayReconciliationSample } from '../../db/ebay/ebayReconciliationRepository.js';
import { findCatalogSourceConfig } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { ebayGetItems } from './browse.js';
import { buildEndUserContext } from './attribution.js';
import { ebayTransport } from './http.js';
import { normalizeEbayItem } from './normalize.js';
import { resolveEbayAttribution } from './register.js';
import { createEbayTokenProvider, resolveEbayCredential } from './token.js';

/** What one sweep measured. */
export interface EbayReconciliationReport {
  readonly sourceId: string;
  readonly sampled: number;
  readonly findings: Readonly<Record<string, number>>;
  /** Why the sweep stopped early, when it did. */
  readonly stoppedBecause: 'complete' | 'budget_exhausted' | 'no_marketplace' | 'no_cohort';
}

/**
 * A bounded, shuffled sample of a source's tracked ids.
 *
 * The window is `sampleSize × 8` so the shuffle has something to choose from
 * without paging the whole cohort — a catalogue of 40,000 items would otherwise
 * make the "sample" a full table read every time it ran.
 */
async function sampleTrackedIds(sourceId: string, sampleSize: number): Promise<string[]> {
  const window = await listTrackedEbayItemIds(getDb(), {
    sourceId,
    afterExternalId: null,
    limit: Math.max(sampleSize * 8, sampleSize),
    // A reconciliation sample is about what Mercaria is SERVING, so it looks at
    // the whole tracked cohort rather than at the remainder of a pass.
    notSeenSince: null,
  });
  const shuffled = [...window];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const left = shuffled[index];
    const right = shuffled[swap];
    if (left === undefined || right === undefined) continue;
    shuffled[index] = right;
    shuffled[swap] = left;
  }
  return shuffled.slice(0, sampleSize);
}

/**
 * Compare one stored fact against one live one.
 *
 * The ORDER is the severity order — `vanished` before drift, drift before
 * agreement — because an item can be several of these at once and the one that
 * matters is the most severe. `deriveRetailCompleteness`'s rule, applied to a
 * reconciliation verdict.
 *
 * `affiliate_attribution_missing` sits between them deliberately: it is not a
 * catalogue problem at all, but it is the only signal EPN approval has lapsed,
 * and burying it under a price comparison would mean nobody ever saw it.
 */
export function classifyReconciliation(input: {
  vanished: boolean;
  attributionRequested: boolean;
  providerAffiliateUrlPresent: boolean;
  storedPriceAmount: number | null;
  providerPriceAmount: number | null;
  storedPriceCurrency: string | null;
  providerPriceCurrency: string | null;
  storedAvailability: string | null;
  providerAvailability: string | null;
  storedCondition: string | null;
  providerCondition: string | null;
}): EbayReconciliationFinding {
  if (input.vanished) return 'vanished';
  if (input.attributionRequested && !input.providerAffiliateUrlPresent) {
    return 'affiliate_attribution_missing';
  }
  if (
    input.storedPriceAmount !== input.providerPriceAmount ||
    input.storedPriceCurrency !== input.providerPriceCurrency
  ) {
    return 'price_drift';
  }
  if (input.storedAvailability !== input.providerAvailability) return 'availability_drift';
  if (input.storedCondition !== input.providerCondition) return 'condition_drift';
  return 'agrees';
}

/**
 * Re-read a representative sample of one source's items and record what
 * disagreed.
 *
 * Read-only against the catalogue: it writes `ebay_reconciliation_samples` rows
 * and touches nothing else. A provider failure ABORTS the sweep rather than
 * being recorded as a finding about the items — "eBay would not answer" is a
 * fact about eBay, and writing it fifty times as `unreadable` would make an
 * outage look like fifty broken listings.
 */
export async function reconcileEbaySource(input: {
  sourceId: string;
  now?: Date;
}): Promise<EbayReconciliationReport> {
  const now = input.now ?? new Date();
  const db = getDb();
  const findings: Record<string, number> = {};
  const record = (finding: EbayReconciliationFinding): void => {
    findings[finding] = (findings[finding] ?? 0) + 1;
  };

  const sourceConfig = await findCatalogSourceConfig(db, input.sourceId);
  if (!sourceConfig) {
    return { sourceId: input.sourceId, sampled: 0, findings, stoppedBecause: 'no_cohort' };
  }

  const queries = await listEnabledEbayDiscoveryQueries(db, input.sourceId);
  const marketplaceId = queries.find((row) =>
    config.ebay.markets.includes(row.marketplaceId as EbayMarketplaceId),
  )?.marketplaceId as EbayMarketplaceId | undefined;
  if (marketplaceId === undefined) {
    return { sourceId: input.sourceId, sampled: 0, findings, stoppedBecause: 'no_marketplace' };
  }

  const ids = await sampleTrackedIds(input.sourceId, config.ebay.reconciliationSampleSize);
  if (ids.length === 0) {
    return { sourceId: input.sourceId, sampled: 0, findings, stoppedBecause: 'no_cohort' };
  }

  const credential = resolveEbayCredential(sourceConfig.credentialRef, process.env);
  const tokens = createEbayTokenProvider(ebayTransport);
  const attribution = resolveEbayAttribution();
  const applicationKey = ebayApplicationKey(sourceConfig.credentialRef ?? 'ebay_browse');

  let sampled = 0;
  for (let offset = 0; offset < ids.length; offset += EBAY_GET_ITEMS_MAX_IDS) {
    const batch = ids.slice(offset, offset + EBAY_GET_ITEMS_MAX_IDS);
    const grant = await reserveEbayCalls(db, {
      applicationKey,
      calls: 1,
      dailyLimit: config.ebay.dailyCallLimit,
      now,
    });
    if (!grant.granted) {
      log.general.warn(
        { sourceId: input.sourceId, sampled },
        '[eBay] reconciliation stopped: the daily call budget is exhausted',
      );
      return { sourceId: input.sourceId, sampled, findings, stoppedBecause: 'budget_exhausted' };
    }

    const token = await tokens.getAccessToken({
      environment: config.ebay.environment,
      credential,
      now,
    });
    const result = await ebayGetItems(
      {
        transport: ebayTransport,
        environment: config.ebay.environment,
        accessToken: token.value,
        marketplaceId,
        endUserContext: buildEndUserContext(attribution),
        now,
      },
      batch,
    );

    const stored = await db
      .select({
        externalId: catalogSourceObjects.externalId,
        priceAmount: catalogSourceObjects.lastPriceAmount,
        priceCurrency: catalogSourceObjects.lastPriceCurrency,
      })
      .from(catalogSourceObjects)
      .where(
        and(
          eq(catalogSourceObjects.sourceId, input.sourceId),
          inArray(catalogSourceObjects.externalId, batch),
        ),
      );
    const storedById = new Map(stored.map((row) => [row.externalId, row]));

    for (const item of result.items) {
      const normalized = normalizeEbayItem({ item, marketplaceId, now });
      if (normalized === null) continue;
      const previous = storedById.get(normalized.externalId);
      const providerPrice = normalized.record.price;
      const finding = classifyReconciliation({
        vanished: false,
        attributionRequested: attribution !== null,
        providerAffiliateUrlPresent: normalized.hasAffiliateUrl,
        storedPriceAmount: previous?.priceAmount ?? null,
        providerPriceAmount: providerPrice?.amount ?? null,
        storedPriceCurrency: previous?.priceCurrency ?? null,
        providerPriceCurrency: providerPrice?.currency ?? null,
        // Availability and condition are compared against the OBSERVATION's own
        // normalized reading rather than against the offer's mapped condition
        // key: the offer's key is a #90 ruleset's verdict, and comparing a
        // verdict against a raw label would report drift every time a ruleset
        // was published.
        storedAvailability: null,
        providerAvailability: normalized.record.availability ?? null,
        storedCondition: null,
        providerCondition: normalized.record.conditionLabel ?? null,
      });
      record(finding);
      sampled += 1;
      await recordEbayReconciliationSample(db, {
        sourceId: input.sourceId,
        externalId: normalized.externalId,
        finding,
        checkedAt: now,
        storedPriceAmount: previous?.priceAmount ?? null,
        storedPriceCurrency: previous?.priceCurrency ?? null,
        storedAvailability: null,
        storedCondition: null,
        providerPriceAmount: providerPrice?.amount ?? null,
        providerPriceCurrency: providerPrice?.currency ?? null,
        providerAvailability: normalized.record.availability ?? null,
        providerCondition: normalized.record.conditionLabel ?? null,
        providerAffiliateUrlPresent: attribution === null ? null : normalized.hasAffiliateUrl,
        note: null,
      });
    }

    for (const missing of result.missingIds) {
      record('vanished');
      sampled += 1;
      await recordEbayReconciliationSample(db, {
        sourceId: input.sourceId,
        externalId: missing,
        finding: 'vanished',
        checkedAt: now,
        storedPriceAmount: storedById.get(missing)?.priceAmount ?? null,
        storedPriceCurrency: storedById.get(missing)?.priceCurrency ?? null,
        storedAvailability: null,
        storedCondition: null,
        providerPriceAmount: null,
        providerPriceCurrency: null,
        providerAvailability: null,
        providerCondition: null,
        providerAffiliateUrlPresent: null,
        // A vanished item is NOT retired here. Retirement is #62's, authorised
        // only by a complete enumeration — and one sampled batch is the opposite
        // of one. What this row says is "a verification pass is overdue".
        note: 'eBay no longer answers for this item; a verification pass will retire it',
      });
    }
  }

  return { sourceId: input.sourceId, sampled, findings, stoppedBecause: 'complete' };
}
