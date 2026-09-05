/**
 * Paying the sellers — one transfer per seller order, once the charge is funded.
 *
 * ADR 0001 D3 step 2 and D6. The money is on Mercaria's balance at the rail; this
 * moves each order's net onto that seller's own account, records the movement in
 * the `transfers` table and books the ledger leg that settles their receivable.
 *
 * It runs from the `payment_succeeded` outbox handler, AFTER the orders have
 * been marked paid, so a settlement failure can never leave a buyer with an
 * unfulfillable order: the sale is complete from the buyer's side either way,
 * and what is at stake here is only whether the seller has been paid yet.
 *
 * ## Sibling isolation is the property this file exists to guarantee
 *
 * ADR 0001 D4: funding is atomic at the GROUP level and divergence begins
 * afterwards. So one seller's transfer failing must not touch another's — which
 * means the loop below catches per order rather than per payment, and a failure
 * that a retry cannot fix (an account that lost readiness, a rail that refused
 * the movement outright) is RECORDED and stepped over instead of thrown.
 *
 * The two error classes are treated differently on purpose:
 *
 *  - **Retryable** (the rail is down, a network blip) — rethrown, so the outbox
 *    row retries the whole settlement with backoff. Every step is idempotent, so
 *    the orders already settled are skipped on the next attempt.
 *  - **Permanent** (`payouts_enabled` went false, the rail rejected the
 *    transfer) — recorded as a `transfer_withheld` exception and skipped. No
 *    number of attempts turns it into a payment, and retrying it forever would
 *    dead-letter the whole group's row over one seller, taking their siblings'
 *    settlement with it.
 *
 * ## Why the transfer row is written BEFORE the rail is called
 *
 * `UNIQUE(payment_id, order_id)` is the durable statement that this order gets
 * one transfer and no more. Writing it first means two tasks racing the same
 * outbox row converge on one row, and the rail's own idempotency key
 * (`tr:<paymentId>:<orderId>`) means they converge on one movement — belt and
 * braces, because two transfers for one order is money leaving twice and the
 * only unrecoverable mistake in this file.
 *
 * The provider object id is then claimed with a compare-and-swap
 * (`provider_object_id IS NULL`), and the ledger posting is written in the SAME
 * transaction as that claim. So the posting happens exactly once even if two
 * tasks both got an answer from the rail — the loser's claim matches no row and
 * its posting never runs.
 */

import type { Money, ProviderAccountOwnerType } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  claimTransferProviderObject,
  createOrGetTransfer,
  findPaymentById,
  markTransferHeld,
  type PaymentRow,
} from '../../db/payments/paymentRepository.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { transferCreated } from './ledger-postings.js';
import { deriveSellerNetShares } from './seller-net-shares.js';
import { findOrdersInCheckoutGroup, type LinkedOrder } from './order-linkage.js';
import { findSellerAccount, sellerKeyFor } from './provider-account.service.js';
import { enqueuePaymentEvent, transferWithheldEventId } from './payment-outbox.service.js';
import { settlementBasis } from './payment.service.js';
import {
  isRetryableProviderError,
  isSettlingProvider,
  type SettlingPaymentProvider,
} from './provider.js';
import { resolvePaymentProvider } from './registry.js';
import { redactProviderMessage } from './redact.js';
import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import { highValueHoldFor } from './high-value-hold.js';

/** What one settlement run did, for the caller's log line and its tests. */
export interface SettlementOutcome {
  /** Transfers created by THIS run. A repeat of a settled payment reports zero. */
  created: number;
  /** Orders already settled by an earlier run. */
  alreadySettled: number;
  /** Orders whose transfer could not be made and was recorded as an exception. */
  withheld: number;
}

/**
 * Settle every seller order a funded payment covers.
 *
 * Idempotent, because the outbox is at-least-once: a task dying between the
 * rail's answer and the row's claim means the next task asks the rail again with
 * the same key and gets the same transfer back.
 *
 * @throws When the rail fails in a way a retry could fix. The outbox row is
 *   released with backoff and the settlement resumes where it stopped.
 */
