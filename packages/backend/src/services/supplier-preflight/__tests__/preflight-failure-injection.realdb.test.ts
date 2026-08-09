/**
 * The preflight service END TO END, driven by the fake adapter's failure
 * injection (#122 operations 8, acceptance 5, 6 and 8).
 *
 * ## Why this file exists beside the table tests
 *
 * `preflight-completeness.test.ts` proves the DERIVATION answers `unknown` on a
 * timeout. That is not the same claim. Acceptance 6 is about the PATH: a real
 * adapter that does not answer, a real lease taken and released, a real durable
 * quote written, and checkout refused from what was actually stored — with
 * nothing mocked in between.
 *
 * The four scenarios #122 operations 8 names are each exercised against a real
 * server: a provider timeout, a cost change, a stock loss and a reservation
 * expiry. Plus the two concurrency properties that only show up here: a
 * repeated key does not ask the supplier twice, and a rotated session does not
 * make the same question look new.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';

/**
 * Set the two variables BEFORE any import evaluates.
 *
 * `config/index.ts` reads `process.env` once at module load and freezes the
 * result, and ESM hoists every import above ordinary statements — so setting
 * these in `beforeAll` is too late and every case below would answer
 * `preflight_disabled`, passing for the wrong reason. `vi.hoisted` runs ahead
 * of the imports, which is the only place this can work.
 */
vi.hoisted(() => {
  process.env.SUPPLIER_PREFLIGHT_ENABLED = 'true';
  process.env.SUPPLIER_PREFLIGHT_FINGERPRINT_KEY = 'a'.repeat(64);
});
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { createSupplier, transitionSupplierStatus } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import { upsertProcurementOfferFromSource } from '../../../db/procurement/procurementOfferRepository.js';
import {
  activateSupplierSourcingPolicy,
  insertSupplierSourcingPolicy,
} from '../../../db/supplierPreflight/sourcingPolicyRepository.js';
import { findSupplierReservationByQuote } from '../../../db/supplierPreflight/reservationRepository.js';
import {
  clearFakeSupplierScenarios,
  fakeSupplierAdapter,
  injectFakeSupplierScenario,
  setFakeSupplierBaseline,
  FAKE_SUPPLIER_PROVIDER,
} from '../fake-adapter.js';
import { clearSupplierAdapters, registerSupplierAdapter } from '../registry.js';
import {
  runSupplierPreflight,
  SUPPLIER_SOURCING_POLICY_KEY,
} from '../preflight.service.js';
import { assertPreflightSatisfiesCheckout } from '../checkout-contract.js';
import { authorizeSupplierFulfilment } from '../../supplier-orders/fulfilment-authorization.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
  // Registered directly rather than through `registerFakeSupplierAdapter`,
  // which additionally demands the fake-adapter env flag. The flag exists so a
  // production deployment cannot register it by accident; a test asserting the
  // adapter's behaviour is not that case, and the LIVE-account refusal — the
  // gate that actually protects production — is asserted below.
  registerSupplierAdapter(fakeSupplierAdapter());
}, 120_000);

afterAll(async () => {
  clearSupplierAdapters();
  delete process.env.SUPPLIER_PREFLIGHT_ENABLED;
  delete process.env.SUPPLIER_PREFLIGHT_FINGERPRINT_KEY;
  await closePostgres();
});

afterEach(() => {
  clearFakeSupplierScenarios();
});

