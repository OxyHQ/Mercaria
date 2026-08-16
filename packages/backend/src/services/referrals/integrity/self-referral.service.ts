/**
 * Establishing the first-party facts a self-referral verdict rests on
 * (ADR 0005 D7/D8, #148 "Self-referral evaluation").
 *
 * This file READS; `self-referral.ts` DECIDES. The split is the same one
 * `duplicate-signals.ts` and `payability.ts` already make, and it is what lets
 * the decision be tested against every combination of facts without a database
 * — including the combinations that are hard to construct and easy to get
 * wrong.
 *
 * ## Every query here is a first-party membership or claim
 *
 * A store membership (`store_members`, #142's own admin model) and a VERIFIED
 * merchant claim (`merchant_claims`, #83). Nothing else. There is no email
 * comparison, no address comparison, no card lookup and no payment-domain
 * query, and ADR 0005 D7's *"deliberately nothing else"* is what the
 * `ReferralSelfReferralFacts` return type makes checkable.
 *
 * ## Two facts are NOT ESTABLISHED and say so
 *
 * `beneficiaryOverlapsSubject` needs the referred party's payout beneficiary,
 * and a buyer has none — it is answerable only between two PARTNERS, which is
 * the `shared_payout_beneficiary` risk signal rather than an attribution-time
 * question. `relatedPartyDeclared` is read from the application's own
 * disclosure and is `reviewable` precisely because that free-text field does
 * not name the subject: a partner who disclosed a relationship with somebody
 * has not thereby disclosed one with THIS buyer, and treating the two as the
 * same fact would refuse every referral a candid partner ever makes.
 *
 * Both come back `undefined` where they cannot be established, and `undefined`
 * is NOT read as `false` — see `assessSelfReferral`.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import {
  REFERRAL_ENROLLMENT_MODE_RULES,
  type ReferralEnrollmentMode,
  type ReferralSelfReferralFacts,
  type ReferralSubjectKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import { storeMembers } from '../../../db/schema/stores.js';
import { merchantClaims } from '../../../db/schema/merchantClaims.js';
import { referralPartnerApplications } from '../../../db/schema/referrals.js';
import { referralEnforcementActions } from '../../../db/schema/referralIntegrity.js';
import type { ReferralPartnerRow } from '../../../db/referrals/partnerRepository.js';

/** The subject an attribution is about, at the grain D7 asks about. */
export interface SelfReferralSubject {
  subjectKind: ReferralSubjectKind;
  /** The Oxy account, for an `oxy_user` subject. */
  oxyUserId?: string | null;
  /** The merchant, for a `merchant` subject. */
  merchantId?: string | null;
}

/**
 * Whether an Oxy account holds ANY membership in a store.
 *
 * ADR 0005 D7 says *"any membership (owner/admin/staff)"*, so this asks about
 * the ROW's existence rather than about the role. Narrowing it to `owner` would
 * let a staff member of the referring store buy through their own code, which
 * is the leak D8's hard exclusion exists to close from the other side.
 */
