/**
 * Payout batches: building one, approving it, settling it, cancelling it (#145
 * "Payout batches"; ADR 0005 D14/D15).
 *
 * ## The rail is called OUTSIDE any transaction, and that is not an optimisation
 *
 * `settlePayoutBatch` runs three steps: a transaction that claims the batch by
 * moving it `approved → processing`, the rail call, and a transaction that
 * records the outcome. Holding a row lock across a provider call makes the lock's
 * duration a function of somebody else's availability — the #109 ruling, and the
 * reason the payment domain commits its refund before calling Stripe.
 *
 * The claim is what makes that safe: `processing` is a status only one CAS can
 * reach, so a second worker finds nothing to do rather than paying twice.
 *
 * ## A batch that no longer describes what is owed FAILS rather than shrinking
 *
 * If a reversal lands between the approval and the settlement, the settlement
 * refuses with `amount_no_longer_payable` and stops. It deliberately does NOT
 * pay the smaller figure: #59's ruling that "the set an operator approved with an
 * impact estimate beside it is the set that executes" is the same decision, and
 * paying €95 against an approval for €120 is an amount nobody signed. The remedy
 * is one operator call — cancel, which releases every claim — and the next build
 * makes a batch over what is still payable, for them to approve.
 *
 * ## Withholding is MODELLED and UNSETTLEABLE
 *
 * #145's field 6 is a real column and an operator may set it. Settlement then
 * refuses `withholding_not_supported`, because there is no ledger account for
 * withheld money to sit in and inventing one would put a remittance obligation
 * in a book nobody reconciles against a tax authority.
 *
 * **#146 settled that and the refusal is now PERMANENT rather than pending.**
 * ADR 0005 D15 has Mercaria withhold nothing and issue an annual earnings
 * statement per partner, with partners responsible for their own income tax —
 * no withholding means no remittance obligation, so no `tax_withheld` account
 * may be added. DAC7 is ADR 0005 open item 1 and would change what #146's tax
 * questionnaire COLLECTS, never what this ledger holds.
 */

import { uuidv7 } from '@oxyhq/db';
import {
  REFERRAL_RETRYABLE_PAYOUT_FAILURES,
  type CurrencyCode,
  type ReferralPayoutFailureReason,
} from '@mercaria/shared-types';
import { conflict, notFound } from '../../../lib/errors/error-codes.js';
import { log } from '../../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import { resolveProgramControls } from '../../../db/referrals/programControlRepository.js';
import {
  listRewardsInState,
  setRewardState,
  type ReferralRewardRow,
} from '../../../db/referrals/rewardRepository.js';
import { recordRewardTransition } from '../../../db/referralEarnings/rewardTransitionRepository.js';
import {
  claimRewardForBatch,
  findLiveClaimedRewardIds,
  findOpenPayoutBatch,
  findPayoutBatchById,
  listLivePayoutBatchItems,
  listPayoutBatchesInStatus,
  openPayoutBatch,
  referralPayoutIdempotencyKey,
  releaseBatchItems,
  transitionPayoutBatch,
  REFERRAL_PAYOUT_SYSTEM_ACTOR,
  type ReferralPayoutBatchRow,
} from '../../../db/referralEarnings/payoutBatchRepository.js';
import { findLatestTaxProfile } from '../../../db/referrals/taxProfileRepository.js';
import { deriveTaxReadiness } from '../tax-profile.service.js';
import { readReferralPartnerReadiness } from './partner-readiness.port.js';
import { bookPayoutSettlement } from './posting.service.js';
import {
  deriveBatchEligibility,
  deriveRewardPayability,
  type PayoutGateFacts,
} from './payability.js';
import { resolveReferralPayoutRail } from './payout-rail.port.js';

/** How many of a partner's vested rewards one batch may carry. */
const BATCH_REWARD_LIMIT = 500;

/** What building a batch produced. A STRING discriminant, as everywhere here. */
export type BuildPayoutBatchResult =
  | { outcome: 'opened'; batch: ReferralPayoutBatchRow; rewardCount: number }
  | { outcome: 'nothing_payable'; reasons: readonly string[] }
  | { outcome: 'batch_already_open'; batch: ReferralPayoutBatchRow };

