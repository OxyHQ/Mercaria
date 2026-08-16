/**
 * Registering the payout join into the referral domain's ports (#146, #344).
 *
 * ONE call site, at boot, and it is the only place the two walled domains are
 * joined. #146's two ports are filled together, deliberately: a deployment that
 * could read a partner's readiness but not pay them would build batches that
 * always fail, and one that could pay but not read readiness would pay without
 * gate 1. Registering them separately is how a deployment ends up in either
 * state, so there is no function here that fills only one.
 *
 * #344's risk-facts port joined them here rather than getting a second
 * registrar, and it is NOT part of that both-or-neither pairing. Its absence is
 * a silence — three risk facts go unmeasured and `deriveRiskSignals` emits
 * nothing for them — where an absent readiness reader blocks money. What makes
 * one call site right anyway is that this is the module that already crosses
 * between the two domains; a second one would be a second place to get the
 * direction wrong, which is the whole thing the port shape exists to prevent.
 *
 * There is deliberately NO flag on this. #145's three levers gate the LOOPS —
 * vesting, batch settlement, reconciliation — and a fourth gating the
 * REGISTRATION would be a second way to stop payouts whose off position looks
 * exactly like a deployment that has not shipped #146 yet. `STRIPE_ENABLED` is
 * already the switch that decides whether the rail can do anything, and both
 * halves check it themselves and answer honestly rather than silently.
 */

import {
  registerReferralPartnerReadinessReader,
  type ReferralPartnerReadinessReader,
} from '../referrals/earnings/partner-readiness.port.js';
import { registerReferralPayoutRail } from '../referrals/earnings/payout-rail.port.js';
import {
  registerReferralRiskPaymentFactsReader,
  type ReferralRiskPaymentFactsReader,
} from '../referrals/integrity/payment-facts.port.js';
import { settleReferralPayoutOverStripe } from './rail.js';
import { readPartnerPayoutReadiness } from './readiness.js';
import { readReferralRiskPartnerPaymentFacts } from './risk-payment-facts.js';

/**
 * Fill every port.
 *
 * Idempotent — each registry holds one implementation and a second call
 * replaces it with the same function, so a double import at boot is harmless.
 */
export function registerReferralPayoutJoin(): void {
  const reader: ReferralPartnerReadinessReader = readPartnerPayoutReadiness;
  registerReferralPartnerReadinessReader(reader);
  registerReferralPayoutRail(settleReferralPayoutOverStripe);
  const riskFactsReader: ReferralRiskPaymentFactsReader = readReferralRiskPartnerPaymentFacts;
  registerReferralRiskPaymentFactsReader(riskFactsReader);
}
