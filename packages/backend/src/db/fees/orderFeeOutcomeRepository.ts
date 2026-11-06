/**
 * `order_fee_outcomes` — the marketplace fee decided by the method USED, at the
 * payment's outcome (ADR 0021).
 *
 * Written ONLY from `applyPaymentStatus`, in the transaction that moves a
 * checkout payment to `succeeded`, one row per order of its group: the card
 * keeps the pricing-time snapshot's marketplace-card fee, FairCoin takes none.
 * Append-only (the trigger refuses UPDATE and DELETE); a redelivered success
 * finds the rows already there and writes nothing.
 */

import { inArray } from 'drizzle-orm';
import type { OrderFeeOutcomeMethod } from '@mercaria/shared-types';
import { orderFeeOutcomes } from '../schema/feeOutcomes.js';
import { orderFeeSnapshots } from '../schema/fees.js';
import type { DatabaseOrTransaction } from '../postgres.js';

export interface FeeOutcomeOrder {
  readonly id: string;
  /** The order's presentment currency — the fee's when it has no snapshot fee. */
  readonly presentmentCurrency: string;
}

/** Record how each order of a paid group was paid, and the fee that follows. */
export async function recordOrderFeeOutcomes(
  tx: DatabaseOrTransaction,
  input: {
    readonly paymentId: string;
    readonly method: OrderFeeOutcomeMethod;
    readonly orders: readonly FeeOutcomeOrder[];
  },
): Promise<void> {
  if (input.orders.length === 0) return;
  const snapshots = await tx
    .select({
      orderId: orderFeeSnapshots.orderId,
      feeAmount: orderFeeSnapshots.feeAmount,
      feeCurrency: orderFeeSnapshots.feeCurrency,
    })
    .from(orderFeeSnapshots)
    .where(
      inArray(
        orderFeeSnapshots.orderId,
        input.orders.map((order) => order.id),
      ),
    );
  await tx
    .insert(orderFeeOutcomes)
    .values(
      input.orders.map((order) => {
        const snapshot = snapshots.find((row) => row.orderId === order.id);
        const card = input.method === 'card';
        return {
          orderId: order.id,
          paymentId: input.paymentId,
          method: input.method,
          // The card keeps the terms the seller accepted at pricing; FairCoin
          // takes nothing — the seller holds its whole share in its own wallet.
          feeAmount: card ? (snapshot?.feeAmount ?? 0) : 0,
          feeCurrency: (card ? snapshot?.feeCurrency : undefined) ?? order.presentmentCurrency,
        };
      }),
    )
    .onConflictDoNothing({ target: orderFeeOutcomes.orderId });
}
