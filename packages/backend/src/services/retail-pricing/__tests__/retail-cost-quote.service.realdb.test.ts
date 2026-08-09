/**
 * Composing, revalidating and locking a retail cost quote, end to end against a
 * REAL Postgres database.
 *
 * FX is the one dependency mocked, and only `getRates`: the live provider makes
 * an HTTP call, and a conversion rate that moved between two runs would make
 * every expected total a moving target. Everything else — the conversion
 * arithmetic, the snapshot capture, the completeness gate, the content hash,
 * the CHECKs and the triggers — is the real code against the real server.
 *
 * Covers #120 test cases 2 (cross-currency cost with captured FX), 6 (supplier
 * cost change before checkout), 7 (quote expiry) and 12 (retry returns the same
 * locked total).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';

/**
 * A fixed rate set: 1 USD = 0.918 EUR, quoted with USD as the BASE — which is
 * how this domain asks for it. No pivot currency appears anywhere in the mock,
 * because none appears in the caller either.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above every import and
 * cannot close over an ordinary top-level binding: without it the factory
 * throws `Cannot access 'getRatesMock' before initialization` and the whole
 * file fails to load, which reads as a broken suite rather than a broken mock.
 */
const { getRatesMock } = vi.hoisted(() => {
  const rates = {
    base: 'USD' as const,
    rates: { USD: 1, EUR: 0.918 },
    provider: 'test-fx',
    asOf: '2026-08-09T09:00:00.000Z',
    stale: false,
    ttlSeconds: 300,
  };
  return {
    getRatesMock: vi.fn(async (base: string) => {
      if (base !== 'USD') {
        throw new Error(`the retail quote asked for an unexpected base: ${base}`);
      }
      return rates;
    }),
  };
});

vi.mock('../../fx.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fx.service.js')>();
  return { ...actual, getRates: getRatesMock };
});

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { createSupplier } from '../../../db/procurement/supplierRepository.js';
import { createSupplierAccount } from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import {
  activateRetailPricingPolicy,
  insertRetailPricingPolicy,
  type RetailPricingPolicyRecord,
} from '../../../db/retailPricing/retailPricingPolicyRepository.js';
import { listRetailCostQuoteAcceptancesForGroup } from '../../../db/retailPricing/retailCostQuoteRepository.js';
import {
  composeRetailCostQuote,
  lockRetailCostQuote,
  revalidateRetailCostQuote,
  type ComposeRetailCostQuoteInput,
} from '../retail-cost-quote.service.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Unique WITHIN a run as well as across runs: `uuidv7` is time-ordered, so a
 * truncated prefix repeats for calls made in the same millisecond — which is
 * exactly how these fixtures are called.
 */
let policyKeySequence = 0;

async function makeActivePolicy(
  overrides: Partial<Parameters<typeof insertRetailPricingPolicy>[1]> = {},
): Promise<RetailPricingPolicyRecord> {
  policyKeySequence += 1;
  const draft = await insertRetailPricingPolicy(db, {
    policyKey: `retail-svc-${uuidv7().replace(/-/g, '').slice(0, 20)}-${String(policyKeySequence)}`,
    version: 1,
    name: 'Cost-only retail',
    summary: 'Zero markup, zero intended item profit.',
    effectiveStart: new Date(Date.now() - 86_400_000),
    allowedComponentKinds: [
      'supplier_item',
      'supplier_handling',
      'destination_shipping',
      'tax_duty',
    ],
    createdByOxyUserId: 'oxy-operator',
    ...overrides,
  });
  const active = await activateRetailPricingPolicy(db, {
    id: draft.id,
    approvedByOxyUserId: 'oxy-approver',
  });
  if (!active) throw new Error('fixture policy did not activate');
  return active;
}

