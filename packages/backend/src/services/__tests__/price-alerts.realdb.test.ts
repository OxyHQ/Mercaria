/**
 * #79's acceptance criteria, each against a REAL PostgreSQL server.
 *
 * None of them exists under a mock. The load-bearing ones are a UNIQUE INDEX
 * (one notification per qualifying observation), four CHECKs whose obvious
 * spellings admit exactly the row they exist to refuse, a `FOR UPDATE SKIP
 * LOCKED` claim, a CONVERGING upsert and two CASCADEs — and a mocked `insert`
 * accepts every statement the server refuses.
 *
 * The failure mode the file guards against is a buyer told the same good news
 * twice, or told about a price nobody can still pay. So the assertions fail
 * LOUDLY in the safe-looking direction: a second notification is as much a
 * failure here as a missing one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { PRICE_ALERT_POLICY_VERSION } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { catalogSourceConfigs, catalogSourcePolicies } from '../../db/schema/ingestion.js';
import { offers } from '../../db/schema/offers.js';
import { offerPriceSnapshots, offerPriceWriteMetrics } from '../../db/schema/priceHistory.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import { notifications } from '../../db/schema/notifications.js';
import {
  priceAlertEvaluations,
  priceAlertNotifications,
  priceAlertTriggerQuotes,
  priceAlertTriggers,
  priceAlerts,
} from '../../db/schema/priceAlerts.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { recordExternalOffer } from '../offers/offer.service.js';
import { retireOffers } from '../../db/offers/offerRepository.js';
import {
  claimPriceAlertEvaluations,
  completePriceAlertEvaluation,
  findPriceAlertEvaluationForProduct,
  requestPriceAlertEvaluationForProduct,
} from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import {
  findPriceAlertById,
  insertPriceAlert,
  markPriceAlertsAmbiguousAfterSplit,
  stampPriceAlertRehoming,
  type NewPriceAlert,
} from '../../db/priceAlerts/priceAlertRepository.js';
import {
  listPriceAlertTriggers,
  listPriceAlertTriggerQuotes,
} from '../../db/priceAlerts/priceAlertTriggerRepository.js';
import {
  claimPriceAlertNotifications,
  listPriceAlertNotifications,
} from '../../db/priceAlerts/priceAlertNotificationRepository.js';
import { evaluatePriceAlertsForProduct } from '../price-alerts/evaluation.service.js';
import { deliverPriceAlertNotification } from '../price-alerts/delivery.service.js';
import { tracePriceAlert } from '../price-alerts/operator.service.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `price-alert-${RUN}`;
const BUYER = `oxy-buyer-${RUN}`;
const DAY_MS = 24 * 60 * 60 * 1_000;

const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/**
 * Assert a write is refused, and report WHY — the whole cause chain.
 *
 * drizzle's own message says "Failed query: …" and the constraint name lives on
 * the `PostgresError` it wraps, so a test matching only the outer message would
 * pass against ANY refusal, including a typo.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  const alertIds = (
    await db
      .select({ id: priceAlerts.id })
      .from(priceAlerts)
      .where(eq(priceAlerts.oxyUserId, BUYER))
  ).map((row) => row.id);
  await db
    .delete(notifications)
    .where(inArray(notifications.oxyUserId, [BUYER]));
  // The alert cascades its triggers, their quotes and their delivery records.
  await db.delete(priceAlerts).where(inArray(priceAlerts.id, safeIds(alertIds)));
  await db
    .delete(priceAlertEvaluations)
    .where(inArray(priceAlertEvaluations.canonicalProductId, safeIds(createdProductIds)));
  await db.delete(offerPriceSnapshots).where(
    sql`${offerPriceSnapshots.offerId} in (
      select id from offers where canonical_variant_id = any(${sql.param(safeIds(createdVariantIds))}::text[])
    )`,
  );
  await db
    .delete(offerPriceWriteMetrics)
    .where(inArray(offerPriceWriteMetrics.sourceId, safeIds(createdSourceIds)));
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceConfigs)
    .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
    );
    await tx
      .delete(catalogSourcePolicies)
      .where(inArray(catalogSourcePolicies.sourceId, safeIds(createdSourceIds)));
    await tx.execute(
      sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
    );
  });
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

async function mintProduct(label: string): Promise<string> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `PriceAlert ${label} ${RUN}`,
      normalizedName: `pricealert ${label} ${RUN}`,
      slug: `pricealert-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);
  return product.id;
}

async function mintVariant(productId: string): Promise<string> {
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId,
      signature: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  createdVariantIds.push(variant.id);
  return variant.id;
}

async function mintMerchant(label: string): Promise<string> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `PriceAlert ${label} ${RUN}`, slug: `pricealert-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

/** A source that may display a price, so a case is about alerts and nothing else. */
async function bringUpSource(
  label: string,
): Promise<{ sourceId: string; provider: string; merchantId: string }> {
  const provider = `pa-${label}-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 64);
  const merchantId = await mintMerchant(label);
  const resolved = await configureIngestionSource({
    name: `Price alert source ${label} ${RUN}`,
    kind: 'feed',
    provider,
    merchantId,
    fetchCadenceSeconds: 3_600,
    freshnessTtlSeconds: 3_600,
    pageSize: 50,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({
    sourceId,
    reviewedByOxyUserId: OPERATOR,
    mayDisplay: true,
    mayStore: false,
    mayCache: false,
    mayDisplayPrice: true,
    mayDisplayMedia: true,
    mayLinkOut: true,
    mayAppendAffiliateParams: false,
    mayIndex: true,
    mayRefreshAutomatically: true,
    extractionMode: 'disallowed',
    attributionRequired: true,
  });
  await changeIngestionSourceStatus({
    sourceId,
    status: 'active',
    actorOxyUserId: OPERATOR,
    reason: 'price alert acceptance suite',
  });
  return { sourceId, provider, merchantId };
}

async function mintSourceRecord(sourceId: string, externalId: string): Promise<string> {
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'offer',
      externalId,
      contentHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      observedAt: new Date(),
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

/** One observation of one external offer, through the REAL write path. */
async function observe(input: {
  source: { sourceId: string; provider: string; merchantId: string };
  canonicalVariantId: string;
  externalOfferId: string;
  amount: number;
  currency: string;
  observedAt: Date;
  delivery?: { amount: number; currency: string };
  availability?: 'in_stock' | 'out_of_stock' | 'unknown';
}): Promise<string> {
  const sourceRecordId = await mintSourceRecord(
    input.source.sourceId,
    `${input.externalOfferId}-${input.observedAt.getTime()}`,
  );
  return recordExternalOffer({
    kind: 'external',
    canonicalVariantId: input.canonicalVariantId,
    merchantId: input.source.merchantId,
    sourceRecordId,
    sourceId: input.source.sourceId,
    provider: input.source.provider,
    externalOfferId: input.externalOfferId,
    price: { amount: input.amount, currency: input.currency },
    ...(input.delivery ? { delivery: { cost: input.delivery } } : {}),
    ...(input.availability ? { availability: input.availability } : {}),
    conditionSourceLabel: 'New',
    destinationUrl: `https://example.test/${input.externalOfferId}`,
    observedAt: input.observedAt,
    staleAt: new Date(input.observedAt.getTime() + 30 * DAY_MS),
  });
}

