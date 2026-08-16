/**
 * One partner's own earnings, in the shape ADR 0005 A5 permits (#147 "Earnings
 * detail").
 *
 * ## Two sources, and they are asked to agree
 *
 * The per-state figures come from `referral_rewards`, because a state is a
 * property of a reward; the outstanding and settled positions come from
 * `ledger_entries`, because #145 acceptance 1 makes the ledger the authority on
 * what is owed and there is deliberately no balance table.
 *
 * Two stores that must agree without something comparing them is a discrepancy
 * nobody notices — the reason #145 ships a reconciliation sweep at all. This
 * read runs the same comparison at the moment a partner looks, and publishes
 * `ledgerAgrees` beside the figures. It repairs NOTHING (the
 * `payment_discrepancies` posture): the sweep records findings, a person acts
 * on them, and a read surface that quietly corrected one would be rewriting
 * financial history to make a screen look tidy.
 *
 * ## Nothing here is forgeable by a client
 *
 * #147 acceptance 2. Every figure is read from a table a client cannot write:
 * `referral_rewards` is written only by #144's accrual and #145's transitions,
 * `ledger_entries` only by `insertLedgerTransaction`. No request parameter
 * reaches an amount, and there is no amount on any request schema in this
 * domain to reach one with.
 */

import {
  REFERRAL_METRIC_DEFINITIONS,
  REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY,
  type CurrencyCode,
  type ReferralEarningsByCurrency,
  type ReferralMetricDefinition,
  type ReferralPartnerEarnings,
  type ReferralRewardPartnerView,
  type ReferralRewardState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import {
  listRewardsByPartner,
  type ReferralRewardRow,
} from '../../../db/referrals/rewardRepository.js';
import { readReferralPartnerLedgerBalances } from '../../../db/referralEarnings/partnerBalanceRepository.js';
import { findLiveClaimedRewardIds } from '../../../db/referralEarnings/payoutBatchRepository.js';
import { countPartnerPendingConversions } from '../../../db/referrals/performanceRepository.js';

/** How many reward rows the partner-facing list carries. */
const RECENT_REWARD_LIMIT = 50;

/** How many rows the per-currency summary is computed over. */
const SUMMARY_REWARD_SCAN = 500;

const EARNINGS_METRIC_KEYS = [
  'referral_pending_earnings',
  'referral_held_earnings',
  'referral_vested_earnings',
  'referral_payable_now',
  'referral_paid_earnings',
  'referral_reversed_earnings',
  'referral_outstanding_balance',
] as const;

export function earningsMetricDefinitions(): ReferralMetricDefinition[] {
  return EARNINGS_METRIC_KEYS.map((key) => REFERRAL_METRIC_DEFINITIONS[key]);
}

/**
 * A reward as ADR 0005 A5 permits a partner to see it.
 *
 * `ReferralRewardPartnerView` has existed since #144 and had NO producer; this
 * is it. Note what is not read off the row even though it is sitting there:
 * `conversionId`, `attributionId`, `fundingRecordRef`, `programVersionId` and
 * `ruleVersionId` are all present on `ReferralRewardRow` and all absent here,
 * which is why this is a named projection rather than a spread.
 *
 * `campaignRef` comes from the CALLER, because a reward names its rule version
 * and the campaign is the rule's. Passing it in keeps this function total and
 * synchronous rather than making a per-row lookup.
 */
export function projectRewardForPartner(
  row: ReferralRewardRow,
  campaignRef?: string,
): ReferralRewardPartnerView {
  return {
    date: row.accruedAt.toISOString().slice(0, 10),
    state: row.state as ReferralRewardState,
    netAmountMinor: Number(row.netAmountMinor),
    currency: row.currency as CurrencyCode,
    fundingSourceId: row.fundingSourceId,
    ...(campaignRef !== undefined ? { campaignRef } : {}),
  };
}

/** The states whose nets make up the "on hold" figure. */
const HELD_STATES: readonly ReferralRewardState[] = ['held', 'frozen'];

interface CurrencyTally {
  heldMinor: number;
  vestedMinor: number;
  paidMinor: number;
  reversedMinor: number;
  vestedUnclaimedMinor: number;
}

function emptyTally(): CurrencyTally {
  return {
    heldMinor: 0,
    vestedMinor: 0,
    paidMinor: 0,
    reversedMinor: 0,
    vestedUnclaimedMinor: 0,
  };
}

/**
 * Everything a partner may read about their own money.
 *
 * Deliberately NOT `readReferralPartnerBalances`, which #145 built for the
 * operator trace: that one takes a `programId` because it resolves the
 * program's payout lever, and a partner can hold instruments under several
 * programs. This composes the ledger position (which is program-agnostic — a
 * `referral_payable` entry names an owner, not a program) with a reward scan.
 */
export async function readPartnerEarnings(
  partnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPartnerEarnings> {
  const [rewards, ledgerBalances, pendingConversions] = await Promise.all([
    listRewardsByPartner(db, partnerId, SUMMARY_REWARD_SCAN),
    readReferralPartnerLedgerBalances(db, partnerId),
    countPartnerPendingConversions(db, partnerId),
  ]);

  const vestedIds = rewards.filter((row) => row.state === 'vested').map((row) => row.id);
  const claimed = await findLiveClaimedRewardIds(db, vestedIds);

  const tallies = new Map<string, CurrencyTally>();
  const tallyFor = (currency: string): CurrencyTally => {
    const existing = tallies.get(currency);
    if (existing) return existing;
    const fresh = emptyTally();
    tallies.set(currency, fresh);
    return fresh;
  };

  for (const row of rewards) {
    const tally = tallyFor(row.currency);
    const net = Number(row.netAmountMinor);
    if (HELD_STATES.includes(row.state as ReferralRewardState)) {
      tally.heldMinor += net;
    } else if (row.state === 'vested') {
      tally.vestedMinor += net;
      // "Payable now" is vested MINUS what a live batch already holds a claim
      // on — the same discrimination `deriveRewardPayability` makes, so a
      // partner is never shown money as available while a batch is settling it.
      if (!claimed.has(row.id)) tally.vestedUnclaimedMinor += net;
    } else if (row.state === 'paid') {
      tally.paidMinor += net;
    } else if (row.state === 'voided') {
      // A voided reward's net is what was reversed. Its gross is not read: the
      // partner never had the gross, they had the net after every adjustment.
      tally.reversedMinor += net;
    }
  }

  // A currency that appears in the ledger but not in the reward scan is real —
  // the scan is bounded and the ledger is not — so both sides seed the set.
  for (const balance of ledgerBalances) tallyFor(balance.currency);

  const byCurrency: ReferralEarningsByCurrency[] = [...tallies.entries()]
    .map(([currency, tally]) => {
      const ledger = ledgerBalances.find((row) => row.currency === currency);
      const minimum = REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY[currency as CurrencyCode];
      // The comparison: what the rewards say is outstanding (held + vested,
      // the money accrued and not yet paid) against what the ledger's
      // `referral_payable` position says. They agree unless a posting is
      // missing, which is exactly what #145's sweep records.
      const rewardOutstanding = tally.heldMinor + tally.vestedMinor;
      const ledgerOutstanding = ledger?.outstandingMinor ?? 0;
      return {
        currency: currency as CurrencyCode,
        heldMinor: tally.heldMinor,
        vestedMinor: tally.vestedMinor,
        paidMinor: ledger?.settledMinor ?? tally.paidMinor,
        reversedMinor: tally.reversedMinor,
        payableNowMinor: tally.vestedUnclaimedMinor,
        outstandingMinor: ledgerOutstanding,
        ...(minimum !== undefined ? { payoutMinimumMinor: minimum } : {}),
        ledgerAgrees: rewardOutstanding === ledgerOutstanding,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    pendingConversions,
    byCurrency,
    recentRewards: rewards.slice(0, RECENT_REWARD_LIMIT).map((row) => projectRewardForPartner(row)),
    metrics: earningsMetricDefinitions(),
  };
}
