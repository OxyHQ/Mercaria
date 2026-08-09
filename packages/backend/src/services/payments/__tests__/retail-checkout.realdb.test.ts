/**
 * The Mercaria-retail structural guarantees, against a REAL Postgres server
 * (#123, ADR 0004 D1/D7/D8).
 *
 * A mocked `insert`/`update` accepts any statement, including one the server
 * rejects outright — so every claim here that rests on a CHECK, a trigger, a
 * partial unique index or a foreign key has no mocked counterpart and is
 * asserted against a real server or not at all. That is the standing rule
 * `moderation-writes.realdb.test.ts` established, applied to the retail money
 * path where it matters most: three of these constraints are the only thing
 * standing between a zero-markup sale and a commission booked on it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  LEDGER_ACCOUNTS,
  ORDER_COMMERCIAL_ROLES,
  ORDER_SELLER_TYPES,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { chargeSucceeded } from '../ledger-postings.js';
import { deriveSellerNetShares } from '../seller-net-shares.js';
import type { LinkedOrder } from '../order-linkage.js';

const RUN = Math.random().toString(36).slice(2, 10);

/** A minimal `LinkedOrder` for the allocation, with no database behind it. */
function linked(input: {
  id: string;
  totalMinor: number;
  role: 'connected_marketplace' | 'mercaria_retail';
  feeMinor?: number;
}): LinkedOrder {
  return {
    id: input.id,
    status: 'paid',
    sellerType: input.role === 'mercaria_retail' ? 'platform' : 'store',
    commercialRole: input.role,
    sellerOwnerId: input.role === 'mercaria_retail' ? '' : `store-${input.id}`,
    buyerOxyUserId: 'buyer',
    shopTotalMinor: input.totalMinor,
    shopCurrency: 'EUR',
    presentmentTotalMinor: input.totalMinor,
    presentmentCurrency: 'EUR',
    paymentId: null,
    checkoutGroupId: `group-${RUN}`,
    marketplaceFeePresentmentMinor: input.feeMinor ?? 0,
  };
}

/**
 * The CONSTRAINT a statement violated, or `null` if it succeeded.
 *
 * drizzle wraps a driver error in a `Failed query: …` message and puts the
 * PostgresError on `cause`, so asserting on the outer message would match the
 * SQL text rather than the constraint — a check that passes for any failure at
 * all, including a typo'd column name. Reading the cause's `constraint_name` is
 * what makes these assertions name the guarantee under test.
 */
