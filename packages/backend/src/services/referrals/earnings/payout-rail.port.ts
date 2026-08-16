/**
 * The payout RAIL — a named, fail-closed seam that #146 fills (#145).
 *
 * ADR 0005 D14 selects one launch rail: Stripe Connect transfers to a
 * payment-ready connected account, reusing #46's `provider_accounts` so a
 * referral payout can never mint a second one. **#146 FILLED this**: the
 * implementation is `services/referral-payouts/rail.ts`, registered at boot,
 * and this file stays the request shape, the outcome union and the registry.
 *
 * The registry is still a PORT rather than a direct call, and the reason has
 * outlived the seam: the implementation lives OUTSIDE both walled domains, so
 * the dependency runs join → domain and this file names no rail.
 *
 * ## Why it was empty, and why the alternatives were both worse
 *
 * A `console.log` rail looks like a working feature in every test and pays
 * nobody in production. A direct Stripe client here would put the card rail
 * inside the referral domain — which `reward-funding-isolation.test.ts` refuses
 * by name, and rightly: a partner payout and a buyer's charge are different
 * money with different compliance, and one import is how they stop being.
 *
 * While the registry was empty every settlement failed `rail_not_configured`,
 * VISIBLY, with the batch intact, its items still claimed and its idempotency
 * key unchanged — which is what made #146 a registration rather than a
 * migration: `rail_not_configured` is retryable, so a batch queued back then
 * settles on its next pass, on its own key, with no replay.
 *
 * ## The request carries no beneficiary DETAIL, deliberately
 *
 * `payoutBeneficiaryRef` is #142's opaque pointer at whatever account the rail
 * resolves. There is no bank number, no address, no tax identifier and no email
 * in this type — a rail that needs one reads it from the domain that holds it,
 * under its own authorization, rather than being handed it by a marketing
 * ledger.
 */

import type { CurrencyCode } from '@mercaria/shared-types';

/** What a rail is asked to move. */
export interface ReferralPayoutRequest {
  batchId: string;
  partnerId: string;
  /** #142's opaque pointer at the rail account. Never a bank detail. */
  payoutBeneficiaryRef: string;
  /** The batch's `net_payout_minor`. Always positive. */
  amountMinor: number;
  currency: CurrencyCode;
  /**
   * Derived from the batch id, so every retry presents the SAME key.
   * ADR 0001 D11's rule: a retry after a lost response must be indistinguishable
   * from the first attempt on the provider's side, or the partner is paid twice.
   */
  idempotencyKey: string;
}

/**
 * What a rail answers.
 *
 * A STRING discriminant, because this backend compiles with `strict: false` and
 * TypeScript does not narrow a union on a boolean-literal one.
 *
 * The three branches are genuinely different next actions and collapsing any two
 * is a bug: `settled` books the ledger, `refused` is terminal until somebody
 * fixes the beneficiary, and `unavailable` is retried on the same key. A rail
 * that answered `refused` for a timeout would strand a partner's money behind an
 * operator's decision that nothing was wrong with.
 */
export type ReferralPayoutOutcome =
  | { outcome: 'settled'; providerReference: string }
  | { outcome: 'refused'; reason: 'rail_rejected' | 'beneficiary_not_payable'; detail: string }
  | { outcome: 'unavailable'; detail: string };

/** The one function a rail implements. */
export type ReferralPayoutRail = (request: ReferralPayoutRequest) => Promise<ReferralPayoutOutcome>;

let rail: ReferralPayoutRail | undefined;

/**
 * Register the payout rail. Called once at boot by #146 when it ships; until
 * then every settlement fails `rail_not_configured` and no batch reaches `paid`.
 */
export function registerReferralPayoutRail(implementation: ReferralPayoutRail): void {
  rail = implementation;
}

/**
 * Drop the registration.
 *
 * Exists for tests, which must be able to assert the DEFAULT refusal as well as
 * a registered path — a port whose unregistered behaviour is untestable is a
 * port whose unregistered behaviour is unknown.
 */
export function resetReferralPayoutRail(): void {
  rail = undefined;
}

/** The registered rail, or `undefined` on every deployment that exists today. */
export function resolveReferralPayoutRail(): ReferralPayoutRail | undefined {
  return rail;
}
