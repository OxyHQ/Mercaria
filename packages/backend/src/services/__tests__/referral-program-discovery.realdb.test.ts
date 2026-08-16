/**
 * Partner program discovery is SCOPED, against a REAL Postgres server (#392).
 *
 * `listProgramIdentities` had no `where` clause at all — `DISTINCT ON
 * (program_id)` ordered by `program_id` with a fixed `LIMIT` — and
 * `readProgramOffers` treated the result as "the programs", filtering for
 * eligibility in JavaScript AFTERWARDS. So the set a partner was offered was
 * the first N program ids in STRING order, and everything past that was
 * silently absent: no cursor, no total, no signal.
 *
 * Two properties need a server behind them, which is why this is not a mocked
 * suite:
 *
 *  - **the SCOPE is a predicate, not a branch.** A mocked repository returns
 *    whatever the test handed it, so it cannot tell a scoped query from an
 *    unscoped one — which is the entire question here. The regression case
 *    below seeds MORE programs than the old limit and asserts the one it owns
 *    still arrives; against the unscoped read it does not, because fifty-two
 *    lower-sorting ids occupy the whole page.
 *  - **the two ENDS of one rule agree.** The read needs an indexable predicate
 *    and the projection needs a per-program reason, so the rule is stated
 *    twice — #106's `buyerOrClaimantSql` / `authorizeOrderAccess` split. Two
 *    spellings of one rule can disagree, so ONE matrix drives both: what SQL
 *    returned, and what the projection said about it.
 *
 * Everything seeded here is scoped to ids this file owns (`TAG`), and the noise
 * programs are DRAFTS — never open, never enrolled — so after the scope lands
 * they are invisible to every other file's discovery reads as well as this
 * one's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ReferralPartnerOwnerType, ReferralProgramStatus } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { referralCodes, referralPartners, referralPrograms } from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import {
  insertProgramVersion,
  listDiscoverableProgramIdentities,
} from '../../db/referrals/programRepository.js';
import { insertCode } from '../../db/referrals/instrumentRepository.js';
import { readProgramOffers } from '../referrals/dashboard/programs.service.js';

const TAG = uuidv7().slice(-8);
let db: Database;

const trackedPartnerIds: string[] = [];
const trackedProgramIds: string[] = [];

/**
 * How many programs the unscoped read used to consider.
 *
 * Named here rather than imported because the constant is GONE — the scoped
 * read has no limit, so there is nothing left to import. What this number is
 * for is sizing the noise: the regression case must put more than this many
 * lower-sorting program ids in front of the program it owns, or it would pass
 * identically before and after and measure nothing.
 */
const RETIRED_DISCOVERY_LIMIT = 50;

const PUBLISHED = {
  approvedByOxyUserId: `oxy-op-${TAG}`,
  publishedAt: new Date('2026-06-01T00:00:00.000Z'),
  effectiveStartAt: new Date('2026-06-01T00:00:00.000Z'),
};

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralCodes).where(inArray(referralCodes.partnerId, trackedPartnerIds));
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db
      .delete(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  await closePostgres();
});

/**
 * One program version.
 *
 * `programId` is supplied rather than minted so the case can decide where the
 * row sorts: the unscoped read's order was `program_id` ascending, so "sorts
 * before the target" is what makes the regression deterministic no matter what
 * a sibling file has seeded into the shared database.
 */