/**
 * Build a batch over everything one partner may currently be paid in one
 * currency.
 *
 * Runs in ONE transaction: the batch header and every claim commit together, so
 * a crash mid-build leaves no batch holding half its rewards and no total that
 * describes something else.
 *
 * The gate facts are read fresh here and re-read at settlement, which is not
 * duplication: a partner can lose readiness in between, and the second read is
 * the one that decides whether money actually moves.
 */
export async function buildPayoutBatchForPartner(input: {
  partnerId: string;
  programId: string;
  currency: CurrencyCode;
  createdByOxyUserId: string;
  /** ADR 0005 D14's exception: a final payout ignores the minimum. */
  finalPayout?: boolean;
  withholdingMinor?: number;
}): Promise<BuildPayoutBatchResult> {
  // No clock parameter, deliberately: nothing a build decides depends on one.
  // The batch's own `created_at` is the database's, the payability gate reads
  // stored state, and the minimum is a constant — so an injected instant here
  // would be a parameter nothing honours.
  const db = getDb();

  const existing = await findOpenPayoutBatch(db, {
    partnerId: input.partnerId,
    currency: input.currency,
  });
  if (existing) return { outcome: 'batch_already_open', batch: existing };

  return await db.transaction(async (tx) => {
    const facts = await readPartnerGateFacts(tx, {
      partnerId: input.partnerId,
      programId: input.programId,
    });
    const candidates = await listRewardsInState(tx, {
      partnerId: input.partnerId,
      currency: input.currency,
      states: ['vested'],
      limit: BATCH_REWARD_LIMIT,
    });
    const claimed = await findLiveClaimedRewardIds(
      tx,
      candidates.map((reward) => reward.id),
    );

    const payable: ReferralRewardRow[] = [];
    const blocked = new Set<string>();
    for (const reward of candidates) {
      const verdict = deriveRewardPayability({
        ...facts,
        rewardState: reward.state,
        rewardNetAmountMinor: reward.netAmountMinor,
        rewardCurrency: reward.currency,
        claimedByOpenBatch: claimed.has(reward.id),
      });
      if (verdict.verdict === 'payable') payable.push(reward);
      else for (const reason of verdict.reasons) blocked.add(reason);
    }

    const gross = payable.reduce((total, reward) => total + reward.netAmountMinor, 0);
    const withholding = input.withholdingMinor ?? 0;
    const eligibility = deriveBatchEligibility({
      currency: input.currency,
      grossEligibleMinor: gross,
      withholdingMinor: withholding,
      finalPayout: input.finalPayout ?? false,
    });
    if (eligibility.verdict === 'blocked') {
      return {
        outcome: 'nothing_payable',
        reasons: [...new Set([...blocked, ...eligibility.reasons])],
      };
    }

    const batchId = uuidv7();
    const batch = await openPayoutBatch(tx, {
      batchId,
      partnerId: input.partnerId,
      programId: input.programId,
      currency: input.currency,
      grossEligibleMinor: gross,
      withholdingMinor: withholding,
      createdByOxyUserId: input.createdByOxyUserId,
    });
    // The partial unique refused it: another builder opened one between the read
    // above and here. Reporting it is right — retrying would race again.
    if (!batch) {
      const rival = await findOpenPayoutBatch(tx, {
        partnerId: input.partnerId,
        currency: input.currency,
      });
      if (!rival) throw conflict('A referral payout batch could not be opened');
      return { outcome: 'batch_already_open', batch: rival };
    }

    for (const reward of payable) {
      const item = await claimRewardForBatch(tx, {
        batchId: batch.id,
        rewardId: reward.id,
        netAmountMinor: reward.netAmountMinor,
        currency: reward.currency,
      });
      // A claim the partial unique refused means a rival batch took it between
      // the probe and here. The header would then overstate what this batch
      // holds, so the whole build rolls back rather than paying a total it
      // cannot cover.
      if (!item) {
        throw conflict(
          `Referral reward ${reward.id} was claimed by another payout batch while this one was ` +
            'being built.',
        );
      }
    }

    await appendReferralEvent(tx, {
      subjectType: 'payout_batch',
      subjectId: batch.id,
      action: 'payout_batch_opened',
      actorKind: input.createdByOxyUserId === REFERRAL_PAYOUT_SYSTEM_ACTOR ? 'system' : 'operator',
      ...(input.createdByOxyUserId === REFERRAL_PAYOUT_SYSTEM_ACTOR
        ? {}
        : { actorRef: input.createdByOxyUserId }),
      reason:
        `opened over ${String(payable.length)} vested rewards, ` +
        `${String(eligibility.netPayoutMinor)} ${input.currency} net`,
    });

    return { outcome: 'opened', batch, rewardCount: payable.length };
  });
}

