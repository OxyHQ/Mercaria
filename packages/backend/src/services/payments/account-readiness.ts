/**
 * ADR 0001 D9's readiness verdict, as a pure function of what a rail reported.
 *
 * The adapter reduces its own account object to an {@link AccountSnapshot}
 * (`peable/accounts.ts`); this file turns a snapshot into the ONE stored verdict,
 * `provider_accounts.onboarding_state`, and into the repository's state input.
 * Nothing downstream re-derives it: the checkout gate compares the stored value
 * to one literal (`provider-account.service.ts`).
 *
 * Split out of the adapter so the derivation is a truth table a test can walk
 * without a gateway, and so it is written once whatever rail reports the facts.
 */

import type { ProviderCapabilityStatus, ProviderOnboardingState } from '@mercaria/shared-types';
import type { ProviderAccountState } from '../../db/payments/providerAccountRepository.js';

/** A rail's account reduced to what Mercaria stores. */
export interface AccountSnapshot {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapability?: ProviderCapabilityStatus;
  /**
   * The rail's own answer to "will a transfer to this account settle now".
   *
   * A conjunct, not a replacement: Peable refuses a transfer to an account it
   * does not consider payable (`AccountNotPayableError`), so a seller Mercaria
   * called ready while the gateway did not would have orders whose settlement
   * can never execute.
   */
  payable: boolean;
  currentlyDue: number;
  eventuallyDue: number;
  pastDue: number;
  pendingVerification: number;
  deadlineAt?: Date;
  disabledReasonCodes: readonly string[];
  defaultCurrency?: string;
}

/**
 * `disabled_reason` values from which an account does not recover by finishing
 * onboarding.
 *
 * Every `rejected.*` is matched by PREFIX rather than enumerated, so a value the
 * acquirer adds later lands on the safe side: a rejection Mercaria does not
 * recognise is still a rejection, and treating it as `action_required` would
 * send the seller round a hosted flow that cannot help them.
 */
const TERMINAL_DISABLED_REASONS: ReadonlySet<string> = new Set([
  'listed',
  'platform_paused',
  'other',
]);

/** Reasons that mean the provider is deciding — nothing for the seller to do. */
const REVIEW_DISABLED_REASONS: ReadonlySet<string> = new Set([
  'under_review',
  'requirements.pending_verification',
]);

/**
 * A machine token, and nothing that could be a sentence or a name.
 *
 * Applied to every reason code before it is stored, because these are shown to
 * the account's owner and the field is a string whose value set is the
 * provider's. Anything that does not match becomes `other` — information is
 * lost deliberately, and the alternative is forwarding whatever a provider put
 * in a free-text-capable field into Mercaria's database and UI.
 */
const REASON_CODE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** A provider's `disabled_reason`, reduced to safe machine tokens. */
export function safeReasonCodes(reason: string | null | undefined): readonly string[] {
  if (typeof reason !== 'string' || reason.trim() === '') return [];
  return [REASON_CODE_SHAPE.test(reason) ? reason : 'other'];
}

function isTerminallyDisabled(codes: readonly string[]): boolean {
  return codes.some((code) => code.startsWith('rejected.') || TERMINAL_DISABLED_REASONS.has(code));
}

/**
 * ADR 0001 D9's readiness conjunction, and the ONLY place it is written.
 *
 * Payouts enabled, the transfers capability active, the rail calling the
 * account payable, nothing due and nothing past due, and no disabling reason.
 * `charges_enabled` is deliberately not a conjunct — under separate charges and
 * transfers (D3) the connected account never charges anything.
 *
 * `currentlyDue === 0` is stricter than the ADR's own summary line, which names
 * only `past_due`. It is deliberate: a requirement that is merely `currently_due`
 * becomes `past_due` on a deadline nobody is watching, and the difference is a
 * seller who is ready on Monday and has failing checkouts on Tuesday morning.
 */
export function isPaymentReady(snapshot: AccountSnapshot): boolean {
  return (
    snapshot.payoutsEnabled &&
    snapshot.transfersCapability === 'active' &&
    snapshot.payable &&
    snapshot.pastDue === 0 &&
    snapshot.currentlyDue === 0 &&
    snapshot.disabledReasonCodes.length === 0
  );
}

/**
 * The single stored verdict, derived in a fixed order.
 *
 *  1. a rejection — terminal, and the seller must not be sent back into a
 *     hosted flow that will not change it.
 *  2. `past_due` — this must beat `ready`, and it does not merely because
 *     readiness already excludes it: an account can be past due AND under
 *     review, and `restricted` is the more actionable of the two.
 *  3. readiness — the D9 conjunction.
 *  4. review — the provider is deciding; telling someone to act here opens a
 *     support ticket about an action that does not exist.
 *  5. everything else is the seller's move.
 */
export function deriveOnboardingState(snapshot: AccountSnapshot): ProviderOnboardingState {
  if (isTerminallyDisabled(snapshot.disabledReasonCodes)) return 'disabled';
  if (snapshot.pastDue > 0) return 'restricted';
  if (isPaymentReady(snapshot)) return 'ready';
  if (snapshot.disabledReasonCodes.some((code) => REVIEW_DISABLED_REASONS.has(code))) {
    return 'under_review';
  }
  // Nothing asked of the seller, and the provider still working: review, not a
  // call to action. The capability check matters on its own because a
  // submitted account clears its requirements before `transfers` goes active.
  if (snapshot.currentlyDue === 0 && snapshot.pastDue === 0) {
    if (snapshot.pendingVerification > 0 || snapshot.transfersCapability === 'pending') {
      return 'under_review';
    }
  }
  return 'action_required';
}

/** The snapshot as the repository's state input, stamped with when it was READ. */
export function toAccountState(snapshot: AccountSnapshot, syncedAt: Date): ProviderAccountState {
  return {
    onboardingState: deriveOnboardingState(snapshot),
    chargesEnabled: snapshot.chargesEnabled,
    payoutsEnabled: snapshot.payoutsEnabled,
    ...(snapshot.transfersCapability ? { transfersCapability: snapshot.transfersCapability } : {}),
    requirementsCurrentlyDue: snapshot.currentlyDue,
    requirementsEventuallyDue: snapshot.eventuallyDue,
    requirementsPastDue: snapshot.pastDue,
    requirementsPendingVerification: snapshot.pendingVerification,
    ...(snapshot.deadlineAt ? { requirementsDeadlineAt: snapshot.deadlineAt } : {}),
    disabledReasonCodes: snapshot.disabledReasonCodes,
    ...(snapshot.defaultCurrency ? { defaultCurrency: snapshot.defaultCurrency } : {}),
    syncedAt,
  };
}