async function holdsStoreMembership(
  db: DatabaseOrTransaction,
  input: { storeId: string; oxyUserId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(storeMembers)
    .where(
      and(eq(storeMembers.storeId, input.storeId), eq(storeMembers.oxyUserId, input.oxyUserId)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether an Oxy account holds a VERIFIED claim on a merchant.
 *
 * `verified` and nothing weaker: #83's partial unique makes at most one
 * verified claimant per merchant, and a `review_pending` claim is somebody
 * asserting a relationship nobody has checked. Reading a pending claim as
 * administration would let a claimant refuse a rival's attribution by filing.
 */
async function administersMerchant(
  db: DatabaseOrTransaction,
  input: { merchantId: string; oxyUserId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(merchantClaims)
    .where(
      and(
        eq(merchantClaims.merchantId, input.merchantId),
        eq(merchantClaims.claimantOxyUserId, input.oxyUserId),
        eq(merchantClaims.state, 'verified'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The facts, for one partner and one subject.
 *
 * A `store` partner has no single Oxy account, so `same_oxy_actor` is asked as
 * *"does the converting account hold membership in the partner store"* — which
 * is exactly D7's own wording and is why the same query serves both halves.
 */
export async function collectSelfReferralFacts(
  db: DatabaseOrTransaction,
  input: { partner: ReferralPartnerRow; subject: SelfReferralSubject },
): Promise<ReferralSelfReferralFacts> {
  const { partner, subject } = input;
  const facts: ReferralSelfReferralFacts = {};

  // ADR 0005 D7, buyer half. `undefined` when the subject is not an Oxy
  // account at all: a guest checkout scope is not comparable to a partner
  // owner, and answering `false` would assert a check nobody could perform.
  if (subject.subjectKind === 'oxy_user' && subject.oxyUserId != null) {
    if (partner.ownerType === 'user') {
      facts.subjectIsPartnerOwner = partner.ownerId === subject.oxyUserId;
    } else {
      facts.subjectIsPartnerOwner = await holdsStoreMembership(db, {
        storeId: partner.ownerId,
        oxyUserId: subject.oxyUserId,
      });
    }
  }

  // ADR 0005 D7, merchant half, and D8's hard exclusion in the same fact.
  if (subject.subjectKind === 'merchant' && subject.merchantId != null) {
    if (partner.ownerType === 'user') {
      facts.partnerHoldsReferredStoreMembership = await administersMerchant(db, {
        merchantId: subject.merchantId,
        oxyUserId: partner.ownerId,
      });
    }
    // A `store` partner referring a merchant is left NOT ESTABLISHED rather
    // than answered `false`: linking a Mercaria store to a merchant is #84's
    // `native_store_links`, which does not exist yet, so the question has no
    // first-party answer today. Saying `false` would assert a check nobody
    // performed, which is the one thing `undefined` exists to prevent.
  }

  const modeRule =
    REFERRAL_ENROLLMENT_MODE_RULES[partner.enrollmentMode as ReferralEnrollmentMode];
  if (modeRule !== undefined) {
    facts.enrollmentIsStaffOrTest = !modeRule.earnsProductionRewards;
  }

  // The LATEST revision, explicitly ordered.
  //
  // This read was `.limit(1)` with NO `orderBy`, which in SQL returns an
  // ARBITRARY row: a partner who revised their application (#146 keeps every
  // revision, and `changes_requested` exists so they can) got whichever one the
  // planner happened to hand back. That is a nondeterministic input to a
  // self-referral gate — the same partner could be reviewed or admitted across
  // two calls with nothing about them changed, and nobody could reproduce it.
  //
  // The NEWEST revision is the right one because it is the partner's CURRENT
  // statement: a disclosure made on revision 1 and removed on revision 2 has
  // been withdrawn, and reading the old one holds a superseded answer against
  // them. `desc(revision)` rather than `desc(createdAt)` — `revision` is the
  // column #146 increments and two rows can share a timestamp.
  const [application] = await db
    .select({ disclosure: referralPartnerApplications.relatedPartyDisclosure })
    .from(referralPartnerApplications)
    .where(eq(referralPartnerApplications.partnerId, partner.id))
    .orderBy(desc(referralPartnerApplications.revision))
    .limit(1);
  if (application !== undefined) {
    const disclosed = (application.disclosure ?? '').trim();
    facts.relatedPartyDeclared = disclosed.length > 0;
  }

  // An operator finding a reviewer approved, expressed as the thing that
  // records exactly that: a live enforcement action resting on identity
  // evidence and citing the self-referral prohibition. A boolean column
  // somewhere else would be a second representation of one decision.
  const [finding] = await db
    .select({ one: sql<number>`1` })
    .from(referralEnforcementActions)
    .where(
      and(
        eq(referralEnforcementActions.partnerId, partner.id),
        eq(referralEnforcementActions.basis, 'identity_evidence'),
        eq(referralEnforcementActions.conduct, 'self_or_related_party_referral'),
        sql`${referralEnforcementActions.liftedAt} is null`,
      ),
    )
    .limit(1);
  facts.approvedOperatorFinding = finding !== undefined;

  return facts;
}