/** Approve a batch — the second pair of eyes, attributably. */
export async function approvePayoutBatch(input: {
  batchId: string;
  approvedByOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPayoutBatchRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const moved = await transitionPayoutBatch(tx, {
      batchId: input.batchId,
      expected: ['draft'],
      to: 'approved',
      at,
      approvedByOxyUserId: input.approvedByOxyUserId,
    });
    if (!moved) {
      throw conflict('That referral payout batch is not awaiting approval');
    }
    await appendReferralEvent(tx, {
      subjectType: 'payout_batch',
      subjectId: moved.id,
      action: 'payout_batch_approved',
      actorKind: 'operator',
      actorRef: input.approvedByOxyUserId,
      reason: input.reason,
    });
    return moved;
  });
}

/**
 * Cancel a batch and hand its rewards back.
 *
 * The ONLY status that releases a claim. A cancelled batch keeps its items — the
 * rows stay, carrying `released_at` — so "which batch held this reward in March"
 * is still answerable, which is what makes acceptance 4 (reversals cannot erase
 * history) true of the payout side too.
 */
export async function cancelPayoutBatch(input: {
  batchId: string;
  cancelledByOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<{ batch: ReferralPayoutBatchRow; released: number }> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const moved = await transitionPayoutBatch(tx, {
      batchId: input.batchId,
      expected: ['draft', 'approved', 'failed'],
      to: 'cancelled',
      at,
      cancelledByOxyUserId: input.cancelledByOxyUserId,
      failureDetail: input.reason,
    });
    // `processing` is deliberately not cancellable: a rail call is in flight and
    // nobody here knows whether the money moved.
    if (!moved) {
      throw conflict(
        'That referral payout batch cannot be cancelled — a settled or in-flight batch is not ' +
          'withdrawable.',
      );
    }
    const released = await releaseBatchItems(tx, { batchId: moved.id, at });
    await appendReferralEvent(tx, {
      subjectType: 'payout_batch',
      subjectId: moved.id,
      action: 'payout_batch_cancelled',
      actorKind: 'operator',
      actorRef: input.cancelledByOxyUserId,
      reason: `${input.reason} (${String(released)} rewards released)`,
    });
    return { batch: moved, released };
  });
}

/** What one settlement attempt did. */
export type SettlePayoutBatchResult =
  | { outcome: 'settled'; batch: ReferralPayoutBatchRow }
  | { outcome: 'failed'; batch: ReferralPayoutBatchRow; reason: ReferralPayoutFailureReason }
  | { outcome: 'not_claimable' };

/**
 * Settle one approved batch: claim it, ask the rail, record what happened.
 *
 * Three steps and only the first and third touch the database. See the file
 * docblock for why the rail call sits between them rather than inside either.
 */
