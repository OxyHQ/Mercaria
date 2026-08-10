/**
 * The retail pricing schema's load-bearing constraints, against a REAL Postgres
 * database — the properties a mocked repository is structurally blind to.
 *
 * A mocked `insert`/`update` accepts any statement, including one the server
 * rejects outright, so the guarantees below only exist here:
 *
 *  - the immutability TRIGGERS: a published policy version is frozen; a quote
 *    and its components refuse UPDATE and DELETE from birth; an acceptance
 *    permits exactly ONE narrow update — `order_id`, NULL → a value, once;
 *  - the CHECKs that make zero markup and the promotion rule structural:
 *    `buyer_payable = customer_total − subsidy`, a non-negative component, a
 *    subsidy bounded by the cost it reduces, and the
 *    completeness ⇔ presentation mapping;
 *  - the FX CHECKs: a conversion exists exactly when the currencies differ, and
 *    it names the pair it converted;
 *  - `UNIQUE(checkout_group_id, quote_id)` — the checkout lock's idempotency,
 *    under CONCURRENT duplicate acceptance rather than sequential calls.
 *
 * No cleanup and no TRUNCATE — vitest runs files in parallel against ONE
 * throwaway database, so every id here is unique per run instead.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import {
  retailCostQuoteAcceptances,
  retailCostQuoteComponents,
  retailCostQuotes,
  retailPricingPolicies,
} from '../../schema/retailPricing.js';
import { createSupplier } from '../../procurement/supplierRepository.js';
import { createSupplierAccount } from '../../procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
  type SupplierAgreementRecord,
} from '../../procurement/agreementRepository.js';
import {
  acceptRetailCostQuote,
  findRetailCostQuoteById,
  findRetailCostQuoteForPresentation,
  insertRetailCostQuote,
  linkRetailAcceptanceToOrder,
  listRetailCostQuoteAcceptancesForGroup,
  type NewRetailCostQuote,
} from '../retailCostQuoteRepository.js';
import {
  activateRetailPricingPolicy,
  findActiveRetailPricingPolicy,
  insertRetailPricingPolicy,
  type RetailPricingPolicyRecord,
} from '../retailPricingPolicyRepository.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint — "it threw" alone
 * would also pass when the WRONG constraint fired.
 */
