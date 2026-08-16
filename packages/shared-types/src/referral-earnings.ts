/**
 * The referral EARNINGS ledger: holds, vesting, payout batches and the
 * funding-source invariant expressed against the chart of accounts (#145, under
 * ADR 0005 "Ledger representability", D12–D15 and R1–R8).
 *
 * #144 decided what a conversion is WORTH and recorded it on `referral_rewards`.
 * This is what that worth costs Mercaria, where it sits until it can be paid,
 * how it is paid, and what happens when the money it was drawn from goes away.
 *
 * ## The funding-source invariant, one layer lower
 *
 * #144 states it over SOURCES: `REFERRAL_FUNDING_SOURCE_IDS` is what a reward
 * may be funded from, `REFERRAL_FORBIDDEN_FUNDING_KINDS` is what it may never
 * be. Both are about the base a rule computes over.
 *
 * #145 restates it over ACCOUNTS, because a posting is where money would
 * actually be taken from the wrong place. {@link REFERRAL_LEDGER_ACCOUNTS} is
 * the complete set of accounts a referral posting may name;
 * {@link REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS} is every other account in
 * Mercaria's chart, named as VALUES. The two are DISJOINT and their union is
 * exactly `LEDGER_ACCOUNTS`, both asserted by a test — so an account added later
 * fails the build until somebody decides which side of the referral boundary it
 * is on, which is the `merge-plan-census.test.ts` device applied to money.
 *
 * `retail_cost_recovery`, `procurement_expense`, `customer_adjustment` and
 * `supplier_prepaid` are on the forbidden side, which is #145's "zero-profit
 * retail protection" as a value a test can run rather than a paragraph. So is
 * `commission_revenue`, and that one is worth reading: a `connected_marketplace`
 * reward is FUNDED from realized commission and does not REDUCE it. The
 * commission stays recognized where ADR 0001 D3 put it and the referral cost is
 * a separate expense against it — booking the reward as a commission reduction
 * would make the one figure that exists nowhere else stop meaning what it means.
 *
 * ## The states #145's issue names that are not states here
 *
 * The issue lists `pending | held | vested | payable | paid | reversed | voided`
 * ("such as"). `ReferralRewardState` (#144, ADR 0005's machine) is
 * `held | vested | frozen | paid | voided`, and the three extras are not added.
 * {@link REFERRAL_REWARD_STATE_ELSEWHERE} names each one and where the fact it
 * describes actually lives, so the gap is data rather than an omission a later
 * reader has to reconstruct.
 */

import type { CurrencyCode } from './money';
import type { LedgerAccount } from './payment';

/**
 * The COMPLETE set of ledger accounts a referral posting may name.
 *
 * Three, and the third is the one that matters: `provider_clearing` is the
 * platform balance, so a payout DEBITS `referral_payable` and CREDITS it — the
 * money leaves the same account a charge put it in. That is what makes "did the
 * platform balance go down by what we paid a partner" a question one book can
 * answer.
 *
 * Stated positively and kept beside the prohibition, the
 * `RETAIL_REVENUE_SIDE_ACCOUNTS` device: what this list defends is an OMISSION,
 * and an omission is invisible unless something names it.
 */
export const REFERRAL_LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  'referral_expense',
  'referral_payable',
  'provider_clearing',
];

/**
 * Every account a referral posting may NEVER name — the rest of Mercaria's
 * chart, as values.
 *
 * DISJOINT from {@link REFERRAL_LEDGER_ACCOUNTS}, and their union is exactly
 * `LEDGER_ACCOUNTS`. Both are asserted by
 * `services/referrals/earnings/__tests__/referral-earnings-isolation.test.ts`,
 * which is what makes a fourteenth account a build failure rather than a silent
 * omission from a list nobody re-reads.
 *
 * The four retail ones are #145's zero-profit protection: a `mercaria_retail`
 * order's supplier cost, its basket value, its cost variance and the customer
 * adjustment it owes are all reachable only through accounts on this list, and
 * no referral posting builder takes a parameter that could name one.
 */
export const REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  'merchant_payable',
  'commission_revenue',
  'processor_expense',
  'refunds',
  'disputes',
  'reserves',
  'retail_cost_recovery',
  'supplier_prepaid',
  'platform_funds',
  'procurement_expense',
  'customer_adjustment',
  'subscription_revenue',
];