function newAlert(overrides: Partial<NewPriceAlert> & Pick<NewPriceAlert, 'canonicalProductId'>): NewPriceAlert {
  return {
    oxyUserId: BUYER,
    canonicalVariantId: null,
    targetAmount: 50_000,
    targetCurrency: 'EUR',
    basis: 'item_price',
    conditionGroups: [],
    market: null,
    sellerScope: 'any',
    proximityScope: 'any',
    merchantId: null,
    storefrontId: null,
    availabilityRequirement: 'any',
    minimumAvailableQuantity: null,
    requirePickupAvailable: false,
    repeatPolicy: 'once',
    resetThresholdAmount: null,
    cooldownSeconds: null,
    quietHoursStartMinute: null,
    quietHoursEndMinute: null,
    quietHoursTimeZone: null,
    locale: null,
    emailOptIn: false,
    ...overrides,
  };
}

describe('ACCEPTANCE 1: one trigger and one notification, despite duplicate source events', () => {
  it('re-evaluating the same observation converges on ONE of each', async () => {
    const source = await bringUpSource('accept1');
    const productId = await mintProduct('accept1');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a1-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });

    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId, repeatPolicy: 'always' }));

    // Three evaluations of ONE unchanged observation — a duplicate source event,
    // an FX re-check and a second worker all look exactly like this.
    const first = await evaluatePriceAlertsForProduct(productId);
    const second = await evaluatePriceAlertsForProduct(productId);
    const third = await evaluatePriceAlertsForProduct(productId);

    expect(first.triggersCreated).toBe(1);
    expect(second.triggersCreated).toBe(0);
    expect(third.triggersCreated).toBe(0);
    // The alert QUALIFIED all three times — `repeatPolicy: 'always'` permits it.
    // What refused the second and third is the unique index, which is the point:
    // a read-then-write would let two concurrent workers both see "no".
    expect(second.qualifiedAlerts).toBe(1);

    const triggers = await listPriceAlertTriggers(alert.id, 50);
    expect(triggers).toHaveLength(1);
    const deliveries = await listPriceAlertNotifications(alert.id, 50);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.row.channel).toBe('oxy_notification');
  }, 60_000);

  it('the identity index refuses a second trigger for one observation, from psql too', async () => {
    const source = await bringUpSource('accept1b');
    const productId = await mintProduct('accept1b');
    const variantId = await mintVariant(productId);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a1b-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);

    const [snapshot] = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId))
      .limit(1);
    expect(snapshot).toBeDefined();

    const message = await rejectionMessage(() =>
      db.insert(priceAlertTriggers).values({
        alertId: alert.id,
        offerId,
        observedPriceVersion: snapshot?.id ?? '',
        alertPolicyVersion: PRICE_ALERT_POLICY_VERSION,
        canonicalProductId: productId,
        canonicalVariantId: variantId,
        basis: 'item_price',
        amountAmount: 40_000,
        amountCurrency: 'EUR',
        targetAmount: 50_000,
        targetCurrency: 'EUR',
        nativeItemAmount: 40_000,
        nativeItemCurrency: 'EUR',
        offerKind: 'external',
        nativeCheckoutEligible: false,
      }),
    );
    expect(message).toContain('price_alert_triggers_identity_key');
  }, 60_000);
});

