/**
 * Reads and writes for `referral_campaign_budgets` — the explicit marketing
 * allocation a `fixed_budget` reward draws down (ADR 0005 D16).
 *
 * ## The claim is ONE conditional UPDATE, and its empty result IS the refusal
 *
 * `set claimed_minor = claimed_minor + $amount where budget_minor -
 * claimed_minor >= $amount and status = 'open'`. Two accruals racing at the
 * ceiling admit exactly one; the loser reads back an empty `RETURNING` set,
 * which the caller turns into `budget_exhausted`. There is no read-then-write
 * anywhere in this file, which is what makes "never pay more than the budget"
 * true under concurrency rather than usually.
 *
 * A RELEASE (a reversal handing budget back — ADR 0005 R6) is the mirror
 * statement, floored at zero so a double release cannot manufacture headroom.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { CurrencyCode, ReferralCampaignBudgetStatus } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralCampaignBudgets } from '../schema/referralRewards.js';

/** A budget row as the services read it back. */
export type ReferralCampaignBudgetRow = typeof referralCampaignBudgets.$inferSelect;

export async function insertCampaignBudget(
  db: DatabaseOrTransaction,
  input: {
    programId: string;
    campaignRef: string;
    name: string;
    currency: CurrencyCode;
    budgetMinor: number;
    createdByOxyUserId: string;
  },
): Promise<ReferralCampaignBudgetRow> {
  const [row] = await db
    .insert(referralCampaignBudgets)
    .values({
      programId: input.programId,
      campaignRef: input.campaignRef,
      name: input.name,
      currency: input.currency,
      budgetMinor: input.budgetMinor,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  return row;
}

export async function findCampaignBudget(
  db: DatabaseOrTransaction,
  input: { programId: string; campaignRef: string },
): Promise<ReferralCampaignBudgetRow | undefined> {
  const [row] = await db
    .select()
    .from(referralCampaignBudgets)
    .where(
      and(
        eq(referralCampaignBudgets.programId, input.programId),
        eq(referralCampaignBudgets.campaignRef, input.campaignRef),
      ),
    );
  return row;
}

export async function findCampaignBudgetById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralCampaignBudgetRow | undefined> {
  const [row] = await db
    .select()
    .from(referralCampaignBudgets)
    .where(eq(referralCampaignBudgets.id, id));
  return row;
}

/**
 * Claim `amountMinor` from an OPEN budget, atomically.
 *
 * @returns the updated row when the claim succeeded, `undefined` when it did
 *   not — an exhausted, closed or invalidated budget, or one whose remaining
 *   headroom is smaller than the claim. The caller cannot tell which, and does
 *   not need to: all four are `budget_exhausted` to an accrual, and a refusal
 *   that distinguished them would let a caller measure a campaign's spend by
 *   probing it.
 */
export async function claimCampaignBudget(
  db: DatabaseOrTransaction,
  input: { budgetId: string; amountMinor: number },
): Promise<ReferralCampaignBudgetRow | undefined> {
  const [row] = await db
    .update(referralCampaignBudgets)
    .set({ claimedMinor: sql`${referralCampaignBudgets.claimedMinor} + ${input.amountMinor}` })
    .where(
      and(
        eq(referralCampaignBudgets.id, input.budgetId),
        eq(referralCampaignBudgets.status, 'open'),
        sql`${referralCampaignBudgets.budgetMinor} - ${referralCampaignBudgets.claimedMinor} >= ${input.amountMinor}`,
      ),
    )
    .returning();
  return row;
}

/**
 * Hand budget back after a reversal (ADR 0005 R6: "the campaign budget claim is
 * released back by the same record").
 *
 * Floored at zero by the predicate rather than by arithmetic: a release larger
 * than what is claimed matches nothing and returns `undefined`, so a duplicated
 * release cannot invent headroom that was never spent.
 */
export async function releaseCampaignBudget(
  db: DatabaseOrTransaction,
  input: { budgetId: string; amountMinor: number },
): Promise<ReferralCampaignBudgetRow | undefined> {
  if (input.amountMinor <= 0) return await findCampaignBudgetById(db, input.budgetId);
  const [row] = await db
    .update(referralCampaignBudgets)
    .set({ claimedMinor: sql`${referralCampaignBudgets.claimedMinor} - ${input.amountMinor}` })
    .where(
      and(
        eq(referralCampaignBudgets.id, input.budgetId),
        sql`${referralCampaignBudgets.claimedMinor} >= ${input.amountMinor}`,
      ),
    )
    .returning();
  return row;
}

/**
 * Move a budget's status. `open → closed` is the prospective stop (ADR 0005
 * D16); `open → invalidated` is #144's sixth reversal cause. Neither touches
 * `claimed_minor`, so nothing already accrued is disturbed.
 */
export async function transitionCampaignBudgetStatus(
  db: DatabaseOrTransaction,
  input: {
    budgetId: string;
    expected: ReferralCampaignBudgetStatus;
    to: Extract<ReferralCampaignBudgetStatus, 'closed' | 'invalidated' | 'exhausted'>;
    at: Date;
  },
): Promise<ReferralCampaignBudgetRow | undefined> {
  const [row] = await db
    .update(referralCampaignBudgets)
    .set({
      status: input.to,
      ...(input.to === 'closed' ? { closedAt: input.at } : {}),
      ...(input.to === 'invalidated' ? { invalidatedAt: input.at } : {}),
    })
    .where(
      and(
        eq(referralCampaignBudgets.id, input.budgetId),
        eq(referralCampaignBudgets.status, input.expected),
      ),
    )
    .returning();
  return row;
}
