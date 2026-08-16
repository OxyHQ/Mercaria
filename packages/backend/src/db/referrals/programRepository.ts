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

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  ReferralAttributionPolicy,
  ReferralConversionType,
  ReferralPartnerOwnerType,
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
 * The statuses under which a program still accepts new partners.
 *
 * ONE constant, read by the SQL predicate below and by the reason derivation in
 * `programs.service.ts`. Those are two APPLICATIONS of one fact rather than two
 * spellings of it — the read needs an indexable predicate and the projection
 * needs a per-program reason, which is #106's `buyerOrClaimantSql` /
 * `authorizeOrderAccess` split, driven from both ends by one realdb matrix.
 */
export const OPEN_PROGRAM_STATUSES: readonly ReferralProgramStatus[] = ['active', 'scheduled'];

/**
 * The distinct program identities, each at its HIGHEST version — #147's
 * OPERATOR list.
 *
 * Selecting the ACTIVE version instead would make a program that has never been
 * published invisible to the operator who is drafting it, which is the one
 * reader who must see it. A partner's discovery surface wants a different set
 * and reads `listDiscoverableProgramIdentities` instead; the two questions were
 * answered by one unscoped query until #392, which is how a program could fall
 * off a partner's list entirely.
 *
 * Still bounded by `limit`, because an operator legitimately wants every
 * program and there is no predicate that narrows "all of them". The caller
 * fetches `limit + 1` and REPORTS the overflow: the population is small, but a
 * silent truncation ordered by a string is arbitrary about which programs it
 * hides, and an operator cannot act on an absence nothing announces.
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

/**
 * The EFFECTIVE version of every program: the ACTIVE one where a program has
 * one, else its highest version.
 *
 * `DISTINCT ON (program_id)` ordered by `status = 'active'` first, then version
 * DESC — which is exactly `findActiveProgramVersion(id) ?? highestVersion`, in
 * one statement rather than one per program. The one-active partial index makes
 * the first sort key unambiguous, so "active first" can only ever pick one row.
 *
 * A draft's terms are not what somebody would be enrolling under, which is why
 * the active version wins even when a higher draft exists.
 */
function effectiveProgramVersions(db: DatabaseOrTransaction) {
  return db
    .selectDistinctOn([referralPrograms.programId])
    .from(referralPrograms)
    .orderBy(
      referralPrograms.programId,
      sql`(${referralPrograms.status} = 'active') desc`,
      desc(referralPrograms.version),
    )
    .as('effective_program_versions');
}

/**
 * The programs one owner may be OFFERED — #147's partner discovery (#392).
 *
 * The predicate is the one `readProgramOffers` already applied in JavaScript,
 * moved to where it can decide what is READ: open status, owner-type
 * eligibility, or an enrollment the partner already holds. It is not a new
 * eligibility notion — inventing one would be a second answer to a question
 * `eligiblePartnerTypes` and `status` already answer.
 *
 * There is deliberately NO `limit`. The unscoped read had one and it was the
 * bug: past it a partner was never offered a program that exists, and because
 * the order was `program_id` — a string — WHICH programs vanished was arbitrary.
 * A limit over the SCOPED set would move that cliff rather than remove it. What
 * bounds this read is the predicate: the programs open to one owner type, plus
 * the ones that owner already earns under.
 *
 * The scope is applied AFTER the effective version is picked, not before. A
 * `WHERE` on the base table would be evaluated before `DISTINCT ON` chooses,
 * so a program whose ACTIVE version excludes this owner type but whose newer
 * SCHEDULED version admits them would be offered on terms nobody is serving.
 */
export async function listDiscoverableProgramIdentities(
  db: DatabaseOrTransaction,
  input: {
    ownerType: ReferralPartnerOwnerType;
    /** Programs this owner already holds an instrument under, if any. */
    enrolledProgramIds: readonly string[];
  },
): Promise<ReferralProgramRow[]> {
  const effective = effectiveProgramVersions(db);

  // A partner whose program was later closed to their owner type must still see
  // the terms they are earning under, or the dashboard would stop explaining
  // the money it is showing.
  //
  // `inArray` is guarded on the empty case deliberately: `inArray(col, [])`
  // renders as the literal `false`, which is correct here but only by accident
  // — an unguarded call reads as a predicate and is a constant.
  const enrolled =
    input.enrolledProgramIds.length > 0
      ? inArray(effective.programId, [...input.enrolledProgramIds])
      : undefined;

  const offerable = and(
    inArray(effective.status, [...OPEN_PROGRAM_STATUSES]),
    // The owner type is a bound SCALAR against a `text[]` COLUMN, so there is
    // no array literal being interpolated and no row-constructor trap here.
    sql`${input.ownerType} = any(${effective.eligiblePartnerTypes})`,
  );

  return await db
    .select()
    .from(effective)
    .where(enrolled ? or(offerable, enrolled) : offerable)
    .orderBy(effective.programId);
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
