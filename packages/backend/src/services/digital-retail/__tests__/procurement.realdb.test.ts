// The levers and the sealing key, set BEFORE `config` is imported. See the file.
import './procurement-env.js';

/**
 * The procurement orchestrator, end to end, against a REAL Postgres database and
 * a supplier that behaves like one (#1016, ADR 0011 D5–D7).
 *
 * ## Why this file exists rather than a mocked orchestration test
 *
 * Every property worth having here is a property of TWO systems agreeing: the
 * database's live-line index and the adapter's idempotency, the CAS and the
 * timeout, the sealed column and the reveal. A mocked repository accepts a second
 * live purchase order, which is precisely the thing that must be impossible — so
 * a mocked test of "we do not buy twice" passes in a world where we would.
 *
 * ## The case this file is really for
 *
 * `purchaseFailsAfterBuying` — a supplier that ALLOCATES a key and then times out
 * before saying so. It is the shape that makes a naive fallback buy a second key,
 * it is invisible to any adapter that fakes failures, and the assertion is not
 * just that Mercaria recovers: it is that the sandbox's own ledger still holds
 * exactly ONE order afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import {
  digitalProcurementOffers,
  digitalPurchaseOrders,
  digitalRetailPricingPolicies,
  digitalSupplierCapabilities,
  digitalSupplyTerms,
} from '../../../db/schema/digitalRetail.js';
import {
  supplierAccounts,
  supplierAgreements,
  suppliers,
} from '../../../db/schema/procurement.js';
import {
  findPurchaseOrder,
  findPurchaseOrdersForLine,
} from '../../../db/digitalRetail/digitalPurchaseOrderRepository.js';
import { findActiveArtifact } from '../../../db/digitalRetail/digitalFulfilmentRepository.js';
import {
  registerDigitalSupplierAdapter,
  unregisterDigitalSupplierAdapter,
} from '../adapter-registry.js';
import { createSandboxAdapter, type SandboxScriptEntry } from '../sandbox-adapter.js';
import {
  procureDigitalLine,
  recoverAmbiguousPurchaseOrder,
  type ProcureDigitalLineInput,
} from '../procurement.service.js';
import { revealArtifactForBuyer, revealArtifactForOperator } from '../reveal.service.js';
import { buildBuyerLibrary } from '../library.js';
import { composeDigitalRetailOffer, projectDigitalRetailSourcingSeam } from '../retail-offer.js';
import { deriveDigitalProcurementEligibility } from '../eligibility.js';
import { findProcurementCandidates } from '../../../db/digitalRetail/digitalProcurementOfferRepository.js';
import {
  activatePricingPolicy,
  createPricingPolicyDraft,
} from '../../../db/digitalRetail/pricingPolicyRepository.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

const NOW = new Date('2026-08-01T10:00:00.000Z');

interface Chain {
  provider: string;
  supplierId: string;
  accountId: string;
  termsId: string;
  variantId: string;
  adapter: ReturnType<typeof createSandboxAdapter>;
}

/**
 * A whole authorized supplier with its OWN adapter slug.
 *
 * The slug is per chain rather than the shared `sandbox`, so two tests in this
 * file — and any other file in the same worker — cannot script each other's
 * supplier. A registry keyed by a name two tests share is a flaky suite waiting
 * for a parallel run.
 */