/** A supplier, an ACTIVE account on the fake platform, and one offer. */
async function makeOffer(sku: string): Promise<{ procurementOfferId: string }> {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Injection supplier ${uuidv7()}`,
    establishmentCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
  });
  await transitionSupplierStatus({
    supplierId: supplier.id,
    expected: 'under_review',
    next: 'active',
    eventKind: 'activated',
    byOxyUserId: 'oxy-operator-1',
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: FAKE_SUPPLIER_PROVIDER,
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
    credentialReference: `/oxy/mercaria/suppliers/fake/${uuidv7()}`,
    enabledMarkets: ['ES'],
    fulfilmentOrigins: ['ES'],
  });
  await transitionAccountState({ accountId: account.id, expected: 'inactive', next: 'active' });

  const { offer } = await upsertProcurementOfferFromSource({
    supplierId: supplier.id,
    supplierAccountId: account.id,
    supplierSku: sku,
    unitCostAmount: 1_000,
    unitCostCurrency: 'EUR',
    availability: 'in_stock',
    eligibleDestinationCountries: ['ES'],
    fulfilmentOriginCountries: ['ES'],
    provenance: 'api',
  });
  return { procurementOfferId: offer.id };
}

/** Publish an active sourcing policy, once per suite run. */
async function ensurePolicy(): Promise<void> {
  const draft = await insertSupplierSourcingPolicy(
    {
      policyKey: SUPPLIER_SOURCING_POLICY_KEY,
      // A per-run version inside int32: the column is an `integer`, and
      // `Date.now()` overflows it. Seconds since an arbitrary recent epoch keeps
      // it unique per suite run and inside range.
      version: Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1_000),
      name: 'Injection policy',
      summary: 'Cheapest complete landed cost.',
      effectiveStart: new Date(Date.now() - 60_000),
      effectiveEnd: null,
      rankingCriteria: ['total_landed_cost'],
      requiredCapabilities: [],
      maxSourcingAttempts: 3,
      maxSupplierShareBps: 10_000,
      quoteTtlSeconds: 900,
      providerTimeoutMs: 500,
      maxProviderConcurrency: 4,
      maxProviderCallsPerMinute: 600,
      healthWindowMinutes: 15,
      healthMinimumSamples: 20,
      healthMaxFailureBps: 5_000,
      healthSuppressionMinutes: 15,
      createdByOxyUserId: 'oxy-operator-1',
    },
    db,
  );
  await activateSupplierSourcingPolicy(
    { policyId: draft.id, approvedByOxyUserId: 'oxy-operator-1' },
    db,
  );
}

const DESTINATION = { country: 'ES', postalCode: '08001', city: 'Barcelona' };

describe('preflight end to end', () => {
  beforeAll(async () => {
    await ensurePolicy();
  }, 60_000);

  it('produces a COMPLETE quote from a healthy supplier', async () => {
    // The positive control. Without it, every refusal below could be produced
    // by a path that never completes at all.
    const sku = `SKU-HEALTHY-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    const result = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      db,
    });
    expect(result.completeness.status).toBe('complete');
    expect(result.quote.availability).toBe('orderable');
    expect(result.quote.shippingCostAmount).toBe(499);
    expect(result.completeness.mayCheckout).toBe(true);
  });

  it('answers UNKNOWN on a provider timeout, and still stores a durable quote', async () => {
    // #122 concurrency 7 and acceptance 6, on the real path.
    const sku = `SKU-TIMEOUT-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    injectFakeSupplierScenario(sku, 'timeout');
    const result = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      db,
    });
    expect(result.quote.availability).toBe('unknown');
    expect(result.completeness.mayCheckout).toBe(false);
    expect(result.quote.blockReasons).toContain('provider_error');
    // Durable: the answer is a row an operator can find, not an exception.
    expect(result.quote.id).toBeTruthy();
    expect(result.reservation).toBeNull();
  });

  it('refuses on a STOCK LOSS rather than quoting an unavailable item', async () => {
    const sku = `SKU-STOCKLOSS-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    injectFakeSupplierScenario(sku, 'stock_loss');
    const result = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      db,
    });
    expect(result.quote.availability).toBe('unavailable');
    expect(result.completeness.mayCheckout).toBe(false);
    expect(result.quote.blockReasons).toContain('not_orderable');
  });

  it('carries a COST CHANGE into the quote rather than the catalogue price', async () => {
    // #122 acceptance 1: a catalogue feed observation is not checkout authority.
    // The offer says 1_000; the supplier now says 1_250, and the quote is what
    // the money path reads.
    const sku = `SKU-COST-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    injectFakeSupplierScenario(sku, 'cost_change');
    const result = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      db,
    });
    expect(result.completeness.status).toBe('complete');
    expect(result.quote.unitCostAmount).toBe(1_250);
  });

  it('stores a real hold, and a lapsed one refuses checkout', async () => {
    // The reservation-expiry scenario: the supplier's own deadline is one
    // second out, so by the time checkout revalidates it has gone.
    const sku = `SKU-HOLD-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    injectFakeSupplierScenario(sku, 'reservation_expiry');
    const result = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      requestReservation: true,
      db,
    });
    expect(result.reservation).not.toBeNull();
    const stored = await findSupplierReservationByQuote(result.quote.id, db);
    expect(stored).toBeDefined();

    const decision = assertPreflightSatisfiesCheckout(
      {
        quoteId: result.quote.id,
        status: result.quote.status,
        environment: result.quote.environment,
        procurementOfferId: result.quote.procurementOfferId,
        quantity: result.quote.quantity,
        requestedCurrency: result.quote.requestedCurrency,
        destinationCountry: result.quote.destinationCountry,
        destinationRegion: result.quote.destinationRegion,
        expiresAt: result.quote.expiresAt,
        consumedAt: result.quote.consumedAt,
        releasedAt: result.quote.releasedAt,
        supersededByQuoteId: result.quote.supersededByQuoteId,
        sourcingPolicyKey: result.quote.sourcingPolicyKey,
        sourcingPolicyVersion: result.quote.sourcingPolicyVersion,
        pricingPolicyKey: null,
        pricingPolicyVersion: null,
        eligibilityPolicyKey: null,
        eligibilityPolicyVersion: null,
        reservationExpiresAt: stored?.providerExpiresAt ?? null,
      },
      {
        environment: result.quote.environment,
        procurementOfferId: result.quote.procurementOfferId ?? '',
        quantity: result.quote.quantity,
        currency: result.quote.requestedCurrency,
        destinationCountry: result.quote.destinationCountry,
        destinationRegion: result.quote.destinationRegion,
        sourcingPolicyKey: result.quote.sourcingPolicyKey,
        sourcingPolicyVersion: result.quote.sourcingPolicyVersion,
        pricingPolicyKey: null,
        pricingPolicyVersion: null,
        eligibilityPolicyKey: null,
        eligibilityPolicyVersion: null,
        // Two seconds on, which is past the one-second hold the scenario mints.
        now: new Date(Date.now() + 2_000),
      },
    );
    expect('refusals' in decision ? decision.refusals : []).toContain('reservation_expired');
  });

  it('does NOT ask the supplier twice for a repeated idempotency key', async () => {
    // #122 concurrency 1, first branch. The second call reuses the stored,
    // still-usable answer — the cost change injected in between proves it never
    // reached the adapter.
    const sku = `SKU-IDEM-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    const key = `idem-${uuidv7()}`;
    const first = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      idempotencyKey: key,
      db,
    });
    setFakeSupplierBaseline({ unitCostMinor: 9_999 });
    const second = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      idempotencyKey: key,
      db,
    });
    expect(second.reused).toBe(true);
    expect(second.quote.id).toBe(first.quote.id);
    expect(second.quote.unitCostAmount).toBe(first.quote.unitCostAmount);
  });

  it('converges on ONE quote when the same question arrives with no key at all', async () => {
    // The fingerprint is the default key, and it carries no session, actor or
    // checkout group — so the same question from a guest and from that guest
    // after signing in is ONE question (#122 concurrency 5).
    const sku = `SKU-ROTATE-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    const asGuest = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      checkoutGroupId: 'group-before-sign-in',
      db,
    });
    const afterSignIn = await runSupplierPreflight({
      procurementOfferId,
      quantity: 1,
      destination: DESTINATION,
      currency: 'EUR',
      checkoutGroupId: 'group-after-sign-in',
      db,
    });
    expect(afterSignIn.reused).toBe(true);
    expect(afterSignIn.quote.id).toBe(asGuest.quote.id);
  });

  it('blocks with `provider_unconfigured` when no adapter serves the platform', async () => {
    const sku = `SKU-NOADAPTER-${uuidv7()}`;
    const { procurementOfferId } = await makeOffer(sku);
    clearSupplierAdapters();
    try {
      const result = await runSupplierPreflight({
        procurementOfferId,
        quantity: 1,
        destination: DESTINATION,
        currency: 'EUR',
        db,
      });
      expect(result.quote.availability).toBe('unknown');
      expect(result.quote.blockReasons).toContain('provider_unconfigured');
    } finally {
      registerSupplierAdapter(fakeSupplierAdapter());
    }
  });
});

describe('the fake adapter cannot reach a live account', () => {
  it('refuses a `live` environment whatever the flag says', async () => {
    // The gate a copied staging flag cannot defeat: a fabricated answer against
    // a live account is a customer charged for stock nobody checked.
    await expect(
      fakeSupplierAdapter().quote({
        providerAccountId: 'acct-live',
        environment: 'live',
        supplierSku: 'SKU-A',
        supplierExternalId: null,
        quantity: 1,
        destination: DESTINATION,
        currency: 'EUR',
        requestedShippingServiceCode: null,
        requestReservation: false,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/refuses a `live` supplier account/);
  });
});

describe('a quote can never authorize fulfilment', () => {
  it('refuses an order with no purchase order under it', async () => {
    // #122's own sentence, now answered by the module that CAN read a purchase
    // order (#124). The property under test is unchanged: a quote id buys
    // nothing, and the only thing that authorizes is a submitted purchase
    // order — so an order with none is refused by name rather than by absence.
    await expect(
      authorizeSupplierFulfilment({
        quoteId: 'quote-1',
        orderId: 'order-with-no-purchase-order',
        supplierAccountId: 'acct-1',
      }),
    ).resolves.toEqual({ authorized: false, reason: 'purchase_order_not_found' });
  });
});
