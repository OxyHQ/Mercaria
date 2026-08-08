/**
 * The rail's own money movements against Mercaria's rows — issue #50, jobs 2 and 3.
 *
 * The other direction from `open-payments.job.ts`. That one walks Mercaria's
 * rows and asks the rail about each; this one walks the RAIL's movements and
 * asks whether Mercaria has a row for each — which is the only way to find money
 * that moved for something Mercaria never recorded at all.
 *
 * ## One list, not five, and the choice is forced by the currency
 *
 * Stripe exposes `charges.list`, `refunds.list`, `transfers.list` and
 * `payouts.list` separately, and sweeping all of them would be four cursors,
 * four windows and four ways to be half finished. Every one of those objects
 * also produces a BALANCE TRANSACTION, so one paginated list covers all of them
 * — and, more importantly, the balance transaction is the only place Stripe
 * states a movement in the PLATFORM's settlement currency (ADR 0001 D8, fact 5).
 *
 * That is not a convenience. Mercaria's transfers are denominated in the
 * platform currency and its refund ledger legs are booked in it, so a comparison
 * against a charge object's presentment `amount` would be comparing two
 * different quantities and reporting the difference as a discrepancy on every
 * single cross-currency charge.
 *
 * ## What is compared, per type, and the one that is deliberately not
 *
 * | Balance transaction | Local row | Compared |
 * |---|---|---|
 * | `charge` | the payment its PaymentIntent names | existence, and `platform_amount` |
 * | `refund` | the refund its id names | existence, and the `refunds` ledger account |
 * | `transfer` | `transfers.provider_object_id` | existence, and the amount |
 * | `payout`, `payout_failure` | `payouts.provider_object_id` | existence only |
 * | `transfer_reversal` | — | nothing, deliberately |
 *
 * A reversal has no Mercaria row of its own: it is a COLUMN on the refund or the
 * dispute that caused it (`provider_reversal_id`) and a `reversed_amount` on the
 * transfer. Checking existence would need a lookup across two tables by an id
 * neither indexes, and the quantity that actually matters — how much of a
 * transfer has been reversed — is already covered by the `transfer` row's own
 * comparison. So this sweep skips them and says so, rather than implementing a
 * check that would be slower and weaker than the one next to it.
 *
 * ## Nothing here converges anything
 *
 * Unlike the open-payments sweep, every finding in this file is recorded and
 * left. There is no equivalent of "read the live object and apply it": a Stripe
 * transfer with no Mercaria row cannot be turned into one, because Mercaria
 * would have to invent which order it settled — and inventing that is how an
 * innocent seller's payable gets closed against somebody else's money.
 */

import type Stripe from 'stripe';
import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import {
  findPaymentByProviderObjectId,
  findPayoutByProviderObjectId,
  findTransferByProviderObjectId,
} from '../../../db/payments/paymentRepository.js';
import { findRefundByProviderRefundId } from '../../../db/orders/refundRepository.js';
import { sumLedgerAccountForRefund } from '../../../db/payments/ledgerRepository.js';
import { listStripeBalanceTransactions } from '../stripe/client.js';
import { reportDiscrepancy } from './discrepancy.service.js';

/** What one page of this job did. */
export interface ProviderObjectsPageResult {
  /** Balance transactions read from the rail. Zero means the pass is complete. */
  scanned: number;
  /** Findings recorded. */
  discrepancies: number;
  /** The rail's own cursor for the next page, or `null` when the pass is complete. */
  nextCursor: string | null;
}

/**
 * Reconcile one bounded page of the rail's balance transactions.
 *
 * @param windowStartAt The oldest movement this pass covers. Set from the
 *   cursor row, so a completed pass narrows the window rather than re-reading a
 *   fixed lookback for ever.
 */
