/**
 * The digital retail schema's load-bearing constraints, against a REAL Postgres
 * database (#1016, ADR 0011) — the properties a mocked repository is
 * structurally blind to:
 *
 *  - EXACTLY ONE live procurement attempt per order line, under concurrency
 *    (ADR 0011 D6 mechanism 2) — the property the whole no-double-buying design
 *    rests on, and one a service-level check cannot have;
 *  - the derived idempotency key's unique index, and the read-back that converges
 *    on it rather than inserting twice;
 *  - the compare-and-swap: two concurrent answers, one winner;
 *  - exactly ONE active artifact per fulfilment, so "the old key and the new one
 *    both work" is unrepresentable;
 *  - the secret-presence biconditional, which a mocked insert accepts in both
 *    wrong directions;
 *  - the append-only and no-delete triggers, which have no mocked counterpart;
 *  - the operator-audit CHECKs that make a fabricated fulfilment impossible.
 *
 * No cleanup and no TRUNCATE — vitest runs files in parallel against ONE
 * throwaway database, so every id here is unique per run instead.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, sqlStateOf, uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import { canonicalProducts, canonicalVariants } from '../../schema/canonicalCatalog.js';
import {
  digitalFulfilmentArtifacts,
  digitalFulfilmentIncidents,
  digitalFulfilmentReveals,
  digitalFulfilments,
  digitalProcurementOffers,
  digitalPurchaseOrderAttempts,
  digitalPurchaseOrders,
  digitalSupplierCapabilities,
  digitalSupplyTerms,
} from '../../schema/digitalRetail.js';
import { supplierAccounts, supplierAgreements, suppliers } from '../../schema/procurement.js';
import {
  findLivePurchaseOrderForLine,
  openPurchaseOrder,
  purchaseOrderIdempotencyKey,
  recordAttempt,
  transitionPurchaseOrder,
} from '../digitalPurchaseOrderRepository.js';
import {
  createFulfilment,
  openIncident,
  recordReveal,
  replaceArtifact,
  storeArtifact,
} from '../digitalFulfilmentRepository.js';
import { findProcurementCandidates } from '../digitalProcurementOfferRepository.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

const RUN = uuidv7().slice(0, 8);
const NOW = new Date('2026-08-01T10:00:00.000Z');

/** Assert a write is refused by the named CLASS of constraint. */
async function expectRefused(
  write: () => Promise<unknown>,
  kind: 'check' | 'unique' | 'trigger',
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  if (kind === 'check') expect(isCheckViolation(caught), String(caught)).toBe(true);
  else if (kind === 'unique') expect(isUniqueViolation(caught), String(caught)).toBe(true);
  else {
    // This domain's triggers raise `restrict_violation` (23001) rather than
    // `check_violation`, so neither helper covers them — and asserting on the
    // MESSAGE would pass for any error at all. The SQLSTATE is the structural
    // fact (`describeDriverError`'s own reasoning) and it is what is checked.
    expect(sqlStateOf(caught), String(caught)).toBe('23001');
  }
}

interface Fixture {
  supplierId: string;
  accountId: string;
  agreementId: string;
  termsId: string;
  productId: string;
  variantId: string;
}