export async function settlePaymentTransfers(paymentId: string): Promise<SettlementOutcome> {
  const db = getDb();
  const payment = await findPaymentById(db, paymentId);
  if (!payment) {
    throw new Error(`Payment ${paymentId} does not exist.`);
  }

  const provider = resolvePaymentProvider(payment.provider);
  if (!provider || !isSettlingProvider(provider)) {
    // Ordinary, not an error. The synthetic rail holds no seller accounts and
    // moves no money, and `external`/`manual_pos` payments were settled
    // somewhere else entirely — an invented transfer row for any of them would
    // be a record of a movement that never happened.
    return { created: 0, alreadySettled: 0, withheld: 0 };
  }

  const sourcePaymentObjectId = payment.providerObjectId;
  if (!sourcePaymentObjectId) {
    throw new Error(
      `Payment ${paymentId} succeeded on ${payment.provider} but carries no provider object id; ` +
        'a transfer cannot name the funds it draws from.',
    );
  }

  const orders = await findOrdersInCheckoutGroup(payment.checkoutGroupId);
  if (orders.length === 0) {
    log.general.error(
      { paymentId, checkoutGroupId: payment.checkoutGroupId },
      '[Payments] settlement found no orders for a funded checkout group',
    );
    return { created: 0, alreadySettled: 0, withheld: 0 };
  }

  // The SAME net the ledger credited when the charge succeeded — gross split
  // minus each order's marketplace-fee snapshot. See `seller-net-shares.ts`
  // for why one definition rather than three.
  const settled = settlementBasis(payment);
  const allocation = deriveSellerNetShares({
    settled,
    presentmentGrossMinor: BigInt(payment.presentmentAmount),
    orders,
  });

  const outcome: SettlementOutcome = { created: 0, alreadySettled: 0, withheld: 0 };
  for (const share of allocation.shares) {
    const order = orders.find((candidate) => candidate.id === share.orderId);
    if (!order) continue;

    const amount: Money = { amount: Number(share.netMinor), currency: allocation.currency };
    const result = await settleOneOrder({ payment, order, amount, sourcePaymentObjectId, provider });
    outcome[result] += 1;
  }

  log.general.info(
    { paymentId, checkoutGroupId: payment.checkoutGroupId, ...outcome },
    '[Payments] settlement complete',
  );
  return outcome;
}

/**
 * The seller's owner vocabulary, from the order's seller type.
 *
 * Typed `ProviderAccountOwnerType` rather than `LedgerOwnerType`, and the
 * narrowing is load-bearing rather than tidy. #128 widened the LEDGER's owner
 * vocabulary with `supplier` for `supplier_prepaid`, and this value is used for
 * two different things: crediting a payable, and looking a CONNECTED ACCOUNT
 * up. A supplier has no connected account and must never have one (ADR 0004
 * D6.8), so the type that reaches `findSellerAccount` has to be the narrower of
 * the two. It is still assignable to `LedgerOwnerType`, so the payable posting
 * is unchanged — which is exactly the direction the widening should flow.
 */
function ownerTypeOf(order: LinkedOrder): ProviderAccountOwnerType {
  return order.sellerType === 'store' ? 'store' : 'user';
}

/**
 * Settle ONE seller order. Never throws for a permanent failure — see the file
 * docblock on sibling isolation.
 */