async function seedProgram(input: {
  programId: string;
  version?: number;
  status?: ReferralProgramStatus;
  eligiblePartnerTypes: readonly ReferralPartnerOwnerType[];
}): Promise<{ id: string; programId: string }> {
  if (!trackedProgramIds.includes(input.programId)) trackedProgramIds.push(input.programId);
  const row = await insertProgramVersion(db, {
    programId: input.programId,
    version: input.version ?? 1,
    name: `Program ${input.programId}`,
    description: 'Fixture',
    publicTermsSummary: 'Earn a share of Mercaria commission.',
    family: 'buyer_referral',
    eligiblePartnerTypes: [...input.eligiblePartnerTypes],
    eligibleSubjectKinds: ['oxy_user'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${input.programId}:1`,
    holdDays: 60,
    payoutPolicyRef: `payout-${input.programId}`,
    termsVersion: 'terms-2026-08-01',
    disclosureVersion: 'disclosure-2026-08-01',
    createdByOxyUserId: `oxy-op-${TAG}`,
    cohortKeys: [],
  });

  const status = input.status ?? 'draft';
  if (status !== 'draft') {
    // `referral_programs_published_check` and `_status_times_check` want the
    // timestamps that go with the state, so they travel with it.
    await db
      .update(referralPrograms)
      .set({
        status,
        ...PUBLISHED,
        ...(status === 'ended' ? { endedAt: new Date('2026-07-01T00:00:00.000Z') } : {}),
        ...(status === 'paused' ? { pausedAt: new Date('2026-07-01T00:00:00.000Z') } : {}),
      })
      .where(eq(referralPrograms.id, row.id));
  }
  return { id: row.id, programId: row.programId };
}

async function seedPartner(label: string, ownerType: ReferralPartnerOwnerType = 'user') {
  const { row } = await insertPartner(db, {
    ownerType,
    ownerId: `owner-${label}-${TAG}`,
    displayName: `Partner ${label} ${TAG}`,
    state: 'applied',
    at: new Date(),
    termsVersion: 'terms-2026-08-01',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(row.id);
  return row;
}

/** An enrollment is an instrument under a program VERSION — what `listPartnerProgramIds` reads. */
async function enroll(partnerId: string, programVersionId: string, label: string): Promise<void> {
  const code = await insertCode(db, {
    partnerId,
    programVersionId,
    code: `c-${label}-${TAG}`.toLowerCase(),
    activatedAt: new Date('2026-06-01T00:00:00.000Z'),
    disclosureRequired: true,
  });
  if (!code) throw new Error('code collision in fixture');
}

describe('a program past the old page is still offered (#392)', () => {
  it('returns a program that sorts behind more than a page of others', async () => {
    // The noise sorts under `aaa-` and the target under `zzz-`, so at least
    // fifty-two program ids sit in front of the target no matter what siblings
    // have seeded. Drafts: never open, nobody enrolled, so once the read is
    // scoped they are invisible to this file's discovery and to everyone
    // else's — they exist only to fill the page the old read would have taken.
    const noiseCount = RETIRED_DISCOVERY_LIMIT + 2;
    for (let i = 0; i < noiseCount; i += 1) {
      await seedProgram({
        programId: `aaa-${TAG}-noise-${String(i).padStart(3, '0')}`,
        eligiblePartnerTypes: ['user'],
      });
    }

    const target = await seedProgram({
      programId: `zzz-${TAG}-target`,
      status: 'active',
      eligiblePartnerTypes: ['user'],
    });

    const { offers } = await readProgramOffers(
      { ownerType: 'user', acceptedTermsVersions: [] },
      db,
    );

    // Scoped to the id this file owns: siblings legitimately have their own
    // open programs in the same result, and asserting a LENGTH here would fail
    // on their work rather than on this one's.
    const mine = offers.find((offer) => offer.program.programId === target.programId);
    expect(mine, 'the target program fell off the discovery page').toBeDefined();
    expect(mine?.eligible).toBe(true);

    // The floor that makes the assertion above non-vacuous: the noise really
    // was written, so "found it" is not "the fixture seeded nothing".
    const seeded = await db
      .select({ programId: referralPrograms.programId })
      .from(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds));
    expect(seeded.length).toBeGreaterThan(RETIRED_DISCOVERY_LIMIT);
  }, 120_000);
});

describe('the scope and the reasons are two ends of ONE rule', () => {
  it('admits, excludes and explains each case the same way', async () => {
    const partner = await seedPartner('matrix');

    const openEligible = await seedProgram({
      programId: `mtx-${TAG}-open-eligible`,
      status: 'active',
      eligiblePartnerTypes: ['user'],
    });
    const openIneligible = await seedProgram({
      programId: `mtx-${TAG}-open-ineligible`,
      status: 'active',
      eligiblePartnerTypes: ['store'],
    });
    const closedEligible = await seedProgram({
      programId: `mtx-${TAG}-closed-eligible`,
      status: 'ended',
      eligiblePartnerTypes: ['user'],
    });
    const draftOnly = await seedProgram({
      programId: `mtx-${TAG}-draft-only`,
      eligiblePartnerTypes: ['user'],
    });
    const closedEnrolled = await seedProgram({
      programId: `mtx-${TAG}-closed-enrolled`,
      status: 'ended',
      eligiblePartnerTypes: ['user'],
    });
    const ineligibleEnrolled = await seedProgram({
      programId: `mtx-${TAG}-ineligible-enrolled`,
      status: 'active',
      eligiblePartnerTypes: ['store'],
    });

    await enroll(partner.id, closedEnrolled.id, 'closed-enrolled');
    await enroll(partner.id, ineligibleEnrolled.id, 'ineligible-enrolled');

    // ── End one: what SQL decided to READ. ────────────────────────────────
    //
    // Asserted directly, because the projection below applies the same rule a
    // second time — so a test that only read `readProgramOffers` would pass
    // with the SQL predicate deleted entirely and measure nothing about it.
    // Measured: removing either half of the predicate leaves the offer output
    // identical, which is what makes this end worth its own assertions.
    const mineOnly = (rows: readonly { programId: string }[]) =>
      rows.map((row) => row.programId).filter((id) => id.startsWith(`mtx-${TAG}-`));

    const scoped = mineOnly(
      await listDiscoverableProgramIdentities(db, {
        ownerType: 'user',
        enrolledProgramIds: [closedEnrolled.programId, ineligibleEnrolled.programId],
      }),
    );
    expect([...scoped].sort()).toEqual(
      [
        openEligible.programId,
        closedEnrolled.programId,
        ineligibleEnrolled.programId,
      ].sort(),
    );

    // With no enrollment the two escape-hatch rows go too — the enrollment is
    // an INPUT to the scope, not a post-filter.
    const scopedWithoutEnrollment = mineOnly(
      await listDiscoverableProgramIdentities(db, {
        ownerType: 'user',
        enrolledProgramIds: [],
      }),
    );
    expect(scopedWithoutEnrollment).toEqual([openEligible.programId]);

    // ── End two: what the PROJECTION said about it. ───────────────────────
    const { offers } = await readProgramOffers(
      { ownerType: 'user', acceptedTermsVersions: [], partnerId: partner.id },
      db,
    );
    const byId = new Map(offers.map((offer) => [offer.program.programId, offer]));

    // Offered, and the projection agrees it is offerable.
    expect(byId.get(openEligible.programId)?.eligible).toBe(true);
    expect(byId.get(openEligible.programId)?.ineligibleReasons).toEqual([]);

    // Not read at all — the SQL end of the rule.
    expect(byId.has(openIneligible.programId)).toBe(false);
    expect(byId.has(closedEligible.programId)).toBe(false);
    expect(byId.has(draftOnly.programId)).toBe(false);

    // Read BECAUSE enrolled, and the projection explains why it is not
    // offerable: a partner must keep seeing the terms they are earning under.
    expect(byId.get(closedEnrolled.programId)?.eligible).toBe(false);
    expect(byId.get(closedEnrolled.programId)?.ineligibleReasons).toContain('program_not_open');
    expect(byId.get(ineligibleEnrolled.programId)?.eligible).toBe(false);
    expect(byId.get(ineligibleEnrolled.programId)?.ineligibleReasons).toContain(
      'owner_type_not_eligible',
    );
  }, 120_000);

  it('reads the ACTIVE version even when a higher draft exists', async () => {
    // `DISTINCT ON` ordered by `status = 'active'` first, then version DESC —
    // the one-statement form of `findActiveProgramVersion(id) ?? highest`. A
    // draft's terms are not what somebody would be enrolling under, so v2 must
    // not be what the offer describes.
    const programId = `mtx-${TAG}-active-under-draft`;
    await seedProgram({ programId, version: 1, status: 'active', eligiblePartnerTypes: ['user'] });
    await seedProgram({ programId, version: 2, eligiblePartnerTypes: ['user'] });

    const { offers } = await readProgramOffers(
      { ownerType: 'user', acceptedTermsVersions: [] },
      db,
    );
    const mine = offers.find((offer) => offer.program.programId === programId);
    expect(mine, 'the program with an active v1 under a draft v2 was not offered').toBeDefined();
    expect(mine?.eligible).toBe(true);
  }, 120_000);
});
