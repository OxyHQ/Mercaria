/**
 * The reads: a partner's balance, and the operator trace (#145 "Operator
 * trace").
 *
 * ## The balance is DERIVED and there is no balance table
 *
 * `#145 acceptance 1`: reward balances are fully derivable from immutable
 * entries, and `ledger_entries` is where those entries are. `outstandingMinor`
 * is the signed `referral_payable` position — positive is owed, negative is a
 * partner receivable after a post-payout reversal (ADR 0005 R7) — and
 * `payableNowMinor` is what a batch could actually pay right now, which is a
 * different question and is answered by the same gate the batch builder uses.
 *
 * ## The trace opens from a PARTNER and nothing else
 *
 * `partner → attribution → conversion → rule → funding → reward entries →
 * hold/vesting → reversal → payout batch → provider payout` is #145's own
 * chain, and every hop of it is reachable from a partner id. There is no email,
 * no order, no buyer and no guest credential anywhere in the shapes below —
 * "buyer private data and guest credentials are excluded" is held by what the
 * projection can carry rather than by a filter somebody applies.
 */

import type { CurrencyCode, ReferralPartnerBalance } from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb } from '../../../db/postgres.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import { resolveProgramControls } from '../../../db/referrals/programControlRepository.js';
import { findLatestTaxProfile } from '../../../db/referrals/taxProfileRepository.js';
import { deriveTaxReadiness } from '../tax-profile.service.js';
import { readReferralPartnerReadiness } from './partner-readiness.port.js';
import {
  listRewardAdjustments,
  listRewardsByPartner,
  listRewardsInState,
  type ReferralRewardRow,
} from '../../../db/referrals/rewardRepository.js';
import { readReferralPartnerLedgerBalances } from '../../../db/referralEarnings/partnerBalanceRepository.js';
import {
  listReferralLedgerPostingsForPartner,
  type ReferralLedgerPostingRow,
} from '../../../db/referralEarnings/ledgerPostingRepository.js';
import {
  findLiveClaimedRewardIds,
  listPayoutBatchesForPartner,
  listPayoutBatchItems,
  type ReferralPayoutBatchRow,
} from '../../../db/referralEarnings/payoutBatchRepository.js';
import {
  listRewardTransitions,
  type ReferralRewardTransitionRow,
} from '../../../db/referralEarnings/rewardTransitionRepository.js';
import { deriveRewardPayability } from './payability.js';

/** How many rewards, batches and postings one trace carries. */
const TRACE_PAGE = 100;

/**
 * One partner's balances, per currency.
 *
 * `payableNowMinor` runs the SAME `deriveRewardPayability` the batch builder
 * runs. Two derivations of "what could we pay" would disagree exactly when a
 * partner asked why the figure on their dashboard did not arrive.
 */
export async function readReferralPartnerBalances(input: {
  partnerId: string;
  programId: string;
}): Promise<ReferralPartnerBalance[]> {
  const db = getDb();
  const partner = await findPartnerById(db, input.partnerId);
  if (!partner) throw notFound('Referral partner not found');
  const controls = await resolveProgramControls(db, input.programId);
  const ledgerBalances = await readReferralPartnerLedgerBalances(db, input.partnerId);

  // #146: derived, exactly as the batch builder derives them. A dashboard
  // reading the stored observation while the builder read the live verdict is
  // how "why have I not been paid" acquires two answers — and the figure this
  // read publishes is the one a partner will hold Mercaria to.
  const readiness = await readReferralPartnerReadiness({
    partnerId: partner.id,
    ownerType: partner.ownerType,
    ownerId: partner.ownerId,
  });
  const taxReadiness = deriveTaxReadiness(await findLatestTaxProfile(db, partner.id));

  const balances: ReferralPartnerBalance[] = [];
  for (const balance of ledgerBalances) {
    const vested = await listRewardsInState(db, {
      partnerId: input.partnerId,
      currency: balance.currency,
      states: ['vested'],
      limit: TRACE_PAGE,
    });
    const claimed = await findLiveClaimedRewardIds(
      db,
      vested.map((reward) => reward.id),
    );
    const payableNowMinor = vested.reduce((total, reward) => {
      const verdict = deriveRewardPayability({
        rewardState: reward.state,
        rewardNetAmountMinor: reward.netAmountMinor,
        rewardCurrency: reward.currency,
        claimedByOpenBatch: claimed.has(reward.id),
        partnerState: partner.state,
        identityReadiness: readiness.identity,
        taxReadiness,
        payoutReadiness: readiness.payout,
        hasPayoutBeneficiary: (readiness.payoutBeneficiaryRef ?? '') !== '',
        programPayoutEnabled: controls.payoutEnabled,
      });
      return verdict.verdict === 'payable' ? total + verdict.netAmountMinor : total;
    }, 0);

    balances.push({
      partnerId: input.partnerId,
      currency: balance.currency,
      outstandingMinor: balance.outstandingMinor,
      settledMinor: balance.settledMinor,
      payableNowMinor,
    });
  }
  return balances;
}

