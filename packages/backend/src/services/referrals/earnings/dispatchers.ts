/**
 * The three referral-earnings loops (#145).
 *
 * Each gates the LOOP and never a durable record, which is ADR 0005 D18's
 * "gating loops and gates, never records" and the standing house rule it
 * restates. Turning any of them off loses nothing: the rewards keep accruing and
 * their postings keep committing (the accrual books INSIDE #144's own
 * transaction and no flag reaches it), the holds keep elapsing, and turning a
 * loop back on drains whatever accumulated.
 *
 * What each one stops:
 *
 *  - `REFERRAL_VESTING_ENABLED` off — held rewards stop becoming `vested`. They
 *    are still owed, still visible, and vest on the first pass after it is back.
 *  - `REFERRAL_PAYOUT_BATCHES_ENABLED` off — no batch is BUILT by the loop. An
 *    operator can still open, approve, settle and cancel one by hand, which is
 *    the supported path during an incident and the reason the surface stays
 *    mounted.
 *  - `REFERRAL_RECONCILIATION_ENABLED` off — nobody is looking. Nothing changes
 *    about what is true, which is the whole reason the sweep detects and never
 *    repairs.
 *
 * `unref()` on every timer: a module-level `setInterval` keeps the Node event
 * loop alive and hangs a vitest run non-deterministically.
 */

import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { getDb } from '../../../db/postgres.js';
import { listPartnersWithPostings } from '../../../db/referralEarnings/ledgerPostingRepository.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import { findOpenPayoutBatch, REFERRAL_PAYOUT_SYSTEM_ACTOR } from '../../../db/referralEarnings/payoutBatchRepository.js';
import { readReferralPartnerLedgerBalances } from '../../../db/referralEarnings/partnerBalanceRepository.js';
import { listRewardsInState } from '../../../db/referrals/rewardRepository.js';
import { buildPayoutBatchForPartner, settleApprovedBatches } from './payout-batch.service.js';
import { reconcileReferralEarnings } from './reconciliation.service.js';
import { vestDueRewards } from './vesting.service.js';

/** One vesting tick. Exported so a test can drive it without a timer. */
export async function runReferralVestingTick(now: Date = new Date()): Promise<number> {
  const result = await vestDueRewards({ at: now, limit: config.referrals.vestingBatchSize });
  if (result.vested > 0) {
    log.general.info(
      { scanned: result.scanned, vested: result.vested, skipped: result.skipped },
      '[Referrals] vested rewards whose hold elapsed',
    );
  }
  return result.vested;
}

/**
 * One batch-construction tick: build for every partner who has something
 * payable, then settle whatever is approved.
 *
 * Building and settling are ONE loop rather than two, deliberately: a batch a
 * loop built and nobody approved never settles, so the two halves are not
 * independent the way a queue's producer and consumer are. What separates them
 * is the APPROVAL, which is a person and not a timer.
 */
export async function runReferralPayoutTick(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const partnerIds = await listPartnersWithPostings(db, {
    limit: config.referrals.payoutBatchSize,
  });

  let opened = 0;
  for (const partnerId of partnerIds) {
    try {
      const partner = await findPartnerById(db, partnerId);
      if (!partner || partner.state !== 'approved') continue;
      const balances = await readReferralPartnerLedgerBalances(db, partnerId);
      for (const balance of balances) {
        if (balance.outstandingMinor <= 0) continue;
        const existing = await findOpenPayoutBatch(db, {
          partnerId,
          currency: balance.currency,
        });
        if (existing) continue;
        // A partner with an outstanding balance but nothing VESTED has nothing
        // to batch; the cheap read here keeps the builder's transaction out of
        // the common case entirely.
        const vested = await listRewardsInState(db, {
          partnerId,
          currency: balance.currency,
          states: ['vested'],
          limit: 1,
        });
        if (vested.length === 0) continue;

        const built = await buildPayoutBatchForPartner({
          partnerId,
          programId: vested[0].programVersionId,
          currency: balance.currency,
          createdByOxyUserId: REFERRAL_PAYOUT_SYSTEM_ACTOR,
        });
        if (built.outcome === 'opened') opened += 1;
      }
    } catch (err: unknown) {
      // One partner's fault must not stop the page. A build that threw leaves
      // no batch, so the next tick tries again from the same place.
      log.general.warn({ err, partnerId }, '[Referrals] payout batch construction failed');
    }
  }

  await settleApprovedBatches({
    limit: config.referrals.payoutBatchSize,
    retryAfterMs: config.referrals.payoutRetryBackoffMs,
    at: now,
  });
  return opened;
}

/** One reconciliation tick over one page of partners. */
export async function runReferralReconciliationTick(now: Date = new Date()): Promise<number> {
  const result = await reconcileReferralEarnings({
    limit: config.referrals.reconciliationBatchSize,
    at: now,
  });
  if (result.findings > 0) {
    log.general.warn(
      {
        partnersScanned: result.partnersScanned,
        rewardsScanned: result.rewardsScanned,
        findings: result.findings,
      },
      '[Referrals] earnings reconciliation recorded discrepancies',
    );
  }
  return result.findings;
}

/** Start the vesting loop on this task. */
export function startReferralVestingDispatcher(): void {
  if (!config.referrals.vestingEnabled) return;
  const timer = setInterval(() => {
    void runReferralVestingTick().catch((err: unknown) => {
      log.general.warn({ err }, '[Referrals] vesting tick failed');
    });
  }, config.referrals.vestingPollIntervalMs);
  timer.unref?.();
}

/** Start the payout build-and-settle loop on this task. */
export function startReferralPayoutDispatcher(): void {
  if (!config.referrals.payoutBatchesEnabled) return;
  const timer = setInterval(() => {
    void runReferralPayoutTick().catch((err: unknown) => {
      log.general.warn({ err }, '[Referrals] payout tick failed');
    });
  }, config.referrals.payoutPollIntervalMs);
  timer.unref?.();
}

/** Start the reconciliation sweep on this task. */
export function startReferralReconciliationDispatcher(): void {
  if (!config.referrals.reconciliationEnabled) return;
  const timer = setInterval(() => {
    void runReferralReconciliationTick().catch((err: unknown) => {
      log.general.warn({ err }, '[Referrals] reconciliation tick failed');
    });
  }, config.referrals.reconciliationPollIntervalMs);
  timer.unref?.();
}
