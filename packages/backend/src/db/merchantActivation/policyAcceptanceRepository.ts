/**
 * `merchant_activation_policy_acceptances` — a seller took on a stated
 * responsibility, once, at a named version (#85).
 *
 * The shape is `fee_schedule_acceptances`' one domain over, deliberately: a
 * replayed accept is the SAME consent and must converge on the existing row
 * rather than duplicating the audit trail. `ON CONFLICT DO NOTHING` plus a
 * read-back is what makes that a database property instead of a service check
 * two racers walk past — and the empty vs one-row `RETURNING` set IS the
 * "already accepted" answer, so a real failure (a dropped connection, pool
 * exhaustion) still propagates instead of being read as a duplicate.
 */

import { and, desc, eq } from 'drizzle-orm';
import type {
  MerchantActivationPolicyKey,
  ProviderAccountOwnerType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { getDb } from '../postgres.js';
import { merchantActivationPolicyAcceptances } from '../schema/merchantActivation.js';

export type MerchantActivationPolicyAcceptanceRow =
  typeof merchantActivationPolicyAcceptances.$inferSelect;

/** One acceptance to record. */
export interface NewMerchantActivationPolicyAcceptance {
  policyKey: MerchantActivationPolicyKey;
  policyVersion: string;
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
  acceptedByOxyUserId: string;
}

/** Record an acceptance, converging on a replay. */
export async function insertPolicyAcceptance(
  db: DatabaseOrTransaction,
  input: NewMerchantActivationPolicyAcceptance,
): Promise<{ created: boolean; row: MerchantActivationPolicyAcceptanceRow }> {
  const [inserted] = await db
    .insert(merchantActivationPolicyAcceptances)
    .values(input)
    .onConflictDoNothing({
      target: [
        merchantActivationPolicyAcceptances.ownerType,
        merchantActivationPolicyAcceptances.ownerId,
        merchantActivationPolicyAcceptances.policyKey,
        merchantActivationPolicyAcceptances.policyVersion,
      ],
    })
    .returning();
  if (inserted) return { created: true, row: inserted };

  const existing = await findPolicyAcceptance(db, input);
  if (!existing) {
    throw new Error(
      `Acceptance of ${input.policyKey} ${input.policyVersion} by ` +
        `${input.ownerType}:${input.ownerId} conflicted but cannot be read back.`,
    );
  }
  return { created: false, row: existing };
}

/** One owner's acceptance of one policy version, or `undefined`. */
export async function findPolicyAcceptance(
  db: DatabaseOrTransaction,
  input: {
    policyKey: MerchantActivationPolicyKey;
    policyVersion: string;
    ownerType: ProviderAccountOwnerType;
    ownerId: string;
  },
): Promise<MerchantActivationPolicyAcceptanceRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantActivationPolicyAcceptances)
    .where(
      and(
        eq(merchantActivationPolicyAcceptances.ownerType, input.ownerType),
        eq(merchantActivationPolicyAcceptances.ownerId, input.ownerId),
        eq(merchantActivationPolicyAcceptances.policyKey, input.policyKey),
        eq(merchantActivationPolicyAcceptances.policyVersion, input.policyVersion),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Every acceptance one owner has ever recorded, newest first.
 *
 * The whole history rather than the current version's row: a merchant surface
 * has to be able to show that a NEWER policy was published and not yet accepted,
 * and a query that only ever asked for the current version could not tell that
 * apart from a seller who had never accepted anything.
 */
export async function listPolicyAcceptancesForOwner(input: {
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
}): Promise<readonly MerchantActivationPolicyAcceptanceRow[]> {
  return getDb()
    .select()
    .from(merchantActivationPolicyAcceptances)
    .where(
      and(
        eq(merchantActivationPolicyAcceptances.ownerType, input.ownerType),
        eq(merchantActivationPolicyAcceptances.ownerId, input.ownerId),
      ),
    )
    .orderBy(desc(merchantActivationPolicyAcceptances.createdAt));
}
