/**
 * Reads and writes for `referral_programs` — one row per immutable VERSION.
 *
 * `db` is the first parameter everywhere, for the reason `paymentRepository.ts`
 * gives: a helper typed only as `Database` would silently run outside its
 * caller's transaction.
 *
 * Every status transition here is a single-statement compare-and-swap
 * (`UPDATE … WHERE id = $1 AND status = $2 RETURNING`), the discipline
 * `CONVENTIONS.md` pins for conditional writes: the row is locked for the
 * statement, so a concurrent racer's predicate is re-checked against the
 * winner's write. "An active version cannot be edited" is exactly such a CAS —
 * the draft update carries `status = 'draft'` in its WHERE, so an edit racing a
 * publish loses cleanly rather than mutating live terms.
 */

import { and, desc, eq } from 'drizzle-orm';
import type {
  ReferralAttributionPolicy,
  ReferralConversionType,
  ReferralProgramFamily,
  ReferralProgramStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralPrograms } from '../schema/referrals.js';

/** A program-version row as the services read it back. */
export type ReferralProgramRow = typeof referralPrograms.$inferSelect;

/** Everything a draft version knows at creation. */
export interface CreateProgramVersionInput {
  programId: string;
  version: number;
  name: string;
  description: string;
  publicTermsSummary: string;
  family: ReferralProgramFamily;
  effectiveStartAt?: Date;
  effectiveEndAt?: Date;
  eligiblePartnerTypes: readonly string[];
  eligibleSubjectKinds: readonly string[];
  markets: readonly string[];
  currencies: readonly string[];
  channels: readonly string[];
  commercialModes: readonly string[];
  attributionPolicy: ReferralAttributionPolicy;
  attributionWindowDays: number;
  activationWindowDays?: number;
  qualifyingEventPolicy: ReferralConversionType;
  commissionRuleRef: string;
  holdDays: number;
  capPolicyRef?: string;
  payoutPolicyRef: string;
  termsVersion: string;
  disclosureVersion: string;
  createdByOxyUserId: string;
  featureFlagKey?: string;
  cohortKeys: readonly string[];
}

/** The draft-editable subset — identity, family and audit fields are not in it. */
export type ProgramDraftPatch = Partial<
  Pick<
    CreateProgramVersionInput,
    | 'name'
    | 'description'
    | 'publicTermsSummary'
    | 'effectiveStartAt'
    | 'effectiveEndAt'
    | 'eligiblePartnerTypes'
    | 'eligibleSubjectKinds'
    | 'markets'
    | 'currencies'
    | 'channels'
    | 'commercialModes'
    | 'attributionWindowDays'
    | 'activationWindowDays'
    | 'qualifyingEventPolicy'
    | 'commissionRuleRef'
    | 'holdDays'
    | 'capPolicyRef'
    | 'payoutPolicyRef'
    | 'termsVersion'
    | 'disclosureVersion'
    | 'featureFlagKey'
    | 'cohortKeys'
  >
>;

export async function insertProgramVersion(
  db: DatabaseOrTransaction,
  input: CreateProgramVersionInput,
): Promise<ReferralProgramRow> {
  const [row] = await db
    .insert(referralPrograms)
    .values({
      programId: input.programId,
      version: input.version,
      name: input.name,
      description: input.description,
      publicTermsSummary: input.publicTermsSummary,
      family: input.family,
      effectiveStartAt: input.effectiveStartAt ?? null,
      effectiveEndAt: input.effectiveEndAt ?? null,
      eligiblePartnerTypes: [...input.eligiblePartnerTypes],
      eligibleSubjectKinds: [...input.eligibleSubjectKinds],
      markets: [...input.markets],
      currencies: [...input.currencies],
      channels: [...input.channels],
      commercialModes: [...input.commercialModes],
      attributionPolicy: input.attributionPolicy,
      attributionWindowDays: input.attributionWindowDays,
      activationWindowDays: input.activationWindowDays ?? null,
      qualifyingEventPolicy: input.qualifyingEventPolicy,
      commissionRuleRef: input.commissionRuleRef,
      holdDays: input.holdDays,
      capPolicyRef: input.capPolicyRef ?? null,
      payoutPolicyRef: input.payoutPolicyRef,
      termsVersion: input.termsVersion,
      disclosureVersion: input.disclosureVersion,
      createdByOxyUserId: input.createdByOxyUserId,
      featureFlagKey: input.featureFlagKey ?? null,
      cohortKeys: [...input.cohortKeys],
    })
    .returning();
  if (!row) {
    throw new Error(`referral_programs insert for ${input.programId} v${input.version} returned no row.`);
  }
  return row;
}