async function expectRefused(
  write: () => Promise<unknown>,
  kind: 'check' | 'unique',
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

/**
 * A policy-key generator that is unique WITHIN a run as well as across runs.
 * `uuidv7` is time-ordered, so a truncated prefix repeats for calls made in the
 * same millisecond — which is exactly how these fixtures are called, and it
 * showed up as a spurious unique violation rather than as a test failure.
 */
let policyKeySequence = 0;
function nextPolicyKey(prefix: string): string {
  policyKeySequence += 1;
  return `${prefix}-${uuidv7().replace(/-/g, '').slice(0, 20)}-${String(policyKeySequence)}`;
}

/** A draft policy fixture, unique per call. */
async function makePolicy(
  overrides: Partial<Parameters<typeof insertRetailPricingPolicy>[1]> = {},
): Promise<RetailPricingPolicyRecord> {
  return await insertRetailPricingPolicy(db, {
    policyKey: nextPolicyKey('retail-cost-only'),
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
}

/** An ACTIVE policy fixture. */
async function makeActivePolicy(): Promise<RetailPricingPolicyRecord> {
  const draft = await makePolicy();
  const active = await activateRetailPricingPolicy(db, {
    id: draft.id,
    approvedByOxyUserId: 'oxy-approver',
  });
  if (!active) throw new Error('fixture policy did not activate');
  return active;
}

/** The supplier-side identities a quote references by foreign key. */
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
  const agreement = await makeApprovedAgreement(supplier.id);
  return {
    supplierId: supplier.id,
    supplierAccountId: account.id,
    agreementId: agreement.id,
  };
}

async function makeApprovedAgreement(supplierId: string): Promise<SupplierAgreementRecord> {
  const draft = await createAgreementVersion({
    supplierId,
    version: 1,
    permittedDestinationCountries: ['ES', 'FR'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
  });
  const approved = await approveAgreement({
    agreementId: draft.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/test.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!approved) throw new Error('fixture agreement did not approve');
  return approved;
}

/** A 64-hex content hash, unique per call. */
function contentHash(): string {
  return (uuidv7().replace(/-/g, '') + uuidv7().replace(/-/g, '')).slice(0, 64);
}

/** A complete, chargeable quote input over a 24.00 + 4.95 EUR component pair. */
function quoteInput(
  policy: RetailPricingPolicyRecord,
  sourcing: { supplierId: string; supplierAccountId: string; agreementId: string },
  overrides: Partial<NewRetailCostQuote> = {},
): NewRetailCostQuote {
  const now = new Date();
  return {
    policyId: policy.id,
    policyKey: policy.policyKey,
    policyVersion: policy.version,
    ...sourcing,
    supplierSku: `SKU-${uuidv7().slice(0, 8)}`,
    quantity: 1,
    destinationCountry: 'ES',
    presentmentCurrency: 'EUR',
    customerTotalAmount: 2_895,
    buyerPayableAmount: 2_895,
    completeness: 'complete',
    presentation: 'exact_cost_only',
    blockReasons: [],
    quotedAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
    contentHash: contentHash(),
    components: [
      {
        kind: 'supplier_item',
        sourceRef: 'supplier_quote',
        sourceAmount: 2_400,
        sourceCurrency: 'EUR',
        presentmentAmount: 2_400,
        presentmentCurrency: 'EUR',
        confidence: 'quoted',
        observedAt: now,
      },
      {
        kind: 'destination_shipping',
        sourceRef: 'carrier_tariff',
        sourceAmount: 495,
        sourceCurrency: 'EUR',
        presentmentAmount: 495,
        presentmentCurrency: 'EUR',
        confidence: 'quoted',
        observedAt: now,
      },
    ],
    ...overrides,
  };
}

describe('retail pricing policy versions', () => {
  it('publishes a new version rather than editing an active one — the trigger says so', async () => {
    const active = await makeActivePolicy();
    expect(active.status).toBe('active');
    expect(active.activatedAt).not.toBeNull();

    // The economic terms of a published version are frozen by trigger, not by
    // review: this UPDATE is exactly the "quietly widen the policy" move.
    await expectRefused(
      () =>
        db
          .update(retailPricingPolicies)
          .set({ allowedComponentKinds: ['supplier_item', 'payment_processing'] })
          .where(eq(retailPricingPolicies.id, active.id)),
      'check',
    );
    await expectRefused(
      () =>
        db
          .update(retailPricingPolicies)
          .set({ roundingToleranceMinor: 5 })
          .where(eq(retailPricingPolicies.id, active.id)),
      'check',
    );
    // And a published version is never deleted.
    await expectRefused(
      () => db.delete(retailPricingPolicies).where(eq(retailPricingPolicies.id, active.id)),
      'check',
    );
  });

  it('holds ONE active version per key, superseding the previous one atomically', async () => {
    const first = await makeActivePolicy();
    const second = await insertRetailPricingPolicy(db, {
      policyKey: first.policyKey,
      version: 2,
      name: 'Cost-only retail v2',
      summary: 'Adds the FX cost component.',
      effectiveStart: new Date(Date.now() - 3_600_000),
      allowedComponentKinds: ['supplier_item', 'destination_shipping', 'tax_duty', 'fx_cost'],
      createdByOxyUserId: 'oxy-operator',
    });
    const activated = await activateRetailPricingPolicy(db, {
      id: second.id,
      approvedByOxyUserId: 'oxy-approver',
    });
    expect(activated?.status).toBe('active');

    const inForce = await findActiveRetailPricingPolicy(db, { policyKey: first.policyKey });
    expect(inForce?.version).toBe(2);

    const [previous] = await db
      .select()
      .from(retailPricingPolicies)
      .where(eq(retailPricingPolicies.id, first.id));
    expect(previous.status).toBe('superseded');
  });

  it('refuses a rounding tolerance wide enough to hide material variance', async () => {
    await expectRefused(
      () => makePolicy({ roundingToleranceMinor: 6 }),
      'check',
    );
    // The vacuity floor: the ceiling itself is accepted, so the refusal above is
    // the bound and not a broken fixture.
    const atCeiling = await makePolicy({ roundingToleranceMinor: 5 });
    expect(atCeiling.roundingToleranceMinor).toBe(5);
  });

  it('refuses a policy that cannot include the item cost, and one that half-configures pass-through', async () => {
    await expectRefused(
      () => makePolicy({ allowedComponentKinds: ['destination_shipping', 'tax_duty'] }),
      'check',
    );
    await expectRefused(
      () =>
        makePolicy({
          allowedComponentKinds: ['supplier_item', 'payment_processing'],
          paymentCostPassthroughEnabled: true,
        }),
      'check',
    );
  });
});

describe('a retail cost quote is immutable from birth', () => {
  it('writes the quote and its components together, then refuses every change', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const { quote, components } = await insertRetailCostQuote(
      db,
      quoteInput(policy, sourcing),
    );
    expect(components).toHaveLength(2);
    expect(quote.customerTotalAmount).toBe(2_895);

    await expectRefused(
      () =>
        db
          .update(retailCostQuotes)
          .set({ customerTotalAmount: 9_999 })
          .where(eq(retailCostQuotes.id, quote.id)),
      'check',
    );
    await expectRefused(
      () => db.delete(retailCostQuotes).where(eq(retailCostQuotes.id, quote.id)),
      'check',
    );
    await expectRefused(
      () =>
        db
          .update(retailCostQuoteComponents)
          .set({ presentmentAmount: 9_999 })
          .where(eq(retailCostQuoteComponents.quoteId, quote.id)),
      'check',
    );
    await expectRefused(
      () => db.delete(retailCostQuoteComponents).where(eq(retailCostQuoteComponents.quoteId, quote.id)),
      'check',
    );
  });

  it('refuses a customer total that is not the exact sum of its components', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    // The markup that must not exist, expressed as an inflated parent total.
    await expect(
      insertRetailCostQuote(
        db,
        quoteInput(policy, sourcing, {
          customerTotalAmount: 3_195,
          buyerPayableAmount: 3_195,
        }),
      ),
    ).rejects.toThrow(/exactly the markup that must not exist/);
  });

  it('refuses a buyer payable that is not cost minus the subsidy', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    // The subsidy CHECK is the structural half of "a promotion is a Mercaria
    // expense": the buyer can only pay less by exactly what Mercaria funded.
    await expectRefused(
      () =>
        db.insert(retailCostQuotes).values({
          policyId: policy.id,
          policyKey: policy.policyKey,
          policyVersion: policy.version,
          ...sourcing,
          supplierSku: 'SKU-X',
          quantity: 1,
          destinationCountry: 'ES',
          presentmentCurrency: 'EUR',
          customerTotalAmount: 2_895,
          customerTotalCurrency: 'EUR',
          buyerPayableAmount: 2_500,
          buyerPayableCurrency: 'EUR',
          completeness: 'complete',
          presentation: 'exact_cost_only',
          blockReasons: [],
          quotedAt: new Date(),
          expiresAt: new Date(Date.now() + 900_000),
          contentHash: contentHash(),
        }),
      'check',
    );
  });

  it('refuses a subsidy larger than the cost it reduces, and a negative one', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const base = {
      policyId: policy.id,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      ...sourcing,
      supplierSku: 'SKU-Y',
      quantity: 1,
      destinationCountry: 'ES',
      presentmentCurrency: 'EUR' as const,
      customerTotalAmount: 1_000,
      customerTotalCurrency: 'EUR' as const,
      subsidyCurrency: 'EUR' as const,
      subsidySource: 'mercaria_marketing_budget' as const,
      subsidyBudgetRef: 'q3-2026',
      completeness: 'complete' as const,
      presentation: 'exact_cost_only' as const,
      blockReasons: [],
      quotedAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
    };
    await expectRefused(
      () =>
        db
          .insert(retailCostQuotes)
          .values({ ...base, subsidyAmount: 1_500, buyerPayableAmount: -500, buyerPayableCurrency: 'EUR', contentHash: contentHash() }),
      'check',
    );
    // A NEGATIVE subsidy would be a promotion that raises the price to fund
    // itself later — refused outright.
    await expectRefused(
      () =>
        db
          .insert(retailCostQuotes)
          .values({ ...base, subsidyAmount: -200, buyerPayableAmount: 1_200, buyerPayableCurrency: 'EUR', contentHash: contentHash() }),
      'check',
    );
  });

  it('refuses a blocked quote that claims an exact cost-only price', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    await expectRefused(
      () =>
        insertRetailCostQuote(
          db,
          quoteInput(policy, sourcing, {
            completeness: 'blocked_undocumented_cost',
            presentation: 'exact_cost_only',
            blockReasons: ['undocumented_supplier_fee'],
          }),
        ),
      'check',
    );
    // And a "complete" quote that carries a block reason, the other direction.
    await expectRefused(
      () =>
        insertRetailCostQuote(
          db,
          quoteInput(policy, sourcing, { blockReasons: ['destination_unknown'] }),
        ),
      'check',
    );
    // And a complete quote with no destination — an exact price for nowhere.
    await expectRefused(
      () =>
        insertRetailCostQuote(
          db,
          quoteInput(policy, sourcing, { destinationCountry: undefined }),
        ),
      'check',
    );
  });

  it('refuses a component amount below zero — "negative supplier cost" is unrepresentable', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const input = quoteInput(policy, sourcing, {
      customerTotalAmount: 2_400 - 495,
      buyerPayableAmount: 2_400 - 495,
    });
    input.components[1].sourceAmount = -495;
    input.components[1].presentmentAmount = -495;
    await expectRefused(() => insertRetailCostQuote(db, input), 'check');
  });

  it('refuses a converted amount with no rate, and an unconverted one that claims a rate', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();

    // Cross-currency with NO captured snapshot: the conversion would be
    // unreproducible, which is the whole reason the column pair exists.
    const missing = quoteInput(policy, sourcing);
    missing.components[0].sourceCurrency = 'USD';
    await expectRefused(() => insertRetailCostQuote(db, missing), 'check');

    // Same-currency carrying a spurious snapshot, the other direction.
    const spurious = quoteInput(policy, sourcing);
    spurious.components[0].fxSnapshot = {
      from: 'EUR',
      to: 'EUR',
      rate: 1,
      provider: 'static',
      asOf: new Date().toISOString(),
    };
    spurious.components[0].fxBasis = 'quoted';
    await expectRefused(() => insertRetailCostQuote(db, spurious), 'check');
  });
});