async function makeChain(
  script: Record<string, SandboxScriptEntry> = {},
  options: { provenance?: 'publisher_direct' | 'authorized_distributor'; variantId?: string } = {},
): Promise<Chain> {
  const provider = `sbx-${uuidv7()}`;
  const [supplier] = await db
    .insert(suppliers)
    .values({
      supplierType: 'digital_distributor',
      canonicalName: `Supplier ${uuidv7()}`,
      status: 'active',
      riskLevel: 'low',
    })
    .returning({ id: suppliers.id });
  const [account] = await db
    .insert(supplierAccounts)
    .values({
      supplierId: supplier!.id,
      provider,
      environment: 'test',
      providerAccountId: `acct-${uuidv7()}`,
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
      permittedChannels: ['mercaria_marketplace'],
      resaleRightsGranted: true,
      dataProcessingTermsAccepted: true,
      evidenceLocation: 'vault://agreements/x.pdf',
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
      provenance: options.provenance ?? 'authorized_distributor',
      permittedProductClasses: ['digital_game'],
      permittedFulfilmentCapabilities: ['activation_key'],
      permittedTerritories: ['ES'],
      resaleRightsGranted: true,
      replacementSupported: true,
      evidenceLocation: 'vault://riders/x.pdf',
      approvedByOxyUserId: 'oxy-approver',
      approvedAt: NOW,
    })
    .returning({ id: digitalSupplyTerms.id });
  await db.insert(digitalSupplierCapabilities).values({
    supplierAccountId: account!.id,
    capability: 'purchase',
    state: 'enabled',
  });

  let variantId = options.variantId;
  if (!variantId) {
    const name = `Game ${uuidv7()}`;
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
    variantId = variant!.id;
  }

  const adapter = createSandboxAdapter({ provider, script });
  registerDigitalSupplierAdapter(adapter);
  return {
    provider,
    supplierId: supplier!.id,
    accountId: account!.id,
    termsId: terms!.id,
    variantId,
    adapter,
  };
}

/** An exact, procurable offer on that chain. Returns its SKU. */
async function makeOffer(
  chain: Chain,
  sku: string,
  overrides: Partial<typeof digitalProcurementOffers.$inferInsert> = {},
): Promise<string> {
  const [product] = await db
    .select({ productId: canonicalVariants.productId })
    .from(canonicalVariants)
    .where(eq(canonicalVariants.id, chain.variantId));
  await db.insert(digitalProcurementOffers).values({
    supplierId: chain.supplierId,
    supplierAccountId: chain.accountId,
    digitalSupplyTermsId: chain.termsId,
    canonicalProductId: product!.productId,
    canonicalVariantId: chain.variantId,
    supplierSku: sku,
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
    // The freshness derivation reads the WALL CLOCK, so an offer fixture has to
    // be fresh against it rather than against this file's frozen `NOW` — a quote
    // confirmed in 2026 is stale by every TTL the moment the suite runs.
    firstSeenAt: new Date(Date.now() - 60_000),
    lastConfirmedAt: new Date(),
    ...overrides,
  });
  return sku;
}

function lineInput(chain: Chain, overrides: Partial<ProcureDigitalLineInput> = {}) {
  const orderItemId = `line-${uuidv7()}`;
  return {
    orderId: `order-${uuidv7()}`,
    orderItemId,
    buyerKey: `oxy:buyer-${uuidv7()}`,
    canonicalVariantId: chain.variantId,
    displayTitle: 'Cyberpunk 2077 — PC · Steam',
    activationTerritory: 'ES',
    requiredCapability: 'activation_key' as const,
    maxAcceptedCostAmount: 1_200,
    currency: 'EUR',
    ...overrides,
  };
}

describe('the happy path', () => {
  it('procures, seals and delivers — and the buyer can reveal exactly what was bought', async () => {
    const chain = await makeChain();
    const sku = await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);

    const result = await procureDigitalLine(input);
    expect(result.status).toBe('fulfilled');
    if (result.status !== 'fulfilled') return;

    const purchaseOrder = await findPurchaseOrder(result.purchaseOrderId);
    expect(purchaseOrder?.status).toBe('fulfilled');
    expect(purchaseOrder?.providerOrderId).toMatch(/^sbx_/);
    expect(purchaseOrder?.finalCostAmount).toBe(1_000);

    // The artifact is stored SEALED: the public row has no secret property at
    // all, and the hint is four characters of the tail.
    const artifact = await findActiveArtifact(result.fulfilmentId);
    expect(artifact).toBeTruthy();
    expect(JSON.stringify(artifact)).not.toContain('SANDBOX');
    expect(artifact?.maskedHint).toBe('-KEY'.slice(-4));

    const revealed = await revealArtifactForBuyer({
      fulfilmentId: result.fulfilmentId,
      buyerKey: input.buyerKey,
    });
    expect(revealed.revealed).toBe(true);
    if (revealed.revealed) expect(revealed.secret).toBe(`SANDBOX-${sku.toUpperCase()}-KEY`);

    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('is idempotent: a second call returns the same fulfilment and buys nothing', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);

    const first = await procureDigitalLine(input);
    const second = await procureDigitalLine(input);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('already_fulfilled');
    expect(chain.adapter.orders.size).toBe(1);

    const orders = await findPurchaseOrdersForLine(input.orderItemId);
    expect(orders).toHaveLength(1);
    unregisterDigitalSupplierAdapter(chain.provider);
  });
});