export async function reconcileProviderObjectsPage(input: {
  cursor: string | null;
  windowStartAt: Date;
  limit: number;
}): Promise<ProviderObjectsPageResult> {
  const page = await listStripeBalanceTransactions({
    createdGte: input.windowStartAt,
    limit: input.limit,
    ...(input.cursor ? { startingAfter: input.cursor } : {}),
  });

  const result: ProviderObjectsPageResult = {
    scanned: page.data.length,
    discrepancies: 0,
    nextCursor: null,
  };

  for (const transaction of page.data) {
    result.discrepancies += await reconcileBalanceTransaction(transaction);
  }

  // Stripe's own `has_more` is what ends the pass. Reading it rather than
  // comparing lengths is what makes an exactly-full final page terminate.
  result.nextCursor = page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null;
  return result;
}

/**
 * Check ONE balance transaction against Mercaria's rows.
 *
 * @returns How many findings it produced.
 */
async function reconcileBalanceTransaction(
  transaction: Stripe.BalanceTransaction,
): Promise<number> {
  // The platform currency the movement landed in, upper-cased to Mercaria's own
  // spelling. Stripe reports currencies lower-case everywhere.
  const currency = transaction.currency.toUpperCase();
  // Stripe SIGNS a balance transaction by direction — a refund and a transfer
  // are negative because they leave the platform balance. Mercaria stores every
  // amount as a magnitude, so the comparison is against the absolute value and
  // the direction is carried by the TYPE.
  const amountMinor = Math.abs(transaction.amount);
  const source = sourceOf(transaction);

  switch (transaction.type) {
    case 'charge':
      return await reconcileCharge({ transaction, source, currency, amountMinor });
    case 'refund':
      return await reconcileRefund({ transaction, source, currency, amountMinor });
    case 'transfer':
      return await reconcileTransfer({ transaction, source, currency, amountMinor });
    case 'payout':
    case 'payout_failure':
      return await reconcilePayout({ transaction, source, currency, amountMinor });
    default:
      // Everything else — `stripe_fee`, `adjustment` (a dispute's own movement,
      // which #49's dispute path already books from the dispute object), a
      // `transfer_reversal` (see the file docblock) — is deliberately not
      // checked here. A sweep that reported every movement it does not model
      // would be a queue of its own gaps.
      return 0;
  }
}

/** The expanded source object, when Stripe returned one. */
function sourceOf(transaction: Stripe.BalanceTransaction): Record<string, unknown> | undefined {
  const source: unknown = transaction.source;
  return typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>)
    : undefined;
}