export async function settlePayoutBatch(input: {
  batchId: string;
  at?: Date;
}): Promise<SettlePayoutBatchResult> {
  const at = input.at ?? new Date();
  const db = getDb();

  // ── 1. Claim, and re-derive what is actually owed ────────────────────────
  const claim = await db.transaction(async (tx) => {
    const batch = await findPayoutBatchById(tx, input.batchId);
    if (!batch) throw notFound('Referral payout batch not found');
    if (batch.status !== 'approved' && batch.status !== 'failed') return undefined;

    const items = await listLivePayoutBatchItems(tx, batch.id);
    const facts = await readPartnerGateFacts(tx, {
      partnerId: batch.partnerId,
      programId: batch.programId,
    });
    const rewards = await listRewardsInState(tx, {
      partnerId: batch.partnerId,
      currency: batch.currency,
      states: ['vested'],
      limit: BATCH_REWARD_LIMIT,
    });
    const stillPayable = new Map(rewards.map((reward) => [reward.id, reward]));

    let live = 0;
    for (const item of items) {
      const reward = stillPayable.get(item.rewardId);
      if (!reward) continue;
      const verdict = deriveRewardPayability({
        ...facts,
        rewardState: reward.state,
        rewardNetAmountMinor: reward.netAmountMinor,
        rewardCurrency: reward.currency,
        // The batch's OWN claim must not block its own settlement.
        claimedByOpenBatch: false,
      });
      if (verdict.verdict === 'payable' && reward.netAmountMinor === item.netAmountMinor) live += 1;
    }

    if (items.length === 0 || live !== items.length) {
      const failed = await transitionPayoutBatch(tx, {
        batchId: batch.id,
        expected: [batch.status],
        to: 'failed',
        at,
        failureReason: 'amount_no_longer_payable',
        failureDetail:
          `${String(live)} of ${String(items.length)} claimed rewards are still payable at the ` +
          'amount this batch was approved for. Cancel it and build a fresh batch over what ' +
          'remains — a smaller payout is an amount nobody approved.',
      });
      return failed ? { batch: failed, blocked: 'amount_no_longer_payable' as const } : undefined;
    }

    if (batch.withholdingMinor > 0) {
      const failed = await transitionPayoutBatch(tx, {
        batchId: batch.id,
        expected: [batch.status],
        to: 'failed',
        at,
        failureReason: 'withholding_not_supported',
        failureDetail:
          'This batch carries a withholding and Mercaria has no ledger account for withheld ' +
          'money to sit in. #141/#146 own the compliance decision.',
      });
      return failed ? { batch: failed, blocked: 'withholding_not_supported' as const } : undefined;
    }

    const moved = await transitionPayoutBatch(tx, {
      batchId: batch.id,
      expected: [batch.status],
      to: 'processing',
      at,
    });
    if (!moved) return undefined;
    // The beneficiary is the one the GATE just derived, not a column read
    // beside it: the rail must be handed the destination the same read decided
    // was payable, or the two could differ by whatever happened in between.
    return {
      batch: moved,
      partnerBeneficiaryRef: facts.payoutBeneficiaryRef,
      blocked: undefined,
    };
  });

  if (!claim) return { outcome: 'not_claimable' };
  if (claim.blocked !== undefined) {
    await recordBatchFailure(claim.batch, claim.blocked);
    return { outcome: 'failed', batch: claim.batch, reason: claim.blocked };
  }

  // ── 2. The rail, outside any transaction ─────────────────────────────────
  const rail = resolveReferralPayoutRail();
  const beneficiaryRef = claim.partnerBeneficiaryRef;
  const outcome = !rail
    ? ({ outcome: 'unavailable', detail: 'no referral payout rail is registered' } as const)
    : !beneficiaryRef
      ? ({
          outcome: 'refused',
          reason: 'beneficiary_not_payable',
          detail: 'the partner has no payout beneficiary',
        } as const)
      : await rail({
          batchId: claim.batch.id,
          partnerId: claim.batch.partnerId,
          payoutBeneficiaryRef: beneficiaryRef,
          amountMinor: claim.batch.netPayoutMinor,
          currency: claim.batch.currency,
          idempotencyKey: referralPayoutIdempotencyKey(claim.batch.id),
        });

  // ── 3. Record what happened ──────────────────────────────────────────────
  if (outcome.outcome === 'settled') {
    const settled = await db.transaction(async (tx) => await applySettlement(tx, {
      batchId: claim.batch.id,
      providerReference: outcome.providerReference,
      at,
    }));
    if (!settled) return { outcome: 'not_claimable' };
    return { outcome: 'settled', batch: settled };
  }

  const reason: ReferralPayoutFailureReason =
    outcome.outcome === 'refused'
      ? outcome.reason
      : rail
        ? 'rail_unavailable'
        : 'rail_not_configured';
  const failed = await db.transaction(async (tx) => {
    const moved = await transitionPayoutBatch(tx, {
      batchId: claim.batch.id,
      expected: ['processing'],
      to: 'failed',
      at,
      failureReason: reason,
      failureDetail: outcome.detail,
    });
    if (moved) {
      await appendReferralEvent(tx, {
        subjectType: 'payout_batch',
        subjectId: moved.id,
        action: 'payout_batch_failed',
        actorKind: 'system',
        reason: `${reason}: ${outcome.detail}`,
      });
    }
    return moved;
  });
  if (!failed) return { outcome: 'not_claimable' };
  return { outcome: 'failed', batch: failed, reason };
}