/** One reward as the trace renders it — every hop #145 names, in one shape. */
export interface ReferralEarningsTraceReward {
  reward: ReferralRewardRow;
  transitions: readonly ReferralRewardTransitionRow[];
  adjustments: readonly { id: string; cause: string; deltaAmountMinor: number; recoveryState: string; occurredAt: Date }[];
  postings: readonly ReferralLedgerPostingRow[];
  /** The batch that settled it, when one has. */
  payoutBatchId?: string;
}

/** The whole trace. Opens from a partner id and carries no buyer-shaped field. */
export interface ReferralEarningsTrace {
  partnerId: string;
  balances: readonly ReferralPartnerBalance[];
  rewards: readonly ReferralEarningsTraceReward[];
  batches: readonly ReferralPayoutBatchRow[];
  postings: readonly ReferralLedgerPostingRow[];
}

/**
 * The operator trace.
 *
 * Composed here rather than in the controller because the JOIN is what goes
 * wrong: a client asking for rewards, transitions, postings and batches
 * separately would page each of them differently and silently drop whichever
 * reward fell outside one window — the #71 argument for server-side
 * composition, applied to an audit trail.
 */
export async function traceReferralEarnings(input: {
  partnerId: string;
  programId: string;
}): Promise<ReferralEarningsTrace> {
  const db = getDb();
  const balances = await readReferralPartnerBalances(input);
  const rewards = await listRewardsByPartner(db, input.partnerId, TRACE_PAGE);
  const batches = await listPayoutBatchesForPartner(db, {
    partnerId: input.partnerId,
    limit: TRACE_PAGE,
  });
  const postings = await listReferralLedgerPostingsForPartner(db, {
    partnerId: input.partnerId,
    limit: TRACE_PAGE,
  });

  const batchByReward = new Map<string, string>();
  for (const batch of batches) {
    for (const item of await listPayoutBatchItems(db, batch.id)) {
      if (item.releasedAt === null) batchByReward.set(item.rewardId, batch.id);
    }
  }

  const traced: ReferralEarningsTraceReward[] = [];
  for (const reward of rewards) {
    const adjustments = await listRewardAdjustments(db, reward.id);
    traced.push({
      reward,
      transitions: await listRewardTransitions(db, reward.id),
      adjustments: adjustments.map((adjustment) => ({
        id: adjustment.id,
        cause: adjustment.cause,
        deltaAmountMinor: adjustment.deltaAmountMinor,
        recoveryState: adjustment.recoveryState,
        occurredAt: adjustment.occurredAt,
      })),
      postings: postings.filter((posting) => posting.rewardId === reward.id),
      ...(batchByReward.has(reward.id)
        ? { payoutBatchId: batchByReward.get(reward.id) as string }
        : {}),
    });
  }

  return { partnerId: input.partnerId, balances, rewards: traced, batches, postings };
}

/**
 * A partner's own view of their payouts — ADR 0005 A5's allow-list, extended to
 * the batch.
 *
 * Day granularity, a status, two amounts, a currency and a count. No conversion
 * id, no order reference, no funding record, no provider reference and no
 * beneficiary: the projection NAMES every field it carries, which is the #46
 * device this domain has used since #142.
 */
export function toReferralPayoutBatchPartnerView(batch: ReferralPayoutBatchRow, itemCount: number): {
  date: string;
  status: string;
  netPayoutMinor: number;
  withholdingMinor: number;
  currency: CurrencyCode;
  itemCount: number;
} {
  return {
    date: (batch.paidAt ?? batch.createdAt).toISOString().slice(0, 10),
    status: batch.status,
    netPayoutMinor: batch.netPayoutMinor,
    withholdingMinor: batch.withholdingMinor,
    currency: batch.currency as CurrencyCode,
    itemCount,
  };
}