async function settleOneOrder(input: {
  payment: PaymentRow;
  order: LinkedOrder;
  amount: Money;
  sourcePaymentObjectId: string;
  provider: SettlingPaymentProvider;
}): Promise<keyof SettlementOutcome> {
  const { payment, order, amount, sourcePaymentObjectId } = input;
  const db = getDb();

  const { row, created } = await createOrGetTransfer(db, {
    paymentId: payment.id,
    orderId: order.id,
    provider: payment.provider,
    amount,
  });
  if (row.providerObjectId) return 'alreadySettled';

  const sellerKey = sellerKeyFor({ ownerType: ownerTypeOf(order), ownerId: order.sellerOwnerId });
  const account = await findSellerAccount({
    ownerType: ownerTypeOf(order),
    ownerId: order.sellerOwnerId,
  });

  // ADR 0001 D4's controlled analog of a skipped transfer: eligibility was
  // checked before the buyer paid, and it can be lost in between. The buyer's
  // order stays paid — the goods are theirs — and the seller's money waits for a
  // person to decide between a recovered account and a refund (#50).
  if (!account || account.onboardingState !== 'ready') {
    await recordWithheld({
      payment,
      order,
      amount,
      reason: account
        ? `the seller's payment account is '${account.onboardingState}', not 'ready'`
        : 'the seller has no payment account on this rail',
    });
    return 'withheld';
  }

  // A HIGH-VALUE share waits before it leaves (see `high-value-hold.ts`).
  //
  // After the readiness gate rather than before it, because "this seller cannot
  // be paid at all" and "this seller is not paid YET" are different facts and
  // an operator reading the exception needs the first one when both are true.
  //
  // ## Decided ONCE, when the transfer row is born; never re-decided
  //
  // `created` gates the policy call, and `transfers.held_until` is the durable
  // answer from then on. Re-evaluating the policy on every re-entry would be
  // the same computation with a moving `now`, and it would make a review's
  // decision impossible to act on: an operator clearing the hold would have it
  // silently re-imposed by the very settlement they ran to release it.
  //
  // Anchored on the transfer row's own `created_at` — the instant this seller's
  // share became settleable. The payment's `updatedAt` would restart the window
  // on every unrelated write, which is a hold that never expires.
  const heldUntil = created
    ? holdReleasableAt({ amount, settleableSince: row.createdAt })
    : row.heldUntil;
  if (heldUntil && heldUntil.getTime() > Date.now()) {
    // The column BEFORE the exception, because the column is what the release
    // sweep reads and the exception is what a person reads. A crash between
    // them leaves a transfer that releases itself on schedule with no case
    // open; the reverse order would leave a case nothing ever closes.
    //
    // On a re-entry both writes are no-ops — `markTransferHeld` rewrites the
    // same instant and the outbox row already exists — which is what makes an
    // outbox retry of a held settlement cost nothing.
    await markTransferHeld(db, { transferId: row.id, heldUntil });
    await recordWithheld({
      payment,
      order,
      amount,
      reason:
        'a high-value transfer waits for review; it becomes releasable at ' +
        heldUntil.toISOString(),
    });
    return 'withheld';
  }

  let providerObjectId: string;
  try {
    const result = await input.provider.createTransfer({
      paymentId: payment.id,
      orderId: order.id,
      sourcePaymentObjectId,
      destinationAccountId: account.providerAccountId,
      amount,
      groupRef: payment.checkoutGroupId,
      // ADR 0001 D11. Derived from two durable Mercaria ids, so a retry of this
      // exact settlement converges on the transfer it already made.
      idempotencyKey: `tr:${payment.id}:${order.id}`,
      // The same rule as a payment's metadata: server-issued ids only. Never a
      // seller name, never a buyer, never an amount breakdown — a rail's
      // metadata is readable by everyone with dashboard access.
      metadata: { orderId: order.id, paymentId: payment.id },
    });
    providerObjectId = result.providerObjectId;
  } catch (error: unknown) {
    if (isRetryableProviderError(error)) throw error;
    await recordWithheld({
      payment,
      order,
      amount,
      reason: `the rail refused the transfer: ${redactProviderMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    });
    return 'withheld';
  }

  // The claim and the posting, together: whoever wins the compare-and-swap books
  // the ledger entry, and a second task's posting never runs.
  await db.transaction(async (tx) => {
    const claimed = await claimTransferProviderObject(tx, {
      transferId: row.id,
      providerObjectId,
      status: 'paid',
    });
    if (!claimed) return;

    const posting = transferCreated({
      paymentId: payment.id,
      transferId: claimed.id,
      orderId: order.id,
      ownerType: ownerTypeOf(order),
      ownerId: order.sellerOwnerId,
      currency: amount.currency,
      amountMinor: BigInt(amount.amount),
    });
    await insertLedgerTransaction(tx, posting.transaction, posting.entries);
  });

  log.general.info(
    { paymentId: payment.id, orderId: order.id, sellerKey, amount: amount.amount },
    '[Payments] seller order settled',
  );
  return 'created';
}

/**
 * When this share becomes releasable, or `undefined` when it is not held.
 *
 * The single place the hold POLICY is consulted. Everything downstream reads
 * `transfers.held_until` instead, which is why a threshold or window changed
 * later never moves a hold already in force.
 */
function holdReleasableAt(input: { amount: Money; settleableSince: Date }): Date | undefined {
  const decision = highValueHoldFor({
    amount: input.amount,
    settleableSince: input.settleableSince,
    now: new Date(),
    thresholds: config.payments.stripe.highValueHoldThresholds,
    windowMs: config.payments.stripe.highValueHoldWindowMs,
  });
  return decision.outcome === 'hold' ? decision.releasableAt : undefined;
}

/**
 * Record that one seller's share could not leave.
 *
 * A durable outbox row rather than a log line, for the same reason
 * `flagSucceededAfterRelease` is one: money is sitting on Mercaria's balance
 * against a debt it has not paid, and that must not be discoverable only by
 * whoever happens to be reading the logs. The transfer row stays `pending`,
 * which is the truth — Mercaria still intends to make it.
 *
 * Keyed on the payment AND the order, so one exception per withheld seller and
 * no more: a settlement retried by the outbox must not open the same case again
 * on every attempt.
 */
async function recordWithheld(input: {
  payment: PaymentRow;
  order: LinkedOrder;
  amount: Money;
  reason: string;
}): Promise<void> {
  const db = getDb();
  const id = transferWithheldEventId(input.payment.id, input.order.id);
  await db.transaction(async (tx) => {
    await enqueuePaymentEvent(tx, {
      id,
      eventType: 'transfer_withheld',
      payload: {
        paymentId: input.payment.id,
        checkoutGroupId: input.payment.checkoutGroupId,
        orderId: input.order.id,
        sellerKey: sellerKeyFor({
          ownerType: ownerTypeOf(input.order),
          ownerId: input.order.sellerOwnerId,
        }),
        amountMinor: input.amount.amount,
        currency: input.amount.currency,
        reason: input.reason,
      },
    });
  });
}
