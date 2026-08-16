/**
 * The four referral posting builders — ADR 0005 "Ledger representability" as
 * code (#145).
 *
 * PURE: each takes a partner, a magnitude, a currency and a description, and
 * returns a `{transaction, entries}` pair for `insertLedgerTransaction`. There
 * is no database handle, no clock and — the load-bearing absence — **no account
 * parameter**. A caller cannot name `retail_cost_recovery`, `procurement_expense`
 * or `commission_revenue` here because there is nowhere to put one, which is
 * #145's funding invariant held by the call graph rather than by a check.
 *
 * ## ADR 0005's six rows are four builders, and the collapse is deliberate
 *
 * | ADR row | Builder |
 * |---|---|
 * | Reward accrued (W) | {@link rewardAccruedPosting} |
 * | Partial-refund adjustment (d) — R2 | {@link rewardReversedPosting} |
 * | Reward voided (remaining net W′) — R1/R3–R6/R8 | {@link rewardReversedPosting} |
 * | Clawback after paid (C) — R7 | {@link rewardReversedPosting} |
 * | Payout batch (vested sum P) — D14 | {@link payoutSettledPosting} |
 * | Recovery received (V) — R7 | {@link recoveryReceivedPosting} |
 *
 * The three middle rows are the identical posting — debit `referral_payable`,
 * credit `referral_expense` — differing only in what the reward was worth before
 * and whether it had been paid. Those two facts are already recorded, once, on
 * `referral_reward_adjustments` (`delta_amount_minor`, `recovery_state`). A
 * second builder per row would be a second representation of them, and the two
 * would eventually disagree.
 *
 * ## Every amount is a positive MAGNITUDE and the builder supplies the sign
 *
 * `amountMinor` is `bigint` and must be `> 0`. Passing a signed figure and
 * letting the builder pass it through would make the direction a property of the
 * CALLER — and a reversal handed a positive delta would credit a partner for a
 * refund. The repository refuses a zero entry outright, so a zero-delta
 * adjustment books nothing at all rather than a pair of empty legs, which is
 * `posting.service.ts`'s early return.
 */

import type { CurrencyCode } from '@mercaria/shared-types';
import type {
  LedgerEntryInput,
  LedgerTransactionInput,
} from '../../../db/payments/ledgerRepository.js';
import { REFERRAL_PAYABLE_OWNER_TYPE } from './accounts.js';

/** One balanced movement, ready for `insertLedgerTransaction`. */
export interface ReferralPosting {
  transaction: LedgerTransactionInput;
  entries: readonly LedgerEntryInput[];
}

/** What every builder is given, and the whole of it. */
export interface ReferralPostingInput {
  /** The `referral_partners.id` the payable is owed to. */
  partnerId: string;
  /** A positive magnitude in minor units of {@link ReferralPostingInput.currency}. */
  amountMinor: bigint;
  currency: CurrencyCode;
  /** One line, for a human reading a trace. Never a payload, never a secret. */
  description: string;
}

/** Raised when a builder is handed an amount that is not a positive magnitude. */
export class InvalidReferralPostingAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReferralPostingAmountError';
  }
}

function assertPositiveMagnitude(amountMinor: bigint, builder: string): void {
  if (amountMinor > 0n) return;
  throw new InvalidReferralPostingAmountError(
    `${builder} needs a positive magnitude; it was handed ${String(amountMinor)}. The direction ` +
      'is the builder’s, never the caller’s — a reversal handed a positive delta would credit a ' +
      'partner for a refund.',
  );
}

/** The `referral_payable` leg, always owned, always by the partner. */
function payable(input: ReferralPostingInput, amountMinor: bigint): LedgerEntryInput {
  return {
    account: 'referral_payable',
    currency: input.currency,
    amountMinor,
    ownerType: REFERRAL_PAYABLE_OWNER_TYPE,
    ownerId: input.partnerId,
  };
}

/**
 * A reward accrued: Mercaria recognised the cost and owes the partner.
 *
 * Debit `referral_expense`, credit `referral_payable`. The expense is recognised
 * at ACCRUAL rather than at payout, which is what makes "the cost of the program"
 * a figure that exists from the moment a partner earns it — and it is the reason
 * a reward reversal is an expense REDUCTION rather than a refund.
 */
export function rewardAccruedPosting(
  input: ReferralPostingInput & { rewardId: string },
): ReferralPosting {
  assertPositiveMagnitude(input.amountMinor, 'rewardAccruedPosting');
  return {
    transaction: { kind: 'referral_reward_accrued', description: input.description },
    entries: [
      { account: 'referral_expense', currency: input.currency, amountMinor: input.amountMinor },
      payable(input, -input.amountMinor),
    ],
  };
}

/**
 * A reward reversed: the funding shrank or went away, so the obligation does.
 *
 * Debit `referral_payable`, credit `referral_expense` — the exact inverse of the
 * accrual, which is what makes a reversal a REVERSING transaction rather than an
 * edit. ADR 0005 and ADR 0001 both refuse a `reverseTransaction(id)` helper for
 * the same reason: a correction is a function of what an operator decided, not
 * of what happens to be stored.
 *
 * After a PAYOUT this same posting takes the payable NEGATIVE, and nothing stops
 * it. That is R7 working: the paid record is never rewritten, the partner owes
 * the difference back, and future accruals offset it first because they credit
 * the same account.
 */
export function rewardReversedPosting(
  input: ReferralPostingInput & { rewardId: string; adjustmentId: string },
): ReferralPosting {
  assertPositiveMagnitude(input.amountMinor, 'rewardReversedPosting');
  return {
    transaction: { kind: 'referral_reward_reversed', description: input.description },
    entries: [
      payable(input, input.amountMinor),
      { account: 'referral_expense', currency: input.currency, amountMinor: -input.amountMinor },
    ],
  };
}

/**
 * A payout batch settled: the obligation is discharged out of the platform
 * balance.
 *
 * Debit `referral_payable`, credit `provider_clearing`. ADR 0005 D14: Mercaria
 * pays, from its own balance, as its own marketing expense — no seller and no
 * supplier funds a referral payout, which is why `merchant_payable` is on the
 * forbidden list and there is no parameter here that could reach it.
 */
export function payoutSettledPosting(
  input: ReferralPostingInput & { payoutBatchId: string },
): ReferralPosting {
  assertPositiveMagnitude(input.amountMinor, 'payoutSettledPosting');
  return {
    transaction: { kind: 'referral_payout', description: input.description },
    entries: [
      payable(input, input.amountMinor),
      { account: 'provider_clearing', currency: input.currency, amountMinor: -input.amountMinor },
    ],
  };
}

/**
 * A recovery received: a partner paid back what a post-payout reversal left them
 * owing (ADR 0005 R7).
 *
 * Debit `provider_clearing`, credit `referral_payable` — the money arrives on the
 * platform balance and the negative payable moves back toward zero. It is an
 * explicit operator act with a mandatory reference, never automatic: R7 says
 * recovery beyond offset "is an explicit operator action … never automatic,
 * always recorded", which is the `payment_repairs` shape.
 */
export function recoveryReceivedPosting(
  input: ReferralPostingInput & { recoveryRef: string },
): ReferralPosting {
  assertPositiveMagnitude(input.amountMinor, 'recoveryReceivedPosting');
  return {
    transaction: { kind: 'referral_recovery', description: input.description },
    entries: [
      { account: 'provider_clearing', currency: input.currency, amountMinor: input.amountMinor },
      payable(input, -input.amountMinor),
    ],
  };
}
