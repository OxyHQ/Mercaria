/**
 * Registering the payout join into the referral domain's ports (#146, #344).
 *
 * ONE call site, at boot, and it is the only place the two walled domains are
 * joined: a second registrar would be a second place to get the direction
 * wrong, which is the whole thing the port shape exists to prevent.
 *
 * Two READERS are registered here — partner payout readiness (ADR 0005 D15
 * gate 1) and the risk payment facts (#344). The payout RAIL port is left
 * empty: its only implementation was a direct Stripe Connect transfer, removed
 * with the direct Stripe rail (ADR 0009 D13). An empty rail port is a state the
 * referral domain already handles — a settlement attempt fails
 * `rail_not_configured`, which is retryable, with the batch and its claims
 * intact, so a rail registered later settles the queued batches on its next
 * pass with no migration and no replay.
 *
 * There is deliberately NO flag on this. #145's three levers gate the LOOPS —
 * vesting, batch settlement, reconciliation — and a fourth gating the
 * REGISTRATION would be a second way to stop payouts.
 */

import {
  registerReferralPartnerReadinessReader,
  type ReferralPartnerReadinessReader,
} from '../referrals/earnings/partner-readiness.port.js';
import {
  registerReferralRiskPaymentFactsReader,
  type ReferralRiskPaymentFactsReader,
} from '../referrals/integrity/payment-facts.port.js';
import { readPartnerPayoutReadiness } from './readiness.js';
import { readReferralRiskPartnerPaymentFacts } from './risk-payment-facts.js';

/**
 * Fill every port this module implements.
 *
 * Idempotent — each registry holds one implementation and a second call
 * replaces it with the same function, so a double import at boot is harmless.
 */
export function registerReferralPayoutJoin(): void {
  const reader: ReferralPartnerReadinessReader = readPartnerPayoutReadiness;
  registerReferralPartnerReadinessReader(reader);
  const riskFactsReader: ReferralRiskPaymentFactsReader = readReferralRiskPartnerPaymentFacts;
  registerReferralRiskPaymentFactsReader(riskFactsReader);
}