describe('the checkout lock', () => {
  it('case 12: a retry converges on ONE lock with the SAME total, even concurrently', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const { quote } = await insertRetailCostQuote(db, quoteInput(policy, sourcing));
    const checkoutGroupId = `grp-${uuidv7()}`;
    const acceptance = {
      quoteId: quote.id,
      checkoutGroupId,
      acceptedTotalAmount: quote.buyerPayableAmount,
      acceptedTotalCurrency: quote.buyerPayableCurrency,
      quoteContentHash: quote.contentHash,
      acceptedAt: new Date(),
      acceptedByOxyUserId: 'oxy-buyer',
    };

    // Two concurrent duplicate submissions — the shape a double-clicked
    // checkout actually takes. Sequential calls would not exercise the index.
    const [first, second] = await Promise.all([
      acceptRetailCostQuote(db, acceptance),
      acceptRetailCostQuote(db, acceptance),
    ]);
    expect(first.acceptance.id).toBe(second.acceptance.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.acceptance.acceptedTotalAmount).toBe(2_895);

    const all = await listRetailCostQuoteAcceptancesForGroup(db, checkoutGroupId);
    expect(all).toHaveLength(1);
  });

  it('refuses an acceptance that names no actor, and one that names two', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const { quote } = await insertRetailCostQuote(db, quoteInput(policy, sourcing));
    const base = {
      quoteId: quote.id,
      acceptedTotalAmount: quote.buyerPayableAmount,
      acceptedTotalCurrency: quote.buyerPayableCurrency,
      quoteContentHash: quote.contentHash,
      acceptedAt: new Date(),
    };
    await expectRefused(
      () =>
        db
          .insert(retailCostQuoteAcceptances)
          .values({ ...base, checkoutGroupId: `grp-${uuidv7()}` }),
      'check',
    );
    await expectRefused(
      () =>
        db.insert(retailCostQuoteAcceptances).values({
          ...base,
          checkoutGroupId: `grp-${uuidv7()}`,
          acceptedByOxyUserId: 'oxy-buyer',
          acceptedGuestSessionId: 'guest-1',
        }),
      'check',
    );
  });

  it('freezes onto the order ONCE, and refuses every other change to the lock', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const { quote } = await insertRetailCostQuote(db, quoteInput(policy, sourcing));
    const { acceptance } = await acceptRetailCostQuote(db, {
      quoteId: quote.id,
      checkoutGroupId: `grp-${uuidv7()}`,
      acceptedTotalAmount: quote.buyerPayableAmount,
      acceptedTotalCurrency: quote.buyerPayableCurrency,
      quoteContentHash: quote.contentHash,
      acceptedAt: new Date(),
      acceptedGuestSessionId: `guest-${uuidv7()}`,
    });
    expect(acceptance.orderId).toBeNull();

    const orderId = `order-${uuidv7()}`;
    const linked = await linkRetailAcceptanceToOrder(db, {
      acceptanceId: acceptance.id,
      orderId,
    });
    expect(linked?.orderId).toBe(orderId);

    // A SECOND attach is refused by the CAS (no row matches `order_id IS NULL`),
    // so a lock can never be re-pointed at a different order.
    expect(
      await linkRetailAcceptanceToOrder(db, {
        acceptanceId: acceptance.id,
        orderId: `order-${uuidv7()}`,
      }),
    ).toBeUndefined();

    // And the trigger refuses a direct re-point, which the CAS alone would not
    // catch if somebody wrote the UPDATE by hand.
    await expectRefused(
      () =>
        db
          .update(retailCostQuoteAcceptances)
          .set({ orderId: `order-${uuidv7()}` })
          .where(eq(retailCostQuoteAcceptances.id, acceptance.id)),
      'check',
    );
    // An accepted amount NEVER rises.
    await expectRefused(
      () =>
        db
          .update(retailCostQuoteAcceptances)
          .set({ acceptedTotalAmount: 9_999 })
          .where(eq(retailCostQuoteAcceptances.id, acceptance.id)),
      'check',
    );
    await expectRefused(
      () =>
        db
          .delete(retailCostQuoteAcceptances)
          .where(eq(retailCostQuoteAcceptances.id, acceptance.id)),
      'check',
    );
  });

  it('a DIFFERENT quote in the same group is a second lock, naming the one it supersedes', async () => {
    // The only representable way a charged amount changes: a NEW quote plus an
    // explicit new acceptance. Nothing mutated.
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const first = await insertRetailCostQuote(db, quoteInput(policy, sourcing));
    const checkoutGroupId = `grp-${uuidv7()}`;
    const firstLock = await acceptRetailCostQuote(db, {
      quoteId: first.quote.id,
      checkoutGroupId,
      acceptedTotalAmount: first.quote.buyerPayableAmount,
      acceptedTotalCurrency: first.quote.buyerPayableCurrency,
      quoteContentHash: first.quote.contentHash,
      acceptedAt: new Date(),
      acceptedByOxyUserId: 'oxy-buyer',
    });

    // Case 6: the supplier's cost moved before checkout completed.
    const revised = quoteInput(policy, sourcing, {
      customerTotalAmount: 3_095,
      buyerPayableAmount: 3_095,
      supersedesQuoteId: first.quote.id,
      supersedeReason: 'supplier_cost_changed',
    });
    revised.components[0].sourceAmount = 2_600;
    revised.components[0].presentmentAmount = 2_600;
    const second = await insertRetailCostQuote(db, revised);

    const secondLock = await acceptRetailCostQuote(db, {
      quoteId: second.quote.id,
      checkoutGroupId,
      acceptedTotalAmount: second.quote.buyerPayableAmount,
      acceptedTotalCurrency: second.quote.buyerPayableCurrency,
      quoteContentHash: second.quote.contentHash,
      acceptedAt: new Date(),
      acceptedByOxyUserId: 'oxy-buyer',
      supersedesAcceptanceId: firstLock.acceptance.id,
    });
    expect(secondLock.created).toBe(true);
    expect(secondLock.acceptance.supersedesAcceptanceId).toBe(firstLock.acceptance.id);

    // The FIRST quote and its lock are untouched — history, not a draft.
    const reread = await findRetailCostQuoteById(db, first.quote.id);
    expect(reread?.quote.customerTotalAmount).toBe(2_895);
    expect(second.quote.supersedesQuoteId).toBe(first.quote.id);
    expect(second.quote.supersedeReason).toBe('supplier_cost_changed');
  });

  it('the quote row never moves — its xmin is the same after every read', async () => {
    // The structural claim behind "immutable from birth", checked the way the
    // moderation-outbox no-op is: the tuple version itself, so a trigger-safe
    // rewrite that left every column alone would still be caught.
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const { quote } = await insertRetailCostQuote(db, quoteInput(policy, sourcing));
    const [before] = await db
      .select({ xmin: sql<string>`${retailCostQuotes}.xmin::text` })
      .from(retailCostQuotes)
      .where(eq(retailCostQuotes.id, quote.id));

    await expectRefused(
      () =>
        db
          .update(retailCostQuotes)
          .set({ blockReasons: [] })
          .where(eq(retailCostQuotes.id, quote.id)),
      'check',
    );

    const [after] = await db
      .select({ xmin: sql<string>`${retailCostQuotes}.xmin::text` })
      .from(retailCostQuotes)
      .where(eq(retailCostQuotes.id, quote.id));
    expect(after.xmin).toBe(before.xmin);
  });
});

