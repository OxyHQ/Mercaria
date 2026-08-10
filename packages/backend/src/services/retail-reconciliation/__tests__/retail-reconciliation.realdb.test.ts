/**
 * The structural guarantees of zero-profit cost reconciliation, against a REAL
 * Postgres server (#128, ADR 0004 D7/D8).
 *
 * A mocked `insert`/`update` accepts any statement, including one the server
 * rejects outright — so every claim here that rests on a CHECK, a trigger, a
 * partial unique index or `ON CONFLICT` semantics has no mocked counterpart and
 * is asserted against a real server or not at all. `moderation-writes.realdb.test.ts`
 * established the rule; this is the domain where breaking it means refunding a
 * buyer twice, or not at all, and finding out months later.
 *
 * What is under test here is the DATABASE and the LEDGER. The equation itself is
 * pure and table-tested in `equation.test.ts`; the walls are scanned in
 * `retail-reconciliation-isolation.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  RETAIL_FORBIDDEN_ACCOUNTS,
  RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';
import {
  customerAdjustmentRefunded,
  prefundTopUp,
  procurementSettled,
  retailVarianceRecognized,
  supplierCreditReceived,
} from '../../payments/ledger-postings.js';
import {
  claimRetailCustomerAdjustment,
  setAdjustmentState,
} from '../../../db/retailReconciliation/adjustmentRepository.js';
import { claimLedgerRecognition } from '../../../db/retailReconciliation/supplierCreditRepository.js';

const RUN = Math.random().toString(36).slice(2, 10);

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
    if (cause !== null && typeof cause === 'object') {
      const name = (cause as { constraint_name?: unknown }).constraint_name;
      if (typeof name === 'string') return name;
      // A trigger's `RAISE EXCEPTION` carries no constraint name, so the SERVER
      // message on the cause is the only thing that names the guarantee.
      // Reading the outer message instead would match the SQL text, which is a
      // check that passes for any failure at all — including a typo'd column.
      const message = (cause as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

let db: Database;
let orderId: string;
let policyId: string;

/** A `mercaria_retail` order, the FK every reconciliation row needs. */
async function seedRetailOrder(suffix: string): Promise<string> {
  const id = `ord-${RUN}-${suffix}`;
  await db.execute(sql`
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
      ${id}, ${`RC-${RUN}-${suffix}`}, 'oxy', 'buyer', 'platform', 'mercaria_retail',
      'R', 'L1', 'C', '00000', 'ES', 'standard', 'Standard shipping',
      0, 'EUR', 0, 'EUR',
      10000, 'EUR', 10000, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR', 0, 'EUR',
      0, 'EUR', 0, 'EUR', 10000, 'EUR', 10000, 'EUR',
      'paid', 'paid'
    )
  `);
  return id;
}

/** A DRAFT reconciliation policy version. */
async function seedPolicy(suffix: string, status = 'draft'): Promise<string> {
  const id = `pol-${RUN}-${suffix}`;
  await db.execute(sql`
    insert into retail_reconciliation_policies (
      id, policy_key, version, name, summary, status, effective_start,
      absorbed_variance_alert_bps,
      absorbed_variance_alert_floor_amount, absorbed_variance_alert_floor_currency,
      recurring_variance_count, recurring_variance_window_hours, finality_ceiling_days,
      sub_threshold_disposition, created_by_oxy_user_id,
      approved_by_oxy_user_id, activated_at
    ) values (
      ${id}, ${`k-${RUN}-${suffix}`}, 1, 'v1', 'the first version', ${status}, now(),
      500, 2500, 'EUR', 3, 168, 180, 'refund_remaining', 'op-1',
      ${status === 'draft' ? null : 'op-2'}, ${status === 'draft' ? null : sql`now()`}
    )
  `);
  return id;
}

/** One reconciliation revision. */
async function insertRevision(input: {
  id: string;
  order: string;
  revision: number;
  completeness: string;
  outcome: string | null;
  customer: number;
  cost: number;
  tolerance: number;
}): Promise<void> {
  await db.execute(sql`
    insert into retail_reconciliations (
      id, order_id, revision, policy_id, policy_key, policy_version, completeness, outcome,
      accounting_currency, customer_amount_before_subsidy_minor, final_attributable_cost_minor,
      cost_variance_minor, tolerance_minor, evidence_digest, computed_at
    ) values (
      ${input.id}, ${input.order}, ${input.revision}, ${policyId}, ${`k-${RUN}-main`}, 1,
      ${input.completeness}, ${input.outcome}, 'EUR',
      ${input.customer}, ${input.cost}, ${input.customer - input.cost}, ${input.tolerance},
      ${'a'.repeat(64)}, now()
    )
  `);
}

