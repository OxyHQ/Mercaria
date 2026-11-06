import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { ORDER_FEE_OUTCOME_METHODS } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks } from './columns';
import { orders } from './orders';
import { payments } from './payments';

/**
 * How a paid order's marketplace fee was DECIDED — by the method the buyer paid
 * with, at the payment's outcome (ADR 0021). One row per order, written in the
 * transaction that moves its payment to `succeeded`, append-only like the
 * snapshot beside it (`mercaria_fee_record_append_only`):
 *
 *  - `card` — the snapshot's marketplace-card fee stands (`fee_amount` is it);
 *  - `faircoin` — no fee: the seller received its whole share in its own Peable
 *    wallet, and Mercaria holds and books nothing (`fee_amount` is a real 0).
 *
 * The snapshot stays the pricing-time record of the card terms the seller had
 * accepted; readers take the EFFECTIVE fee from here when a row exists
 * (`db/fees/orderFeeSnapshotRepository.ts`).
 */
export const orderFeeOutcomes = pgTable(
  'order_fee_outcomes',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    paymentId: text()
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    method: text({ enum: asEnumValues(ORDER_FEE_OUTCOME_METHODS) }).notNull(),
    /** Minor units of `fee_currency`; `0` for FairCoin, never NULL. */
    feeAmount: bigint({ mode: 'number' }).notNull(),
    feeCurrency: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('order_fee_outcomes_order_id_key').on(t.orderId),
    index('order_fee_outcomes_payment_id_idx').on(t.paymentId),
    checkOneOf('order_fee_outcomes_method_check', t.method, ORDER_FEE_OUTCOME_METHODS),
    ...currencyChecks('order_fee_outcomes', [t.feeCurrency]),
    check('order_fee_outcomes_fee_amount_check', sql`${t.feeAmount} >= 0`),
    check(
      'order_fee_outcomes_faircoin_no_fee_check',
      sql`${t.method} <> 'faircoin' or ${t.feeAmount} = 0`,
    ),
  ],
);