export async function findProgramVersionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralProgramRow | undefined> {
  const [row] = await db.select().from(referralPrograms).where(eq(referralPrograms.id, id));
  return row;
}

/**
 * The ONE active version of a program, when there is one. The partial unique
 * index is what makes "the" honest — two rows cannot both satisfy the filter.
 */
export async function findActiveProgramVersion(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<ReferralProgramRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPrograms)
    .where(and(eq(referralPrograms.programId, programId), eq(referralPrograms.status, 'active')));
  return row;
}

/** The highest version row of a program — draft or published, whatever it is. */
export async function findLatestProgramVersion(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<ReferralProgramRow | undefined> {
  const [row] = await db
    .select()
    .from(referralPrograms)
    .where(eq(referralPrograms.programId, programId))
    .orderBy(desc(referralPrograms.version))
    .limit(1);
  return row;
}

/**
 * The distinct program identities, newest activity first (#147's operator list
 * and the partner's program discovery).
 *
 * `DISTINCT ON (program_id)` ordered by version DESC, so each program appears
 * once as its HIGHEST version — the row an operator manages and the row a
 * discovery surface must read the status off. Selecting the ACTIVE version
 * instead would make a program that has never been published invisible to the
 * operator who is drafting it, which is the one reader who must see it.
 *
 * Bounded by `limit`: the operator surface pages, and a partner's discovery
 * list is filtered down afterwards. There is no cursor because the population
 * is programs — a marketing artefact somebody writes by hand, not a table that
 * grows with traffic.
 */
export async function listProgramIdentities(
  db: DatabaseOrTransaction,
  input: { limit: number },
): Promise<ReferralProgramRow[]> {
  return await db
    .selectDistinctOn([referralPrograms.programId])
    .from(referralPrograms)
    .orderBy(referralPrograms.programId, desc(referralPrograms.version))
    .limit(input.limit);
}

/** Every version of one program, newest first — the operator's audit read. */
export async function listProgramVersions(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<ReferralProgramRow[]> {
  return await db
    .select()
    .from(referralPrograms)
    .where(eq(referralPrograms.programId, programId))
    .orderBy(desc(referralPrograms.version));
}

/**
 * Edit a DRAFT. The `status = 'draft'` predicate in the WHERE is the
 * immutability rule: a published version matches nothing, so the caller gets
 * `undefined` back instead of silently rewriting live terms.
 */
export async function updateProgramDraft(
  db: DatabaseOrTransaction,
  id: string,
  patch: ProgramDraftPatch,
): Promise<ReferralProgramRow | undefined> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    set[key] = Array.isArray(value) ? [...value] : value;
  }
  if (Object.keys(set).length === 0) {
    return await findProgramVersionById(db, id);
  }
  const [row] = await db
    .update(referralPrograms)
    .set(set)
    .where(and(eq(referralPrograms.id, id), eq(referralPrograms.status, 'draft')))
    .returning();
  return row;
}

/**
 * One status transition, as a CAS from an EXPECTED status. Timestamps and the
 * approver travel with the transition that defines them, so the CHECKs that
 * hold status/timestamp agreement can never be violated by a write that forgot
 * half.
 */
export async function transitionProgramStatus(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: ReferralProgramStatus;
    to: ReferralProgramStatus;
    at: Date;
    approvedByOxyUserId?: string;
    effectiveStartAt?: Date;
  },
): Promise<ReferralProgramRow | undefined> {
  const [row] = await db
    .update(referralPrograms)
    .set({
      status: input.to,
      ...(input.approvedByOxyUserId !== undefined
        ? { approvedByOxyUserId: input.approvedByOxyUserId }
        : {}),
      ...(input.effectiveStartAt !== undefined ? { effectiveStartAt: input.effectiveStartAt } : {}),
      ...(input.to === 'active' || input.to === 'scheduled' ? { publishedAt: input.at } : {}),
      ...(input.to === 'paused' ? { pausedAt: input.at } : {}),
      ...(input.to === 'ended' ? { endedAt: input.at } : {}),
      ...(input.to === 'retired' ? { retiredAt: input.at } : {}),
    })
    .where(and(eq(referralPrograms.id, input.id), eq(referralPrograms.status, input.expected)))
    .returning();
  return row;
}