async function makeSourcing(): Promise<{
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
}> {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Supplier ${uuidv7()}`,
    establishmentCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
    credentialReference: `/oxy/mercaria/suppliers/test/${uuidv7()}`,
    enabledMarkets: ['ES'],
    fulfilmentOrigins: ['ES'],
  });
  const draft = await createAgreementVersion({
    supplierId: supplier.id,
    version: 1,
    permittedDestinationCountries: ['ES'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
  });
  const agreement = await approveAgreement({
    agreementId: draft.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/test.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!agreement) throw new Error('fixture agreement did not approve');
  return {
    supplierId: supplier.id,
    supplierAccountId: account.id,
    agreementId: agreement.id,
  };
}

function composeInput(
  policy: RetailPricingPolicyRecord,
  sourcing: { supplierId: string; supplierAccountId: string; agreementId: string },
  overrides: Partial<ComposeRetailCostQuoteInput> = {},
): ComposeRetailCostQuoteInput {
  return {
    policy,
    ...sourcing,
    supplierSku: `SKU-${uuidv7().slice(0, 8)}`,
    quantity: 1,
    destination: { country: 'ES' },
    presentmentCurrency: 'EUR',
    sourceCosts: [
      {
        kind: 'supplier_item',
        sourceRef: 'supplier_quote',
        amount: 2_400,
        currency: 'EUR',
        perUnit: true,
        confidence: 'quoted',
        observedAt: new Date('2026-08-09T09:00:00.000Z'),
        supplierQuoteRef: 'SQ-1',
      },
      {
        kind: 'destination_shipping',
        sourceRef: 'carrier_tariff',
        amount: 495,
        currency: 'EUR',
        perUnit: false,
        confidence: 'quoted',
        observedAt: new Date('2026-08-09T09:00:00.000Z'),
      },
    ],
    applicableKinds: ['supplier_item', 'destination_shipping'],
    taxTreatmentDetermined: true,
    marketSupported: true,
    ...overrides,
  };
}

describe('composing a retail cost quote', () => {
  it('case 1: a same-currency quote is the exact sum, and nothing is converted', async () => {
    const policy = await makeActivePolicy();
    const composed = await composeRetailCostQuote(
      composeInput(policy, await makeSourcing()),
      db,
    );

    expect(composed.quote.customerTotalAmount).toBe(2_895);
    expect(composed.quote.buyerPayableAmount).toBe(2_895);
    expect(composed.quote.completeness).toBe('complete');
    expect(composed.quote.presentation).toBe('exact_cost_only');
    // No conversion happened, so no snapshot exists to be reproduced.
    for (const component of composed.components) {
      expect(component.fxRateRate).toBeNull();
      expect(component.fxBasis).toBeNull();
    }
  });

  it('case 2: a cross-currency cost stays in its SOURCE currency and captures the exact FX', async () => {
    const policy = await makeActivePolicy();
    const input = composeInput(policy, await makeSourcing());
    // The supplier bills in USD; the buyer is presented EUR.
    const composed = await composeRetailCostQuote(
      {
        ...input,
        sourceCosts: [
          { ...input.sourceCosts[0], amount: 3_000, currency: 'USD' },
          input.sourceCosts[1],
        ],
      },
      db,
    );

    const item = composed.components.find((c) => c.kind === 'supplier_item');
    expect(item).toBeDefined();
    if (!item) return;
    // The SOURCE amount is stored verbatim — nothing converted on write.
    expect(item.sourceAmount).toBe(3_000);
    expect(item.sourceCurrency).toBe('USD');
    // 30.00 USD × 0.918 = 27.54 EUR, half-even, once.
    expect(item.presentmentAmount).toBe(2_754);
    expect(item.presentmentCurrency).toBe('EUR');
    // The exact conversion is captured and attributable.
    expect(item.fxRateFrom).toBe('USD');
    expect(item.fxRateTo).toBe('EUR');
    expect(item.fxRateRate).toBeCloseTo(0.918, 10);
    expect(item.fxRateProvider).toBe('test-fx');
    expect(item.fxRateAsOf).toBe('2026-08-09T09:00:00.000Z');
    // Mercaria's quote-time rate, distinguished from a provider's final one.
    expect(item.fxBasis).toBe('quoted');

    // The total is the sum of the CONVERTED components, and only that.
    expect(composed.quote.customerTotalAmount).toBe(2_754 + 495);

    // The base asked for was the SOURCE currency, never a pivot.
    expect(getRatesMock).toHaveBeenCalled();
    for (const call of getRatesMock.mock.calls) {
      expect(call[0]).toBe('USD');
    }
  });

  it('applies quantity in the SOURCE currency, before the single conversion', async () => {
    const policy = await makeActivePolicy();
    const input = composeInput(policy, await makeSourcing());
    const composed = await composeRetailCostQuote(
      {
        ...input,
        quantity: 7,
        sourceCosts: [
          { ...input.sourceCosts[0], amount: 333, currency: 'USD', perUnit: true },
          input.sourceCosts[1],
        ],
      },
      db,
    );
    const item = composed.components.find((c) => c.kind === 'supplier_item');
    if (!item) throw new Error('missing item component');

    // 3.33 USD × 7 = 23.31 USD exactly, THEN × 0.918 = 21.398... → 2140 EUR.
    // Converting per unit first (3.33 → 3.06 EUR) and multiplying would give
    // 2142 — a real two-minor-unit drift, which is why the order matters.
    expect(item.sourceAmount).toBe(2_331);
    expect(item.presentmentAmount).toBe(2_140);
  });

  it('records a BLOCKED quote rather than refusing to record the evidence', async () => {
    const policy = await makeActivePolicy();
    const input = composeInput(policy, await makeSourcing());
    const composed = await composeRetailCostQuote(
      {
        ...input,
        applicableKinds: ['supplier_item', 'destination_shipping', 'supplier_handling'],
        undocumentedKinds: ['supplier_handling'],
      },
      db,
    );
    expect(composed.quote.completeness).toBe('blocked_undocumented_cost');
    expect(composed.quote.presentation).toBe('not_purchasable');
    expect(composed.quote.blockReasons).toContain('undocumented_supplier_fee');
    // And it cannot be locked.
    await expect(
      lockRetailCostQuote(
        {
          quoteId: composed.quote.id,
          checkoutGroupId: `grp-${uuidv7()}`,
          actor: { kind: 'oxy', oxyUserId: 'oxy-buyer' },
        },
        db,
      ),
    ).rejects.toThrow(/incomplete/);
  });

  it('refuses a component the active policy version has not approved', async () => {
    const policy = await makeActivePolicy();
    const input = composeInput(policy, await makeSourcing());
    await expect(
      composeRetailCostQuote(
        {
          ...input,
          sourceCosts: [
            ...input.sourceCosts,
            {
              kind: 'payment_processing',
              sourceRef: 'provider_pricing',
              amount: 70,
              currency: 'EUR',
              perUnit: false,
              confidence: 'estimated',
              observedAt: new Date(),
            },
          ],
        },
        db,
      ),
    ).rejects.toThrow(/does not approve the component/);
  });

  it('refuses payment-cost pass-through without a policy that permits it', async () => {
    // The component is approved by the policy, but pass-through is not enabled,
    // so the lawful basis and disclosure were never recorded.
    const policy = await makeActivePolicy({
      allowedComponentKinds: ['supplier_item', 'destination_shipping', 'payment_processing'],
    });
    const input = composeInput(policy, await makeSourcing());
    await expect(
      composeRetailCostQuote(
        {
          ...input,
          sourceCosts: [
            ...input.sourceCosts,
            {
              kind: 'payment_processing',
              sourceRef: 'provider_pricing',
              amount: 70,
              currency: 'EUR',
              perUnit: false,
              confidence: 'estimated',
              observedAt: new Date(),
            },
          ],
        },
        db,
      ),
    ).rejects.toThrow(/lawful basis and disclosure recorded/);
  });
});

describe('revalidating and locking', () => {
  it('case 7: an expired quote is not chargeable, and cannot be locked', async () => {
    const policy = await makeActivePolicy({ quoteTtlSeconds: 1 });
    const now = new Date('2026-08-09T12:00:00.000Z');
    const composed = await composeRetailCostQuote(
      { ...composeInput(policy, await makeSourcing()), now },
      db,
    );
    expect(composed.quote.expiresAt.toISOString()).toBe('2026-08-09T12:00:01.000Z');

    // Live at 12:00:00.500 …
    expect(
      (
        await revalidateRetailCostQuote(
          { quoteId: composed.quote.id, now: new Date('2026-08-09T12:00:00.500Z') },
          db,
        )
      ).outcome,
    ).toBe('chargeable');
    // … expired at 12:00:02, which is the 3DS worked example.
    const stale = await revalidateRetailCostQuote(
      { quoteId: composed.quote.id, now: new Date('2026-08-09T12:00:02.000Z') },
      db,
    );
    expect(stale.outcome).toBe('expired');

    await expect(
      lockRetailCostQuote(
        {
          quoteId: composed.quote.id,
          checkoutGroupId: `grp-${uuidv7()}`,
          actor: { kind: 'oxy', oxyUserId: 'oxy-buyer' },
          now: new Date('2026-08-09T12:00:02.000Z'),
        },
        db,
      ),
    ).rejects.toThrow(/expired/);
  });

  it('the content hash is reproducible from the stored row', async () => {
    // The freeze is only useful if a later read can verify it. Revalidation
    // recomputes the hash from the components and compares.
    const composed = await composeRetailCostQuote(
      composeInput(await makeActivePolicy(), await makeSourcing()),
      db,
    );
    const revalidated = await revalidateRetailCostQuote({ quoteId: composed.quote.id }, db);
    expect(revalidated.outcome).toBe('chargeable');
    expect(composed.quote.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('case 12: an idempotent retry returns the SAME locked total', async () => {
    const composed = await composeRetailCostQuote(
      composeInput(await makeActivePolicy(), await makeSourcing()),
      db,
    );
    const checkoutGroupId = `grp-${uuidv7()}`;
    const args = {
      quoteId: composed.quote.id,
      checkoutGroupId,
      actor: { kind: 'oxy' as const, oxyUserId: 'oxy-buyer' },
    };

    const first = await lockRetailCostQuote(args, db);
    const second = await lockRetailCostQuote(args, db);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.acceptance.id).toBe(first.acceptance.id);
    expect(second.acceptance.acceptedTotalAmount).toBe(first.acceptance.acceptedTotalAmount);
    expect(second.acceptance.acceptedTotalAmount).toBe(2_895);
    expect(await listRetailCostQuoteAcceptancesForGroup(db, checkoutGroupId)).toHaveLength(1);
  });

  it('case 6: a supplier cost change before checkout is a NEW quote and a NEW acceptance', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const input = composeInput(policy, sourcing);
    const first = await composeRetailCostQuote(input, db);
    const checkoutGroupId = `grp-${uuidv7()}`;
    const firstLock = await lockRetailCostQuote(
      {
        quoteId: first.quote.id,
        checkoutGroupId,
        actor: { kind: 'oxy', oxyUserId: 'oxy-buyer' },
      },
      db,
    );

    // The supplier raised its price before the charge. The locked amount is
    // NOT mutated — a fresh quote is composed and the buyer accepts again.
    const second = await composeRetailCostQuote(
      {
        ...input,
        sourceCosts: [{ ...input.sourceCosts[0], amount: 2_600 }, input.sourceCosts[1]],
        supersedesQuoteId: first.quote.id,
        supersedeReason: 'supplier_cost_changed',
      },
      db,
    );
    expect(second.quote.customerTotalAmount).toBe(3_095);
    expect(second.quote.supersedesQuoteId).toBe(first.quote.id);

    const secondLock = await lockRetailCostQuote(
      {
        quoteId: second.quote.id,
        checkoutGroupId,
        actor: { kind: 'oxy', oxyUserId: 'oxy-buyer' },
        supersedesAcceptanceId: firstLock.acceptance.id,
      },
      db,
    );
    expect(secondLock.acceptance.acceptedTotalAmount).toBe(3_095);
    expect(secondLock.acceptance.supersedesAcceptanceId).toBe(firstLock.acceptance.id);

    // The original lock still says what the buyer originally accepted — the
    // charged amount was never silently raised on an existing record.
    const locks = await listRetailCostQuoteAcceptancesForGroup(db, checkoutGroupId);
    expect(locks).toHaveLength(2);
    expect(locks[0].acceptedTotalAmount).toBe(2_895);
  });
});
