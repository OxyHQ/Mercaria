/**
 * The reconciliation sweep ADR 0005 makes a GATE on this issue (#145).
 *
 * > "The reward row's net amount (its own append-only adjustments) and the
 * > ledger's `referral_payable` must agree, and #145 must pin that agreement
 * > with a reconciliation sweep in the #50 mold — the payment domain already
 * > proved that 'two stores that must agree' without a sweep is a discrepancy
 * > nobody notices."
 *
 * They cannot disagree by construction: every posting commits in the same
 * transaction as the fact it books. The sweep exists anyway, for the reason
 * `findGlobalLedgerImbalances` gives about a global imbalance that is equally
 * impossible — "structurally impossible" and "nobody has ever checked" are
 * indistinguishable from outside the code, and this is the cheapest check in the
 * package.
 *
 * ## It DETECTS and never repairs
 *
 * The `payment_discrepancies` posture, and stronger here: every kind it can
 * record is a decision about a financial record. A missing posting could be
 * booked automatically and would then book money nobody authorised; a paid batch
 * with no posting could be un-paid and would then rewrite a payout ADR 0005 R7
 * says is never rewritten. There is no repair function in this file and no route
 * that could call one.
 *
 * ## Bounded, leased-free and resumable
 *
 * One partner per unit of work, paged over the partners who have postings, with
 * a caller-held cursor. There is no lease table: a second sweep running the same
 * page writes the same findings under the same dedupe keys and converges, which
 * is cheaper than a lease and has no expiry to get wrong.
 */

import type { CurrencyCode, ReferralEarningDiscrepancyKind } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import { listRewardsByPartner } from '../../../db/referrals/rewardRepository.js';
import {
  listPartnersWithPostings,
  rewardsMissingAccrualPosting,
  sumRewardPostingObligation,
  findPaidBatchesWithoutPosting,
} from '../../../db/referralEarnings/ledgerPostingRepository.js';
import {
  listPaidPayoutBatches,
  listPayoutBatchItems,
} from '../../../db/referralEarnings/payoutBatchRepository.js';
import { readReferralPartnerLedgerBalances } from '../../../db/referralEarnings/partnerBalanceRepository.js';
import { recordEarningDiscrepancy } from '../../../db/referralEarnings/discrepancyRepository.js';

/** How many of a partner's rewards and batches one pass examines. */
const PARTNER_REWARD_PAGE = 500;
const PARTNER_BATCH_PAGE = 100;

/** What one sweep pass measured. */
export interface ReferralReconciliationResult {
  partnersScanned: number;
  rewardsScanned: number;
  batchesScanned: number;
  findings: number;
  /** The last partner id examined — the caller's resumable cursor. */
  cursor?: string;
}

/**
 * Sweep one page of partners.
 *
 * Every counter is reported, including the ones that are usually zero: a pass
 * that scanned nothing and a pass that found nothing produce the same
 * `findings: 0`, and only `partnersScanned` tells them apart. That is the same
 * vacuity floor `catalog_backfill_runs_counters_total_check` states as a
 * constraint one domain over.
 */
export async function reconcileReferralEarnings(input: {
  limit?: number;
  cursor?: string;
  at?: Date;
}): Promise<ReferralReconciliationResult> {
  const at = input.at ?? new Date();
  const db = getDb();
  const partnerIds = await listPartnersWithPostings(db, {
    limit: input.limit ?? 25,
    ...(input.cursor ? { afterPartnerId: input.cursor } : {}),
  });

  let rewardsScanned = 0;
  let batchesScanned = 0;
  let findings = 0;

  for (const partnerId of partnerIds) {
    const partnerResult = await reconcilePartner(db, { partnerId, at });
    rewardsScanned += partnerResult.rewardsScanned;
    batchesScanned += partnerResult.batchesScanned;
    findings += partnerResult.findings;
  }

  return {
    partnersScanned: partnerIds.length,
    rewardsScanned,
    batchesScanned,
    findings,
    ...(partnerIds.length > 0 ? { cursor: partnerIds[partnerIds.length - 1] } : {}),
  };
}