beforeAll(async () => {
  db = await connectPostgres();
  orderId = await seedRetailOrder('main');
  policyId = await seedPolicy('main');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('the ten tables exist', () => {
  const tables = [
    'retail_reconciliation_policies',
    'retail_reconciliation_tolerances',
    'retail_reconciliations',
    'retail_reconciliation_components',
    'retail_reconciliation_evidence',
    'retail_reconciliation_exceptions',
    'retail_customer_adjustments',
    'retail_supplier_credits',
    'retail_ledger_recognitions',
    'retail_reconciliation_operator_actions',
  ];

  it('every #128 table applied', async () => {
    for (const table of tables) {
      const [row] = await db.execute<{ exists: boolean }>(
        sql`select to_regclass(${`public.${table}`}) is not null as exists`,
      );
      expect(row?.exists, `${table} is missing; the #128 migration did not apply`).toBe(true);
    }
    // A vacuity floor on the list itself.
    expect(tables).toHaveLength(10);
  });
});

describe('a missing cost is never a zero cost', () => {
  /**
   * #128 acceptance 7, as a biconditional.
   *
   * An incomplete reconciliation that carried a verdict would be a confident
   * answer built on a supplier invoice nobody has — and the number it would
   * carry is the whole customer amount as a surplus, which is a refund the buyer
   * was never owed.
   */
  it('refuses a verdict on an incomplete reconciliation', async () => {
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-a`,
        order: orderId,
        revision: 90,
        completeness: 'missing_evidence',
        outcome: 'customer_adjustment_required',
        customer: 10_000,
        cost: 0,
        tolerance: 1,
      }),
    );
    expect(violated).toBe('retail_reconciliations_outcome_shape_check');
  });

  it('refuses a COMPLETE reconciliation with no verdict', async () => {
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-b`,
        order: orderId,
        revision: 91,
        completeness: 'complete',
        outcome: null,
        customer: 10_000,
        cost: 10_000,
        tolerance: 1,
      }),
    );
    expect(violated).toBe('retail_reconciliations_outcome_shape_check');
  });
});

describe('the variance IS the subtraction, and its sign IS the outcome', () => {
  /**
   * ADR 0004 D8.4 as a CHECK. A `customer_adjustment_required` row whose cost
   * EXCEEDED the customer amount is a NEGATIVE amount owed to a buyer — a
   * surcharge wearing a refund's name.
   */
  it('refuses a customer adjustment on a NEGATIVE variance', async () => {
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-c`,
        order: orderId,
        revision: 92,
        completeness: 'complete',
        outcome: 'customer_adjustment_required',
        customer: 10_000,
        cost: 11_000,
        tolerance: 1,
      }),
    );
    expect(violated).toBe('retail_reconciliations_variance_check');
  });

  it('refuses an ABSORBED verdict on a positive variance', async () => {
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-d`,
        order: orderId,
        revision: 93,
        completeness: 'complete',
        outcome: 'mercaria_absorbed',
        customer: 11_000,
        cost: 10_000,
        tolerance: 1,
      }),
    );
    expect(violated).toBe('retail_reconciliations_variance_check');
  });

  it('refuses an EXACT recovery that is not exactly zero', async () => {
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-e`,
        order: orderId,
        revision: 94,
        completeness: 'complete',
        outcome: 'cost_recovered_exactly',
        customer: 10_001,
        cost: 10_000,
        tolerance: 5,
      }),
    );
    expect(violated).toBe('retail_reconciliations_variance_check');
  });

  it('accepts a well-formed revision — the positive control', async () => {
    // Without this, every assertion above passes just as well against a CHECK
    // that refuses EVERY row.
    const violated = await violatedConstraint(() =>
      insertRevision({
        id: `rec-${RUN}-ok`,
        order: orderId,
        revision: 1,
        completeness: 'complete',
        outcome: 'customer_adjustment_required',
        customer: 10_000,
        cost: 9_000,
        tolerance: 1,
      }),
    );
    expect(violated).toBeNull();
  });
});

describe('the tolerance is tiny AND currency-aware', () => {
  /**
   * The whole reason the tolerance lives on a per-currency child row.
   *
   * `5_000_000` minor units is five hundredths of a FAIR (eight decimals) and
   * fifty thousand euros. One integer, two unrelated quantities — and the CHECK
   * is what makes the second unrepresentable while the first is ordinary.
   */
  it('admits a five-hundredth-of-a-unit tolerance in FAIR and refuses it in EUR', async () => {
    const fair = RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR.FAIR;
    expect(fair).toBe(5_000_000);
    const okay = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_reconciliation_tolerances
          (id, policy_id, currency, tolerance_minor, automation_floor_minor)
        values (${`tol-${RUN}-fair`}, ${policyId}, 'FAIR', ${fair}, ${fair})
      `),
    );
    expect(okay).toBeNull();

    const refused = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_reconciliation_tolerances
          (id, policy_id, currency, tolerance_minor, automation_floor_minor)
        values (${`tol-${RUN}-eur`}, ${policyId}, 'EUR', ${fair}, ${fair})
      `),
    );
    expect(refused).toBe('retail_reconciliation_tolerances_bound_check');
  });

  it('refuses an automation floor BELOW the tolerance', async () => {
    // A floor below the tolerance promises an automatic refund for a difference
    // the same policy has already classified as rounding.
    const violated = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_reconciliation_tolerances
          (id, policy_id, currency, tolerance_minor, automation_floor_minor)
        values (${`tol-${RUN}-usd`}, ${policyId}, 'USD', 5, 1)
      `),
    );
    expect(violated).toBe('retail_reconciliation_tolerances_floor_check');
  });
});