/**
 * Book the money and move every reward to `paid`, in ONE transaction.
 *
 * The ledger posting, the batch status and each reward's transition commit
 * together. A reward marked `paid` whose payout the book never recorded is an
 * obligation that vanished, and a posting whose rewards are still `vested` is
 * one that would be paid twice by the next batch.
 */
async function applySettlement(
  tx: DatabaseOrTransaction,
  input: { batchId: string; providerReference: string; at: Date },
): Promise<ReferralPayoutBatchRow | undefined> {
  const moved = await transitionPayoutBatch(tx, {
    batchId: input.batchId,
    expected: ['processing'],
    to: 'paid',
    at: input.at,
    providerReference: input.providerReference,
  });
  if (!moved) return undefined;

  await bookPayoutSettlement(tx, { batch: moved, occurredAt: input.at });

  const items = await listLivePayoutBatchItems(tx, moved.id);
  for (const item of items) {
    const paid = await setRewardState(tx, {
      rewardId: item.rewardId,
      expected: ['vested'],
      to: 'paid',
      at: input.at,
    });
    // The CAS is the batch's own claim working: nothing else can move a reward
    // this batch holds, so a loss here means the world changed under a settled
    // payout and the transaction must not commit half of it.
    if (!paid) {
      throw conflict(
        `Referral reward ${item.rewardId} was not \`vested\` at settlement of batch ` +
          `${moved.id}; the payout is rolling back.`,
      );
    }
    await recordRewardTransition(tx, {
      rewardId: item.rewardId,
      fromState: 'vested',
      toState: 'paid',
      cause: 'payout_settled',
      sourceRef: moved.id,
      actorKind: 'system',
      reason: `settled by payout batch ${moved.id}`,
      occurredAt: input.at,
    });
    await appendReferralEvent(tx, {
      subjectType: 'reward',
      subjectId: item.rewardId,
      action: 'reward_payout_settled',
      actorKind: 'system',
      reason: `paid ${String(item.netAmountMinor)} ${item.currency} in batch ${moved.id}`,
    });
  }

  await appendReferralEvent(tx, {
    subjectType: 'payout_batch',
    subjectId: moved.id,
    action: 'payout_batch_settled',
    actorKind: 'system',
    reason: `${String(moved.netPayoutMinor)} ${moved.currency} over ${String(items.length)} rewards`,
  });
  return moved;
}

/** The audit line for a failure decided before the rail was ever asked. */
async function recordBatchFailure(
  batch: ReferralPayoutBatchRow,
  reason: ReferralPayoutFailureReason,
): Promise<void> {
  const db = getDb();
  await appendReferralEvent(db, {
    subjectType: 'payout_batch',
    subjectId: batch.id,
    action: 'payout_batch_failed',
    actorKind: 'system',
    reason: `${reason}: ${batch.failureDetail ?? 'refused before the rail was called'}`,
  });
}

