/**
 * Reads and writes for `referral_partners` — one participant per owner, ever
 * (ADR 0005 D2).
 *
 * The application insert is `onConflictDoNothing` on the owner key plus a
 * re-read, exactly the `insertProviderAccount` shape and for the same reason:
 * two concurrent enrollment clicks race the gap, and the loser must converge on
 * the winner's row rather than surface a duplicate-key error.
 *
 * Every state transition is a single-statement CAS from an expected-state SET,
 * so "approve an applied-or-invited partner" cannot approve one that was
 * terminated between the read and the write.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type {
  ReferralPartnerOwnerType,
  ReferralPartnerState,
  ReferralPromotionMethod,
  ReferralReadinessSummary,
  ReferralRiskState,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralPartners } from '../schema/referrals.js';

/** A partner row as the services read it back. */
export type ReferralPartnerRow = typeof referralPartners.$inferSelect;

/** Which owner. The natural key every read starts from. */
export interface PartnerOwnerKey {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
}

export async function findPartnerById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db.select().from(referralPartners).where(eq(referralPartners.id, id));
  return row;
}

export async function findPartnerByOwner(
  db: DatabaseOrTransaction,
  key: PartnerOwnerKey,
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartners)
    .where(
      and(eq(referralPartners.ownerType, key.ownerType), eq(referralPartners.ownerId, key.ownerId)),
    );
  return row;
}

/**
 * Record an application or an invitation, converging on the row that already
 * exists if one does.
 */
export async function insertPartner(
  db: DatabaseOrTransaction,
  input: PartnerOwnerKey & {
    displayName: string;
    state: Extract<ReferralPartnerState, 'applied' | 'invited'>;
    at: Date;
    termsVersion?: string;
    promotionMethods: readonly ReferralPromotionMethod[];
  },
): Promise<{ row: ReferralPartnerRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralPartners)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      displayName: input.displayName,
      state: input.state,
      ...(input.state === 'applied' ? { appliedAt: input.at } : { invitedAt: input.at }),
      ...(input.termsVersion !== undefined
        ? { termsVersion: input.termsVersion, termsAcceptedAt: input.at }
        : {}),
      promotionMethods: [...input.promotionMethods],
    })
    .onConflictDoNothing({
      target: [referralPartners.ownerType, referralPartners.ownerId],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findPartnerByOwner(db, input);
  if (!existing) {
    throw new Error(
      `referral_partners insert for ${input.ownerType}:${input.ownerId} conflicted with a row ` +
        'that then could not be read back.',
    );
  }
  return { row: existing, created: false };
}

/**
 * One enrollment-state transition, as a CAS from a SET of expected states.
 *
 * @returns The row as transitioned, or `undefined` when the partner was not in
 *   any expected state — an ordinary refusal the caller maps, never an error.
 */
export async function transitionPartnerState(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralPartnerState[];
    to: ReferralPartnerState;
    at: Date;
    riskState?: ReferralRiskState;
  },
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .update(referralPartners)
    .set({
      state: input.to,
      ...(input.riskState !== undefined ? { riskState: input.riskState } : {}),
      ...(input.to === 'approved' ? { approvedAt: input.at, suspendedAt: null } : {}),
      ...(input.to === 'suspended' ? { suspendedAt: input.at } : {}),
      ...(input.to === 'terminated' ? { terminatedAt: input.at } : {}),
      reviewedAt: input.at,
    })
    .where(
      and(eq(referralPartners.id, input.id), inArray(referralPartners.state, [...input.expected])),
    )
    .returning();
  return row;
}

/**
 * Apply the #146 readiness SUMMARIES. This domain never derives them — it
 * records what the onboarding/tax/payout machinery reported, one verdict per
 * concern.
 */
export async function applyPartnerReadiness(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    taxReadiness?: ReferralReadinessSummary;
    identityReadiness?: ReferralReadinessSummary;
    payoutReadiness?: ReferralReadinessSummary;
    payoutBeneficiaryRef?: string;
  },
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .update(referralPartners)
    .set({
      ...(input.taxReadiness !== undefined ? { taxReadiness: input.taxReadiness } : {}),
      ...(input.identityReadiness !== undefined
        ? { identityReadiness: input.identityReadiness }
        : {}),
      ...(input.payoutReadiness !== undefined ? { payoutReadiness: input.payoutReadiness } : {}),
      ...(input.payoutBeneficiaryRef !== undefined
        ? { payoutBeneficiaryRef: input.payoutBeneficiaryRef }
        : {}),
    })
    .where(eq(referralPartners.id, input.id))
    .returning();
  return row;
}