/**
 * Why each forbidden account can never carry a referral posting — the sentence a
 * refusal carries, so a reader learns the model rather than reading
 * "unrecognized account". The `REFERRAL_FORBIDDEN_FUNDING_LABELS` device.
 */
export const REFERRAL_FORBIDDEN_LEDGER_ACCOUNT_LABELS: Record<string, string> = {
  merchant_payable:
    'a seller receivable — a referral reward is Mercaria’s marketing cost and may never be ' +
    'taken out of what a merchant is owed (ADR 0005 D14: no seller and no supplier funds a ' +
    'referral payout)',
  commission_revenue:
    'recognized marketplace commission, which FUNDS a reward and is never REDUCED by one: ' +
    'ADR 0001 D3 makes this the only place commission exists, and booking the reward here ' +
    'would make that figure stop meaning what it means',
  processor_expense: 'the provider’s own fee on a charge, which is not Mercaria’s to spend',
  refunds: 'money returned to a buyer',
  disputes: 'a disputed amount debited from the platform',
  reserves: 'funds withheld from a seller',
  retail_cost_recovery:
    'what a buyer paid back for Mercaria’s own costs on a zero-margin `mercaria_retail` order ' +
    '(#116/#120) — there is no margin in it to share',
  supplier_prepaid: 'Mercaria’s deposit with a supplier, which is a cost and never income',
  platform_funds: 'Mercaria’s out-of-band cash movements, which are a treasury act',
  procurement_expense: 'what the goods on a retail order cost, which is a cost and never income',
  customer_adjustment:
    'a positive retail cost variance, which #128 reserves for CUSTOMER adjustment — it is the ' +
    'customer’s money awaiting return, not a pool a partner may be paid from',
  subscription_revenue:
    'recognized subscription revenue, which — like commission — funds a reward through #144’s ' +
    '`subscription` source and is never reduced by one',
};

/**
 * What a referral ledger posting RECORDED, as the `referral_ledger_postings`
 * row's own kind.
 *
 * Four, matching `LedgerTransactionKind`'s four referral members one for one:
 * the posting row and the ledger transaction it booked must not be able to
 * disagree about what happened, so they carry the same closed vocabulary rather
 * than two that have to be kept in step.
 */
export type ReferralLedgerPostingKind =
  | 'reward_accrued'
  | 'reward_reversed'
  | 'payout_settled'
  | 'recovery_received';

/** {@link ReferralLedgerPostingKind} as a tuple. */
export const REFERRAL_LEDGER_POSTING_KINDS: readonly ReferralLedgerPostingKind[] = [
  'reward_accrued',
  'reward_reversed',
  'payout_settled',
  'recovery_received',
];

/**
 * A payout batch's lifecycle (#145 "Payout batches" field 9).
 *
 * `failed` is RETRYABLE and keeps its items claimed — a rail that answered 500
 * has not told anybody the money did not move, and the retry rides the batch's
 * own idempotency key. `cancelled` is the terminal operator decision and is the
 * ONLY status that releases items back for a later batch: releasing on failure
 * would let one batch's retry and the next batch both carry the same reward.
 */
export type ReferralPayoutBatchStatus =
  | 'draft'
  | 'approved'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'cancelled';

/** {@link ReferralPayoutBatchStatus} as a tuple. */
export const REFERRAL_PAYOUT_BATCH_STATUSES: readonly ReferralPayoutBatchStatus[] = [
  'draft',
  'approved',
  'processing',
  'paid',
  'failed',
  'cancelled',
];

/**
 * Why a payout batch did not go through (#145 "Payout batches" field 9).
 *
 * A closed set with no `other`: a failure this list cannot express is a defect
 * in the list, and an operator deciding what to do next needs the difference
 * between "we never asked the rail" and "the rail said no".
 */
export type ReferralPayoutFailureReason =
  | 'rail_not_configured'
  | 'rail_rejected'
  | 'rail_unavailable'
  | 'beneficiary_not_payable'
  | 'amount_no_longer_payable'
  | 'withholding_not_supported'
  | 'operator_cancelled';