describe('the ambiguous timeout — ADR 0011 D5 and D6', () => {
  it('STOPS at `ambiguous` rather than falling back, and buys nothing more', async () => {
    // The whole design in one test. The supplier ALLOCATED a key and then timed
    // out; a fallback here buys a second one for a customer paying for one.
    const sku = `SKU-${uuidv7()}`;
    const chain = await makeChain({ [sku]: { purchaseFailsAfterBuying: 'timeout' } });
    await makeOffer(chain, sku);
    // A second supplier for the same variant, so a fallback is AVAILABLE and the
    // test proves it was not taken rather than that it was impossible.
    const rival = await makeChain({}, { variantId: chain.variantId });
    await makeOffer(rival, `SKU-${uuidv7()}`);

    const input = lineInput(chain);
    const result = await procureDigitalLine(input);
    expect(result.status).toBe('ambiguous');

    expect(chain.adapter.orders.size).toBe(1);
    expect(rival.adapter.orders.size).toBe(0);

    // And a retried call does not step over it either.
    const retried = await procureDigitalLine(input);
    expect(retried.status).toBe('ambiguous');
    expect(rival.adapter.orders.size).toBe(0);

    const orders = await findPurchaseOrdersForLine(input.orderItemId);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('ambiguous');
    expect(orders[0]?.errorKind).toBe('timeout');

    unregisterDigitalSupplierAdapter(chain.provider);
    unregisterDigitalSupplierAdapter(rival.provider);
  });

  it('recovers from provider TRUTH, then delivers the key that was already bought', async () => {
    const sku = `SKU-${uuidv7()}`;
    const chain = await makeChain({ [sku]: { purchaseFailsAfterBuying: 'timeout' } });
    await makeOffer(chain, sku);
    const input = lineInput(chain);
    await procureDigitalLine(input);

    const [ambiguous] = await findPurchaseOrdersForLine(input.orderItemId);
    const recovery = await recoverAmbiguousPurchaseOrder(ambiguous!, NOW);
    expect(recovery.resolved).toBe('accepted');

    const delivered = await procureDigitalLine(input);
    expect(delivered.status).toBe('fulfilled');
    // ONE order at the supplier, for one customer order line.
    expect(chain.adapter.orders.size).toBe(1);

    if (delivered.status === 'fulfilled') {
      const revealed = await revealArtifactForBuyer({
        fulfilmentId: delivered.fulfilmentId,
        buyerKey: input.buyerKey,
      });
      expect(revealed.revealed).toBe(true);
    }
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('leaves an attempt AMBIGUOUS when the recovery call itself fails', async () => {
    // The branch a naive implementation gets wrong by reading a failed recovery
    // as "nothing was bought" — which is the assumption that buys a second key.
    const sku = `SKU-${uuidv7()}`;
    const chain = await makeChain({ [sku]: { purchaseFailsAfterBuying: 'timeout' } });
    await makeOffer(chain, sku);
    const input = lineInput(chain);
    await procureDigitalLine(input);
    const [ambiguous] = await findPurchaseOrdersForLine(input.orderItemId);

    // The supplier is unreachable for the recovery call.
    registerDigitalSupplierAdapter({
      ...chain.adapter,
      async recoverPurchase() {
        return {
          ok: false,
          failure: { kind: 'provider_unavailable', messageRedacted: 'unreachable' },
        };
      },
    });

    const recovery = await recoverAmbiguousPurchaseOrder(ambiguous!, NOW);
    expect(recovery.resolved).toBe('still_unknown');
    const [after] = await findPurchaseOrdersForLine(input.orderItemId);
    expect(after?.status).toBe('ambiguous');
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('frees the line when the supplier confirms it bought NOTHING', async () => {
    const sku = `SKU-${uuidv7()}`;
    const chain = await makeChain({ [sku]: { purchaseFails: 'timeout' } });
    await makeOffer(chain, sku);
    const input = lineInput(chain);
    await procureDigitalLine(input);
    const [ambiguous] = await findPurchaseOrdersForLine(input.orderItemId);

    const recovery = await recoverAmbiguousPurchaseOrder(ambiguous!, NOW);
    expect(recovery.resolved).toBe('nothing_bought');
    const [after] = await findPurchaseOrdersForLine(input.orderItemId);
    expect(after?.status).toBe('failed');
    unregisterDigitalSupplierAdapter(chain.provider);
  });
});

describe('fallback', () => {
  it('tries the next eligible supplier when the first REJECTS, and chains the attempts', async () => {
    const failingSku = `SKU-${uuidv7()}`;
    const first = await makeChain({ [failingSku]: { purchaseFails: 'out_of_stock' } });
    await makeOffer(first, failingSku, { costAmount: 900 });
    const second = await makeChain({}, { variantId: first.variantId });
    await makeOffer(second, `SKU-${uuidv7()}`, { costAmount: 1_000 });

    const input = lineInput(first);
    const result = await procureDigitalLine(input);
    expect(result.status).toBe('fulfilled');

    const orders = await findPurchaseOrdersForLine(input.orderItemId);
    expect(orders).toHaveLength(2);
    expect(orders[0]?.status).toBe('rejected');
    expect(orders[0]?.errorKind).toBe('out_of_stock');
    expect(orders[1]?.status).toBe('fulfilled');
    expect(orders[1]?.previousPurchaseOrderId).toBe(orders[0]?.id);
    expect(orders[1]?.attemptOrdinal).toBe(2);

    unregisterDigitalSupplierAdapter(first.provider);
    unregisterDigitalSupplierAdapter(second.provider);
  });

  it('never exceeds the order’s cost ceiling, and refuses rather than absorbing', async () => {
    const sku = `SKU-${uuidv7()}`;
    // The offer says 1 000; the supplier's preflight says 5 000.
    const chain = await makeChain({ [sku]: { costAmount: 5_000 } });
    await makeOffer(chain, sku, { costAmount: 1_000 });

    const input = lineInput(chain, { maxAcceptedCostAmount: 1_200 });
    const result = await procureDigitalLine(input);
    expect(result.status).toBe('exhausted');
    expect(chain.adapter.orders.size).toBe(0);

    const orders = await findPurchaseOrdersForLine(input.orderItemId);
    expect(orders[0]?.status).toBe('rejected');
    expect(orders[0]?.errorKind).toBe('price_changed');
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('reports every reason when NO supplier is eligible, rather than an empty list', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`, {
      mappingStatus: 'ambiguous',
      mappingNote: 'two editions match',
    });
    const result = await procureDigitalLine(lineInput(chain));
    expect(result.status).toBe('no_eligible_supplier');
    if (result.status === 'no_eligible_supplier') {
      expect(result.reasons).toContain('offer_mapping_ambiguous');
    }
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('prefers the stronger PROVENANCE over the cheaper cost', async () => {
    const direct = await makeChain({}, { provenance: 'publisher_direct' });
    await makeOffer(direct, `SKU-${uuidv7()}`, { costAmount: 1_100 });
    const cheaper = await makeChain({}, { variantId: direct.variantId });
    await makeOffer(cheaper, `SKU-${uuidv7()}`, { costAmount: 800 });

    const result = await procureDigitalLine(lineInput(direct));
    expect(result.status).toBe('fulfilled');
    expect(direct.adapter.orders.size).toBe(1);
    expect(cheaper.adapter.orders.size).toBe(0);

    unregisterDigitalSupplierAdapter(direct.provider);
    unregisterDigitalSupplierAdapter(cheaper.provider);
  });
});

describe('what the buyer sees', () => {
  it('shows the purchase in the library with a hint and no secret', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);
    const result = await procureDigitalLine(input);
    expect(result.status).toBe('fulfilled');

    const library = await buildBuyerLibrary(input.buyerKey);
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({
      origin: 'authorized_retail',
      title: 'Cyberpunk 2077 — PC · Steam',
      status: 'active',
      action: 'reveal',
      revealed: false,
    });
    expect(JSON.stringify(library)).not.toContain('SANDBOX');
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('refuses another buyer with the SAME answer as a missing fulfilment', async () => {
    // Distinguishing them would confirm an id exists, which is an enumeration
    // oracle over a table of bearer secrets.
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);
    const result = await procureDigitalLine(input);
    if (result.status !== 'fulfilled') throw new Error('fixture did not fulfil');

    const somebodyElse = await revealArtifactForBuyer({
      fulfilmentId: result.fulfilmentId,
      buyerKey: 'oxy:someone-else',
    });
    const missing = await revealArtifactForBuyer({
      fulfilmentId: uuidv7(),
      buyerKey: input.buyerKey,
    });
    expect(somebodyElse).toEqual({ revealed: false, reason: 'not_found' });
    expect(missing).toEqual({ revealed: false, reason: 'not_found' });
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('marks the library entry revealed after the first reveal, and counts them', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);
    const result = await procureDigitalLine(input);
    if (result.status !== 'fulfilled') throw new Error('fixture did not fulfil');

    await revealArtifactForBuyer({ fulfilmentId: result.fulfilmentId, buyerKey: input.buyerKey });
    const library = await buildBuyerLibrary(input.buyerKey);
    expect(library[0]?.revealed).toBe(true);
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('audits an operator reveal separately, and requires a reason', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const input = lineInput(chain);
    const result = await procureDigitalLine(input);
    if (result.status !== 'fulfilled') throw new Error('fixture did not fulfil');

    await expect(
      revealArtifactForOperator({
        fulfilmentId: result.fulfilmentId,
        operatorOxyUserId: 'oxy-support-1',
        reason: '   ',
      }),
    ).rejects.toThrow();

    const revealed = await revealArtifactForOperator({
      fulfilmentId: result.fulfilmentId,
      operatorOxyUserId: 'oxy-support-1',
      reason: 'customer reports the key was already used, case 42',
    });
    expect(revealed.revealed).toBe(true);
    unregisterDigitalSupplierAdapter(chain.provider);
  });
});

describe('the attempt log', () => {
  it('records every adapter call, including the ones that failed', async () => {
    const sku = `SKU-${uuidv7()}`;
    const chain = await makeChain({ [sku]: { purchaseFails: 'sku_unknown' } });
    await makeOffer(chain, sku);
    const input = lineInput(chain);
    await procureDigitalLine(input);

    const [order] = await findPurchaseOrdersForLine(input.orderItemId);
    const attempts = await db
      .select()
      .from(digitalPurchaseOrders)
      .where(eq(digitalPurchaseOrders.id, order!.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.errorKind).toBe('sku_unknown');
    expect(attempts[0]?.status).toBe('rejected');
    unregisterDigitalSupplierAdapter(chain.provider);
  });
});

describe('the #57 seam', () => {
  it('projects a candidate carrying identity and a verdict, and NOTHING else', async () => {
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const [candidate] = await findProcurementCandidates(chain.variantId);
    const seam = projectDigitalRetailSourcingSeam(
      candidate!,
      deriveDigitalProcurementEligibility({
        supplier: { status: candidate!.supplierStatus, riskLevel: candidate!.supplierRiskLevel },
        account: { state: candidate!.accountState, purchaseCapabilityState: 'enabled' },
        terms: null,
        offer: {
          id: candidate!.offerId,
          status: candidate!.offerStatus,
          mappingStatus: candidate!.mappingStatus,
          availability: candidate!.availability,
          canonicalProductId: candidate!.canonicalProductId,
          canonicalVariantId: candidate!.canonicalVariantId,
          productClass: candidate!.productClass,
          fulfilmentCapability: candidate!.fulfilmentCapability,
          brandSlug: candidate!.brandSlug,
          activationTerritories: candidate!.activationTerritories,
          costAmount: candidate!.costAmount,
          costCurrency: candidate!.costCurrency,
          quoteTtlSeconds: candidate!.quoteTtlSeconds,
          expiresAt: candidate!.offerExpiresAt,
          lastConfirmedAt: candidate!.lastConfirmedAt,
          expectedFulfilmentSeconds: candidate!.expectedFulfilmentSeconds,
        },
      }),
    );
    // The privacy property, asserted on a REAL projection of a REAL row rather
    // than on the type: a serializer cannot ship what is not there.
    const serialized = JSON.stringify(seam);
    expect(serialized).not.toContain(candidate!.supplierId);
    expect(serialized).not.toContain(candidate!.supplierAccountId);
    expect(serialized).not.toContain(candidate!.supplierSku);
    expect(serialized).not.toContain(String(candidate!.costAmount));
    expect(seam.canonicalVariantId).toBe(chain.variantId);
    unregisterDigitalSupplierAdapter(chain.provider);
  });

  it('refuses to compose a public offer while publication is off', async () => {
    // The lever is read at module load and this deployment has it OFF, which is
    // the state every deployment is in until a market's sign-offs are recorded.
    const chain = await makeChain();
    await makeOffer(chain, `SKU-${uuidv7()}`);
    const result = await composeDigitalRetailOffer([], 'ES');
    expect(result).toEqual({ composed: false, refusal: 'publication_disabled' });
    unregisterDigitalSupplierAdapter(chain.provider);
  });
});

describe('pricing policies', () => {
  it('activates one version per market and class, superseding the last', async () => {
    const key = `digital-retail-${uuidv7()}`;
    const market = 'ES';
    const first = await createPricingPolicyDraft({
      policyKey: key,
      version: 1,
      name: 'Launch',
      summary: 'The launch band for digital games in Spain.',
      market,
      productClass: 'digital_game',
      currency: 'EUR',
      marginFloorBps: 1_000,
      marginCeilingBps: 2_000,
      effectiveStart: new Date(Date.now() - 60_000),
      createdByOxyUserId: 'oxy-operator',
    });
    const activated = await activatePricingPolicy(first.id, 'oxy-approver', new Date());
    expect(activated?.status).toBe('active');

    const second = await createPricingPolicyDraft({
      policyKey: key,
      version: 2,
      name: 'Wider band',
      summary: 'Raises the ceiling after the first month of trading.',
      market,
      productClass: 'digital_game',
      currency: 'EUR',
      marginFloorBps: 1_000,
      marginCeilingBps: 3_000,
      effectiveStart: new Date(),
      createdByOxyUserId: 'oxy-operator',
    });
    // The supersede has to happen FIRST, or the partial unique refuses the write.
    const promoted = await activatePricingPolicy(second.id, 'oxy-approver', new Date());
    expect(promoted?.status).toBe('active');

    const rows = await db
      .select({ id: digitalRetailPricingPolicies.id, status: digitalRetailPricingPolicies.status })
      .from(digitalRetailPricingPolicies)
      .where(eq(digitalRetailPricingPolicies.policyKey, key));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)?.status).toBe('superseded');
    expect(rows.find((row) => row.id === second.id)?.status).toBe('active');
  });

  it('refuses to activate a version that is not a draft', async () => {
    const key = `digital-retail-${uuidv7()}`;
    const draft = await createPricingPolicyDraft({
      policyKey: key,
      version: 1,
      name: 'Once',
      summary: 'A policy activated twice would have two activation records.',
      market: 'FR',
      productClass: 'software_licence',
      currency: 'EUR',
      marginFloorBps: 500,
      marginCeilingBps: 500,
      effectiveStart: new Date(),
      createdByOxyUserId: 'oxy-operator',
    });
    await activatePricingPolicy(draft.id, 'oxy-approver', new Date());
    expect(await activatePricingPolicy(draft.id, 'oxy-approver', new Date())).toBeNull();
  });
});
