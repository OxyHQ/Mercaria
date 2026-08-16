/**
 * Budget and cap utilization for one program (#147 operator item 6).
 *
 * DERIVED at read time from the rows that carry the facts, and there is
 * deliberately no utilization TABLE. #144's own cap enforcement declines a
 * running-total row for the reason that applies here too: a counter is a second
 * representation of a sum the rewards already carry, it cannot express a
 * `lifetime` cap, and it does not survive a rule changing its period. A stored
 * figure that disagreed with the rewards would be the number an operator makes
 * a budget decision on.
 *
 * ## OPERATOR ONLY, and it is the placement that says so
 *
 * Nothing on the partner surface imports this module, and
 * `referral-dashboard-isolation.test.ts` fails the build if it starts to. A
 * campaign's remaining headroom is Mercaria's marketing position: telling a
 * partner would let them measure how much of a campaign other partners had
 * taken, and a partner's own ceiling is already published to them as a LIMIT.
 */

import type { CurrencyCode, ReferralProgramUtilization, ReferralRewardState } from '@mercaria/shared-types';
import { REFERRAL_REWARD_STATES } from '@mercaria/shared-types';
import { eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { listCampaignBudgetsForProgram } from '../../../db/referrals/campaignBudgetRepository.js';
import { countProgramActivePartners } from '../../../db/referrals/performanceRepository.js';
import { referralRewards } from '../../../db/schema/referralRewards.js';
import { referralPrograms } from '../../../db/schema/referrals.js';

export async function readProgramUtilization(
  programId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralProgramUtilization> {
  const [budgets, activePartners, rewardRows] = await Promise.all([
    listCampaignBudgetsForProgram(db, programId),
    countProgramActivePartners(db, programId),
    // A reward names a program VERSION; the utilization is per PROGRAM, so the
    // join is what folds every version's rewards into one figure. Summing by
    // version would report a program's spend falling to zero the day somebody
    // published new terms.
    db
      .select({
        state: referralRewards.state,
        currency: referralRewards.currency,
        total: sql<number>`coalesce(sum(${referralRewards.netAmountMinor}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(referralRewards)
      .innerJoin(referralPrograms, eq(referralPrograms.id, referralRewards.programVersionId))
      .where(eq(referralPrograms.programId, programId))
      .groupBy(referralRewards.state, referralRewards.currency),
  ]);

  const rewardCounts = Object.fromEntries(
    REFERRAL_REWARD_STATES.map((state) => [state, 0]),
  ) as Record<ReferralRewardState, number>;
  const accrualsByCurrency = new Map<string, number>();

  for (const row of rewardRows) {
    rewardCounts[row.state as ReferralRewardState] += Number(row.count);
    // `voided` is EXCLUDED from the accrual figure: a voided reward's funding
    // ceased to exist (ADR 0005 R1), so counting it as spend would report a
    // budget as consumed by money nobody was paid and nobody owes.
    if (row.state === 'voided') continue;
    // postgres.js decodes `sum()` over a bigint column as a STRING, and drizzle
    // types it `number` — so `a + b` would be string concatenation. Coerced at
    // the boundary, here, where the value enters JavaScript.
    const amount = Number(row.total);
    accrualsByCurrency.set(row.currency, (accrualsByCurrency.get(row.currency) ?? 0) + amount);
  }

  return {
    programId,
    campaigns: budgets.map((budget) => ({
      campaignRef: budget.campaignRef,
      currency: budget.currency as CurrencyCode,
      allocatedMinor: Number(budget.budgetMinor),
      claimedMinor: Number(budget.claimedMinor),
      remainingMinor: Number(budget.budgetMinor) - Number(budget.claimedMinor),
      status: budget.status,
    })),
    accrualsMinor: [...accrualsByCurrency.entries()]
      .map(([currency, amountMinor]) => ({ currency: currency as CurrencyCode, amountMinor }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    rewardCounts,
    activePartners,
  };
}