/** {@link ReferralPayoutFailureReason} as a tuple. */
export const REFERRAL_PAYOUT_FAILURE_REASONS: readonly ReferralPayoutFailureReason[] = [
  'rail_not_configured',
  'rail_rejected',
  'rail_unavailable',
  'beneficiary_not_payable',
  'amount_no_longer_payable',
  // #145 "Payout batches" field 6 is MODELLED and UNSETTLEABLE: the column
  // exists, an operator may set it, and settlement refuses while there is no
  // account for the withheld money to sit in. Inventing a `tax_withheld` account
  // would put a remittance obligation in a book nobody reconciles against a tax
  // authority — #141/#146 own the compliance decision, and this is the honest
  // shape of waiting for it.
  'withholding_not_supported',
  'operator_cancelled',
];

/**
 * The failures a RETRY could fix, so the settlement loop retries those and only
 * those.
 *
 * The complement is terminal by NATURE rather than by attempt count:
 * `amount_no_longer_payable` and `withholding_not_supported` describe the batch
 * itself, so a hundred retries produce a hundred identical refusals;
 * `beneficiary_not_payable` and `rail_rejected` describe the partner's rail
 * standing, which the partner or an operator changes and Mercaria does not; and
 * `operator_cancelled` is a decision. Retrying any of them would spin a loop
 * against a condition that cannot move — the `permission_denied` /
 * `topic_not_supported` split #262 made one domain over.
 *
 * A failed batch stays visible and keeps its claims either way. What differs is
 * whether a machine keeps asking.
 */
export const REFERRAL_RETRYABLE_PAYOUT_FAILURES: readonly ReferralPayoutFailureReason[] = [
  'rail_not_configured',
  'rail_unavailable',
];

/**
 * Why a reward may not be paid yet — ADR 0005 D15's gates plus the mechanical
 * ones, each naming a condition somebody can act on.
 *
 * D15's rule is that a partner failing a gate is **skipped, not voided**: the
 * balance stays payable and enters the next batch that passes. So every member
 * here withholds and none of them destroys anything.
 */
export type ReferralPayoutBlockReason =
  | 'reward_not_vested'
  | 'reward_frozen'
  | 'reward_voided'
  | 'reward_already_paid'
  | 'reward_claimed_by_open_batch'
  | 'reward_net_is_zero'
  | 'partner_not_approved'
  | 'partner_suspended'
  | 'identity_not_ready'
  | 'tax_not_ready'
  | 'payout_not_ready'
  | 'no_payout_beneficiary'
  | 'program_payout_paused'
  | 'below_minimum'
  | 'payout_minimum_not_published';

/** {@link ReferralPayoutBlockReason} as a tuple. */
export const REFERRAL_PAYOUT_BLOCK_REASONS: readonly ReferralPayoutBlockReason[] = [
  'reward_not_vested',
  'reward_frozen',
  'reward_voided',
  'reward_already_paid',
  'reward_claimed_by_open_batch',
  'reward_net_is_zero',
  'partner_not_approved',
  'partner_suspended',
  'identity_not_ready',
  'tax_not_ready',
  'payout_not_ready',
  'no_payout_beneficiary',
  'program_payout_paused',
  'below_minimum',
  'payout_minimum_not_published',
];

/**
 * Whether one reward may enter a payout batch right now.
 *
 * DERIVED and never stored — the `deriveNativeCheckoutEligibility` divergence
 * from the one-stored-verdict rule, and for the same reason: the inputs are the
 * partner's LIVE readiness triple, their LIVE state, the program's LIVE payout
 * lever and the reward's own state, which move without anybody touching the
 * reward. A stored `payable` state would be a second representation going stale
 * the instant Stripe restricts an account, and the place that must not happen is
 * a batch builder including somebody it should not.
 *
 * A STRING discriminant, because this backend compiles with `strict: false` and
 * TypeScript does not narrow a union on a boolean-literal one. The `blocked`
 * branch carries no amount, so nothing can pay a reward it has just been told
 * not to.
 */
export type ReferralRewardPayability =
  | { verdict: 'payable'; netAmountMinor: number; currency: CurrencyCode }
  | { verdict: 'blocked'; reasons: readonly ReferralPayoutBlockReason[] };