/** One partner's five probes. Exported so the operator surface can run one. */
export async function reconcilePartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; at: Date },
): Promise<{ rewardsScanned: number; batchesScanned: number; findings: number }> {
  const rewards = await listRewardsByPartner(db, input.partnerId, PARTNER_REWARD_PAGE);
  const batches = await listPaidPayoutBatches(db, {
    partnerId: input.partnerId,
    limit: PARTNER_BATCH_PAGE,
  });
  let findings = 0;

  const record = async (
    kind: ReferralEarningDiscrepancyKind,
    subjectId: string,
    detail: {
      currency: CurrencyCode;
      expectedMinor: number;
      observedMinor: number;
      detail: string;
      rewardId?: string;
      payoutBatchId?: string;
    },
  ): Promise<void> => {
    const { created } = await recordEarningDiscrepancy(db, {
      kind,
      subjectId,
      partnerId: input.partnerId,
      currency: detail.currency,
      expectedMinor: detail.expectedMinor,
      observedMinor: detail.observedMinor,
      detail: detail.detail,
      observedAt: input.at,
      ...(detail.rewardId ? { rewardId: detail.rewardId } : {}),
      ...(detail.payoutBatchId ? { payoutBatchId: detail.payoutBatchId } : {}),
    });
    findings += 1;
    if (created) {
      await appendReferralEvent(db, {
        subjectType: 'partner',
        subjectId: input.partnerId,
        action: 'earnings_discrepancy_recorded',
        actorKind: 'system',
        reason: `${kind}: ${detail.detail}`,
      });
    }
  };

  // ── Probe 1: a reward with NO accrual posting ────────────────────────────
  // The one an automatic repair would be most tempting for, and the one where
  // it would book money nobody authorised.
  const unbooked = await rewardsMissingAccrualPosting(
    db,
    rewards.filter((reward) => reward.grossAmountMinor > 0).map((reward) => reward.id),
  );
  for (const rewardId of unbooked) {
    const reward = rewards.find((candidate) => candidate.id === rewardId);
    if (!reward) continue;
    await record('ledger_posting_missing', reward.id, {
      currency: reward.currency,
      expectedMinor: reward.grossAmountMinor,
      observedMinor: 0,
      rewardId: reward.id,
      detail:
        `reward ${reward.id} accrued ${String(reward.grossAmountMinor)} ${reward.currency} and ` +
        'has no `reward_accrued` posting',
    });
  }

  // ── Probe 2: the reward's net vs what its postings describe ──────────────
  for (const reward of rewards) {
    if (unbooked.has(reward.id)) continue;
    const obligation = await sumRewardPostingObligation(db, reward.id);
    if (obligation === reward.netAmountMinor) continue;
    await record('reward_net_disagrees_with_ledger', reward.id, {
      currency: reward.currency,
      expectedMinor: reward.netAmountMinor,
      observedMinor: obligation,
      rewardId: reward.id,
      detail:
        `reward ${reward.id} carries a net of ${String(reward.netAmountMinor)} while its ` +
        `postings describe ${String(obligation)} ${reward.currency}`,
    });
  }

  // ── Probe 3: a PAID batch that booked nothing ────────────────────────────
  const unpostedBatches = await findPaidBatchesWithoutPosting(db, {
    batchIds: batches.map((batch) => batch.id),
  });
  for (const batchId of unpostedBatches) {
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) continue;
    await record('payout_without_ledger_posting', batch.id, {
      currency: batch.currency,
      expectedMinor: batch.netPayoutMinor,
      observedMinor: 0,
      payoutBatchId: batch.id,
      detail:
        `batch ${batch.id} is \`paid\` for ${String(batch.netPayoutMinor)} ${batch.currency} and ` +
        'booked no `payout_settled` posting',
    });
  }

  // ── Probe 4: a batch header that disagrees with its own items ────────────
  for (const batch of batches) {
    const items = await listPayoutBatchItems(db, batch.id);
    const live = items.filter((item) => item.releasedAt === null);
    const itemTotal = live.reduce((total, item) => total + item.netAmountMinor, 0);
    if (itemTotal === batch.grossEligibleMinor) continue;
    await record('batch_total_disagrees_with_items', batch.id, {
      currency: batch.currency,
      expectedMinor: batch.grossEligibleMinor,
      observedMinor: itemTotal,
      payoutBatchId: batch.id,
      detail:
        `batch ${batch.id} claims a gross of ${String(batch.grossEligibleMinor)} while its ` +
        `${String(live.length)} live items sum to ${String(itemTotal)} ${batch.currency}`,
    });
  }

  // ── Probe 5: a paid reward with no batch item to explain it ──────────────
  const paidRewards = rewards.filter((reward) => reward.state === 'paid');
  if (paidRewards.length > 0) {
    const claimedIds = new Set<string>();
    for (const batch of batches) {
      for (const item of await listPayoutBatchItems(db, batch.id)) claimedIds.add(item.rewardId);
    }
    for (const reward of paidRewards) {
      if (claimedIds.has(reward.id)) continue;
      await record('paid_reward_without_batch_item', reward.id, {
        currency: reward.currency,
        expectedMinor: reward.netAmountMinor,
        observedMinor: 0,
        rewardId: reward.id,
        detail: `reward ${reward.id} is \`paid\` and no payout batch item names it`,
      });
    }
  }

  // ── Probe 6: a negative payable with no liability to explain it ──────────
  // A negative balance is ADR 0005 R7 working — a reward reversed after payout.
  // What it must never be is a balance nobody can account for, so the probe
  // compares it against the recorded liabilities rather than against zero.
  //
  // It is SKIPPED when the reward page came back FULL, and that is not caution:
  // this is the one probe that aggregates a bounded page against a whole-partner
  // ledger figure, so a partner with more rewards than the page holds would show
  // a shortfall that is an artefact of the bound. A finding that means "we did
  // not read far enough" is worse than none — it is the vacuous measurement this
  // whole sweep exists to avoid, wearing a discrepancy's name.
  const balances = await readReferralPartnerLedgerBalances(db, input.partnerId);
  if (rewards.length >= PARTNER_REWARD_PAGE) return {
    rewardsScanned: rewards.length,
    batchesScanned: batches.length,
    findings,
  };
  for (const balance of balances) {
    if (balance.outstandingMinor >= 0) continue;
    const liabilities = rewards
      .filter((reward) => reward.currency === balance.currency && reward.state === 'paid')
      .reduce((total, reward) => total + (reward.grossAmountMinor - reward.netAmountMinor), 0);
    if (liabilities >= -balance.outstandingMinor) continue;
    await record('partner_balance_negative_without_liability', `${input.partnerId}`, {
      currency: balance.currency,
      expectedMinor: -liabilities,
      observedMinor: balance.outstandingMinor,
      detail:
        `partner ${input.partnerId} owes ${String(-balance.outstandingMinor)} ` +
        `${balance.currency} back and the recorded post-payout reversals account for only ` +
        String(liabilities),
    });
  }

  return { rewardsScanned: rewards.length, batchesScanned: batches.length, findings };
}