describe('ACCEPTANCE 2: item price and known total behave differently on unknown shipping', () => {
  it('a known-total alert does not fire where an item-price alert does', async () => {
    const source = await bringUpSource('accept2');
    const productId = await mintProduct('accept2');
    const variantId = await mintVariant(productId);
    // The source publishes a price and NO delivery cost — the fixture that
    // distinguishes the two bases. An offer with a real delivery cost would fire
    // both and prove nothing.
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a2-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });

    const itemAlert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    const totalAlert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, basis: 'known_total' }),
    );

    await evaluatePriceAlertsForProduct(productId);

    expect(await listPriceAlertTriggers(itemAlert.id, 10)).toHaveLength(1);
    expect(await listPriceAlertTriggers(totalAlert.id, 10)).toHaveLength(0);

    // And the trace SAYS why, rather than reading as "no offer was cheap enough".
    const trace = await tracePriceAlert(totalAlert.id);
    expect(trace.triggers).toHaveLength(0);
    expect(trace.alert.basis).toBe('known_total');
  }, 60_000);

  it('a PUBLISHED delivery cost of zero satisfies a known-total alert', async () => {
    const source = await bringUpSource('accept2b');
    const productId = await mintProduct('accept2b');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a2b-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
      delivery: { amount: 0, currency: 'EUR' },
    });

    const totalAlert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, basis: 'known_total' }),
    );
    await evaluatePriceAlertsForProduct(productId);

    const triggers = await listPriceAlertTriggers(totalAlert.id, 10);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.nativeDeliveryAmount).toBe(0);
    expect(triggers[0]?.amountAmount).toBe(40_000);
  }, 60_000);

  it('an item-price trigger cannot carry a delivery cost — the basis CHECK', async () => {
    const source = await bringUpSource('accept2c');
    const productId = await mintProduct('accept2c');
    const variantId = await mintVariant(productId);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a2c-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    const [snapshot] = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId))
      .limit(1);

    const message = await rejectionMessage(() =>
      db.insert(priceAlertTriggers).values({
        alertId: alert.id,
        offerId,
        observedPriceVersion: snapshot?.id ?? '',
        alertPolicyVersion: `${PRICE_ALERT_POLICY_VERSION}-probe`,
        canonicalProductId: productId,
        canonicalVariantId: variantId,
        basis: 'item_price',
        amountAmount: 40_000,
        amountCurrency: 'EUR',
        targetAmount: 50_000,
        targetCurrency: 'EUR',
        nativeItemAmount: 40_000,
        nativeItemCurrency: 'EUR',
        // The lie: an item-price comparison carrying a delivery figure beside it
        // is exactly what somebody later reads as "the total was this".
        nativeDeliveryAmount: 500,
        nativeDeliveryCurrency: 'EUR',
        offerKind: 'external',
        nativeCheckoutEligible: false,
      }),
    );
    expect(message).toContain('price_alert_triggers_basis_shape_check');
  }, 60_000);
});

