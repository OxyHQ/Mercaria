/**
 * Open local payments against the rail's current state — issue #50, jobs 1 and 4.
 *
 * A webhook is how Mercaria normally learns a payment's outcome, and a webhook
 * that never arrives is SILENT BY CONSTRUCTION: nothing here knows about an
 * event it was never sent. So the only mechanism that can notice is one that
 * does not depend on having been told, and this is it — ADR 0001's sequence 6,
 * applied to payments rather than to accounts.
 *
 * ## It CONVERGES, and that is not a violation of "never auto-repair"
 *
 * Issue #50's jobs 8 forbids auto-deleting or rewriting financial history to
 * hide a mismatch, and acceptance 5 forbids marking a payment successful without
 * verified provider evidence. Neither is what happens here. A live
 * `paymentIntents.retrieve` IS verified provider evidence — the same fact a
 * webhook would have carried, read from the same account with the same key,
 * minus the delivery — and applying it APPENDS the accounting that should
 * already exist rather than removing any.
 *
 * The convergence goes through `applyPaymentStatus`, the ONE writer of a
 * payment's status. Not a similar sequence of steps: the same function, so the
 * compare-and-swap, the ledger postings, the outbox row and the settlement that
 * follows are the webhook path exactly. A parallel state writer here would be a
 * second state machine that drifts from the first at the first change to either.
 *
 * ## The reverse direction is NEVER automatic
 *
 * Mercaria saying paid while the rail says otherwise means orders have been
 * marked paid, inventory has been committed and sellers may already have been
 * transferred. Un-paying that would be a second wrong on top of the first, so it
 * is recorded as `payment_local_paid_provider_unpaid` and left for a person.
 *
 * This job's own query cannot reach that case — it reads only non-terminal
 * payments — but the branch is written out anyway, because the same function
 * serves the operator surface's `refetch`, which is pointed at whatever payment
 * an operator names.
 */

import type Stripe from 'stripe';
import type { PaymentStatus } from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import {
  findOpenPaymentsForReconciliation,
  type PaymentRow,
} from '../../../db/payments/paymentRepository.js';
import { applyPaymentStatus, canTransitionPaymentStatus } from '../payment.service.js';
import { retrieveStripePaymentIntent } from '../stripe/client.js';
import { readStripeSettlement } from '../stripe/settlement-read.js';
import { mapPaymentIntentStatus } from '../stripe/verify.js';
import { reportDiscrepancy, resolveDetectedDiscrepancy } from './discrepancy.service.js';
import { log } from '../../../lib/logger.js';

/** What one page of this job did. */
export interface OpenPaymentsPageResult {
  /** Payments read from the local store. Zero means the pass is complete. */
  scanned: number;
  /** Payments whose status this page moved, using the rail's own answer. */
  converged: number;
  /** Findings recorded, including the ones that then converged. */
  discrepancies: number;
  /** The id to resume from, or `null` when the pass is complete. */
  nextCursor: string | null;
}

/**
 * Reconcile one bounded page of open payments.
 *
 * Exported separately from the runner so a test can drive one page without a
 * timer, and so the pagination stays readable next to the cursor semantics it
 * implements.
 */