/**
 * What moved a reward from one state to another (#145 "Reward lifecycle": state
 * changes are durable, idempotent and auditable).
 *
 * A closed set, because the transition row's idempotency key is derived from it
 * — two spellings of one cause would let one transition be recorded twice.
 *
 * There is deliberately NO `accrual` member: a reward is BORN `held`, and
 * `referral_reward_transitions_moves_check` refuses a row whose `from_state`
 * equals its `to_state`. The birth of a row is not a transition, and recording
 * one would make "how many times did this reward move" answer one too many. The
 * accrual's own record is its `referral_ledger_postings` row and its
 * `reward_accrued` event.
 *
 * Every member here is written by something. `partner_suspended` and
 * `frozen_for_review` are the two freeze paths (D18/R8 and R3); `freeze_lifted`
 * is the single lift, whose distinct reasons live in the row's own free-text
 * `reason` rather than in a cause per outcome.
 */
export type ReferralRewardTransitionCause =
  | 'hold_elapsed'
  | 'frozen_for_review'
  | 'partner_suspended'
  | 'freeze_lifted'
  | 'payout_settled'
  | 'funding_reversed'
  | 'fraud_invalidated'
  | 'budget_invalidated';

/** {@link ReferralRewardTransitionCause} as a tuple. */
export const REFERRAL_REWARD_TRANSITION_CAUSES: readonly ReferralRewardTransitionCause[] = [
  'hold_elapsed',
  'frozen_for_review',
  'partner_suspended',
  'freeze_lifted',
  'payout_settled',
  'funding_reversed',
  'fraud_invalidated',
  'budget_invalidated',
];

/**
 * What the reconciliation sweep found — ADR 0005's requirement that the reward's
 * net and the ledger's `referral_payable` are two stores that must agree, and
 * that the agreement is PINNED rather than assumed.
 *
 * The `payment_discrepancies` posture: this domain DETECTS and never repairs.
 * Every kind here is a decision about a financial record, and the two that look
 * mechanical (`ledger_posting_missing`, `payout_without_ledger_posting`) are the
 * ones where an automatic repair would book money nobody authorised.
 */
export type ReferralEarningDiscrepancyKind =
  | 'reward_net_disagrees_with_ledger'
  | 'ledger_posting_missing'
  | 'payout_without_ledger_posting'
  | 'paid_reward_without_batch_item'
  | 'batch_total_disagrees_with_items'
  | 'partner_balance_negative_without_liability'
  | 'vested_reward_past_payout_horizon';

/** {@link ReferralEarningDiscrepancyKind} as a tuple. */
export const REFERRAL_EARNING_DISCREPANCY_KINDS: readonly ReferralEarningDiscrepancyKind[] = [
  'reward_net_disagrees_with_ledger',
  'ledger_posting_missing',
  'payout_without_ledger_posting',
  'paid_reward_without_batch_item',
  'batch_total_disagrees_with_items',
  'partner_balance_negative_without_liability',
  'vested_reward_past_payout_horizon',
];

/** A discrepancy's lifecycle. `resolved` is an operator's decision, never a sweep's. */
export type ReferralEarningDiscrepancyStatus = 'open' | 'acknowledged' | 'resolved';

/** {@link ReferralEarningDiscrepancyStatus} as a tuple. */
export const REFERRAL_EARNING_DISCREPANCY_STATUSES: readonly ReferralEarningDiscrepancyStatus[] = [
  'open',
  'acknowledged',
  'resolved',
];

/**
 * The three states #145's issue names that ARE NOT members of
 * `ReferralRewardState`, and where each fact actually lives.
 *
 * Named as data rather than left as an absence — the `deferred: #NN` device, one
 * domain over. A test asserts these keys are DISJOINT from
 * `REFERRAL_REWARD_STATES`, so adding one to the machine later fails the build
 * until this entry goes with it.
 */