/** A whole authorized supplier, down to an approved rider. */
async function makeSupplyChain(overrides: { provenance?: 'publisher_direct' } = {}): Promise<Fixture> {
  const [supplier] = await db
    .insert(suppliers)
    .values({
      supplierType: 'digital_distributor',
      canonicalName: `Digital supplier ${uuidv7()}`,
      status: 'active',
      riskLevel: 'low',
      establishmentCountries: ['ES'],
    })
    .returning({ id: suppliers.id });
  const [account] = await db
    .insert(supplierAccounts)
    .values({
      supplierId: supplier!.id,
      provider: 'sandbox',
      environment: 'test',
      providerAccountId: `acct-${uuidv7()}`,
      enabledMarkets: ['ES'],
      state: 'active',
      activatedAt: NOW,
    })
    .returning({ id: supplierAccounts.id });
  const [agreement] = await db
    .insert(supplierAgreements)
    .values({
      supplierId: supplier!.id,
      version: 1,
      approvalState: 'approved',
      effectiveAt: new Date(NOW.getTime() - 86_400_000),
      permittedDestinationCountries: ['ES'],
      permittedChannels: ['mercaria_marketplace'],
      resaleRightsGranted: true,
      dataProcessingTermsAccepted: true,
      evidenceLocation: 'vault://agreements/digital.pdf',
      reviewedByOxyUserId: 'oxy-reviewer',
      approvedByOxyUserId: 'oxy-approver',
      approvedAt: NOW,
    })
    .returning({ id: supplierAgreements.id });
  const [terms] = await db
    .insert(digitalSupplyTerms)
    .values({
      agreementId: agreement!.id,
      supplierId: supplier!.id,
      provenance: overrides.provenance ?? 'authorized_distributor',
      permittedProductClasses: ['digital_game'],
      permittedFulfilmentCapabilities: ['activation_key'],
      permittedTerritories: ['ES'],
      resaleRightsGranted: true,
      replacementSupported: true,
      evidenceLocation: 'vault://riders/digital.pdf',
      approvedByOxyUserId: 'oxy-approver',
      approvedAt: NOW,
    })
    .returning({ id: digitalSupplyTerms.id });
  await db.insert(digitalSupplierCapabilities).values({
    supplierAccountId: account!.id,
    capability: 'purchase',
    state: 'enabled',
  });

  const name = `Canonical game ${uuidv7()}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      normalizedName: name.toLowerCase(),
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product!.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });

  return {
    supplierId: supplier!.id,
    accountId: account!.id,
    agreementId: agreement!.id,
    termsId: terms!.id,
    productId: product!.id,
    variantId: variant!.id,
  };
}

/** One exact, procurable offer on that chain. */
async function makeOffer(
  fixture: Fixture,
  overrides: Partial<typeof digitalProcurementOffers.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(digitalProcurementOffers)
    .values({
      supplierId: fixture.supplierId,
      supplierAccountId: fixture.accountId,
      digitalSupplyTermsId: fixture.termsId,
      canonicalProductId: fixture.productId,
      canonicalVariantId: fixture.variantId,
      supplierSku: `SKU-${uuidv7()}`,
      supplierNativeTitle: 'Supplier title',
      productClass: 'digital_game',
      fulfilmentCapability: 'activation_key',
      taxClass: 'electronically_supplied_service',
      platform: 'pc',
      activationEcosystem: 'sandbox-store',
      edition: 'standard',
      activationTerritories: ['ES'],
      costAmount: 1_000,
      costCurrency: 'EUR',
      availability: 'in_stock',
      mappingStatus: 'exact',
      firstSeenAt: NOW,
      lastConfirmedAt: NOW,
      ...overrides,
    })
    .returning({ id: digitalProcurementOffers.id });
  return row!.id;
}

/**
 * The raw COLUMN values of a purchase order, for the tests that write one
 * directly rather than through the repository.
 *
 * Separate from {@link purchaseOrderInput} because that one carries `now` and
 * other repository-level fields that are not columns — spreading it into
 * `.values()` is a TS2769 the suite would only meet at `tsc` time.
 */
function purchaseOrderRow(fixture: Fixture, orderItemId: string) {
  return {
    idempotencyKey: `dpo:${orderItemId}:1`,
    attemptOrdinal: 1,
    orderId: `order-${orderItemId}`,
    orderItemId,
    supplierId: fixture.supplierId,
    supplierAccountId: fixture.accountId,
    digitalSupplyTermsId: fixture.termsId,
    canonicalVariantId: fixture.variantId,
    supplierSku: 'SKU-1',
    productClass: 'digital_game' as const,
    fulfilmentCapability: 'activation_key' as const,
    platform: 'pc',
    activationEcosystem: 'sandbox-store',
    edition: 'standard',
    quotedCostAmount: 1_000,
    quotedCostCurrency: 'EUR' as const,
    maxAcceptedCostAmount: 1_200,
    maxAcceptedCostCurrency: 'EUR' as const,
    statusChangedAt: NOW,
  };
}

/** A purchase-order input for one order line. */
function purchaseOrderInput(fixture: Fixture, orderItemId: string, attemptOrdinal = 1) {
  return {
    orderId: `order-${RUN}-${orderItemId}`,
    orderItemId,
    attemptOrdinal,
    previousPurchaseOrderId: null,
    supplierId: fixture.supplierId,
    supplierAccountId: fixture.accountId,
    digitalSupplyTermsId: fixture.termsId,
    digitalProcurementOfferId: null,
    canonicalVariantId: fixture.variantId,
    supplierSku: 'SKU-1',
    productClass: 'digital_game' as const,
    fulfilmentCapability: 'activation_key' as const,
    platform: 'pc',
    activationEcosystem: 'sandbox-store',
    edition: 'standard',
    quotedCostAmount: 1_000,
    quotedCostCurrency: 'EUR',
    maxAcceptedCostAmount: 1_200,
    now: NOW,
  };
}

describe('the supply rider — one per agreement version', () => {
  it('refuses a second rider on one agreement', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db.insert(digitalSupplyTerms).values({
          agreementId: fixture.agreementId,
          supplierId: fixture.supplierId,
          provenance: 'authorized_wholesaler',
          evidenceLocation: 'vault://riders/second.pdf',
          approvedByOxyUserId: 'oxy-approver',
          approvedAt: NOW,
        }),
      'unique',
    );
  });

  it('refuses a product class outside the closed tuple — a gift card is unrepresentable', async () => {
    // ADR 0011 D16: stored value is not "disabled by a flag", it has no member.
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db
          .update(digitalSupplyTerms)
          .set({ permittedProductClasses: ['gift_card'] })
          .where(eq(digitalSupplyTerms.id, fixture.termsId)),
      'check',
    );
  });

  it('refuses a rider with no evidence location', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db
          .update(digitalSupplyTerms)
          .set({ evidenceLocation: '   ' })
          .where(eq(digitalSupplyTerms.id, fixture.termsId)),
      'check',
    );
  });
});

describe('a capability pauses on its own', () => {
  it('refuses a pause with no reason', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db
          .update(digitalSupplierCapabilities)
          .set({ state: 'paused', pausedAt: NOW })
          .where(eq(digitalSupplierCapabilities.supplierAccountId, fixture.accountId)),
      'check',
    );
  });

  it('refuses two rows for one account and capability', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db
          .insert(digitalSupplierCapabilities)
          .values({ supplierAccountId: fixture.accountId, capability: 'purchase' }),
      'unique',
    );
  });
});

describe('the procurement offer', () => {
  it('refuses an `exact` mapping with no canonical variant', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () => makeOffer(fixture, { mappingStatus: 'exact', canonicalVariantId: null }),
      'check',
    );
  });

  it('refuses an `ambiguous` mapping with no note — the review queue needs a reason', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(() => makeOffer(fixture, { mappingStatus: 'ambiguous' }), 'check');
  });

  it('stores an ambiguous offer WITH a note, keeping the supplier title verbatim', async () => {
    // Stored and dark, never dropped: a candidate that vanishes is
    // indistinguishable from one that was never there.
    const fixture = await makeSupplyChain();
    const offerId = await makeOffer(fixture, {
      mappingStatus: 'ambiguous',
      mappingNote: 'two editions match this title',
      supplierNativeTitle: 'GAME OF THE YEAR ED. [EU/RU]',
    });
    const [row] = await db
      .select()
      .from(digitalProcurementOffers)
      .where(eq(digitalProcurementOffers.id, offerId));
    expect(row?.supplierNativeTitle).toBe('GAME OF THE YEAR ED. [EU/RU]');
  });

  it('refuses a second offer for one account and SKU, and refreshes in place instead', async () => {
    const fixture = await makeSupplyChain();
    const sku = `SKU-${uuidv7()}`;
    await makeOffer(fixture, { supplierSku: sku });
    await expectRefused(() => makeOffer(fixture, { supplierSku: sku }), 'unique');
  });

  it('refuses a non-slug platform, so a free-text ecosystem cannot arrive', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(() => makeOffer(fixture, { platform: 'PC (Windows)' }), 'check');
  });

  it('joins every fact the eligibility derivation needs, in one read', async () => {
    const fixture = await makeSupplyChain();
    const offerId = await makeOffer(fixture);
    const candidates = await findProcurementCandidates(fixture.variantId);
    expect(candidates.map((candidate) => candidate.offerId)).toContain(offerId);
    const candidate = candidates.find((entry) => entry.offerId === offerId);
    expect(candidate?.supplierStatus).toBe('active');
    expect(candidate?.purchaseCapabilityState).toBe('enabled');
    expect(candidate?.provenance).toBe('authorized_distributor');
    expect(candidate?.permittedProductClasses).toEqual(['digital_game']);
  });

  it('still returns an offer with NO rider, so the refusal is explainable', async () => {
    const fixture = await makeSupplyChain();
    const offerId = await makeOffer(fixture, { digitalSupplyTermsId: null });
    const candidates = await findProcurementCandidates(fixture.variantId);
    const candidate = candidates.find((entry) => entry.offerId === offerId);
    expect(candidate).toBeDefined();
    expect(candidate?.termsId).toBeNull();
  });
});

describe('exactly-once procurement — ADR 0011 D6', () => {
  it('converges on ONE purchase order under concurrent duplicate creation', async () => {
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const input = purchaseOrderInput(fixture, orderItemId);
    const [a, b] = await Promise.all([openPurchaseOrder(input), openPurchaseOrder(input)]);
    expect(a.purchaseOrder.id).toBe(b.purchaseOrder.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const rows = await db
      .select({ id: digitalPurchaseOrders.id })
      .from(digitalPurchaseOrders)
      .where(eq(digitalPurchaseOrders.orderItemId, orderItemId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a SECOND live attempt for one order line — the fallback rule as an index', async () => {
    // The property the whole design rests on: while an attempt is unresolved —
    // `ambiguous` above all — nothing else can be opened for that buyer.
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const first = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId, 1));
    const second = await openPurchaseOrder({
      ...purchaseOrderInput(fixture, orderItemId, 2),
      previousPurchaseOrderId: first.purchaseOrder.id,
    });
    expect(second.created).toBe(false);
    expect(second.purchaseOrder.id).toBe(first.purchaseOrder.id);
  });

  it('allows a fallback once the first attempt is TERMINAL', async () => {
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const first = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId, 1));
    await transitionPurchaseOrder({
      purchaseOrderId: first.purchaseOrder.id,
      from: 'pending',
      to: 'failed',
      now: NOW,
      errorKind: 'provider_unavailable',
    });
    const second = await openPurchaseOrder({
      ...purchaseOrderInput(fixture, orderItemId, 2),
      previousPurchaseOrderId: first.purchaseOrder.id,
    });
    expect(second.created).toBe(true);
    expect(await findLivePurchaseOrderForLine(orderItemId)).toMatchObject({
      id: second.purchaseOrder.id,
    });
  });

  it('derives the idempotency key, so a replay re-derives it rather than minting one', () => {
    expect(purchaseOrderIdempotencyKey('line-1', 2)).toBe('dpo:line-1:2');
  });

  it('refuses a hand-typed idempotency key — the column holds a DERIVED shape', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db.insert(digitalPurchaseOrders).values({
          ...purchaseOrderRow(fixture, `line-${uuidv7()}`),
          idempotencyKey: 'whatever-i-typed',
        }),
      'check',
    );
  });
});

describe('the compare-and-swap', () => {
  it('lets exactly one of two concurrent answers win', async () => {
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const { purchaseOrder } = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId));
    const [a, b] = await Promise.all([
      transitionPurchaseOrder({
        purchaseOrderId: purchaseOrder.id,
        from: 'pending',
        to: 'preflighted',
        now: NOW,
      }),
      transitionPurchaseOrder({
        purchaseOrderId: purchaseOrder.id,
        from: 'pending',
        to: 'cancelled',
        now: NOW,
      }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['stale', 'updated']);
  });

  it('answers `forbidden` for an edge the machine does not admit, issuing no SQL', async () => {
    // A timeout may NEVER write `failed` from `submitting` — the edge does not
    // exist, and the repository refuses it before it reaches the database.
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    const result = await transitionPurchaseOrder({
      purchaseOrderId: purchaseOrder.id,
      from: 'fulfilled',
      to: 'pending',
      now: NOW,
    });
    expect(result.outcome).toBe('forbidden');
  });

  it('answers `missing` for a purchase order that is not there', async () => {
    const result = await transitionPurchaseOrder({
      purchaseOrderId: uuidv7(),
      from: 'pending',
      to: 'preflighted',
      now: NOW,
    });
    expect(result.outcome).toBe('missing');
  });

  it('keeps `ambiguous_since` after recovery, as history', async () => {
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    for (const [from, to] of [
      ['pending', 'preflighted'],
      ['preflighted', 'submitting'],
      ['submitting', 'ambiguous'],
      ['ambiguous', 'accepted'],
    ] as const) {
      await transitionPurchaseOrder({ purchaseOrderId: purchaseOrder.id, from, to, now: NOW });
    }
    const [row] = await db
      .select()
      .from(digitalPurchaseOrders)
      .where(eq(digitalPurchaseOrders.id, purchaseOrder.id));
    expect(row?.status).toBe('accepted');
    expect(row?.ambiguousSince).not.toBeNull();
  });
});

describe('the frozen purchase order', () => {
  it('refuses a changed cost snapshot, by trigger', async () => {
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    await expectRefused(
      () =>
        db
          .update(digitalPurchaseOrders)
          .set({ quotedCostAmount: 1 })
          .where(eq(digitalPurchaseOrders.id, purchaseOrder.id)),
      'trigger',
    );
  });

  it('refuses a bound below the quote, and a final cost above the bound', async () => {
    const fixture = await makeSupplyChain();
    await expectRefused(
      () =>
        db.insert(digitalPurchaseOrders).values({
          ...purchaseOrderRow(fixture, `line-${uuidv7()}`),
          maxAcceptedCostAmount: 500,
        }),
      'check',
    );

    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    await expectRefused(
      () =>
        db
          .update(digitalPurchaseOrders)
          .set({ finalCostAmount: 99_999, finalCostCurrency: 'EUR' })
          .where(eq(digitalPurchaseOrders.id, purchaseOrder.id)),
      'check',
    );
  });
});

describe('the attempt log is append-only', () => {
  it('numbers attempts monotonically without a read-modify-write', async () => {
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    const attempt = (operation: 'preflight' | 'purchase') =>
      recordAttempt({
        purchaseOrderId: purchaseOrder.id,
        operation,
        outcome: 'succeeded',
        errorKind: null,
        errorMessageRedacted: null,
        providerRequestId: null,
        providerReference: null,
        startedAt: NOW,
        finishedAt: NOW,
      });
    await attempt('preflight');
    await attempt('purchase');
    const rows = await db
      .select({ attemptNumber: digitalPurchaseOrderAttempts.attemptNumber })
      .from(digitalPurchaseOrderAttempts)
      .where(eq(digitalPurchaseOrderAttempts.purchaseOrderId, purchaseOrder.id));
    expect(rows.map((row) => row.attemptNumber).sort()).toEqual([1, 2]);
  });

  it('refuses UPDATE and DELETE', async () => {
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    const row = await recordAttempt({
      purchaseOrderId: purchaseOrder.id,
      operation: 'preflight',
      outcome: 'failed',
      errorKind: 'timeout',
      errorMessageRedacted: 'timed out',
      providerRequestId: null,
      providerReference: null,
      startedAt: NOW,
      finishedAt: NOW,
    });
    await expectRefused(
      () =>
        db
          .update(digitalPurchaseOrderAttempts)
          .set({ outcome: 'succeeded' })
          .where(eq(digitalPurchaseOrderAttempts.id, row.id)),
      'trigger',
    );
    await expectRefused(
      () =>
        db
          .delete(digitalPurchaseOrderAttempts)
          .where(eq(digitalPurchaseOrderAttempts.id, row.id)),
      'trigger',
    );
  });

  it('refuses a successful attempt that also carries an error', async () => {
    const fixture = await makeSupplyChain();
    const { purchaseOrder } = await openPurchaseOrder(
      purchaseOrderInput(fixture, `line-${uuidv7()}`),
    );
    await expectRefused(
      () =>
        db.insert(digitalPurchaseOrderAttempts).values({
          purchaseOrderId: purchaseOrder.id,
          attemptNumber: 1,
          operation: 'purchase',
          outcome: 'succeeded',
          errorKind: 'timeout',
          startedAt: NOW,
          finishedAt: NOW,
        }),
      'check',
    );
  });
});

/* -------------------------------------------------------------------------- */

/** A delivered fulfilment with one active, sealed artifact. */
async function makeDeliveredFulfilment(fixture: Fixture) {
  const orderItemId = `line-${uuidv7()}`;
  const { purchaseOrder } = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId));
  const { fulfilment } = await createFulfilment({
    purchaseOrderId: purchaseOrder.id,
    orderId: `order-${orderItemId}`,
    orderItemId,
    buyerKey: `oxy:buyer-${uuidv7()}`,
    capability: 'activation_key',
    productClass: 'digital_game',
    canonicalVariantId: fixture.variantId,
    displayTitle: 'A game',
    platform: 'pc',
    activationEcosystem: 'sandbox-store',
    edition: 'standard',
    now: NOW,
  });
  const artifactId = await storeArtifact({
    fulfilmentId: fulfilment.id,
    capability: 'activation_key',
    source: 'supplier_api',
    sealedSecret: 'v1:aaaa:bbbb:cccc',
    keyReference: '/oxy/mercaria/digital-retail/seal/test',
    sealAlgorithm: 'aes-256-gcm.v1',
    plaintextSha256: 'a'.repeat(64),
    maskedHint: 'WXYZ',
    instructions: 'Redeem in the store.',
    providerArtifactId: null,
    replacesArtifactId: null,
    incidentId: null,
    operatorOxyUserId: null,
    expiresAt: null,
    now: NOW,
  });
  return { fulfilment, artifactId, purchaseOrderId: purchaseOrder.id };
}

describe('the fulfilment and its artifacts', () => {
  it('creates ONE fulfilment per order line, converging on a replay', async () => {
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const { purchaseOrder } = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId));
    const input = {
      purchaseOrderId: purchaseOrder.id,
      orderId: `order-${orderItemId}`,
      orderItemId,
      buyerKey: `oxy:buyer-${uuidv7()}`,
      capability: 'activation_key' as const,
      productClass: 'digital_game' as const,
      canonicalVariantId: fixture.variantId,
      displayTitle: 'A game',
      platform: 'pc',
      activationEcosystem: 'sandbox-store',
      edition: 'standard',
      now: NOW,
    };
    const [a, b] = await Promise.all([createFulfilment(input), createFulfilment(input)]);
    expect(a.fulfilment.id).toBe(b.fulfilment.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('keeps EXACTLY ONE active artifact — “both keys work” is unrepresentable', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        storeArtifact({
          fulfilmentId: fulfilment.id,
          capability: 'activation_key',
          source: 'supplier_api',
          sealedSecret: 'v1:dddd:eeee:ffff',
          keyReference: '/oxy/mercaria/digital-retail/seal/test',
          sealAlgorithm: 'aes-256-gcm.v1',
          plaintextSha256: 'b'.repeat(64),
          maskedHint: 'ABCD',
          instructions: null,
          providerArtifactId: null,
          replacesArtifactId: null,
          incidentId: null,
          operatorOxyUserId: null,
          expiresAt: null,
          now: NOW,
        }),
      'unique',
    );
  });

  it('replaces an artifact by superseding it, and keeps the old one', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment, artifactId } = await makeDeliveredFulfilment(fixture);
    const incident = await openIncident({
      fulfilmentId: fulfilment.id,
      artifactId,
      kind: 'buyer_reported_invalid',
      reportNote: 'key rejected at redemption',
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      now: NOW,
    });
    const replacementId = await replaceArtifact({
      supersedesArtifactId: artifactId,
      fulfilmentId: fulfilment.id,
      capability: 'activation_key',
      source: 'supplier_api',
      sealedSecret: 'v1:gggg:hhhh:iiii',
      keyReference: '/oxy/mercaria/digital-retail/seal/test',
      sealAlgorithm: 'aes-256-gcm.v1',
      plaintextSha256: 'c'.repeat(64),
      maskedHint: 'MNOP',
      instructions: null,
      providerArtifactId: null,
      replacesArtifactId: artifactId,
      incidentId: incident.id,
      operatorOxyUserId: null,
      expiresAt: null,
      now: NOW,
    });
    const rows = await db
      .select({ id: digitalFulfilmentArtifacts.id, state: digitalFulfilmentArtifacts.state })
      .from(digitalFulfilmentArtifacts)
      .where(eq(digitalFulfilmentArtifacts.fulfilmentId, fulfilment.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === artifactId)?.state).toBe('replaced');
    expect(rows.find((row) => row.id === replacementId)?.state).toBe('active');
  });

  it('refuses a secret on a capability that hands none over, and its converse', async () => {
    const fixture = await makeSupplyChain();
    const orderItemId = `line-${uuidv7()}`;
    const { purchaseOrder } = await openPurchaseOrder(purchaseOrderInput(fixture, orderItemId));
    const { fulfilment } = await createFulfilment({
      purchaseOrderId: purchaseOrder.id,
      orderId: `order-${orderItemId}`,
      orderItemId,
      buyerKey: `oxy:buyer-${uuidv7()}`,
      capability: 'direct_account_activation',
      productClass: 'digital_game',
      canonicalVariantId: fixture.variantId,
      displayTitle: 'A game',
      platform: 'pc',
      activationEcosystem: 'sandbox-store',
      edition: 'standard',
      now: NOW,
    });
    // A direct activation carrying a key nobody should ever be shown.
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentArtifacts).values({
          fulfilmentId: fulfilment.id,
          capability: 'direct_account_activation',
          source: 'supplier_api',
          sealedSecret: 'v1:aaaa:bbbb:cccc',
          keyReference: '/oxy/mercaria/digital-retail/seal/test',
          sealAlgorithm: 'aes-256-gcm.v1',
        }),
      'check',
    );
    // An activation key with nothing in it.
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentArtifacts).values({
          fulfilmentId: fulfilment.id,
          capability: 'activation_key',
          source: 'supplier_api',
        }),
      'check',
    );
  });

  it('refuses a pasted key where the key REFERENCE belongs', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentArtifacts).values({
          fulfilmentId: fulfilment.id,
          capability: 'activation_key',
          source: 'supplier_api',
          state: 'replaced',
          sealedSecret: 'v1:aaaa:bbbb:cccc',
          keyReference: 'sk_live_51Habc123SECRET',
          sealAlgorithm: 'aes-256-gcm.v1',
        }),
      'check',
    );
  });

  it('refuses a hint longer than four characters at INSERT', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment, artifactId } = await makeDeliveredFulfilment(fixture);
    // A second row rather than an update, because the hint is part of the SEAL
    // and the trigger freezes it — the CHECK is what stops one being written in
    // the first place, and the trigger is what stops it being changed after.
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentArtifacts).values({
          fulfilmentId: fulfilment.id,
          capability: 'activation_key',
          source: 'supplier_api',
          state: 'replaced',
          sealedSecret: 'v1:aaaa:bbbb:cccc',
          keyReference: '/oxy/mercaria/digital-retail/seal/test',
          sealAlgorithm: 'aes-256-gcm.v1',
          maskedHint: 'ABCDEFGH',
        }),
      'check',
    );
    // And the hint cannot be edited afterwards either — a changed hint would
    // describe a key the buyer was never given.
    await expectRefused(
      () =>
        db
          .update(digitalFulfilmentArtifacts)
          .set({ maskedHint: 'ZZZZ' })
          .where(eq(digitalFulfilmentArtifacts.id, artifactId)),
      'trigger',
    );
  });

  it('refuses DELETE, and refuses swapping the sealed half', async () => {
    const fixture = await makeSupplyChain();
    const { artifactId } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        db
          .update(digitalFulfilmentArtifacts)
          .set({ sealedSecret: 'v1:zzzz:zzzz:zzzz' })
          .where(eq(digitalFulfilmentArtifacts.id, artifactId)),
      'trigger',
    );
    await expectRefused(
      () => db.delete(digitalFulfilmentArtifacts).where(eq(digitalFulfilmentArtifacts.id, artifactId)),
      'trigger',
    );
  });

  it('lets the MUTABLE half move: state, redemption and instructions', async () => {
    const fixture = await makeSupplyChain();
    const { artifactId } = await makeDeliveredFulfilment(fixture);
    await db
      .update(digitalFulfilmentArtifacts)
      .set({ redemptionState: 'redeemed', redemptionCheckedAt: NOW, instructions: 'Updated.' })
      .where(eq(digitalFulfilmentArtifacts.id, artifactId));
    const [row] = await db
      .select()
      .from(digitalFulfilmentArtifacts)
      .where(eq(digitalFulfilmentArtifacts.id, artifactId));
    expect(row?.redemptionState).toBe('redeemed');
  });
});

describe('the reveal audit', () => {
  it('records a reveal, advances the counter and freezes the FIRST timestamp', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment, artifactId } = await makeDeliveredFulfilment(fixture);
    const later = new Date(NOW.getTime() + 60_000);
    await recordReveal({
      fulfilmentId: fulfilment.id,
      artifactId,
      actorKind: 'buyer',
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      reason: null,
      now: NOW,
    });
    await recordReveal({
      fulfilmentId: fulfilment.id,
      artifactId,
      actorKind: 'buyer',
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      reason: null,
      now: later,
    });
    const [row] = await db
      .select()
      .from(digitalFulfilments)
      .where(eq(digitalFulfilments.id, fulfilment.id));
    expect(row?.revealCount).toBe(2);
    expect(row?.firstRevealedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('refuses an operator reveal with no operator and no reason', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment, artifactId } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentReveals).values({
          fulfilmentId: fulfilment.id,
          artifactId,
          actorKind: 'operator',
          revealedAt: NOW,
        }),
      'check',
    );
  });

  it('refuses UPDATE and DELETE on the audit', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment, artifactId } = await makeDeliveredFulfilment(fixture);
    await recordReveal({
      fulfilmentId: fulfilment.id,
      artifactId,
      actorKind: 'buyer',
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      reason: null,
      now: NOW,
    });
    await expectRefused(
      () =>
        db
          .delete(digitalFulfilmentReveals)
          .where(eq(digitalFulfilmentReveals.fulfilmentId, fulfilment.id)),
      'trigger',
    );
  });

  it('carries NO device, IP, session or user-agent column, by construction', async () => {
    // `~/AGENTS.md`'s no-IP invariant, and the epic's W11 requirement 5. Asserted
    // against the REAL table rather than against the drizzle definition, so a
    // hand-written migration adding one is caught too.
    const columns = await db.execute(
      sql`select column_name from information_schema.columns
          where table_name = 'digital_fulfilment_reveals'`,
    );
    const names = (columns as unknown as { column_name: string }[]).map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(5);
    for (const forbidden of ['ip', 'ip_address', 'user_agent', 'device_id', 'fingerprint', 'session_id']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('the operator audit — ADR 0011 D12', () => {
  it('refuses an operator-entered artifact with no operator and no incident', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        db.insert(digitalFulfilmentArtifacts).values({
          fulfilmentId: fulfilment.id,
          capability: 'activation_key',
          source: 'operator_manual',
          state: 'replaced',
          sealedSecret: 'v1:aaaa:bbbb:cccc',
          keyReference: '/oxy/mercaria/digital-retail/seal/test',
          sealAlgorithm: 'aes-256-gcm.v1',
        }),
      'check',
    );
  });

  it('refuses an operator-raised incident that names no operator — a machine cannot file', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    await expectRefused(
      () =>
        openIncident({
          fulfilmentId: fulfilment.id,
          artifactId: null,
          kind: 'provider_incident',
          reportNote: 'supplier outage',
          buyerKey: null,
          operatorOxyUserId: null,
          now: NOW,
        }),
      'check',
    );
  });

  it('refuses a `replacement_issued` incident that names no replacement', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    const incident = await openIncident({
      fulfilmentId: fulfilment.id,
      artifactId: null,
      kind: 'buyer_reported_used',
      reportNote: 'already redeemed',
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      now: NOW,
    });
    await expectRefused(
      () =>
        db
          .update(digitalFulfilmentIncidents)
          .set({ state: 'replacement_issued', resolvedAt: NOW })
          .where(eq(digitalFulfilmentIncidents.id, incident.id)),
      'check',
    );
  });

  it('refuses DELETE on an incident', async () => {
    const fixture = await makeSupplyChain();
    const { fulfilment } = await makeDeliveredFulfilment(fixture);
    const incident = await openIncident({
      fulfilmentId: fulfilment.id,
      artifactId: null,
      kind: 'buyer_reported_invalid',
      reportNote: null,
      buyerKey: fulfilment.buyerKey,
      operatorOxyUserId: null,
      now: NOW,
    });
    await expectRefused(
      () => db.delete(digitalFulfilmentIncidents).where(eq(digitalFulfilmentIncidents.id, incident.id)),
      'trigger',
    );
  });
});