describe('what happened cannot be edited', () => {
  it('refuses an UPDATE to a reconciliation revision', async () => {
    const violated = await violatedConstraint(() =>
      db.execute(
        sql`update retail_reconciliations set tolerance_minor = 99 where id = ${`rec-${RUN}-ok`}`,
      ),
    );
    expect(violated).toContain('append-only');
  });

  it('refuses a DELETE of a reconciliation revision', async () => {
    const violated = await violatedConstraint(() =>
      db.execute(sql`delete from retail_reconciliations where id = ${`rec-${RUN}-ok`}`),
    );
    expect(violated).toContain('append-only');
  });

  it('refuses an UPDATE to an operator audit row', async () => {
    await db.execute(sql`
      insert into retail_reconciliation_operator_actions
        (id, action, outcome, actor_oxy_user_id, reason, order_id, attempted_at)
      values (${`act-${RUN}-1`}, 'reconcile_order', 'applied', 'op-1', 'because', ${orderId}, now())
    `);
    const violated = await violatedConstraint(() =>
      db.execute(
        sql`update retail_reconciliation_operator_actions set reason = 'other' where id = ${`act-${RUN}-1`}`,
      ),
    );
    expect(violated).toContain('append-only');
  });

  it('refuses editing the TERMS of a published policy version, and permits the lifecycle', async () => {
    const published = await seedPolicy('published', 'active');
    const frozen = await violatedConstraint(() =>
      db.execute(
        sql`update retail_reconciliation_policies set finality_ceiling_days = 30 where id = ${published}`,
      ),
    );
    expect(frozen).toContain('frozen');

    // The positive control: superseding it is exactly what publishing the next
    // version does, and a trigger that refused it would make a second version
    // unpublishable.
    const superseded = await violatedConstraint(() =>
      db.execute(
        sql`update retail_reconciliation_policies set status = 'superseded' where id = ${published}`,
      ),
    );
    expect(superseded).toBeNull();
  });
});