describe('ACCEPTANCE 3: the conversion is reproducible from the recorded quote', () => {
  it('a converted trigger stores the quote, and a same-currency one stores none', async () => {
    const source = await bringUpSource('accept3');
    const productId = await mintProduct('accept3');
    const variantId = await mintVariant(productId);
    // GBP against a EUR alert — the only shape that produces a quote at all.
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a3-${RUN}`,
      amount: 30_000,
      currency: 'GBP',
      observedAt: new Date(),
    });
    const converted = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, targetAmount: 100_000 }),
    );
    await evaluatePriceAlertsForProduct(productId);

    const triggers = await listPriceAlertTriggers(converted.id, 10);
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0];
    if (!trigger) throw new Error('the trigger was not written');
    expect(trigger.nativeItemCurrency).toBe('GBP');
    expect(trigger.nativeItemAmount).toBe(30_000);
    expect(trigger.amountCurrency).toBe('EUR');

    const quotes = await listPriceAlertTriggerQuotes(trigger.id);
    expect(quotes).toHaveLength(1);
    const quote = quotes[0];
    if (!quote) throw new Error('the quote was not written');
    expect(quote.component).toBe('item_price');
    expect(quote.fxFrom).toBe('GBP');
    expect(quote.fxTo).toBe('EUR');
    expect(quote.fxRate).toBeGreaterThan(0);
    // Re-derivable: the stored native amount times the stored rate is the stored
    // comparison amount, to the minor unit. That is the whole of acceptance 3.
    expect(Math.round(trigger.nativeItemAmount * quote.fxRate)).toBe(trigger.amountAmount);
  }, 60_000);

  it('a quote converting a currency into itself is refused', async () => {
    const source = await bringUpSource('accept3b');
    const productId = await mintProduct('accept3b');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a3b-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);
    const triggers = await listPriceAlertTriggers(alert.id, 10);
    const trigger = triggers[0];
    if (!trigger) throw new Error('the trigger was not written');
    // The evaluator recorded NO quote for a same-currency offer — a row saying
    // nothing happened is not evidence.
    expect(await listPriceAlertTriggerQuotes(trigger.id)).toHaveLength(0);

    const message = await rejectionMessage(() =>
      db.insert(priceAlertTriggerQuotes).values({
        triggerId: trigger.id,
        component: 'item_price',
        fxFrom: 'EUR',
        fxTo: 'EUR',
        fxRate: 1,
        fxProvider: 'static',
        fxAsOf: new Date(),
      }),
    );
    expect(message).toContain('price_alert_trigger_quotes_distinct_check');
  }, 60_000);
});

describe('ACCEPTANCE 4: a stale or expired offer cannot trigger, or remain the destination', () => {
  it('a retired offer produces no trigger', async () => {
    const source = await bringUpSource('accept4');
    const productId = await mintProduct('accept4');
    const variantId = await mintVariant(productId);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a4-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    await retireOffers(db, [offerId], 'source_disappeared', new Date());

    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    const outcome = await evaluatePriceAlertsForProduct(productId);
    expect(outcome.qualifiedAlerts).toBe(0);
    expect(await listPriceAlertTriggers(alert.id, 10)).toHaveLength(0);
  }, 60_000);

  it('an offer retired BETWEEN the trigger and the send is SUPPRESSED, with a row', async () => {
    const source = await bringUpSource('accept4b');
    const productId = await mintProduct('accept4b');
    const variantId = await mintVariant(productId);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a4b-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);
    expect(await listPriceAlertTriggers(alert.id, 10)).toHaveLength(1);

    // The price goes away before the dispatcher gets to it.
    await retireOffers(db, [offerId], 'source_disappeared', new Date());

    const claimed = await claimPriceAlertNotifications({
      leaseOwner: `owner-${RUN}`,
      batchSize: 10,
      leaseMs: 60_000,
    });
    const mine = claimed.filter((row) => row.alertId === alert.id);
    expect(mine).toHaveLength(1);
    const row = mine[0];
    if (!row) throw new Error('the delivery row was not claimed');

    const outcome = await deliverPriceAlertNotification(row, `owner-${RUN}`);
    expect(outcome.outcome).toBe('suppressed');

    const deliveries = await listPriceAlertNotifications(alert.id, 10);
    expect(deliveries[0]?.row.state).toBe('suppressed');
    // A withholding leaves a ROW — issue operations 3's stale-link measurement.
    // A silent drop would make the number unanswerable.
    expect(deliveries[0]?.row.suppressionReason).toBe('destination_no_longer_eligible');
    expect(deliveries[0]?.row.deliveredAt).toBeNull();
  }, 60_000);
});

describe('ACCEPTANCE 5: merge, split and variant change', () => {
  it('a MERGE rehoming stamps the provenance exactly once, on the loser side', async () => {
    const loserId = await mintProduct('merge-loser');
    const winnerId = await mintProduct('merge-winner');
    const moving = await insertPriceAlert(newAlert({ canonicalProductId: loserId }));
    const settled = await insertPriceAlert(newAlert({ canonicalProductId: winnerId }));

    const stamped = await stampPriceAlertRehoming({ canonicalProductId: loserId, now: new Date() });
    expect(stamped).toBe(1);

    const moved = await findPriceAlertById(moving.id);
    const untouched = await findPriceAlertById(settled.id);
    expect(moved?.rehomedFromCanonicalProductId).toBe(loserId);
    expect(moved?.rehomedAt).toBeInstanceOf(Date);
    // The alert that was ALWAYS on the winner must not claim to have moved —
    // the reason the stamp runs on the loser side and not afterwards.
    expect(untouched?.rehomedFromCanonicalProductId).toBeNull();

    // Idempotent: a resumed phase re-runs it as a no-op, because there is
    // nothing left on the loser.
    await db
      .update(priceAlerts)
      .set({ canonicalProductId: winnerId })
      .where(eq(priceAlerts.id, moving.id));
    expect(await stampPriceAlertRehoming({ canonicalProductId: loserId, now: new Date() })).toBe(0);
  }, 60_000);

  it('a SPLIT pauses and marks, and an already-ambiguous alert keeps its ORIGINAL job', async () => {
    const productId = await mintProduct('split');
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));

    const firstJob = `split-job-1-${RUN}`;
    const secondJob = `split-job-2-${RUN}`;
    // The split job rows themselves belong to #59; this exercise is about the
    // MARKING, so the job ids are supplied directly and the FK is relaxed for
    // the two probe rows below.
    await db.execute(sql`alter table price_alerts drop constraint price_alerts_split_job_id_catalog_split_jobs_id_fk`);
    try {
      const marked = await markPriceAlertsAmbiguousAfterSplit({
        sourceCanonicalProductId: productId,
        splitJobId: firstJob,
      });
      expect(marked).toBe(1);
      const paused = await findPriceAlertById(alert.id);
      expect(paused?.resolutionState).toBe('ambiguous_after_split');
      // An ambiguous alert is PAUSED, which is the half a saved product does not
      // need: an alert on the wrong side of a split would actively notify.
      expect(paused?.state).toBe('paused');
      expect(paused?.splitJobId).toBe(firstJob);

      // A SECOND split must not retarget an unanswered question.
      const again = await markPriceAlertsAmbiguousAfterSplit({
        sourceCanonicalProductId: productId,
        splitJobId: secondJob,
      });
      expect(again).toBe(0);
      expect((await findPriceAlertById(alert.id))?.splitJobId).toBe(firstJob);

      // …and it is no longer evaluable, so it cannot notify while the buyer has
      // not answered.
      const outcome = await evaluatePriceAlertsForProduct(productId);
      expect(outcome.evaluatedAlerts).toBe(0);
    } finally {
      await db.update(priceAlerts).set({
        resolutionState: 'resolved',
        splitJobId: null,
        splitTargetCanonicalProductId: null,
      }).where(eq(priceAlerts.id, alert.id));
      await db.execute(
        sql`alter table price_alerts add constraint price_alerts_split_job_id_catalog_split_jobs_id_fk
            foreign key (split_job_id) references catalog_split_jobs(id) on delete restrict`,
      );
    }
  }, 60_000);

  it('a VARIANT-scoped alert ignores a cheaper offer on a different variant', async () => {
    const source = await bringUpSource('variant');
    const productId = await mintProduct('variant');
    const watched = await mintVariant(productId);
    const other = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: watched,
      externalOfferId: `v-watched-${RUN}`,
      amount: 60_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    await observe({
      source,
      canonicalVariantId: other,
      externalOfferId: `v-other-${RUN}`,
      amount: 10_000,
      currency: 'EUR',
      observedAt: new Date(),
    });

    const alert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, canonicalVariantId: watched }),
    );
    await evaluatePriceAlertsForProduct(productId);
    // The cheap one is a different configuration. Firing on it would tell a
    // buyer their 256 GB phone got cheap because the 64 GB one did.
    expect(await listPriceAlertTriggers(alert.id, 10)).toHaveLength(0);

    // A product-wide alert on the same product DOES fire, and says which variant.
    const wide = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);
    const triggers = await listPriceAlertTriggers(wide.id, 10);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.canonicalVariantId).toBe(other);
  }, 60_000);
});

describe('ACCEPTANCE 6: a delivery retry never re-runs evaluation or duplicates a trigger', () => {
  it('claiming and failing a delivery leaves ONE trigger and ONE delivery row', async () => {
    const source = await bringUpSource('accept6');
    const productId = await mintProduct('accept6');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a6-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, emailOptIn: true }),
    );
    await evaluatePriceAlertsForProduct(productId);

    // TWO delivery rows for ONE trigger: the ecosystem channel and the email the
    // buyer explicitly asked for.
    const queued = await listPriceAlertNotifications(alert.id, 10);
    expect(queued).toHaveLength(2);
    expect(queued.map((entry) => entry.row.channel).sort()).toEqual(['email', 'oxy_notification']);

    const owner = `owner6-${RUN}`;
    const claimed = await claimPriceAlertNotifications({
      leaseOwner: owner,
      batchSize: 20,
      leaseMs: 60_000,
    });
    const email = claimed.find((row) => row.alertId === alert.id && row.channel === 'email');
    if (!email) throw new Error('the email delivery was not claimed');

    // No transport is registered — the shipped state — so it fails VISIBLY.
    const outcome = await deliverPriceAlertNotification(email, owner);
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.failure).toBe('transport_unconfigured');

    const after = await listPriceAlertNotifications(alert.id, 10);
    const emailRow = after.find((entry) => entry.row.channel === 'email');
    expect(emailRow?.row.state).toBe('failed');
    expect(emailRow?.row.failureReason).toBe('transport_unconfigured');
    // The retry re-reads THIS row and never the price: still one trigger.
    expect(await listPriceAlertTriggers(alert.id, 10)).toHaveLength(1);
    expect(after).toHaveLength(2);
  }, 60_000);
});

describe('ACCEPTANCE 7: a buyer with no push registration is never told delivery succeeded', () => {
  it('the notification reaches the FEED and its push channel is not claimed', async () => {
    const source = await bringUpSource('accept7');
    const productId = await mintProduct('accept7');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a7-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);

    const owner = `owner7-${RUN}`;
    const claimed = await claimPriceAlertNotifications({
      leaseOwner: owner,
      batchSize: 20,
      leaseMs: 60_000,
    });
    const row = claimed.find((entry) => entry.alertId === alert.id);
    if (!row) throw new Error('the delivery row was not claimed');

    const outcome = await deliverPriceAlertNotification(row, owner);
    expect(outcome.outcome).toBe('delivered');

    const after = await listPriceAlertNotifications(alert.id, 10);
    expect(after[0]?.row.state).toBe('delivered');
    expect(after[0]?.row.notificationId).toBeTruthy();
    // …and the feed row records what each channel actually did. This buyer has
    // no push registration, so `channels` is `in_app` alone and there is no
    // claim anywhere that a push went out.
    const [feed] = await db
      .select({ channels: notifications.channels, deliveryStatus: notifications.deliveryStatus, type: notifications.type })
      .from(notifications)
      .where(eq(notifications.id, after[0]?.row.notificationId ?? ''))
      .limit(1);
    expect(feed?.type).toBe('price_alert');
    expect(feed?.channels).not.toContain('push');
    expect(Object.keys(feed?.deliveryStatus ?? {})).not.toContain('push');

    // `openedAt` is DERIVED from the feed row and is absent until it is read.
    expect(after[0]?.openedAt).toBeNull();
    await db
      .update(notifications)
      .set({ readAt: new Date(), status: 'read' })
      .where(eq(notifications.id, after[0]?.row.notificationId ?? ''));
    const opened = await listPriceAlertNotifications(alert.id, 10);
    expect(opened[0]?.openedAt).toBeInstanceOf(Date);
  }, 60_000);
});

describe('ACCEPTANCE 8: creation, evaluation, delivery, pause and deletion end to end', () => {
  it('a paused alert is not evaluated and its queued delivery is suppressed', async () => {
    const source = await bringUpSource('accept8');
    const productId = await mintProduct('accept8');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `a8-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, repeatPolicy: 'always' }),
    );
    await evaluatePriceAlertsForProduct(productId);
    expect(await listPriceAlertTriggers(alert.id, 10)).toHaveLength(1);

    await db.update(priceAlerts).set({ state: 'paused' }).where(eq(priceAlerts.id, alert.id));

    // Paused: not evaluated at all.
    const outcome = await evaluatePriceAlertsForProduct(productId);
    expect(outcome.evaluatedAlerts).toBe(0);

    // …and the delivery already queued is SUPPRESSED rather than sent.
    const owner = `owner8-${RUN}`;
    const claimed = await claimPriceAlertNotifications({
      leaseOwner: owner,
      batchSize: 20,
      leaseMs: 60_000,
    });
    const row = claimed.find((entry) => entry.alertId === alert.id);
    if (!row) throw new Error('the delivery row was not claimed');
    expect((await deliverPriceAlertNotification(row, owner)).outcome).toBe('suppressed');
    const after = await listPriceAlertNotifications(alert.id, 10);
    expect(after[0]?.row.suppressionReason).toBe('alert_paused');
  }, 60_000);

  it('the evaluation queue CONVERGES, claims with a lease and records what it saw', async () => {
    const productId = await mintProduct('queue');
    await insertPriceAlert(newAlert({ canonicalProductId: productId }));

    // Three requests, one row — the convergence issue abuse rule 2 asks for.
    await requestPriceAlertEvaluationForProduct(productId);
    await requestPriceAlertEvaluationForProduct(productId);
    await requestPriceAlertEvaluationForProduct(productId);
    const queued = await findPriceAlertEvaluationForProduct(productId);
    expect(queued?.requestedRevision).toBeGreaterThanOrEqual(3);

    const owner = `queue-owner-${RUN}`;
    const claimed = await claimPriceAlertEvaluations({
      leaseOwner: owner,
      batchSize: 50,
      leaseMs: 60_000,
    });
    const mine = claimed.filter((row) => row.canonicalProductId === productId);
    expect(mine).toHaveLength(1);
    // A SECOND claimant gets nothing — `FOR UPDATE SKIP LOCKED` plus the lease.
    const second = await claimPriceAlertEvaluations({
      leaseOwner: `other-${RUN}`,
      batchSize: 50,
      leaseMs: 60_000,
    });
    expect(second.filter((row) => row.canonicalProductId === productId)).toHaveLength(0);

    const owned = await completePriceAlertEvaluation({
      id: mine[0]?.id ?? '',
      leaseOwner: owner,
      evaluatedAlerts: 1,
      qualifiedAlerts: 0,
    });
    expect(owned).toBe(true);
    const done = await findPriceAlertEvaluationForProduct(productId);
    expect(done?.state).toBe('done');
    // The VACUITY floor: a subject with one alert reporting zero evaluated is a
    // broken read, and only these counters can say so.
    expect(done?.lastEvaluatedAlerts).toBe(1);
    expect(done?.lastQualifiedAlerts).toBe(0);

    // A completion by somebody who no longer holds the lease is refused.
    expect(
      await completePriceAlertEvaluation({
        id: mine[0]?.id ?? '',
        leaseOwner: `stranger-${RUN}`,
        evaluatedAlerts: 99,
        qualifiedAlerts: 99,
      }),
    ).toBe(false);
  }, 60_000);

  it('an offer WRITE enqueues an evaluation only when somebody is watching', async () => {
    const source = await bringUpSource('enqueue');
    const unwatched = await mintProduct('unwatched');
    const unwatchedVariant = await mintVariant(unwatched);
    await observe({
      source,
      canonicalVariantId: unwatchedVariant,
      externalOfferId: `unwatched-${RUN}`,
      amount: 1_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    // No alert on it, so the hottest write path in the system wrote no row.
    expect(await findPriceAlertEvaluationForProduct(unwatched)).toBeUndefined();

    const watched = await mintProduct('watched');
    const watchedVariant = await mintVariant(watched);
    await insertPriceAlert(newAlert({ canonicalProductId: watched }));
    await observe({
      source,
      canonicalVariantId: watchedVariant,
      externalOfferId: `watched-${RUN}`,
      amount: 1_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    expect(await findPriceAlertEvaluationForProduct(watched)).toBeDefined();
  }, 60_000);
});

describe('the CHECKs that a mocked insert would accept', () => {
  it('a repeat policy carries exactly the input it needs, in BOTH directions', async () => {
    const productId = await mintProduct('checks');

    const missing = await rejectionMessage(() =>
      db.insert(priceAlerts).values({
        oxyUserId: BUYER,
        canonicalProductId: productId,
        targetAmount: 1_000,
        targetCurrency: 'EUR',
        basis: 'item_price',
        repeatPolicy: 'reset_threshold',
      }),
    );
    expect(missing).toContain('price_alerts_reset_threshold_check');

    const surplus = await rejectionMessage(() =>
      db.insert(priceAlerts).values({
        oxyUserId: BUYER,
        canonicalProductId: productId,
        targetAmount: 1_000,
        targetCurrency: 'EUR',
        basis: 'item_price',
        repeatPolicy: 'always',
        cooldownSeconds: 60,
      }),
    );
    expect(surplus).toContain('price_alerts_cooldown_check');
  }, 60_000);

  it('a reset threshold at or below the target is refused', async () => {
    const productId = await mintProduct('reset-check');
    const message = await rejectionMessage(() =>
      db.insert(priceAlerts).values({
        oxyUserId: BUYER,
        canonicalProductId: productId,
        targetAmount: 1_000,
        targetCurrency: 'EUR',
        basis: 'item_price',
        repeatPolicy: 'reset_threshold',
        // Equal to the target: a price under the target could never cross back
        // above it, so the alert would be `once` under another name.
        resetThresholdAmount: 1_000,
      }),
    );
    expect(message).toContain('price_alerts_reset_above_target_check');
  }, 60_000);

  it('quiet hours are three facts or none', async () => {
    const productId = await mintProduct('quiet-check');
    const message = await rejectionMessage(() =>
      db.insert(priceAlerts).values({
        oxyUserId: BUYER,
        canonicalProductId: productId,
        targetAmount: 1_000,
        targetCurrency: 'EUR',
        basis: 'item_price',
        quietHoursStartMinute: 60,
        quietHoursEndMinute: 120,
        // No zone: a window in the SERVER's time is not a fact about the buyer's
        // night.
      }),
    );
    expect(message).toContain('price_alerts_quiet_hours_shape_check');
  }, 60_000);

  it('an ambiguous alert must be paused, and a paused one need not be ambiguous', async () => {
    const productId = await mintProduct('ambiguity-check');
    await db.execute(sql`alter table price_alerts drop constraint price_alerts_split_job_id_catalog_split_jobs_id_fk`);
    try {
      const message = await rejectionMessage(() =>
        db.insert(priceAlerts).values({
          oxyUserId: BUYER,
          canonicalProductId: productId,
          targetAmount: 1_000,
          targetCurrency: 'EUR',
          basis: 'item_price',
          resolutionState: 'ambiguous_after_split',
          splitJobId: `job-${RUN}`,
          // Left `enabled`: an ambiguous alert that kept notifying would be
          // notifying about a product the buyer may not have meant.
          state: 'enabled',
        }),
      );
      expect(message).toContain('price_alerts_ambiguity_paused_check');
    } finally {
      await db.execute(
        sql`alter table price_alerts add constraint price_alerts_split_job_id_catalog_split_jobs_id_fk
            foreign key (split_job_id) references catalog_split_jobs(id) on delete restrict`,
      );
    }
  }, 60_000);

  it('a trigger whose amount does not satisfy its own target is refused', async () => {
    const source = await bringUpSource('satisfies');
    const productId = await mintProduct('satisfies');
    const variantId = await mintVariant(productId);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `sat-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    const [snapshot] = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId))
      .limit(1);

    const message = await rejectionMessage(() =>
      db.insert(priceAlertTriggers).values({
        alertId: alert.id,
        offerId,
        observedPriceVersion: snapshot?.id ?? '',
        alertPolicyVersion: `${PRICE_ALERT_POLICY_VERSION}-probe2`,
        canonicalProductId: productId,
        canonicalVariantId: variantId,
        basis: 'item_price',
        // Above the target it claims to satisfy.
        amountAmount: 90_000,
        amountCurrency: 'EUR',
        targetAmount: 50_000,
        targetCurrency: 'EUR',
        nativeItemAmount: 90_000,
        nativeItemCurrency: 'EUR',
        offerKind: 'external',
        nativeCheckoutEligible: false,
      }),
    );
    expect(message).toContain('price_alert_triggers_satisfies_target_check');
  }, 60_000);

  it('a DELIVERED row has an instant and a suppressed one does not', async () => {
    const source = await bringUpSource('delivered-check');
    const productId = await mintProduct('delivered-check');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `dc-${RUN}`,
      amount: 40_000,
      currency: 'EUR',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(newAlert({ canonicalProductId: productId }));
    await evaluatePriceAlertsForProduct(productId);
    const [row] = await db
      .select({ id: priceAlertNotifications.id })
      .from(priceAlertNotifications)
      .where(eq(priceAlertNotifications.alertId, alert.id))
      .limit(1);

    const message = await rejectionMessage(() =>
      db
        .update(priceAlertNotifications)
        .set({ state: 'delivered', deliveredAt: null })
        .where(eq(priceAlertNotifications.id, row?.id ?? '')),
    );
    expect(message).toContain('price_alert_notifications_delivered_at_check');
  }, 60_000);
});

describe('erasure is ONE scoped delete, and it takes the history with it', () => {
  it('deleting a buyer\'s alerts cascades their triggers, quotes and deliveries', async () => {
    const source = await bringUpSource('erase');
    const productId = await mintProduct('erase');
    const variantId = await mintVariant(productId);
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `erase-${RUN}`,
      amount: 30_000,
      currency: 'GBP',
      observedAt: new Date(),
    });
    const alert = await insertPriceAlert(
      newAlert({ canonicalProductId: productId, targetAmount: 100_000 }),
    );
    await evaluatePriceAlertsForProduct(productId);
    const triggers = await listPriceAlertTriggers(alert.id, 10);
    expect(triggers).toHaveLength(1);
    expect(await listPriceAlertTriggerQuotes(triggers[0]?.id ?? '')).toHaveLength(1);

    await db.delete(priceAlerts).where(eq(priceAlerts.id, alert.id));

    expect(
      await db
        .select({ id: priceAlertTriggers.id })
        .from(priceAlertTriggers)
        .where(eq(priceAlertTriggers.alertId, alert.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: priceAlertTriggerQuotes.id })
        .from(priceAlertTriggerQuotes)
        .where(eq(priceAlertTriggerQuotes.triggerId, triggers[0]?.id ?? '')),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: priceAlertNotifications.id })
        .from(priceAlertNotifications)
        .where(eq(priceAlertNotifications.alertId, alert.id)),
    ).toHaveLength(0);
    // The OFFER and its observation are untouched: this domain owns neither.
    expect(
      await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.canonicalVariantId, variantId), eq(offers.status, 'active'))),
    ).not.toHaveLength(0);
  }, 60_000);
});