/**
 * The gate facts for one partner under one program.
 *
 * Read in one place so the build and the settlement cannot disagree about what
 * they mean — two spellings of "is this partner payable" is exactly the pair
 * that drifts.
 */
async function readPartnerGateFacts(
  db: DatabaseOrTransaction,
  input: { partnerId: string; programId: string },
): Promise<
  Omit<
    PayoutGateFacts,
    'rewardState' | 'rewardNetAmountMinor' | 'rewardCurrency' | 'claimedByOpenBatch'
  > & { payoutBeneficiaryRef: string | undefined }
> {
  const partner = await findPartnerById(db, input.partnerId);
  if (!partner) throw notFound('Referral partner not found');
  const controls = await resolveProgramControls(db, input.programId);

  // #146: all three summaries and the beneficiary are DERIVED here, never read
  // off the partner row. The stored columns are an OBSERVATION of what the
  // derivation last said (`recordPartnerReadinessObservation` is their only
  // writer) and go stale the instant Stripe restricts an account — and the one
  // place that must not happen is a batch builder including somebody it should
  // not. This is the `deriveNativeCheckoutEligibility` divergence from the
  // one-stored-verdict rule, taken for the reason that rule itself gives: the
  // inputs sit on tables this domain does not own.
  const readiness = await readReferralPartnerReadiness({
    partnerId: partner.id,
    ownerType: partner.ownerType,
    ownerId: partner.ownerId,
  });
  const tax = deriveTaxReadiness(await findLatestTaxProfile(db, partner.id));

  return {
    partnerState: partner.state,
    identityReadiness: readiness.identity,
    taxReadiness: tax,
    payoutReadiness: readiness.payout,
    hasPayoutBeneficiary: (readiness.payoutBeneficiaryRef ?? '') !== '',
    payoutBeneficiaryRef: readiness.payoutBeneficiaryRef,
    programPayoutEnabled: controls.payoutEnabled,
  };
}

/** What one settlement pass did. */
export interface PayoutSettlementSweepResult {
  scanned: number;
  settled: number;
  failed: number;
}

/**
 * Settle every approved batch, one page at a time.
 *
 * `failed` batches are retried too, but only those whose reason a retry could
 * FIX (`REFERRAL_RETRYABLE_PAYOUT_FAILURES`) — which is what makes a rail outage
 * recover by itself, on the batch's own idempotency key, while a batch that
 * failed because it no longer describes what is owed waits for the operator who
 * has to cancel it. Retrying that one would spin against a condition no attempt
 * can move.
 */
export async function settleApprovedBatches(input: {
  limit?: number;
  retryAfterMs?: number;
  at?: Date;
}): Promise<PayoutSettlementSweepResult> {
  const at = input.at ?? new Date();
  const limit = input.limit ?? 25;
  const db = getDb();
  const batches = await listPayoutBatchesInStatus(db, {
    statuses: ['approved', 'failed'],
    limit,
    ...(input.retryAfterMs !== undefined
      ? { notAttemptedSince: new Date(at.getTime() - input.retryAfterMs) }
      : {}),
  });

  let settled = 0;
  let failed = 0;
  for (const batch of batches) {
    // A `failed` batch whose reason a retry cannot fix is left for a person.
    if (
      batch.status === 'failed' &&
      (batch.failureReason === null ||
        !REFERRAL_RETRYABLE_PAYOUT_FAILURES.includes(batch.failureReason))
    ) {
      continue;
    }
    try {
      const result = await settlePayoutBatch({ batchId: batch.id, at });
      if (result.outcome === 'settled') settled += 1;
      else if (result.outcome === 'failed') failed += 1;
    } catch (error) {
      // One batch's fault must not stop the page: a settlement that threw has
      // left the batch `processing`, which the next pass does not claim, so it
      // is visible to the operator surface rather than retried blindly.
      failed += 1;
      log.general.error(
        { err: error, batchId: batch.id },
        '[Referrals] a payout batch settlement threw',
      );
    }
  }
  return { scanned: batches.length, settled, failed };
}
