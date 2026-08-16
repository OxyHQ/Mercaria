/**
 * The launch payout rail: a Stripe Connect transfer to the partner's own
 * connected account (#146, ADR 0005 D14).
 *
 * This is what #145 left EMPTY. Its port docblock says the day #146 calls
 * `registerReferralPayoutRail` "the queued batches settle on their next pass
 * with no migration and no replay", and that is exactly what registering this
 * does: a batch that failed `rail_not_configured` is in `failed`, that reason is
 * in `REFERRAL_RETRYABLE_PAYOUT_FAILURES`, and the settlement sweep retries it
 * on the batch's OWN idempotency key. Nothing is rebuilt and nothing is replayed.
 *
 * ## Mercaria pays from the PLATFORM balance
 *
 * ADR 0005 D14: "Mercaria pays, from the platform balance (`provider_clearing`),
 * as its own marketing/commission expense. No seller and no supplier ever funds
 * a referral payout." So the transfer carries NO `source_transaction` — that
 * parameter is #47's, and it exists to make a seller's transfer wait for the
 * buyer's charge to land. Naming a charge here would fund a partner's reward out
 * of one specific buyer's money, which is precisely the coupling I2 forbids.
 *
 * ## The currency gate is what makes minor units safe
 *
 * Stripe's `amount` is the currency's smallest unit, and so is
 * `net_payout_minor`. Those agree for a two-decimal currency and do NOT agree
 * for FAIR, which carries eight — so a FAIR batch handed to Stripe as minor
 * units would move a number a hundred million times too small, silently and
 * successfully. The rail therefore refuses any batch whose currency is not the
 * platform's settlement currency (ADR 0001 D8, the same rule #47's transfers
 * live under) rather than converting: an FX conversion at payout time would
 * change what a partner is owed after the amount was approved, which is #59's
 * "the set an operator approved is the set that executes".
 *
 * ## Every failure lands on the branch that describes it
 *
 * `refused` is terminal until somebody fixes the beneficiary; `unavailable` is
 * retried on the same key. Getting that backwards in either direction is a real
 * fault — a refusal retried forever spins against a condition no attempt can
 * move, and an outage reported as a refusal strands a partner's money behind an
 * operator decision nothing was wrong with. So a Stripe error is classified by
 * what it says about the ACCOUNT rather than by its HTTP status.
 */

import type Stripe from 'stripe';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { createStripeTransfer } from '../payments/stripe/client.js';
import type {
  ReferralPayoutOutcome,
  ReferralPayoutRequest,
} from '../referrals/earnings/payout-rail.port.js';
import { parseSellerKey } from '../payments/provider-account.service.js';
import { deriveReferralPayoutReadiness } from './beneficiary.js';
import { resolvePartnerTransferDestination } from './readiness.js';

/**
 * Stripe error codes that mean the DESTINATION is wrong, not that Stripe is.
 *
 * Everything not named here — a network fault, a 500, a rate limit, an
 * unrecognised code — is treated as `unavailable` and retried. That asymmetry is
 * the safe one: retrying a genuine refusal costs one wasted call per sweep and
 * is visible in the batch's failure detail, while giving up on a transient fault
 * strands money until a person notices.
 */
const DESTINATION_REFUSAL_CODES: readonly string[] = [
  'account_invalid',
  'account_country_invalid_address',
  'transfers_not_allowed',
  'balance_insufficient',
  'transfer_source_balance_parameters_mismatch',
];

/** Whether an error is Stripe saying no rather than Stripe being unavailable. */
function isDestinationRefusal(error: unknown): error is Stripe.errors.StripeError {
  const candidate = error as Partial<Stripe.errors.StripeError> | undefined;
  if (!candidate || typeof candidate.type !== 'string') return false;
  if (candidate.type === 'StripeInvalidRequestError') return true;
  return typeof candidate.code === 'string' && DESTINATION_REFUSAL_CODES.includes(candidate.code);
}

/** A message safe to store on the batch — never a raw provider payload. */
function railDetail(error: unknown): string {
  const candidate = error as Partial<Stripe.errors.StripeError> | undefined;
  const type = typeof candidate?.type === 'string' ? candidate.type : 'unknown_error';
  const code = typeof candidate?.code === 'string' ? `:${candidate.code}` : '';
  return `${type}${code}`;
}

/**
 * Move one approved batch to its partner's connected account.
 *
 * Every refusal is decided BEFORE the call, so a batch that cannot be paid never
 * spends a provider round trip and its failure detail names the actual
 * condition. The readiness re-check is not redundant with the gate: the gate ran
 * in the claiming transaction and the account can be restricted between that
 * commit and this call, which is the window in which paying would be wrong.
 */
export async function settleReferralPayoutOverStripe(
  request: ReferralPayoutRequest,
): Promise<ReferralPayoutOutcome> {
  if (!config.payments.stripe.enabled) {
    return { outcome: 'unavailable', detail: 'stripe is not enabled on this deployment' };
  }

  const platformCurrency = config.payments.stripe.platformCurrency;
  if (request.currency !== platformCurrency) {
    return {
      outcome: 'refused',
      reason: 'rail_rejected',
      detail:
        `a ${request.currency} batch cannot settle over a rail whose platform currency is ` +
        `${platformCurrency}; minor units are not comparable across precisions`,
    };
  }

  const owner = parseSellerKey(request.payoutBeneficiaryRef);
  if (!owner) {
    return {
      outcome: 'refused',
      reason: 'beneficiary_not_payable',
      detail: 'the payout beneficiary is not a seller key this rail understands',
    };
  }

  const destination = await resolvePartnerTransferDestination(owner);
  if (!destination) {
    return {
      outcome: 'refused',
      reason: 'beneficiary_not_payable',
      detail: 'the partner holds no connected account on this rail',
    };
  }
  if (deriveReferralPayoutReadiness(destination.onboardingState) !== 'ready') {
    return {
      outcome: 'refused',
      reason: 'beneficiary_not_payable',
      detail: 'the partner’s connected account is not payment-ready',
    };
  }

  try {
    const transfer = await createStripeTransfer(
      {
        amount: request.amountMinor,
        currency: request.currency.toLowerCase(),
        destination: destination.accountId,
        // The batch id and the partner id, and nothing else. No reward ids, no
        // amounts beside the one being moved, no owner key — the metadata
        // allow-list reasoning from #107, applied to a rail that carries a
        // marketing payout rather than a buyer's charge.
        metadata: {
          referralPayoutBatchId: request.batchId,
          referralPartnerId: request.partnerId,
        },
      },
      request.idempotencyKey,
    );
    return { outcome: 'settled', providerReference: transfer.id };
  } catch (error) {
    // The account id is never logged in full; #46's rule is last four only, and
    // there is no reason a payout log needs even that.
    log.general.error(
      { err: error, batchId: request.batchId },
      '[Referrals] a payout transfer failed',
    );
    if (isDestinationRefusal(error)) {
      return { outcome: 'refused', reason: 'rail_rejected', detail: railDetail(error) };
    }
    return { outcome: 'unavailable', detail: railDetail(error) };
  }
}
