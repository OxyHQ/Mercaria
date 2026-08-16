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

import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  ReferralEnrollmentMode,
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
    /**
     * `draft` joined the set in #146 increment 2: an application somebody has
     * started and not submitted needs a partner row to hang off, and giving it
     * its own owner-keyed table would put a second index beside
     * `referral_partners_owner_key` answering the same question.
     */
    state: Extract<ReferralPartnerState, 'draft' | 'applied' | 'invited'>;
    at: Date;
    /** Absent for a `draft`, which has accepted nothing yet. */
    termsVersion?: string;
    promotionMethods: readonly ReferralPromotionMethod[];
    /** Absent means #142's shipped behaviour, `open_application`. */
    enrollmentMode?: ReferralEnrollmentMode;
  },
): Promise<{ row: ReferralPartnerRow; created: boolean }> {
  const [inserted] = await db
    .insert(referralPartners)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      displayName: input.displayName,
      state: input.state,
      ...(input.state === 'applied' ? { appliedAt: input.at } : {}),
      ...(input.state === 'invited' ? { invitedAt: input.at } : {}),
      ...(input.termsVersion !== undefined
        ? { termsVersion: input.termsVersion, termsAcceptedAt: input.at }
        : {}),
      ...(input.enrollmentMode !== undefined ? { enrollmentMode: input.enrollmentMode } : {}),
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

/**
 * Take the partner row's lock for the duration of an enrollment write.
 *
 * `declareTaxProfile` takes the same lock for the same reason: an application
 * submission and a terms acceptance both allocate a number (`revision`) or
 * project a value onto the partner, and two concurrent clicks must be serialised
 * rather than collide on a unique index and surface as a 500.
 */
export async function lockPartnerForEnrollment(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPartners)
    .where(eq(referralPartners.id, id))
    .for('update');
  return row;
}

/**
 * Project the newest accepted PARTNER AGREEMENT onto the partner row.
 *
 * `referral_terms_acceptances` is the authority (append-only, and the only
 * thing that can answer "which versions has this partner ever accepted");
 * `terms_version`/`terms_accepted_at` are the single stored verdict a gate
 * reads, and #76's `review_aggregates` → entity-`rating` relationship is the
 * precedent. This is the ONE writer, called inside the acceptance's own
 * transaction, which is what stops the two drifting.
 *
 * The `where` refuses to move a NEWER stamp backwards: a re-acceptance racing
 * an older one must not leave the projection naming the loser.
 */
export async function projectPartnerAgreementAcceptance(
  db: DatabaseOrTransaction,
  input: { id: string; termsVersion: string; acceptedAt: Date },
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .update(referralPartners)
    .set({ termsVersion: input.termsVersion, termsAcceptedAt: input.acceptedAt })
    .where(
      and(
        eq(referralPartners.id, input.id),
        sql`(${referralPartners.termsAcceptedAt} is null
             or ${referralPartners.termsAcceptedAt} <= ${input.acceptedAt.toISOString()}::timestamptz)`,
      ),
    )
    .returning();
  return row;
}

/**
 * Record marketing consent, or withdraw it (`at: null`).
 *
 * Its own writer because it is its own fact (#146 terms rule 8): a transactional
 * send must never be able to read a terms acceptance as permission to market,
 * and the way that happens is one function writing both.
 */
export async function setPartnerMarketingConsent(
  db: DatabaseOrTransaction,
  input: { id: string; at: Date | null },
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .update(referralPartners)
    .set({ marketingConsentAt: input.at })
    .where(eq(referralPartners.id, input.id))
    .returning();
  return row;
}

/** Open the appeal on a suspended or terminated partner, or resolve one. */
export async function transitionPartnerAppeal(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ('none' | 'open' | 'accepted' | 'rejected')[];
    to: 'none' | 'open' | 'accepted' | 'rejected';
    at: Date;
  },
): Promise<ReferralPartnerRow | undefined> {
  const [row] = await db
    .update(referralPartners)
    .set({ appealState: input.to, reviewedAt: input.at })
    .where(
      and(
        eq(referralPartners.id, input.id),
        inArray(referralPartners.appealState, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/** One page of the operator review inbox, newest submission first. */
export async function listPartnersByState(
  db: DatabaseOrTransaction,
  input: { states: readonly ReferralPartnerState[]; limit: number },
): Promise<readonly ReferralPartnerRow[]> {
  return await db
    .select()
    .from(referralPartners)
    .where(inArray(referralPartners.state, [...input.states]))
    .orderBy(sql`${referralPartners.createdAt} desc`, sql`${referralPartners.id} desc`)
    .limit(input.limit);
}