/** The id of the expanded source, whichever form Stripe returned it in. */
function sourceIdOf(transaction: Stripe.BalanceTransaction): string | undefined {
  const source: unknown = transaction.source;
  if (typeof source === 'string') return source;
  if (typeof source === 'object' && source !== null && 'id' in source) {
    const id: unknown = (source as { id: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** What every per-type check is handed. */
interface MovementContext {
  transaction: Stripe.BalanceTransaction;
  source: Record<string, unknown> | undefined;
  currency: string;
  amountMinor: number;
}

/**
 * A charge against the payment its PaymentIntent names.
 *
 * The PaymentIntent is what Mercaria stores (`payments.provider_object_id`), not
 * the charge — ADR 0001 D4 makes the intent the group-level object — which is
 * exactly why the list is expanded: without `data.source` this would need a
 * second retrieve per charge to reach `payment_intent`.
 */
async function reconcileCharge(context: MovementContext): Promise<number> {
  const chargeId = sourceIdOf(context.transaction);
  const intentId = readString(context.source, 'payment_intent');
  if (intentId === undefined) {
    // A platform charge that funds no PaymentIntent. Under ADR 0001 D3/D4 every
    // Mercaria charge has one, so this is a charge created outside Mercaria —
    // recorded, because money on the platform balance that Mercaria cannot
    // attribute is the definition of this finding.
    await reportDiscrepancy({
      kind: 'payment_missing_locally',
      provider: 'stripe',
      correlationKey: chargeId ?? context.transaction.id,
      ...(chargeId ? { providerObjectId: chargeId } : {}),
      detail: {
        reason: 'the charge names no PaymentIntent',
        balanceTransactionId: context.transaction.id,
        amountMinor: context.amountMinor,
        currency: context.currency,
      },
    });
    return 1;
  }

  const payment = await findPaymentByProviderObjectId(getDb(), 'stripe', intentId);
  if (!payment) {
    await reportDiscrepancy({
      kind: 'payment_missing_locally',
      provider: 'stripe',
      correlationKey: intentId,
      providerObjectId: intentId,
      detail: {
        reason: 'no Mercaria payment names this PaymentIntent',
        balanceTransactionId: context.transaction.id,
        amountMinor: context.amountMinor,
        currency: context.currency,
      },
    });
    return 1;
  }

  // The PLATFORM side. Absent means the payment has not been booked as
  // succeeded yet, which the open-payments sweep owns — reporting it here too
  // would open a second row for one condition, in a kind whose meaning is
  // "these two numbers disagree" rather than "one of them is missing".
  if (payment.platformAmount === null || payment.platformCurrency === null) return 0;
  if (
    payment.platformAmount === context.amountMinor &&
    payment.platformCurrency === context.currency
  ) {
    return 0;
  }

  await reportDiscrepancy({
    kind: 'payment_amount_mismatch',
    provider: 'stripe',
    // A DIFFERENT correlation key from the presentment-side check in
    // `open-payments.job.ts`, so the two sides of one payment are two rows. They
    // have different causes — a re-priced intent versus a conversion booked at
    // the wrong rate — and merging them would hide whichever was found second.
    correlationKey: `${payment.id}:platform`,
    paymentId: payment.id,
    checkoutGroupId: payment.checkoutGroupId,
    providerObjectId: intentId,
    detail: {
      side: 'platform',
      localAmountMinor: payment.platformAmount,
      localCurrency: payment.platformCurrency,
      providerAmountMinor: context.amountMinor,
      providerCurrency: context.currency,
      balanceTransactionId: context.transaction.id,
    },
  });
  return 1;
}

/**
 * A refund against Mercaria's refund record and what the ledger booked for it.
 *
 * Two checks, and the second is the reason this job exists at all: a refund's
 * platform figure never reaches a Mercaria COLUMN — it goes straight into the
 * `refunds` ledger account (`refund-execution.service.ts`) — so the only way to
 * compare it against what the rail says the platform balance lost is to read the
 * book back. That is issue #50's jobs 3, "provider balance-transaction amounts
 * against immutable Mercaria ledger amounts", literally.
 */
async function reconcileRefund(context: MovementContext): Promise<number> {
  const refundId = sourceIdOf(context.transaction);
  if (refundId === undefined) return 0;

  const refund = await findRefundByProviderRefundId('stripe', refundId);
  if (!refund) {
    // #49 raises `refund_unmatched` from the EVENT path for this same condition.
    // Both exist because they see different things: that one can only ever fire
    // for a refund whose event was delivered, and this one finds a refund
    // nothing told Mercaria about at all.
    await reportDiscrepancy({
      kind: 'refund_missing_locally',
      provider: 'stripe',
      correlationKey: refundId,
      providerObjectId: refundId,
      detail: {
        reason: 'no Mercaria refund names this provider refund',
        balanceTransactionId: context.transaction.id,
        amountMinor: context.amountMinor,
        currency: context.currency,
      },
    });
    return 1;
  }

  const booked = await sumLedgerAccountForRefund(getDb(), {
    refundId: refund.id,
    account: 'refunds',
  });
  // Nothing booked yet: the refund committed and its money has not moved, which
  // is an ordinary state (#49 — a refund is `refunded` while its money is
  // `pending`) and belongs to the outbox rather than here.
  if (booked.length === 0) return 0;

  const inCurrency = booked.find((entry) => entry.currency === context.currency);
  // `refunds` is a debit account, so its entries are POSITIVE for money returned
  // to a buyer — the magnitude is what compares against the rail's own.
  const bookedMinor = inCurrency ? inCurrency.totalMinor : 0n;
  if (bookedMinor === BigInt(context.amountMinor)) return 0;

  await reportDiscrepancy({
    kind: 'refund_amount_mismatch',
    provider: 'stripe',
    correlationKey: refund.id,
    ...(refund.paymentId ? { paymentId: refund.paymentId } : {}),
    orderId: refund.orderId,
    providerObjectId: refundId,
    detail: {
      bookedMinor: bookedMinor.toString(),
      bookedCurrency: context.currency,
      providerAmountMinor: context.amountMinor,
      providerCurrency: context.currency,
      balanceTransactionId: context.transaction.id,
    },
  });
  return 1;
}

/** A transfer against the `transfers` row that should name it. */
async function reconcileTransfer(context: MovementContext): Promise<number> {
  const transferId = sourceIdOf(context.transaction);
  if (transferId === undefined) return 0;

  const row = await findTransferByProviderObjectId(getDb(), 'stripe', transferId);
  if (!row) {
    // Money has left the platform balance for a connected account and Mercaria
    // has no record of intending it. Not repairable here: turning this into a
    // `transfers` row would mean inventing which order it settled, and that is
    // how an innocent seller's payable gets closed against somebody else's money.
    await reportDiscrepancy({
      kind: 'transfer_missing_locally',
      provider: 'stripe',
      correlationKey: transferId,
      providerObjectId: transferId,
      detail: {
        reason: 'no Mercaria transfer names this provider transfer',
        balanceTransactionId: context.transaction.id,
        amountMinor: context.amountMinor,
        currency: context.currency,
        destination: readString(context.source, 'destination'),
      },
    });
    return 1;
  }

  if (row.amountAmount === context.amountMinor && row.amountCurrency === context.currency) {
    return 0;
  }
  await reportDiscrepancy({
    kind: 'transfer_amount_mismatch',
    provider: 'stripe',
    correlationKey: transferId,
    paymentId: row.paymentId,
    orderId: row.orderId,
    providerObjectId: transferId,
    detail: {
      localAmountMinor: row.amountAmount,
      localCurrency: row.amountCurrency,
      providerAmountMinor: context.amountMinor,
      providerCurrency: context.currency,
      balanceTransactionId: context.transaction.id,
    },
  });
  return 1;
}

/**
 * A payout against the `payouts` row that should name it.
 *
 * Existence only, and no amount comparison — which is the right depth for the
 * one object in this sweep Mercaria is not a party to. ADR 0001 D6 is explicit
 * that a payout books NOTHING: the merchant receivable was settled when the
 * transfer was created, so a payout's amount is between the seller and Stripe
 * and there is no Mercaria figure it could disagree with. What Mercaria owes
 * here is an explanation, which needs the row to exist and nothing more.
 *
 * Hence `info` severity on this kind: a missing payout row costs a dashboard
 * line and no money at all.
 */
async function reconcilePayout(context: MovementContext): Promise<number> {
  const payoutId = sourceIdOf(context.transaction);
  if (payoutId === undefined) return 0;

  const row = await findPayoutByProviderObjectId(getDb(), 'stripe', payoutId);
  if (row) return 0;

  await reportDiscrepancy({
    kind: 'payout_missing_locally',
    provider: 'stripe',
    correlationKey: payoutId,
    providerObjectId: payoutId,
    detail: {
      reason: 'no Mercaria payout names this provider payout',
      balanceTransactionType: context.transaction.type,
      balanceTransactionId: context.transaction.id,
      amountMinor: context.amountMinor,
      currency: context.currency,
    },
  });
  return 1;
}

/**
 * One string field off an expanded provider object.
 *
 * The expansion is `unknown`-shaped by construction — it is whichever of six
 * Stripe types the movement was about — so every field read goes through a
 * narrowing rather than a cast. Stripe also returns these fields either expanded
 * or as a bare id string depending on the request, and the id is what Mercaria
 * wants in both cases.
 */
function readString(
  source: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value: unknown = source?.[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id: unknown = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/**
 * How far back a pass reaches when no completed one has narrowed the window.
 *
 * Read here rather than by the runner because it is a property of THIS job — the
 * open-payments sweep has no window at all (it walks local rows) and the ledger
 * audit's is its own — so a single shared constant would be three different
 * decisions wearing one name.
 */
export function providerObjectsWindowStart(cursorWindowStart: Date | null, now: Date): Date {
  return cursorWindowStart ?? new Date(now.getTime() - config.payments.reconciliation.lookbackMs);
}