export const REFERRAL_REWARD_STATE_ELSEWHERE: Record<'pending' | 'payable' | 'reversed', string> = {
  pending:
    'a reward that has not accrued has no ROW: `referral_conversions.state` already carries ' +
    '`pending`, and a reward row for something nobody has earned would give the machine two ' +
    'ways to say one thing',
  payable:
    'DERIVED, never stored — `deriveRewardPayability` reads the partner’s live readiness ' +
    'triple, their state, the program’s payout lever and the reward’s own state, none of ' +
    'which the reward row owns; a stored verdict would go stale the instant a rail restricts ' +
    'an account (the `deriveNativeCheckoutEligibility` divergence)',
  reversed:
    'the append-only `referral_reward_adjustments` trail: a partial reversal leaves the state ' +
    'alone and lowers the net, a full one is `voided`, and a reward already PAID stays `paid` ' +
    'forever (ADR 0005 R7) — so a `reversed` state would contradict R7 on exactly the rows ' +
    'that matter most',
};

/**
 * The minimum a partner must have accrued before a batch may pay them, per
 * currency (ADR 0005 D14: EUR 25, balances below it roll forward).
 *
 * A CODE CONSTANT and not an environment variable, for the `#126` terms reason:
 * this is a published policy partners were recruited under, so changing it is a
 * commit with an author and a date rather than a value somebody sets at 3am. It
 * is PARTIAL on purpose — a currency Mercaria has published no minimum for is
 * blocked with `payout_minimum_not_published` rather than defaulted to zero,
 * because a defaulted minimum is a policy nobody signed.
 */
export const REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY: Readonly<
  Partial<Record<CurrencyCode, number>>
> = Object.freeze({ EUR: 2_500 });

/**
 * One partner's balance, DERIVED from `ledger_entries` and from nothing else
 * (#145 acceptance 1: reward balances are fully derivable from immutable
 * entries).
 *
 * There is deliberately no balance TABLE and no balance COLUMN anywhere in this
 * domain. `outstandingMinor` is the signed `referral_payable` position: positive
 * is what Mercaria owes, NEGATIVE is what the partner owes back after a
 * post-payout reversal (ADR 0005 R7), and future accruals offset it first.
 */
export interface ReferralPartnerBalance {
  partnerId: string;
  currency: CurrencyCode;
  /** Signed. Negative is a partner receivable, which R7 makes a real state. */
  outstandingMinor: number;
  /** What has been settled to this partner, ever. Never negative. */
  settledMinor: number;
  /** What a batch could pay right now — the payable rewards' nets, summed. */
  payableNowMinor: number;
}

/**
 * A payout batch as an operator reads it — every field #145's "Payout batches"
 * section names, and nothing else.
 *
 * There is no partner contact, no beneficiary detail and no rail credential:
 * `providerReference` is the rail's own opaque handle and
 * `payoutBeneficiaryRef` stays on the partner row where #142 put it.
 */
export interface ReferralPayoutBatchView {
  id: string;
  partnerId: string;
  currency: CurrencyCode;
  status: ReferralPayoutBatchStatus;
  /** Field 5 — the sum of the included rewards' nets. */
  grossEligibleMinor: number;
  /** Field 6 — withholding, when a jurisdiction requires it. Never negative. */
  withholdingMinor: number;
  /** Field 7 — `gross - withholding`. Never negative, a CHECK. */
  netPayoutMinor: number;
  /** Field 8 — the rail's own reference, once there is one. */
  providerReference?: string;
  /** Field 9 */
  failureReason?: ReferralPayoutFailureReason;
  failureDetail?: string;
  /** Field 10 */
  createdAt: string;
  approvedAt?: string;
  paidAt?: string;
  /** Field 11 — stable, so a retry converges on the rail. */
  idempotencyKey: string;
  /** Field 12 */
  createdByOxyUserId: string;
  approvedByOxyUserId?: string;
  itemCount: number;
}

/**
 * A partner's own view of one payout (ADR 0005 A5's allow-list, extended to the
 * batch: an amount, a date, a state, and nothing that names anybody else).
 *
 * No conversion id, no order reference, no funding record, no buyer-shaped field
 * at any aggregation level — the `ReferralRewardPartnerView` contract, one table
 * over.
 */
export interface ReferralPayoutBatchPartnerView {
  /** Day granularity, `YYYY-MM-DD`. */
  date: string;
  status: ReferralPayoutBatchStatus;
  netPayoutMinor: number;
  withholdingMinor: number;
  currency: CurrencyCode;
  itemCount: number;
}