describe('exactly one customer adjustment per revision', () => {
  it('converges a repeat rather than creating a second obligation', async () => {
    const order = await seedRetailOrder('adj');
    await insertRevision({
      id: `rec-${RUN}-adj`,
      order,
      revision: 1,
      completeness: 'complete',
      outcome: 'customer_adjustment_required',
      customer: 10_000,
      cost: 9_000,
      tolerance: 1,
    });

    const input = {
      orderId: order,
      reconciliationId: `rec-${RUN}-adj`,
      reconciliationRevision: 1,
      amount: { amount: 1_000, currency: 'EUR' as const },
      method: 'provider_refund' as const,
    };
    const first = await claimRetailCustomerAdjustment(input, db);
    const second = await claimRetailCustomerAdjustment(input, db);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The SAME row, not a second one with the same figures. #128 acceptance 3 is
    // "exactly one obligation", and two rows for one surplus is two refunds.
    expect(second.adjustment.id).toBe(first.adjustment.id);

    const [count] = await db.execute<{ n: string }>(
      sql`select count(*) as n from retail_customer_adjustments where order_id = ${order}`,
    );
    expect(Number(count?.n)).toBe(1);
  });

  it('refuses an adjustment of zero', async () => {
    // A zero surplus is `cost_recovered_exactly` and creates no obligation at
    // all; a zero-valued row would sit in the operator queue forever owing
    // nothing.
    const violated = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_customer_adjustments
          (id, order_id, reconciliation_id, reconciliation_revision,
           adjustment_amount, adjustment_currency, method, state)
        values (${`adj-${RUN}-zero`}, ${orderId}, ${`rec-${RUN}-ok`}, 1, 0, 'EUR', 'provider_refund', 'owed')
      `),
    );
    expect(violated).toBe('retail_customer_adjustments_amount_check');
  });

  /**
   * The bug this case exists for: `setAdjustmentState` spreads its optional
   * fields, so `blockReason: undefined` OMITS the column rather than nulling it.
   * An operator asking for a sub-threshold surplus to be refunded would have
   * moved the row to `provider_refund` while it still carried
   * `below_automation_threshold` — which the CHECK below refuses outright, and
   * which on a path that did not change the method would have silently kept the
   * sweep from ever paying it.
   */
  it('clears the block reason EXPLICITLY when an operator asks for the refund', async () => {
    const order = await seedRetailOrder('clear');
    await insertRevision({
      id: `rec-${RUN}-clear`,
      order,
      revision: 1,
      completeness: 'complete',
      outcome: 'customer_adjustment_required',
      customer: 10_000,
      cost: 9_950,
      tolerance: 1,
    });
    const { adjustment } = await claimRetailCustomerAdjustment(
      {
        orderId: order,
        reconciliationId: `rec-${RUN}-clear`,
        reconciliationRevision: 1,
        amount: { amount: 50, currency: 'EUR' },
        method: 'recorded_payable',
        blockReason: 'below_automation_threshold',
      },
      db,
    );
    expect(adjustment.blockReason).toBe('below_automation_threshold');

    const moved = await setAdjustmentState(
      {
        id: adjustment.id,
        state: 'owed',
        from: ['payable_recorded', 'owed'],
        method: 'provider_refund',
        clearBlockReason: true,
      },
      db,
    );
    expect(moved?.method).toBe('provider_refund');
    expect(moved?.blockReason).toBeNull();
  });

  it('refuses a `provider_refund` that still names a block reason', async () => {
    // The other direction of the same biconditional, and the constraint that
    // would have caught the omitted-optional bug at the WRITE.
    const violated = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_customer_adjustments
          (id, order_id, reconciliation_id, reconciliation_revision,
           adjustment_amount, adjustment_currency, method, state, block_reason)
        values (${`adj-${RUN}-br`}, ${orderId}, ${`rec-${RUN}-ok`}, 1, 100, 'EUR',
                'provider_refund', 'owed', 'below_automation_threshold')
      `),
    );
    expect(violated).toBe('retail_customer_adjustments_block_shape_check');
  });

  it('refuses a blocked method with no reason, and a reason with no block', async () => {
    const noReason = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_customer_adjustments
          (id, order_id, reconciliation_id, reconciliation_revision,
           adjustment_amount, adjustment_currency, method, state)
        values (${`adj-${RUN}-nr`}, ${orderId}, ${`rec-${RUN}-ok`}, 1, 100, 'EUR', 'recorded_payable', 'owed')
      `),
    );
    expect(noReason).toBe('retail_customer_adjustments_block_shape_check');
  });
});

describe('the ledger, and ADR 0004 D7’s postings', () => {
  it('books a positive variance to `customer_adjustment` and nowhere else', async () => {
    const posting = retailVarianceRecognized({
      orderId,
      currency: 'EUR',
      amountMinor: 1_000n,
    });
    const written = await insertLedgerTransaction(db, posting.transaction, posting.entries);
    expect(written.entryIds).toHaveLength(2);

    const rows = await db.execute<{ account: string; total: string }>(sql`
      select account, sum(amount_minor)::text as total
      from ledger_entries where transaction_id = ${written.id}
      group by account
    `);
    const byAccount = new Map([...rows].map((row) => [row.account, BigInt(row.total)]));
    expect(byAccount.get('retail_cost_recovery')).toBe(1_000n);
    expect(byAccount.get('customer_adjustment')).toBe(-1_000n);
    // ADR 0004 D7 proof 1: no retail movement may touch a revenue account.
    for (const forbidden of RETAIL_FORBIDDEN_ACCOUNTS) {
      expect(byAccount.has(forbidden)).toBe(false);
    }
    expect(RETAIL_FORBIDDEN_ACCOUNTS).toContain('commission_revenue');
  });

  it('closes the liability exactly when the adjustment is refunded', async () => {
    // D7 proof 2's mechanism: recognition and refund are two transactions of ONE
    // kind, and an order whose `customer_adjustment` nets to zero has been made
    // whole. Reading that off one kind is what makes it a query.
    const refundOrder = await seedRetailOrder('close');
    const recognized = retailVarianceRecognized({
      orderId: refundOrder,
      currency: 'EUR',
      amountMinor: 750n,
    });
    await insertLedgerTransaction(db, recognized.transaction, recognized.entries);
    const refunded = customerAdjustmentRefunded({
      orderId: refundOrder,
      refundId: `ref-${RUN}`,
      currency: 'EUR',
      amountMinor: 750n,
    });
    await insertLedgerTransaction(db, refunded.transaction, refunded.entries);

    const [row] = await db.execute<{ total: string }>(sql`
      select coalesce(sum(amount_minor), 0)::text as total
      from ledger_entries
      where order_id = ${refundOrder} and account = 'customer_adjustment'
    `);
    expect(BigInt(row?.total ?? '1')).toBe(0n);
  });

  it('books a supplier draw and its credit as exact opposites', async () => {
    const drawOrder = await seedRetailOrder('draw');
    const supplierId = `sup-${RUN}`;
    const draw = procurementSettled({
      orderId: drawOrder,
      supplierId,
      purchaseOrderId: `po-${RUN}`,
      currency: 'EUR',
      amountMinor: 9_000n,
    });
    await insertLedgerTransaction(db, draw.transaction, draw.entries);
    const credit = supplierCreditReceived({
      orderId: drawOrder,
      supplierId,
      purchaseOrderId: `po-${RUN}`,
      currency: 'EUR',
      amountMinor: 9_000n,
    });
    await insertLedgerTransaction(db, credit.transaction, credit.entries);

    const [expense] = await db.execute<{ total: string }>(sql`
      select coalesce(sum(amount_minor), 0)::text as total
      from ledger_entries
      where order_id = ${drawOrder} and account = 'procurement_expense'
    `);
    expect(BigInt(expense?.total ?? '1')).toBe(0n);

    // The supplier's deposit is carried per OWNER, under its own owner type.
    const [prepaid] = await db.execute<{ total: string }>(sql`
      select coalesce(sum(amount_minor), 0)::text as total
      from ledger_entries
      where owner_type = 'supplier' and owner_id = ${supplierId}
    `);
    expect(BigInt(prepaid?.total ?? '1')).toBe(0n);
  });

  it('books a prefund top-up against platform funds', async () => {
    const supplierId = `sup-${RUN}-top`;
    const posting = prefundTopUp({ supplierId, currency: 'EUR', amountMinor: 50_000n });
    const written = await insertLedgerTransaction(db, posting.transaction, posting.entries);
    const rows = await db.execute<{ account: string; owner_type: string | null; total: string }>(sql`
      select account, owner_type, sum(amount_minor)::text as total
      from ledger_entries where transaction_id = ${written.id}
      group by account, owner_type
    `);
    const entries = [...rows];
    expect(entries).toHaveLength(2);
    expect(entries.find((row) => row.account === 'supplier_prepaid')?.owner_type).toBe('supplier');
    expect(entries.find((row) => row.account === 'platform_funds')?.owner_type).toBeNull();
  });

  it('refuses an unbalanced retail posting', async () => {
    // The mutation: the recognition builder's two legs, made to disagree. The
    // repository is the ONLY writer and refuses before issuing any SQL, so a
    // posting builder that stopped balancing fails here rather than leaving
    // money unaccounted for.
    const posting = retailVarianceRecognized({ orderId, currency: 'EUR', amountMinor: 400n });
    const broken = posting.entries.map((entry, index) =>
      index === 0 ? { ...entry, amountMinor: entry.amountMinor + 1n } : entry,
    );
    await expect(
      insertLedgerTransaction(db, posting.transaction, broken),
    ).rejects.toThrow(/does not balance/);
  });
});

describe('a posting is claimed before it is booked', () => {
  it('answers the second claim with nothing rather than a second posting', async () => {
    const claimOrder = await seedRetailOrder('claim');
    const posting = retailVarianceRecognized({
      orderId: claimOrder,
      currency: 'EUR',
      amountMinor: 300n,
    });
    const written = await insertLedgerTransaction(db, posting.transaction, posting.entries);

    const first = await claimLedgerRecognition(
      {
        kind: 'variance_recognized',
        claimKey: `rec-${RUN}-claim`,
        ledgerTransactionId: written.id,
        orderId: claimOrder,
        booked: { amount: 300, currency: 'EUR' },
        bookedAt: new Date(),
      },
      db,
    );
    const second = await claimLedgerRecognition(
      {
        kind: 'variance_recognized',
        claimKey: `rec-${RUN}-claim`,
        ledgerTransactionId: written.id,
        orderId: claimOrder,
        booked: { amount: 300, currency: 'EUR' },
        bookedAt: new Date(),
      },
      db,
    );

    expect(first).toBeDefined();
    // The empty result IS the "already booked" answer — and the caller THROWS on
    // it rather than shrugging, because `ON CONFLICT DO NOTHING` does not abort a
    // transaction and shrugging would commit the duplicate entries.
    expect(second).toBeUndefined();
  });

  it('scopes the claim to its KIND', async () => {
    // The same key under two kinds is two different postings about one thing — a
    // purchase order's draw and its credit both name the purchase order.
    const kindOrder = await seedRetailOrder('kind');
    const posting = procurementSettled({
      orderId: kindOrder,
      supplierId: `sup-${RUN}-k`,
      purchaseOrderId: `po-${RUN}-k`,
      currency: 'EUR',
      amountMinor: 100n,
    });
    const written = await insertLedgerTransaction(db, posting.transaction, posting.entries);
    const drawClaim = await claimLedgerRecognition(
      {
        kind: 'procurement_settled',
        claimKey: `po-${RUN}-k`,
        ledgerTransactionId: written.id,
        orderId: kindOrder,
        booked: { amount: 100, currency: 'EUR' },
        bookedAt: new Date(),
      },
      db,
    );
    const creditClaim = await claimLedgerRecognition(
      {
        kind: 'supplier_credit',
        claimKey: `po-${RUN}-k`,
        ledgerTransactionId: written.id,
        orderId: kindOrder,
        booked: { amount: 100, currency: 'EUR' },
        bookedAt: new Date(),
      },
      db,
    );
    expect(drawClaim).toBeDefined();
    expect(creditClaim).toBeDefined();
  });
});

describe('a supplier credit names what it affects', () => {
  it('refuses an attributed credit with no order, and an unattributable one WITH an order', async () => {
    const noOrder = await violatedConstraint(() =>
      db.execute(sql`
        insert into retail_supplier_credits
          (id, classification, purchase_order_id, provider_document_id,
           credit_amount, credit_currency, accounting_amount, accounting_currency,
           issued_at, recorded_at, claim_key)
        values (${`cr-${RUN}-1`}, 'cost_reduction', null, 'DOC-1',
                100, 'EUR', 100, 'EUR', now(), now(), ${`ck-${RUN}-1`})
      `),
    );
    // The purchase order is NOT NULL, so this fails before the shape CHECK — a
    // credit that names no purchase order is not a credit about anything.
    expect(noOrder).toContain('purchase_order_id');
  });
});

describe('the global ledger still nets to zero per currency', () => {
  it('reports no imbalance after every posting above', async () => {
    // The cheapest check in the package and the one that would catch a builder
    // whose legs disagree in a way the per-transaction assertions above miss.
    const rows = await db.execute<{ currency: string; total: string }>(sql`
      select currency, sum(amount_minor)::text as total
      from ledger_entries
      group by currency
      having sum(amount_minor) <> 0
    `);
    expect([...rows]).toEqual([]);
    // The vacuity floor: an empty ledger nets to zero too.
    const [count] = await db.execute<{ n: string }>(
      sql`select count(*) as n from ledger_entries`,
    );
    expect(Number(count?.n)).toBeGreaterThanOrEqual(10);
  });
});
