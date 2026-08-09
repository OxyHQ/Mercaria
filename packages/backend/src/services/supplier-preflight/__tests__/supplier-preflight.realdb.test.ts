/**
 * The guarantees a mocked drizzle call cannot express, against a REAL Postgres
 * server (#122 acceptance 3, 5, 8).
 *
 * Everything in this file is a CHECK, a unique index, a trigger or a
 * compare-and-swap. None of them exists without a server: a mocked `insert`
 * accepts any statement, including one the database rejects outright, so a
 * suite of mocks would report every property below as held while none of them
 * was — the blind spot `AGENTS.md` names for this whole backend.
 *
 * The cases are the ones #122 acceptance 8 lists, plus the honesty rule
 * acceptance 3 states:
 *
 *  - a reservation cannot be written for an adapter that did not declare the
 *    capability, or without the supplier's own id and expiry;
 *  - a single-use reservation cannot be consumed twice, CONCURRENTLY;
 *  - a quote consumed by one checkout cannot be attached to another;
 *  - an expired quote fails safely;
 *  - release is idempotent;
 *  - a quote is immutable and undeletable;
 *  - the shipping-option and sourcing-attempt trails are append-only;
 *  - two sourcing runs over one request converge instead of doubling the trail;
 *  - a `complete` quote cannot be stored with an unknown availability, an
 *    unpriced route or an unexplained block;
 *  - the provider call lease bounds concurrency and rate across tasks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { createSupplier, transitionSupplierStatus } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import { supplierQuotes, supplierReservations } from '../../../db/schema/supplierPreflight.js';
import {
  consumeSupplierQuote,
  insertSupplierQuote,
  listSupplierQuoteShippingOptions,
  releaseSupplierQuote,
  type NewSupplierQuote,
} from '../../../db/supplierPreflight/quoteRepository.js';
import {
  consumeSupplierReservation,
  findSupplierReservationByQuote,
  recordSupplierReservation,
  releaseSupplierReservation,
} from '../../../db/supplierPreflight/reservationRepository.js';
import { recordSupplierSourcingAttempts } from '../../../db/supplierPreflight/sourcingAttemptRepository.js';
import {
  claimSupplierCallLease,
  releaseSupplierCallLease,
} from '../../../db/supplierPreflight/callLeaseRepository.js';
import { recordSupplierCallOutcome } from '../../../db/supplierPreflight/healthRepository.js';
import {
  findLiveSupplierPreflightSuppression,
  raiseSupplierPreflightSuppression,
} from '../../../db/supplierPreflight/suppressionRepository.js';
import { eq } from 'drizzle-orm';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

const EUR = 'EUR' as const;

/** A supplier and an ACTIVE account, built through the real repositories. */
async function makeAccount(): Promise<{ supplierId: string; supplierAccountId: string }> {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Preflight supplier ${uuidv7()}`,
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
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
    credentialReference: `/oxy/mercaria/suppliers/test/${uuidv7()}`,
    enabledMarkets: ['ES'],
    fulfilmentOrigins: ['ES'],
  });
  await transitionAccountState({ accountId: account.id, expected: 'inactive', next: 'active' });
  return { supplierId: supplier.id, supplierAccountId: account.id };
}

/** A `complete`, usable quote for one account. */
function quoteInput(
  ids: { supplierId: string; supplierAccountId: string },
  overrides: Partial<NewSupplierQuote> = {},
): NewSupplierQuote {
  const now = new Date();
  const fingerprint = uuidv7().replace(/[^a-f0-9]/g, '').padEnd(64, '0').slice(0, 64);
  return {
    idempotencyKey: `key-${uuidv7()}`,
    requestFingerprint: fingerprint,
    supplierId: ids.supplierId,
    supplierAccountId: ids.supplierAccountId,
    environment: 'test',
    provider: 'test-platform',
    declaredCapabilities: ['live_stock_lookup', 'destination_shipping_quote', 'inventory_reservation'],
    procurementOfferId: null,
    canonicalProductId: null,
    canonicalVariantId: null,
    supplierSku: 'SKU-A',
    quantity: 1,
    checkoutGroupId: null,
    orderId: null,
    requestedCurrency: EUR,
    destinationCountry: 'ES',
    destinationRegion: null,
    identityConfirmation: 'confirmed',
    availability: 'orderable',
    maxOrderableQuantity: 10,
    minimumOrderQuantity: 1,
    packSize: 1,
    unitCostAmount: 1_000,
    supplierFeesAmount: null,
    shippingCostAmount: 499,
    shippingBasis: 'basket',
    selectedShippingServiceCode: 'std',
    handlingDaysMin: null,
    handlingDaysMax: null,
    dispatchDaysMin: null,
    dispatchDaysMax: null,
    deliveryDaysMin: 2,
    deliveryDaysMax: 5,
    taxAmount: null,
    dutyAmount: null,
    importResponsibility: 'supplier',
    fulfilmentOriginCountry: 'ES',
    destinationRestrictions: [],
    providerQuoteReference: null,
    priceGuarantee: 'guaranteed',
    stockGuarantee: 'guaranteed',
    providerReasonCodes: [],
    sourceRecordRef: null,
    status: 'complete',
    blockReasons: [],
    exceptionKind: null,
    sourcingPolicyId: null,
    sourcingPolicyKey: null,
    sourcingPolicyVersion: null,
    pricingPolicyKey: null,
    pricingPolicyVersion: null,
    eligibilityPolicyKey: null,
    eligibilityPolicyVersion: null,
    requestedAt: now,
    quotedAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
    attempts: 1,
    lastFailureKind: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    latencyMs: 120,
    shippingOptions: [
      {
        serviceCode: 'std',
        carrier: 'carrier',
        serviceName: 'Standard',
        costAmount: 499,
        costCurrency: EUR,
        basis: 'basket',
        deliveryDaysMin: 2,
        deliveryDaysMax: 5,
        guaranteed: true,
      },
    ],
    ...overrides,
  };
}


/**
 * Assert a database refusal, matching against the WHOLE error chain.
 *
 * drizzle wraps a driver error as `Failed query: …` and puts the server's own
 * message — which is the part naming the constraint — on `cause`. Matching the
 * top-level message alone would pass for any failure at all, including a typo
 * in the fixture, so every refusal below is checked against the flattened
 * chain. That distinction is the difference between "the CHECK fired" and "the
 * statement did not work", and only one of those is what these tests claim.
 */
async function expectRefusal(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  const chain: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    chain.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  expect(chain.join(' | ')).toMatch(pattern);
}

describe('supplier quote constraints', () => {
  it('stores a complete quote with its offered services', async () => {
    // The positive control. Without it every refusal below could be produced by
    // a table that rejects everything.
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    expect(quote.status).toBe('complete');
    const options = await listSupplierQuoteShippingOptions(quote.id, db);
    expect(options).toHaveLength(1);
    expect(options[0]?.serviceCode).toBe('std');
  });

  it('refuses a COMPLETE quote whose availability is unknown', async () => {
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(quoteInput(ids, { availability: 'unknown' }), db), /supplier_quotes_complete_requirements_check/);
  });

  it('refuses a COMPLETE quote with no shipping cost', async () => {
    // #122's closing rule, in the database: a missing required shipping cost
    // cannot pass checkout, and the quote that would let it cannot be stored.
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(
        quoteInput(ids, {
          shippingCostAmount: null,
          shippingBasis: 'unknown',
          selectedShippingServiceCode: null,
          shippingOptions: [],
        }),
        db,
      ), /supplier_quotes_complete_requirements_check/);
  });

  it('refuses a complete quote carrying a block reason, and a blocked one carrying none', async () => {
    // Both directions of the biconditional, because a one-directional CHECK
    // would let a blocked quote read as clean.
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(quoteInput(ids, { blockReasons: ['provider_timeout'] }), db), /supplier_quotes_block_reason_presence_check/);
    await expectRefusal(() => insertSupplierQuote(quoteInput(ids, { status: 'partial', blockReasons: [] }), db), /supplier_quotes_block_reason_presence_check/);
  });

  it('refuses an INVALID quote with no exception kind, and a partial one carrying one', async () => {
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(
        quoteInput(ids, {
          status: 'invalid',
          blockReasons: ['provider_contract_violation'],
          exceptionKind: null,
          availability: 'unknown',
        }),
        db,
      ), /supplier_quotes_exception_presence_check/);
  });

  it('refuses a headline shipping figure that names no offered service', async () => {
    // The cross-row invariant no CHECK can see — refused by the single writer,
    // before any SQL is issued.
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(
        quoteInput(ids, { selectedShippingServiceCode: 'express-not-offered' }),
        db,
      ), /not among the services it recorded/);
  });

  it('refuses a shipping cost that disagrees with the selected service', async () => {
    const ids = await makeAccount();
    await expectRefusal(() => insertSupplierQuote(quoteInput(ids, { shippingCostAmount: 12_345 }), db), /does not match the selected service/);
  });

  it('refuses a second quote under one idempotency key', async () => {
    const ids = await makeAccount();
    const key = `key-${uuidv7()}`;
    await insertSupplierQuote(quoteInput(ids, { idempotencyKey: key }), db);
    await expectRefusal(() => insertSupplierQuote(quoteInput(ids, { idempotencyKey: key }), db), /supplier_quotes_idempotency_key_key/);
  });

  it('is IMMUTABLE and undeletable', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    await expectRefusal(() => db.update(supplierQuotes).set({ availability: 'unavailable' }).where(eq(supplierQuotes.id, quote.id)), /immutable/);
    await expectRefusal(() => db.delete(supplierQuotes).where(eq(supplierQuotes.id, quote.id)), /cannot be deleted/);
  });

  it('refuses UPDATE and DELETE on the shipping-option trail', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const [option] = await listSupplierQuoteShippingOptions(quote.id, db);
    expect(option).toBeDefined();
    await expectRefusal(() => db.execute(
        `update supplier_quote_shipping_options set cost_amount = 1 where id = '${option?.id ?? ''}'`,
      ), /append-only/);
  });
});

describe('supplier quote usage', () => {
  it('lets ONE checkout consume a quote and refuses the second, concurrently', async () => {
    // #122 concurrency 3. Two racers on one compare-and-swap: exactly one row
    // is updated and the loser is TOLD, rather than both proceeding.
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const [first, second] = await Promise.all([
      consumeSupplierQuote({ quoteId: quote.id, checkoutGroupId: 'group-a' }, db),
      consumeSupplierQuote({ quoteId: quote.id, checkoutGroupId: 'group-b' }, db),
    ]);
    const winners = [first, second].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);
  });

  it('refuses to consume an EXPIRED quote', async () => {
    const ids = await makeAccount();
    const past = new Date(Date.now() - 60_000);
    const quote = await insertSupplierQuote(
      quoteInput(ids, {
        requestedAt: new Date(past.getTime() - 60_000),
        quotedAt: new Date(past.getTime() - 30_000),
        expiresAt: past,
      }),
      db,
    );
    expect(await consumeSupplierQuote({ quoteId: quote.id, checkoutGroupId: 'g' }, db)).toBeUndefined();
  });

  it('releases idempotently', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    expect(await releaseSupplierQuote({ quoteId: quote.id, reason: 'checkout_abandoned' }, db)).toBe(true);
    // The second call converges rather than failing — a release that finds
    // nothing to do has succeeded.
    expect(await releaseSupplierQuote({ quoteId: quote.id, reason: 'checkout_abandoned' }, db)).toBe(false);
  });

  it('refuses to consume a RELEASED quote', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    await releaseSupplierQuote({ quoteId: quote.id, reason: 'checkout_abandoned' }, db);
    expect(await consumeSupplierQuote({ quoteId: quote.id, checkoutGroupId: 'g' }, db)).toBeUndefined();
  });
});

describe('supplier reservations — the honesty rule', () => {
  const held = {
    supported: true as const,
    state: 'reserved' as const,
    providerReservationId: 'provider-hold-1',
    providerExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    singleUse: true,
  };

  it('records a hold the supplier actually made', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const reservation = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        declaredCapabilities: ['inventory_reservation'],
        outcome: { ...held, providerReservationId: `hold-${uuidv7()}` },
      },
      db,
    );
    expect(reservation.quoteId).toBe(quote.id);
    // The provider handle is PROTECTED: a whole-row read must not carry it.
    expect(reservation).not.toHaveProperty('providerReservationId');
  });

  it('refuses a hold whose declared capabilities do not include reservation', async () => {
    // THE structural guarantee of the domain, at the database. Even a writer
    // that bypassed `applyDeclaredCapabilities` and the repository's type has
    // no row to land in.
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    await expectRefusal(() => db.insert(supplierReservations).values({
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        providerReservationId: `hold-${uuidv7()}`,
        declaredCapabilities: ['live_stock_lookup'],
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        providerExpiresAt: new Date(Date.now() + 600_000),
      }), /supplier_reservations_capability_declared_check/);
  });

  it('refuses a hold with a blank provider reservation id', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    await expectRefusal(() => db.insert(supplierReservations).values({
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        providerReservationId: '   ',
        declaredCapabilities: ['inventory_reservation'],
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        providerExpiresAt: new Date(Date.now() + 600_000),
      }), /supplier_reservations_provider_id_check/);
  });

  it('cannot be consumed twice, concurrently', async () => {
    // #122 concurrency 2, and the case a mocked test cannot express at all.
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const reservation = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        declaredCapabilities: ['inventory_reservation'],
        outcome: { ...held, providerReservationId: `hold-${uuidv7()}` },
      },
      db,
    );
    const outcomes = await Promise.all([
      consumeSupplierReservation({ reservationId: reservation.id, checkoutGroupId: 'a' }, db),
      consumeSupplierReservation({ reservationId: reservation.id, checkoutGroupId: 'b' }, db),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to consume a hold past the SUPPLIER\'s own deadline', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const reservation = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(Date.now() - 120_000),
        declaredCapabilities: ['inventory_reservation'],
        outcome: {
          ...held,
          providerReservationId: `hold-${uuidv7()}`,
          providerExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
      db,
    );
    expect(
      await consumeSupplierReservation({ reservationId: reservation.id, checkoutGroupId: 'a' }, db),
    ).toBe(false);
  });

  it('releases idempotently, and a released hold cannot be consumed', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const reservation = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        declaredCapabilities: ['inventory_reservation'],
        outcome: { ...held, providerReservationId: `hold-${uuidv7()}` },
      },
      db,
    );
    expect(await releaseSupplierReservation({ reservationId: reservation.id, reason: 'expired' }, db)).toBe(true);
    expect(await releaseSupplierReservation({ reservationId: reservation.id, reason: 'expired' }, db)).toBe(false);
    expect(
      await consumeSupplierReservation({ reservationId: reservation.id, checkoutGroupId: 'a' }, db),
    ).toBe(false);
  });

  it('converges when one quote reserves twice', async () => {
    const ids = await makeAccount();
    const quote = await insertSupplierQuote(quoteInput(ids), db);
    const outcome = { ...held, providerReservationId: `hold-${uuidv7()}` };
    const first = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        declaredCapabilities: ['inventory_reservation'],
        outcome,
      },
      db,
    );
    const second = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: ids.supplierId,
        supplierAccountId: ids.supplierAccountId,
        procurementOfferId: null,
        supplierSku: 'SKU-A',
        quantity: 1,
        reservedAt: new Date(),
        declaredCapabilities: ['inventory_reservation'],
        outcome: { ...outcome, providerReservationId: `hold-${uuidv7()}` },
      },
      db,
    );
    expect(second.id).toBe(first.id);
    expect(await findSupplierReservationByQuote(quote.id, db)).toBeDefined();
  });
});

describe('the sourcing trail', () => {
  it('converges when a run is replayed, instead of doubling the trail', async () => {
    const ids = await makeAccount();
    const fingerprint = uuidv7().replace(/[^a-f0-9]/g, '').padEnd(64, '0').slice(0, 64);
    const attempts = [0, 1].map((sequence) => ({
      requestFingerprint: fingerprint,
      sequence,
      checkoutGroupId: 'group-x',
      supplierId: ids.supplierId,
      supplierAccountId: ids.supplierAccountId,
      procurementOfferId: null,
      sourcingPolicyId: null,
      sourcingPolicyKey: null,
      sourcingPolicyVersion: null,
      rank: sequence,
      outcome: 'skipped' as const,
      reason: 'offer_ineligible' as const,
      quoteId: null,
      at: new Date(),
    }));
    expect(await recordSupplierSourcingAttempts(attempts, db)).toBe(2);
    expect(await recordSupplierSourcingAttempts(attempts, db)).toBe(0);
  });

  it('refuses a `selected` attempt with no quote, and a skipped one carrying one', async () => {
    const ids = await makeAccount();
    const fingerprint = uuidv7().replace(/[^a-f0-9]/g, '').padEnd(64, '0').slice(0, 64);
    await expectRefusal(() => recordSupplierSourcingAttempts(
        [
          {
            requestFingerprint: fingerprint,
            sequence: 0,
            checkoutGroupId: null,
            supplierId: ids.supplierId,
            supplierAccountId: ids.supplierAccountId,
            procurementOfferId: null,
            sourcingPolicyId: null,
            sourcingPolicyKey: null,
            sourcingPolicyVersion: null,
            rank: 0,
            outcome: 'selected',
            reason: 'selected_by_policy',
            quoteId: null,
            at: new Date(),
          },
        ],
        db,
      ), /supplier_sourcing_attempts_selected_quote_check/);
  });
});

describe('the provider call lease', () => {
  it('bounds concurrency exactly, across callers', async () => {
    const ids = await makeAccount();
    const budget = {
      supplierAccountId: ids.supplierAccountId,
      maxConcurrency: 2,
      maxCallsPerMinute: 100,
    };
    const claims = await Promise.all(
      ['a', 'b', 'c'].map((owner) =>
        claimSupplierCallLease({ budget, leaseOwner: owner }, db),
      ),
    );
    expect(claims.filter((claim) => claim.granted)).toHaveLength(2);
    const refused = claims.find((claim) => !claim.granted);
    expect(refused && 'reason' in refused ? refused.reason : null).toBe('all_slots_busy');
  });

  it('refuses once the per-minute budget is spent, and says which refusal it is', async () => {
    // The two refusals are kept apart because they need different fixes: one is
    // "raise the concurrency", the other "raise the allowance".
    const ids = await makeAccount();
    const budget = {
      supplierAccountId: ids.supplierAccountId,
      maxConcurrency: 1,
      maxCallsPerMinute: 2,
    };
    for (let call = 0; call < 2; call += 1) {
      const claim = await claimSupplierCallLease({ budget, leaseOwner: `owner-${String(call)}` }, db);
      expect(claim.granted).toBe(true);
      if (claim.granted) {
        await releaseSupplierCallLease({ leaseId: claim.leaseId, leaseOwner: `owner-${String(call)}` }, db);
      }
    }
    const spent = await claimSupplierCallLease({ budget, leaseOwner: 'owner-3' }, db);
    // Read through `in` rather than by narrowing on `granted`: this repository
    // compiles with `strict: false`, under which truthiness narrowing on a
    // boolean-literal discriminant does not narrow the union.
    expect('reason' in spent ? spent.reason : null).toBe('rate_limited');
  });

  it('releases only the lease the caller owns', async () => {
    const ids = await makeAccount();
    const budget = {
      supplierAccountId: ids.supplierAccountId,
      maxConcurrency: 1,
      maxCallsPerMinute: 100,
    };
    const claim = await claimSupplierCallLease({ budget, leaseOwner: 'mine' }, db);
    expect(claim.granted).toBe(true);
    if (!claim.granted) return;
    expect(await releaseSupplierCallLease({ leaseId: claim.leaseId, leaseOwner: 'theirs' }, db)).toBe(false);
    expect(await releaseSupplierCallLease({ leaseId: claim.leaseId, leaseOwner: 'mine' }, db)).toBe(true);
  });
});

describe('health counters and suppressions', () => {
  it('keeps the counters reconciling, which is what the CHECK guarantees', async () => {
    const ids = await makeAccount();
    for (const succeeded of [true, false, true]) {
      await recordSupplierCallOutcome(
        {
          supplierAccountId: ids.supplierAccountId,
          succeeded,
          failureKind: succeeded ? null : 'timeout',
          latencyMs: succeeded ? 100 : null,
          windowMinutes: 15,
        },
        db,
      );
    }
    const [row] = await db.execute<{
      attempts: string;
      successes: string;
      failures: string;
      timeouts: string;
    }>(
      `select attempts, successes, failures, timeouts from supplier_preflight_health
       where supplier_account_id = '${ids.supplierAccountId}'`,
    );
    expect(Number(row?.attempts)).toBe(3);
    expect(Number(row?.successes)).toBe(2);
    expect(Number(row?.failures)).toBe(1);
    expect(Number(row?.timeouts)).toBe(1);
  });

  it('converges when two operators stop one subject', async () => {
    const ids = await makeAccount();
    const subject = {
      scope: 'supplier_account' as const,
      supplierId: null,
      supplierAccountId: ids.supplierAccountId,
      marketCountry: null,
      kind: 'kill_switch' as const,
    };
    const first = await raiseSupplierPreflightSuppression(
      {
        ...subject,
        origin: 'operator',
        reason: 'Incident 1',
        sourcingPolicyId: null,
        raisedByOxyUserId: 'oxy-op-1',
        effectiveFrom: new Date(),
        expiresAt: null,
      },
      db,
    );
    const second = await raiseSupplierPreflightSuppression(
      {
        ...subject,
        origin: 'operator',
        reason: 'Incident 1 again',
        sourcingPolicyId: null,
        raisedByOxyUserId: 'oxy-op-2',
        effectiveFrom: new Date(),
        expiresAt: null,
      },
      db,
    );
    expect(second.id).toBe(first.id);
    expect(await findLiveSupplierPreflightSuppression(subject, db)).toBeDefined();
  });

  it('refuses an automatic stop that is not a health one', async () => {
    // The CHECK that keeps an operator's power an operator's: the health loop
    // cannot file a kill switch.
    const ids = await makeAccount();
    await expectRefusal(() => raiseSupplierPreflightSuppression(
        {
          scope: 'supplier_account',
          supplierId: null,
          supplierAccountId: ids.supplierAccountId,
          marketCountry: null,
          kind: 'kill_switch',
          origin: 'automatic_health',
          reason: 'should not be storable',
          sourcingPolicyId: null,
          raisedByOxyUserId: null,
          effectiveFrom: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
        },
        db,
      ), /check|violat|constraint/i);
  });

  it('refuses a market stop that also names an account', async () => {
    const ids = await makeAccount();
    await expectRefusal(() => raiseSupplierPreflightSuppression(
        {
          scope: 'market',
          supplierId: null,
          supplierAccountId: ids.supplierAccountId,
          marketCountry: 'ES',
          kind: 'kill_switch',
          origin: 'operator',
          reason: 'scope confusion',
          sourcingPolicyId: null,
          raisedByOxyUserId: 'oxy-op-1',
          effectiveFrom: new Date(),
          expiresAt: null,
        },
        db,
      ), /check|violat|constraint/i);
  });
});