export async function reconcileOpenPaymentsPage(input: {
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<OpenPaymentsPageResult> {
  const now = input.now ?? new Date();
  const payments = await findOpenPaymentsForReconciliation(getDb(), {
    provider: 'stripe',
    createdBefore: new Date(now.getTime() - config.payments.reconciliation.openPaymentMinAgeMs),
    ...(input.cursor ? { afterId: input.cursor } : {}),
    limit: input.limit,
  });

  const result: OpenPaymentsPageResult = {
    scanned: payments.length,
    converged: 0,
    discrepancies: 0,
    nextCursor: null,
  };
  if (payments.length === 0) return result;

  for (const payment of payments) {
    const outcome = await reconcileOnePayment(payment);
    if (outcome.converged) result.converged += 1;
    result.discrepancies += outcome.findings;
  }

  // A SHORT page is the end of the pass. A full one means there may be more, so
  // the cursor advances to the last id read — and because ids are uuid v7 the
  // next page starts exactly where this one stopped, whatever has been inserted
  // in the meantime.
  result.nextCursor =
    payments.length < input.limit ? null : (payments[payments.length - 1]?.id ?? null);
  return result;
}

/** What reconciling one payment did. */
export interface OnePaymentOutcome {
  /** Whether the payment's status MOVED, using the rail's own current state. */
  converged: boolean;
  /** How many discrepancy rows this call opened or re-confirmed. */
  findings: number;
  /** The status the rail reports, when it reports one this version maps. */
  providerStatus?: PaymentStatus;
  /** One sentence for an operator. Safe to render — ids and statuses only. */
  note: string;
}

/**
 * Reconcile ONE payment against the rail.
 *
 * Also what the operator surface's `refetch` calls (issue #50, operator surface
 * 5), which is why it is a function rather than a loop body: an operator asking
 * "what does Stripe actually say about this" and a sweep asking the same question
 * must get the same answer through the same code, or the answer an incident is
 * resolved on is not the answer the system acts on.
 *
 * It never throws for a rail failure. A sweep must reach the rest of its page,
 * and an operator pressing `refetch` during a Stripe outage should be told the
 * rail could not be read rather than handed a 500.
 */
export async function reconcileOnePayment(payment: PaymentRow): Promise<OnePaymentOutcome> {
  if (!payment.providerObjectId) {
    // Mercaria opened a payment and never got an object back from the rail. The
    // buyer was never given anything to pay with, so no money can have moved —
    // which makes this a stalled checkout rather than a financial discrepancy,
    // and the reservation sweep is what cancels it.
    return {
      converged: false,
      findings: 0,
      note: 'the payment carries no provider object; nothing was ever created at the rail',
    };
  }

  let intent: Stripe.PaymentIntent;
  try {
    intent = await retrieveStripePaymentIntent(payment.providerObjectId);
  } catch (error: unknown) {
    // The rail refusing a read is not a finding about the payment. Recording one
    // would fill the queue with rows about Stripe's availability — already
    // visible everywhere else — and would make a real discrepancy harder to see
    // during exactly the incident where it matters most.
    log.general.warn(
      { err: error, paymentId: payment.id, providerObjectId: payment.providerObjectId },
      '[Reconciliation] could not read a PaymentIntent; leaving the payment as it is',
    );
    return { converged: false, findings: 0, note: 'the rail could not be read' };
  }

  // BEFORE the status comparison, and unconditionally: an amount that disagrees
  // is a finding whether or not the statuses do, and checking it inside the
  // "they disagree" branch would make a charge for the wrong amount invisible
  // precisely when both systems are otherwise happy about it.
  let findings = (await reportAmountMismatch(payment, intent)) ? 1 : 0;

  const providerStatus = mapPaymentIntentStatus(intent.status);
  if (providerStatus === undefined || providerStatus === payment.status) {
    return {
      converged: false,
      findings,
      ...(providerStatus ? { providerStatus } : {}),
      note:
        providerStatus === undefined
          ? `the rail reports '${intent.status}', which this version does not map to a payment status`
          : 'the rail and Mercaria agree',
    };
  }

  // BOTH say the money arrived, and only Mercaria's own refund lifecycle has
  // moved on. Not a discrepancy: a Stripe PaymentIntent stays `succeeded` after
  // a refund — the refund is a separate object — so a refunded payment read live
  // ALWAYS reports this pair.
  //
  // The paging sweep never reaches it (its query excludes terminal statuses),
  // but the operator surface's `refetch` is pointed at whatever payment somebody
  // names — so without this branch, re-fetching any refunded payment would open
  // a `critical` finding about a payment that is completely fine, which is the
  // fastest way to make an operator stop trusting the queue.
  if (isSettledStatus(payment.status) && isSettledStatus(providerStatus)) {
    return {
      converged: false,
      findings,
      providerStatus,
      note: `both report the charge as settled; Mercaria is '${payment.status}' because of its own refund lifecycle, which the rail's intent status does not express`,
    };
  }

  // Mercaria believes money arrived and the rail does not. Never automatic —
  // see the file docblock.
  if (isSettledStatus(payment.status) && !isSettledStatus(providerStatus)) {
    await reportDiscrepancy({
      kind: 'payment_local_paid_provider_unpaid',
      provider: 'stripe',
      correlationKey: payment.id,
      paymentId: payment.id,
      checkoutGroupId: payment.checkoutGroupId,
      providerObjectId: payment.providerObjectId,
      detail: { localStatus: payment.status, providerStatus, providerRawStatus: intent.status },
    });
    return {
      converged: false,
      findings: findings + 1,
      providerStatus,
      note: `Mercaria says '${payment.status}' and the rail says '${providerStatus}'; recorded for an operator`,
    };
  }

  // The rail is ahead. Record the finding FIRST, so the row exists even if the
  // convergence throws — an operator must be able to see a missed webhook that
  // Mercaria then failed to apply, which is the worse of the two cases and the
  // one a "converge, and record only on failure" ordering would lose entirely.
  const discrepancy = await reportDiscrepancy({
    kind: 'payment_provider_paid_local_unpaid',
    provider: 'stripe',
    correlationKey: payment.id,
    paymentId: payment.id,
    checkoutGroupId: payment.checkoutGroupId,
    providerObjectId: payment.providerObjectId,
    detail: { localStatus: payment.status, providerStatus, providerRawStatus: intent.status },
  });
  findings += 1;

  if (!canTransitionPaymentStatus(payment.status, providerStatus)) {
    // The one case that survives: the rail captured a payment whose reservation
    // had already timed out and whose orders were released. #48's event router
    // raises `payment_succeeded_after_release` for that, and the outbox row it
    // wrote is the operator's queue entry — so the discrepancy above is the
    // reconciliation half of one condition, and nothing more is done here.
    return {
      converged: false,
      findings,
      providerStatus,
      note: `the rail reports '${providerStatus}' but the payment is '${payment.status}', which cannot reach it`,
    };
  }

  let applied;
  try {
    const settlement =
      providerStatus === 'succeeded' ? await readStripeSettlement(intent) : undefined;
    applied = await applyPaymentStatus({
      paymentId: payment.id,
      next: providerStatus,
      providerObjectId: payment.providerObjectId,
      // Distinguishes this convergence from a webhook's in a `payment_failed`
      // outbox id, so a sweep re-deriving a failure the rail already reported
      // does not collide with the row that event wrote.
      providerEventId: `reconciliation:${payment.id}:${intent.status}`,
      ...(settlement ? { platform: settlement.platform, feeMinor: settlement.feeMinor } : {}),
    });
  } catch (error: unknown) {
    // The discrepancy row is already committed, which is the whole reason it was
    // written first. The next pass tries again; until then an operator can see
    // both that the rail is ahead and that Mercaria could not catch up.
    log.general.error(
      { err: error, paymentId: payment.id, discrepancyId: discrepancy.id, providerStatus },
      '[Reconciliation] could not converge a payment onto the state the rail reports',
    );
    return {
      converged: false,
      findings,
      providerStatus,
      note: `the rail reports '${providerStatus}' and applying it failed; the finding stays open`,
    };
  }

  if (applied.changed) {
    await resolveDetectedDiscrepancy({
      discrepancyId: discrepancy.id,
      reason: 'converged_from_provider',
      note:
        'Read live from the rail and applied through applyPaymentStatus: ' +
        `'${payment.status}' → '${providerStatus}'.`,
    });
  }

  return {
    converged: applied.changed,
    findings,
    providerStatus,
    note: applied.changed
      ? `converged '${payment.status}' → '${providerStatus}' from the rail's own state`
      : 'a concurrent delivery applied the same status first',
  };
}

/**
 * Compare what the rail says it charged against what Mercaria recorded.
 *
 * The PRESENTMENT side, which is the one both systems state directly: the
 * intent's `amount` and `currency` are what the buyer was asked for, and
 * `payments.presentment_*` is what Mercaria says they were asked for. The
 * PLATFORM side is compared by the provider-object sweep instead, against the
 * balance transaction — the only place the rail states a figure in the
 * settlement currency (ADR 0001 D8, fact 5).
 *
 * @returns Whether a finding was recorded.
 */
async function reportAmountMismatch(
  payment: PaymentRow,
  intent: Stripe.PaymentIntent,
): Promise<boolean> {
  const railCurrency = intent.currency.toUpperCase();
  if (intent.amount === payment.presentmentAmount && railCurrency === payment.presentmentCurrency) {
    return false;
  }
  await reportDiscrepancy({
    kind: 'payment_amount_mismatch',
    provider: 'stripe',
    correlationKey: payment.id,
    paymentId: payment.id,
    checkoutGroupId: payment.checkoutGroupId,
    ...(payment.providerObjectId ? { providerObjectId: payment.providerObjectId } : {}),
    detail: {
      side: 'presentment',
      localAmountMinor: payment.presentmentAmount,
      localCurrency: payment.presentmentCurrency,
      providerAmountMinor: intent.amount,
      providerCurrency: railCurrency,
    },
  });
  return true;
}

/** Whether a status means Mercaria believes the money arrived. */
function isSettledStatus(status: PaymentStatus): boolean {
  return status === 'succeeded' || status === 'partially_refunded' || status === 'refunded';
}