/**
 * #129's presentation read, which is deliberately WIDER than the chargeable one.
 *
 * `findChargeableRetailCostQuote` answers "may money move against this" and so
 * filters `completeness = 'complete'`; this answers "what may a page SAY", and
 * a quote that concluded `not_purchasable` is exactly the answer #120's
 * `presentation` and `blockReasons` exist to give. Every case here turns on a
 * NULL or an ordering that a mocked repository cannot express: `is null`
 * against `= 'ES'`, an expiry compared to a real clock, and `created_at`
 * ordering across rows inserted in one transaction.
 */
describe("the quote a page may quote from", () => {
  it('prefers a quote composed FOR the market over a destination-less one', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const variantId = `var-${uuidv7()}`;

    // The destination-less quote first, so the market-scoped one is NOT simply
    // the newest row: without the destination preference this case would pass
    // on `created_at` alone and prove nothing.
    const anywhere = await insertRetailCostQuote(
      db,
      quoteInput(policy, sourcing, {
        canonicalVariantId: variantId,
        destinationCountry: null,
        completeness: 'awaiting_destination',
        presentation: 'starting_item_cost',
        blockReasons: ['destination_unknown'],
      }),
    );
    const forSpain = await insertRetailCostQuote(
      db,
      quoteInput(policy, sourcing, { canonicalVariantId: variantId, destinationCountry: 'ES' }),
    );

    const withMarket = await findRetailCostQuoteForPresentation({
      canonicalVariantId: variantId,
      destinationCountry: 'es',
    });
    expect(withMarket?.id).toBe(forSpain.quote.id);

    // With NO destination, the market-scoped quote must not be reachable: it
    // prices shipping and tax into Spain, and showing it to somebody who has
    // told Mercaria nothing would be a total composed for another country.
    const withoutMarket = await findRetailCostQuoteForPresentation({
      canonicalVariantId: variantId,
    });
    expect(withoutMarket?.id).toBe(anywhere.quote.id);
    expect(withoutMarket?.presentation).toBe('starting_item_cost');
  });

  it('returns a BLOCKED quote, which the chargeable read filters away', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const variantId = `var-${uuidv7()}`;
    const blocked = await insertRetailCostQuote(
      db,
      quoteInput(policy, sourcing, {
        canonicalVariantId: variantId,
        completeness: 'blocked_tax_undetermined',
        presentation: 'not_purchasable',
        blockReasons: ['tax_undetermined'],
      }),
    );

    const found = await findRetailCostQuoteForPresentation({
      canonicalVariantId: variantId,
      destinationCountry: 'ES',
    });
    expect(found?.id).toBe(blocked.quote.id);
    // The whole point: the page learns WHY, rather than being unable to tell a
    // blocked offer from one nobody has priced.
    expect(found?.blockReasons).toEqual(['tax_undetermined']);
  });

  it('never returns an EXPIRED quote, in either direction', async () => {
    const policy = await makeActivePolicy();
    const sourcing = await makeSourcing();
    const variantId = `var-${uuidv7()}`;
    const quotedAt = new Date(Date.now() - 7_200_000);
    await insertRetailCostQuote(
      db,
      quoteInput(policy, sourcing, {
        canonicalVariantId: variantId,
        quotedAt,
        expiresAt: new Date(quotedAt.getTime() + 900_000),
      }),
    );

    expect(
      await findRetailCostQuoteForPresentation({
        canonicalVariantId: variantId,
        destinationCountry: 'ES',
      }),
    ).toBeUndefined();
    expect(
      await findRetailCostQuoteForPresentation({ canonicalVariantId: variantId }),
    ).toBeUndefined();
  });
});