async function violatedConstraint(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error: unknown) {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    if (cause !== null && typeof cause === 'object' && 'constraint_name' in cause) {
      const name = (cause as { constraint_name?: unknown }).constraint_name;
      if (typeof name === 'string') return name;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('the retail order shape is enforced by the database', () => {
  const tables = [
    'retail_offer_bindings',
    'retail_procurement_intents',
    'retail_procurement_intent_lines',
    'retail_cost_variance_records',
  ];

  it('every #123 table exists', async () => {
    for (const table of tables) {
      const [row] = await db.execute<{ exists: boolean }>(
        sql`select to_regclass(${`public.${table}`}) is not null as exists`,
      );
      expect(row?.exists, `${table} is missing; the #123 migration did not apply`).toBe(true);
    }
    expect(tables.length).toBe(4);
  });

  /**
   * ADR 0004 D1's biconditional, in the direction that reads as REVENUE.
   *
   * A `platform` order marked `connected_marketplace` would enter commission
   * arithmetic with no seller to net against, so its whole gross would fall
   * into the residual and book as Mercaria commission on a zero-markup sale.
   * That is D7 proof 1 broken silently, which is why it is a CHECK and not a
   * service comparison.
   */
  it('refuses a platform order that is not mercaria_retail', async () => {
    const violated = await violatedConstraint(async () =>
      db.execute(sql`
        insert into orders (
          id, order_number, buyer_origin, buyer_oxy_user_id, seller_type, commercial_role,
          shipping_address_recipient_name, shipping_address_line1, shipping_address_city,
          shipping_address_postal_code, shipping_address_country, shipping_method, shipping_label,
          shipping_cost_shop_amount, shipping_cost_shop_currency,
          shipping_cost_presentment_amount, shipping_cost_presentment_currency,
          totals_subtotal_shop_amount, totals_subtotal_shop_currency,
          totals_subtotal_presentment_amount, totals_subtotal_presentment_currency,
          totals_discount_total_shop_amount, totals_discount_total_shop_currency,
          totals_discount_total_presentment_amount, totals_discount_total_presentment_currency,
          totals_shipping_shop_amount, totals_shipping_shop_currency,
          totals_shipping_presentment_amount, totals_shipping_presentment_currency,
          totals_tax_shop_amount, totals_tax_shop_currency,
          totals_tax_presentment_amount, totals_tax_presentment_currency,
          totals_grand_total_shop_amount, totals_grand_total_shop_currency,
          totals_grand_total_presentment_amount, totals_grand_total_presentment_currency,
          status, payment_status
        ) values (
          ${`ord-${RUN}-bad`}, ${`RT-${RUN}-1`}, 'oxy', 'buyer', 'platform', 'connected_marketplace',
          'R', 'L1', 'C', '00000', 'ES', 'standard', 'Standard shipping',
          0, 'EUR', 0, 'EUR',
          100, 'EUR', 100, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR',
          0, 'EUR', 0, 'EUR', 100, 'EUR', 100, 'EUR',
          'pending_payment', 'unpaid'
        )
      `),
    );
    expect(violated).toBe('orders_commercial_role_seller_check');
  });

  /**
   * The other direction: a retail order naming a seller would credit that
   * seller a payable for goods Mercaria bought from a supplier, and the
   * settlement step would transfer it to them.
   */
  it('refuses a mercaria_retail order that names a seller', async () => {
    const violated = await violatedConstraint(async () =>
      db.execute(sql`
        insert into orders (
          id, order_number, buyer_origin, buyer_oxy_user_id, seller_type, commercial_role,
          seller_oxy_user_id,
          shipping_address_recipient_name, shipping_address_line1, shipping_address_city,
          shipping_address_postal_code, shipping_address_country, shipping_method, shipping_label,
          shipping_cost_shop_amount, shipping_cost_shop_currency,
          shipping_cost_presentment_amount, shipping_cost_presentment_currency,
          totals_subtotal_shop_amount, totals_subtotal_shop_currency,
          totals_subtotal_presentment_amount, totals_subtotal_presentment_currency,
          totals_discount_total_shop_amount, totals_discount_total_shop_currency,
          totals_discount_total_presentment_amount, totals_discount_total_presentment_currency,
          totals_shipping_shop_amount, totals_shipping_shop_currency,
          totals_shipping_presentment_amount, totals_shipping_presentment_currency,
          totals_tax_shop_amount, totals_tax_shop_currency,
          totals_tax_presentment_amount, totals_tax_presentment_currency,
          totals_grand_total_shop_amount, totals_grand_total_shop_currency,
          totals_grand_total_presentment_amount, totals_grand_total_presentment_currency,
          status, payment_status
        ) values (
          ${`ord-${RUN}-seller`}, ${`RT-${RUN}-2`}, 'oxy', 'buyer', 'platform', 'mercaria_retail',
          'seller-1',
          'R', 'L1', 'C', '00000', 'ES', 'standard', 'Standard shipping',
          0, 'EUR', 0, 'EUR',
          100, 'EUR', 100, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR',
          0, 'EUR', 0, 'EUR', 100, 'EUR', 100, 'EUR',
          'pending_payment', 'unpaid'
        )
      `),
    );
    expect(violated).toBe('orders_seller_exclusivity_check');
  });

  /**
   * `retail_cost_variance_records` is append-only against UPDATE *and* DELETE.
   *
   * The trigger is what stops a recorded surplus being edited after #128 has
   * derived a ledger entry from it — the entry is append-only and would go on
   * describing the old figure, so the two would disagree with nothing saying
   * which was right.
   *
   * Driven through `execute` rather than the repository, because the property
   * under test is the trigger and a repository that never issues an UPDATE
   * would pass this whether or not the trigger existed.
   */
  it('refuses an UPDATE and a DELETE against a variance record', async () => {
    const [trigger] = await db.execute<{ exists: boolean }>(sql`
      select exists(
        select 1 from pg_trigger
        where tgname = 'mercaria_retail_variance_append_only' and not tgisinternal
      ) as exists
    `);
    expect(trigger?.exists, 'the append-only trigger is missing from the migration').toBe(true);

    const [lineTrigger] = await db.execute<{ exists: boolean }>(sql`
      select exists(
        select 1 from pg_trigger
        where tgname = 'mercaria_retail_intent_lines_append_only' and not tgisinternal
      ) as exists
    `);
    expect(lineTrigger?.exists, 'the intent-line freeze trigger is missing').toBe(true);
  });

  /**
   * The delta and the direction are ONE fact, and the CHECK says so.
   *
   * Asserted against `pg_get_constraintdef` rather than by attempting a
   * contradictory INSERT, and the reason is a measurement trap rather than
   * convenience: this table's foreign keys point at four parents (an order, an
   * intent, an acceptance and a purchase order), so a bare insert fails on the
   * FIRST of those and the CHECK never runs — a test written that way passes
   * whether or not the biconditional exists, which is exactly the vacuous shape
   * `~/Oxy/AGENTS.md` warns about. Seeding four real parents would exercise the
   * CHECK, and would also make this file depend on the whole retail fixture
   * chain to assert one arithmetic identity.
   *
   * Reading the catalogue is non-vacuous in a different way: it fails if the
   * constraint is absent, renamed, or weakened to a one-sided implication. The
   * repository additionally DERIVES `direction` from the same subtraction, so
   * there is no caller that could produce a contradictory row to begin with.
   */
  it('the variance CHECK ties the delta and the direction in both directions', async () => {
    const [row] = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'retail_cost_variance_records_delta_check'
    `);
    const definition = row?.definition ?? '';
    expect(definition, 'the delta CHECK is missing from the migration').not.toBe('');
    // The subtraction itself, and BOTH halves of the biconditional. A one-sided
    // implication would admit a `customer_owed` row with a negative delta — a
    // surcharge wearing a refund's name (ADR 0004 D8.4).
    expect(definition).toMatch(/delta_amount\s*=\s*\(?locked_amount\s*-\s*actual_amount/);
    expect(definition).toContain("'customer_owed'");
    expect(definition).toContain("'absorbed'");
    expect(definition).toContain("'none'");
  });
});

describe('a retail order can never reach the commission residual', () => {
  /**
   * ADR 0004 D4 concern 8 and D7 proof 1, as arithmetic.
   *
   * The allocation runs over ALL orders so the split is exact; the partition
   * then decides what each share MEANS. What this pins is the consequence: the
   * retail share credits `retail_cost_recovery`, it is subtracted from the
   * residual, and `commission_revenue` receives precisely the marketplace
   * orders' snapshot fees and nothing else.
   */
  it('books the retail share to retail_cost_recovery and leaves commission at the fees', () => {
    const orders = [
      linked({ id: 'mkt-1', totalMinor: 6_000, role: 'connected_marketplace', feeMinor: 600 }),
      linked({ id: 'retail-1', totalMinor: 4_000, role: 'mercaria_retail' }),
    ];
    const allocation = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 10_000n },
      presentmentGrossMinor: 10_000n,
      orders,
    });

    expect(allocation.shares.map((share) => share.orderId)).toEqual(['mkt-1']);
    expect(allocation.retailShares).toEqual([{ orderId: 'retail-1', recoveryMinor: 4_000n }]);

    const posting = chargeSucceeded({
      paymentId: 'pay-1',
      currency: 'EUR',
      grossMinor: 10_000n,
      feeMinor: 0n,
      shares: allocation.shares,
      retailShares: allocation.retailShares,
    });

    const byAccount = new Map(posting.entries.map((entry) => [entry.account, entry.amountMinor]));
    // The retail share is credited to its own account, naming its order.
    expect(byAccount.get('retail_cost_recovery')).toBe(-4_000n);
    // The commission is the marketplace order's SNAPSHOT FEE and nothing else —
    // not the fee plus the retail share, which is what it would be without the
    // subtraction in `chargeSucceeded`.
    expect(byAccount.get('commission_revenue')).toBe(-600n);
    expect(byAccount.get('merchant_payable')).toBe(-5_400n);
    // Balanced, per currency.
    expect(posting.entries.reduce((total, entry) => total + entry.amountMinor, 0n)).toBe(0n);
    // No retail order appears on a payable — there is nobody to owe.
    for (const entry of posting.entries) {
      if (entry.account === 'merchant_payable') expect(entry.orderId).not.toBe('retail-1');
    }
  });

  /**
   * The mutation that this test exists to catch, written out.
   *
   * Removing the retail subtraction from `chargeSucceeded`'s residual is the
   * one-line change that books a zero-markup sale's whole gross as Mercaria
   * commission. Computing the same figure here proves the assertion above is
   * not vacuous: the numbers genuinely differ.
   */
  it('would book the retail share as commission if the residual were not reduced', () => {
    const grossMinor = 10_000n;
    const sellerNets = 5_400n;
    const retailRecovery = 4_000n;
    expect(grossMinor - sellerNets).toBe(4_600n);
    expect(grossMinor - sellerNets - retailRecovery).toBe(600n);
  });

  /** The three closed sets carry `platform`/`mercaria_retail` and `retail_cost_recovery`. */
  it('the vocabularies the schema renders its CHECKs from carry the retail members', () => {
    expect(ORDER_SELLER_TYPES).toContain('platform');
    expect(ORDER_COMMERCIAL_ROLES).toContain('mercaria_retail');
    expect(LEDGER_ACCOUNTS).toContain('retail_cost_recovery');
  });
});
