/**
 * Reads and writes for `referral_tax_profiles` (#146, ADR 0005 D15 gate 2).
 *
 * The table is APPEND-ONLY by trigger, so there is deliberately no update and no
 * delete here — a correction is {@link insertTaxProfileRevision} again, and the
 * derivation reads {@link findLatestTaxProfile}. A repository function that
 * looked like an edit would be one the database refuses at runtime, which is a
 * worse place to find out than `tsc`.
 */

import { desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type {
  ReferralTaxParticipantType,
  ReferralTaxQuestionnaireVersion,
  ReferralTaxVatStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralPartners, referralTaxProfiles } from '../schema/referrals.js';

/** A tax profile row as the services read it back. */
export type ReferralTaxProfileRow = typeof referralTaxProfiles.$inferSelect;

/**
 * The partner's CURRENT declaration — the highest revision — or `undefined`.
 *
 * Ordered by `revision` and never by `(created_at, id)`: two submissions in one
 * millisecond share an instant and uuid v7 is not monotonic within one, so that
 * ordering would pick a winner at random on exactly the correction this table
 * exists to record.
 */
export async function findLatestTaxProfile(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralTaxProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(referralTaxProfiles)
    .where(eq(referralTaxProfiles.partnerId, partnerId))
    .orderBy(desc(referralTaxProfiles.revision))
    .limit(1);
  return row;
}

/** Every declaration a partner has made, newest first. */
export async function listTaxProfileRevisions(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<readonly ReferralTaxProfileRow[]> {
  return await db
    .select()
    .from(referralTaxProfiles)
    .where(eq(referralTaxProfiles.partnerId, partnerId))
    .orderBy(desc(referralTaxProfiles.revision));
}

/**
 * Record one declaration, as the next revision.
 *
 * MUST run inside a transaction that has already taken `FOR UPDATE` on the
 * partner row ({@link lockPartnerForTaxProfile}). Two concurrent submissions
 * would otherwise both read the same highest revision, and one of them would
 * lose to `referral_tax_profiles_partner_revision_key` with a 23505 the caller
 * would have to interpret. Serialising on the partner is cheaper than teaching
 * every caller to retry, and the partner row is the natural lock: a declaration
 * is about exactly one.
 */
export async function insertTaxProfileRevision(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    questionnaireVersion: ReferralTaxQuestionnaireVersion;
    participantType: ReferralTaxParticipantType;
    residencyCountry: string;
    vatStatus: ReferralTaxVatStatus;
    declaredAt: Date;
    declaredByOxyUserId: string;
  },
): Promise<ReferralTaxProfileRow> {
  const previous = await findLatestTaxProfile(db, input.partnerId);
  const [row] = await db
    .insert(referralTaxProfiles)
    .values({
      id: uuidv7(),
      partnerId: input.partnerId,
      revision: (previous?.revision ?? 0) + 1,
      questionnaireVersion: input.questionnaireVersion,
      participantType: input.participantType,
      residencyCountry: input.residencyCountry,
      vatStatus: input.vatStatus,
      declaredAt: input.declaredAt,
      declaredByOxyUserId: input.declaredByOxyUserId,
    })
    .returning();
  if (!row) {
    throw new Error(
      `referral_tax_profiles insert for partner ${input.partnerId} returned no row.`,
    );
  }
  return row;
}

/**
 * Take the partner row's lock, so revisions are allocated one at a time.
 *
 * Returns whether the partner exists, which the caller needs anyway — a
 * declaration for a partner that is not there is a 404 rather than a foreign-key
 * error surfacing from three frames down.
 */
export async function lockPartnerForTaxProfile(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: referralPartners.id })
    .from(referralPartners)
    .where(eq(referralPartners.id, partnerId))
    .for('update');
  return row !== undefined;
}
