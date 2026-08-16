/**
 * The referral partner dashboard (#147), against a REAL Postgres server.
 *
 * Three of the four properties this issue turns on exist only with a server
 * behind it, which is why this is not a mocked suite:
 *
 *  - **the OWNER boundary** (#147 acceptance 3). Two partners with real rows,
 *    real touches and real conversions, each reading their own dashboard. A
 *    mocked repository returns whatever the test handed it, so it cannot tell a
 *    scoped query from an unscoped one — which is the whole question.
 *  - **the DISCLOSURE FLOOR over real aggregates**. The pure unit suite pins
 *    the rule; this pins that the rule is reached by SQL that grouped what it
 *    said it grouped, including the bot filter, which is a predicate and not a
 *    branch.
 *  - **the runtime PROJECTION WALK** over a genuinely composed dashboard —
 *    #92's two-gate rule, whose second gate exists precisely because a static
 *    scan sees the code somebody wrote and a walk sees what a serializer
 *    emitted.
 *
 * The fourth is #147 acceptance 4, program-version immutability, which is a
 * `WHERE status = 'draft'` predicate the server enforces and a mock accepts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { REFERRAL_PARTNER_DISCLOSURE_FLOOR } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralLinks,
  referralEvents,
  referralPartners,
  referralPrograms,
  referralTouches,
} from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import { insertProgramVersion } from '../../db/referrals/programRepository.js';
import { insertCode, insertLink } from '../../db/referrals/instrumentRepository.js';
import { insertTouch } from '../../db/referrals/touchRepository.js';
import { insertAttribution } from '../../db/referrals/attributionRepository.js';
import { upsertConversion } from '../../db/referrals/conversionRepository.js';
import {
  assertOwnsCode,
  assertOwnsLink,
  readReferralPartnerDashboard,
} from '../referrals/dashboard/dashboard.service.js';
import { readPartnerPerformance } from '../referrals/dashboard/performance.service.js';
import { findForbiddenPartnerFields } from '../referrals/dashboard/partner-projection.js';
import {
  createProgramDraft,
  editProgramDraft,
  endProgram,
  pauseProgram,
  publishProgram,
  resumeProgram,
} from '../referrals/program.service.js';

const TAG = uuidv7().slice(-8);
let db: Database;

const trackedPartnerIds: string[] = [];
const trackedProgramVersionIds: string[] = [];
const trackedProgramIds: string[] = [];

/** The window every performance read in this file uses. */
const FROM = '2026-07-01';
const THROUGH = '2026-07-31';
function at(day: number): Date {
  return new Date(`2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (trackedPartnerIds.length > 0) {
    // Children first, and no trigger window is needed: none of these five
    // tables carries an append-only trigger, so a plain DELETE is enough.
    await db
      .delete(referralConversions)
      .where(
        inArray(
          referralConversions.attributionId,
          db
            .select({ id: referralAttributions.id })
            .from(referralAttributions)
            .where(inArray(referralAttributions.partnerId, trackedPartnerIds)),
        ),
      );
    await db
      .delete(referralAttributions)
      .where(inArray(referralAttributions.partnerId, trackedPartnerIds));
    await db.delete(referralTouches).where(inArray(referralTouches.partnerId, trackedPartnerIds));
    await db
      .delete(referralLinks)
      .where(
        inArray(
          referralLinks.codeId,
          db
            .select({ id: referralCodes.id })
            .from(referralCodes)
            .where(inArray(referralCodes.partnerId, trackedPartnerIds)),
        ),
      );
    await db.delete(referralCodes).where(inArray(referralCodes.partnerId, trackedPartnerIds));
    await db
      .delete(referralEvents)
      .where(
        and(
          eq(referralEvents.subjectType, 'partner'),
          inArray(referralEvents.subjectId, trackedPartnerIds),
        ),
      );
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramVersionIds.length > 0) {
    await db
      .delete(referralEvents)
      .where(
        and(
          eq(referralEvents.subjectType, 'program'),
          inArray(referralEvents.subjectId, trackedProgramVersionIds),
        ),
      );
  }
  if (trackedProgramIds.length > 0) {
    await db
      .delete(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  await closePostgres();
}, 120_000);

/** A published, active program version this file owns. */
async function seedProgram(label: string) {
  const programId = `prog-${label}-${TAG}`;
  trackedProgramIds.push(programId);
  const row = await insertProgramVersion(db, {
    programId,
    version: 1,
    name: `Program ${label} ${TAG}`,
    description: 'Fixture',
    publicTermsSummary: 'Earn a share of Mercaria commission.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user'],
    eligibleSubjectKinds: ['oxy_user'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${label}-${TAG}:1`,
    holdDays: 60,
    payoutPolicyRef: `payout-${label}-${TAG}`,
    termsVersion: 'terms-2026-08-01',
    disclosureVersion: 'disclosure-2026-08-01',
    createdByOxyUserId: `oxy-op-${TAG}`,
    cohortKeys: [],
  });
  trackedProgramVersionIds.push(row.id);
  // Published and active, so program discovery has something to offer.
  await db
    .update(referralPrograms)
    .set({
      status: 'active',
      approvedByOxyUserId: `oxy-op-${TAG}`,
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
      effectiveStartAt: new Date('2026-06-01T00:00:00.000Z'),
    })
    .where(eq(referralPrograms.id, row.id));
  return { ...row, status: 'active' as const };
}

async function seedPartner(label: string) {
  const { row } = await insertPartner(db, {
    ownerType: 'user',
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

interface SeededCode {
  id: string;
  code: string;
}

async function seedCode(input: {
  partnerId: string;
  programVersionId: string;
  label: string;
  market?: string;
  campaignRef?: string;
}): Promise<SeededCode> {
  const code = await insertCode(db, {
    partnerId: input.partnerId,
    programVersionId: input.programVersionId,
    code: `c-${input.label}-${TAG}`.toLowerCase(),
    activatedAt: new Date('2026-06-01T00:00:00.000Z'),
    disclosureRequired: true,
    ...(input.market !== undefined ? { market: input.market } : {}),
    ...(input.campaignRef !== undefined ? { campaignRef: input.campaignRef } : {}),
  });
  if (!code) throw new Error('code collision in fixture');
  return { id: code.id, code: code.code };
}

async function seedTouch(input: {
  programVersionId: string;
  partnerId: string;
  codeId: string;
  day: number;
  trafficClass?: 'organic' | 'bot' | 'preview' | 'internal';
  clientSurface?: 'web' | 'ios' | 'android' | 'pos' | 'other';
}) {
  const occurredAt = at(input.day);
  return await insertTouch(db, {
    programVersionId: input.programVersionId,
    partnerId: input.partnerId,
    codeId: input.codeId,
    touchKind: 'code_entry_in_app',
    occurredAt,
    clientSurface: input.clientSurface ?? 'web',
    actorKind: 'oxy_user',
    oxyUserId: `subject-${uuidv7().slice(-10)}`,
    trafficClass: input.trafficClass ?? 'organic',
    consentMode: 'granted',
    attributionWindowExpiresAt: new Date(occurredAt.getTime() + 30 * 86_400_000),
    expiresAt: new Date(occurredAt.getTime() + 400 * 86_400_000),
  });
}

async function seedConversion(input: {
  programId: string;
  programVersionId: string;
  partnerId: string;
  codeId: string;
  touchId: string;
  day: number;
}) {
  const occurredAt = at(input.day);
  const subjectRef = `subject-${uuidv7().slice(-10)}`;
  const attribution = await insertAttribution(db, {
    programId: input.programId,
    programVersionId: input.programVersionId,
    partnerId: input.partnerId,
    subjectKind: 'oxy_user',
    subjectRef,
    winningTouchId: input.touchId,
    winningCodeId: input.codeId,
    evidenceTouchKind: 'code_entry_in_app',
    evidenceOccurredAt: occurredAt,
    attributionPolicy: 'last_touch',
    ruleVersionRef: `rule-${TAG}:1`,
    expiresAt: new Date(occurredAt.getTime() + 30 * 86_400_000),
    originalActorKind: 'oxy_user',
  });
  if (!attribution) throw new Error('attribution fixture returned no row');
  const { row } = await upsertConversion(db, {
    attributionId: attribution.id,
    programVersionId: input.programVersionId,
    conversionType: 'first_qualifying_paid_order',
    sourceKind: 'order',
    sourceRef: `ord-${uuidv7().slice(-10)}`,
    sourceEventId: `evt-${uuidv7().slice(-10)}`,
    occurredAt,
    state: 'pending',
  });
  // `eligible` is the QUALIFIED state — `verifyConversion` is what normally
  // moves it, and the fixture writes the same column the service does.
  await db
    .update(referralConversions)
    .set({ state: 'eligible', verifiedAt: occurredAt })
    .where(eq(referralConversions.id, row.id));
  return row;
}

describe('#147 acceptance 3 — a partner sees their own numbers and nobody else’s', () => {
  it('scopes every figure to the owner the MOUNT resolved', async () => {
    const program = await seedProgram('scope');
    const mine = await seedPartner('mine');
    const theirs = await seedPartner('theirs');

    const myCode = await seedCode({
      partnerId: mine.id,
      programVersionId: program.id,
      label: 'mine',
      market: 'ES',
    });
    const theirCode = await seedCode({
      partnerId: theirs.id,
      programVersionId: program.id,
      label: 'theirs',
      market: 'FR',
    });

    // Twelve clicks for me, forty for them — both above the floor, so a leak
    // would be visible as a number rather than as a suppression.
    for (let i = 0; i < 12; i += 1) {
      await seedTouch({
        programVersionId: program.id,
        partnerId: mine.id,
        codeId: myCode.id,
        day: 1 + (i % 20),
      });
    }
    for (let i = 0; i < 40; i += 1) {
      await seedTouch({
        programVersionId: program.id,
        partnerId: theirs.id,
        codeId: theirCode.id,
        day: 1 + (i % 20),
      });
    }

    const myPerformance = await readPartnerPerformance({
      partnerId: mine.id,
      dimension: 'market',
      from: FROM,
      through: THROUGH,
    });
    expect(myPerformance.totals.humanClicks).toBe(12);

    const theirPerformance = await readPartnerPerformance({
      partnerId: theirs.id,
      dimension: 'market',
      from: FROM,
      through: THROUGH,
    });
    expect(theirPerformance.totals.humanClicks).toBe(40);

    // The market breakdown is a single row each and both clear the floor, so
    // neither is suppressed — and neither carries the other's market.
    expect(myPerformance.rows.map((r) => r.key)).toEqual(['ES']);
    expect(theirPerformance.rows.map((r) => r.key)).toEqual(['FR']);
  }, 120_000);
});

describe('instrument ownership is decided by reading the instrument, not by listing', () => {
  it('refuses another partner\'s code and link with the SAME 404', async () => {
    const program = await seedProgram('own');
    const mine = await seedPartner('own-mine');
    const theirs = await seedPartner('own-theirs');
    const myCode = await seedCode({
      partnerId: mine.id,
      programVersionId: program.id,
      label: 'own-mine',
    });
    const theirCode = await seedCode({
      partnerId: theirs.id,
      programVersionId: program.id,
      label: 'own-theirs',
    });
    const theirLink = await insertLink(db, {
      id: uuidv7(),
      codeId: theirCode.id,
      token: `tok-own-${TAG}`,
      activatedAt: new Date(),
      disclosureRequired: true,
    });

    const owner = { ownerType: 'user' as const, ownerId: mine.ownerId };
    await expect(assertOwnsCode(owner, myCode.id, db)).resolves.toEqual({ partnerId: mine.id });
    await expect(assertOwnsCode(owner, theirCode.id, db)).rejects.toThrow(/not found/iu);
    await expect(assertOwnsLink(owner, theirLink.id, db)).rejects.toThrow(/not found/iu);
    // A code id that names nothing gets the SAME refusal as one that names
    // somebody else — a distinguishable answer enumerates other partners'
    // instruments.
    await expect(assertOwnsCode(owner, `01a00000-0000-7000-8000-00000000dead`, db)).rejects.toThrow(
      /not found/iu,
    );
  }, 120_000);

  it("answers for an owner's OWN instrument past any list cap", async () => {
    // The case the first implementation got wrong in the quiet direction. It
    // listed the owner's codes with `limit: 500` and looked for the id in
    // them, so a partner past the cap was answered 404 for one of their own —
    // indistinguishable from the refusal the function exists to give. Reading
    // the instrument BY ID has no cap to fall off, and this asserts the
    // property directly rather than seeding five hundred rows to prove it:
    // `assertOwnsCode` issues no list read at all.
    const program = await seedProgram('cap');
    const partner = await seedPartner('cap');
    const code = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'cap',
    });
    const link = await insertLink(db, {
      id: uuidv7(),
      codeId: code.id,
      token: `tok-cap-${TAG}`,
      activatedAt: new Date(),
      disclosureRequired: true,
    });
    const owner = { ownerType: 'user' as const, ownerId: partner.ownerId };
    await expect(assertOwnsCode(owner, code.id, db)).resolves.toEqual({ partnerId: partner.id });
    await expect(assertOwnsLink(owner, link.id, db)).resolves.toEqual({ partnerId: partner.id });

    const source = readFileSync(
      join(process.cwd(), 'src/services/referrals/dashboard/dashboard.service.ts'),
      'utf8',
    );
    // The mutation guard for the paragraph above: reintroducing either list
    // read reintroduces the cap, and no functional case at fixture scale can
    // see it.
    expect(source).not.toMatch(/assertOwns[\s\S]{0,600}listCodesByPartner/u);
    expect(source).not.toMatch(/assertOwns[\s\S]{0,600}listLinksByCode/u);
  }, 120_000);
});

describe('the disclosure floor over REAL aggregates', () => {
  it('drops a market under the floor and keeps it in the undimensioned total', async () => {
    const program = await seedProgram('floor');
    const partner = await seedPartner('floor');
    const big = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'big',
      market: 'ES',
    });
    const mid = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'mid',
      market: 'PT',
    });
    const tiny = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'tiny',
      market: 'AD',
    });

    for (let i = 0; i < 25; i += 1) {
      await seedTouch({ programVersionId: program.id, partnerId: partner.id, codeId: big.id, day: 2 });
    }
    for (let i = 0; i < 14; i += 1) {
      await seedTouch({ programVersionId: program.id, partnerId: partner.id, codeId: mid.id, day: 3 });
    }
    for (let i = 0; i < 2; i += 1) {
      await seedTouch({ programVersionId: program.id, partnerId: partner.id, codeId: tiny.id, day: 4 });
    }

    const byMarket = await readPartnerPerformance({
      partnerId: partner.id,
      dimension: 'market',
      from: FROM,
      through: THROUGH,
    });

    expect(byMarket.disclosureFloor).toBe(REFERRAL_PARTNER_DISCLOSURE_FLOOR);
    expect(byMarket.totals.humanClicks).toBe(41);
    // `AD` is below the floor and goes, and because it was the ONLY one below,
    // the smallest survivor (`PT`) goes with it — otherwise 41 minus the
    // published rows restores `AD` exactly.
    const keys = byMarket.rows.map((r) => r.key);
    expect(keys).toEqual(['ES']);
    expect(byMarket.withheldRowCount).toBe(2);
    expect(JSON.stringify(byMarket.rows)).not.toContain('AD');

    // The same partner's DATE breakdown publishes the small days: a date is a
    // fact about the promotion, not about who arrived.
    const byDate = await readPartnerPerformance({
      partnerId: partner.id,
      dimension: 'date',
      from: FROM,
      through: THROUGH,
    });
    expect(byDate.disclosureFloor).toBeUndefined();
    expect(byDate.rows.find((r) => r.key === '2026-07-04')?.humanClicks).toBe(2);
  }, 120_000);

  it('counts organic clicks only, and that is a PREDICATE rather than a branch', async () => {
    const program = await seedProgram('bots');
    const partner = await seedPartner('bots');
    const code = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'bots',
      market: 'ES',
    });

    for (let i = 0; i < 5; i += 1) {
      await seedTouch({ programVersionId: program.id, partnerId: partner.id, codeId: code.id, day: 5 });
    }
    for (const trafficClass of ['bot', 'preview', 'internal'] as const) {
      await seedTouch({
        programVersionId: program.id,
        partnerId: partner.id,
        codeId: code.id,
        day: 5,
        trafficClass,
      });
    }

    const result = await readPartnerPerformance({
      partnerId: partner.id,
      dimension: 'date',
      from: FROM,
      through: THROUGH,
    });
    expect(result.totals.humanClicks).toBe(5);

    // Vacuity floor on the fixture itself: eight touches really were written,
    // so "five" is a filter having worked rather than three inserts failing.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(referralTouches)
      .where(eq(referralTouches.partnerId, partner.id));
    expect(Number(count)).toBe(8);
  }, 120_000);

  it('counts a qualified conversion and excludes a pending one', async () => {
    const program = await seedProgram('conv');
    const partner = await seedPartner('conv');
    const code = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'conv',
      campaignRef: 'summer',
    });
    const touch = await seedTouch({
      programVersionId: program.id,
      partnerId: partner.id,
      codeId: code.id,
      day: 6,
    });
    await seedConversion({
      programId: program.programId,
      programVersionId: program.id,
      partnerId: partner.id,
      codeId: code.id,
      touchId: touch.id,
      day: 6,
    });

    // A second conversion left `pending` — a candidate nobody verified.
    const pendingAttribution = await insertAttribution(db, {
      programId: program.programId,
      programVersionId: program.id,
      partnerId: partner.id,
      subjectKind: 'oxy_user',
      subjectRef: `subject-${uuidv7().slice(-10)}`,
      winningTouchId: touch.id,
      winningCodeId: code.id,
      evidenceTouchKind: 'code_entry_in_app',
      evidenceOccurredAt: at(6),
      attributionPolicy: 'last_touch',
      ruleVersionRef: `rule-${TAG}:1`,
      expiresAt: new Date(at(6).getTime() + 30 * 86_400_000),
      originalActorKind: 'oxy_user',
    });
    if (!pendingAttribution) throw new Error('attribution fixture returned no row');
    await upsertConversion(db, {
      attributionId: pendingAttribution.id,
      programVersionId: program.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `ord-${uuidv7().slice(-10)}`,
      sourceEventId: `evt-${uuidv7().slice(-10)}`,
      occurredAt: at(6),
      state: 'pending',
    });

    const byCampaign = await readPartnerPerformance({
      partnerId: partner.id,
      dimension: 'campaign',
      from: FROM,
      through: THROUGH,
    });
    expect(byCampaign.totals.qualifiedConversions).toBe(1);
    expect(byCampaign.rows.find((r) => r.key === 'summer')?.qualifiedConversions).toBe(1);
  }, 120_000);
});

describe('the composed dashboard', () => {
  it('carries nothing ADR 0005 A5 forbids, walked over a REAL response', async () => {
    const program = await seedProgram('walk');
    const partner = await seedPartner('walk');
    const code = await seedCode({
      partnerId: partner.id,
      programVersionId: program.id,
      label: 'walk',
      market: 'ES',
      campaignRef: 'autumn',
    });
    const touch = await seedTouch({
      programVersionId: program.id,
      partnerId: partner.id,
      codeId: code.id,
      day: 7,
    });
    await seedConversion({
      programId: program.programId,
      programVersionId: program.id,
      partnerId: partner.id,
      codeId: code.id,
      touchId: touch.id,
      day: 7,
    });

    const dashboard = await readReferralPartnerDashboard({
      ownerType: 'user',
      ownerId: partner.ownerId,
    });

    // The walk itself, over a genuinely composed response rather than a
    // fixture somebody shaped to pass.
    expect(findForbiddenPartnerFields(dashboard)).toEqual([]);

    // POSITIVE CONTROL. "I found no forbidden field" and "I walked nothing"
    // produce the same empty array, so the walker is shown a real emitted
    // dashboard with one field added and must find exactly it.
    const tampered = JSON.parse(JSON.stringify(dashboard)) as Record<string, unknown>;
    (tampered.partner as Record<string, unknown>).buyerEmail = 'someone@example.test';
    expect(findForbiddenPartnerFields(tampered)).toEqual(['$.partner.buyerEmail']);

    // And the dashboard is not vacuously safe by being empty.
    expect(dashboard.partner?.id).toBe(partner.id);
    expect(dashboard.instruments.codes.map((c) => c.id)).toContain(code.id);
    expect(dashboard.instruments.disclosureText.length).toBeGreaterThan(20);
    expect(dashboard.performance.metrics.length).toBeGreaterThanOrEqual(2);
    expect(dashboard.programs.length).toBeGreaterThanOrEqual(1);
    expect(dashboard.support.unavailable).toContain('dispute_thread_not_built');
  }, 120_000);

  it('names the revenue base beside every percentage', async () => {
    const program = await seedProgram('basis');
    const partner = await seedPartner('basis');
    await seedCode({ partnerId: partner.id, programVersionId: program.id, label: 'basis' });

    const dashboard = await readReferralPartnerDashboard({
      ownerType: 'user',
      ownerId: partner.ownerId,
    });
    const offer = dashboard.programs.find((o) => o.program.programId === program.programId);
    expect(offer).toBeDefined();
    // No rule version is active for this fixture's `commissionRuleRef`, so the
    // honest answer is `not_published` — NOT `0%`, which would tell a partner
    // they earn nothing rather than that nothing has been published.
    expect(offer?.rewardBasis.kind).toBe('not_published');
  }, 120_000);

  it('answers for an owner who has never enrolled without a 404', async () => {
    const dashboard = await readReferralPartnerDashboard({
      ownerType: 'user',
      ownerId: `never-${TAG}`,
    });
    expect(dashboard.partner).toBeUndefined();
    expect(dashboard.enrollment.outstanding).toContain('application_not_submitted');
    // The metric definitions still ship: the enrollment screen is exactly where
    // somebody reads what they would be measured on.
    expect(dashboard.performance.metrics.length).toBeGreaterThanOrEqual(2);
    expect(findForbiddenPartnerFields(dashboard)).toEqual([]);
  }, 120_000);
});

describe('#147 acceptance 4 — an operator cannot edit an ACTIVE version in place', () => {
  it('refuses the edit and publishes a new version instead', async () => {
    const draft = await createProgramDraft({
      name: `Lifecycle ${TAG}`,
      description: 'Fixture',
      publicTermsSummary: 'Terms.',
      family: 'buyer_referral',
      eligiblePartnerTypes: ['user'],
      eligibleSubjectKinds: ['oxy_user'],
      markets: [],
      currencies: [],
      channels: [],
      commercialModes: [],
      attributionPolicy: 'last_touch',
      attributionWindowDays: 30,
      qualifyingEventPolicy: 'first_qualifying_paid_order',
      commissionRuleRef: `rule-life-${TAG}:1`,
      holdDays: 60,
      payoutPolicyRef: `payout-life-${TAG}`,
      termsVersion: 'terms-2026-08-01',
      disclosureVersion: 'disclosure-2026-08-01',
      createdByOxyUserId: `oxy-op-${TAG}`,
      cohortKeys: [],
      effectiveStartAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    trackedProgramIds.push(draft.programId);
    trackedProgramVersionIds.push(draft.id);
    expect(draft.status).toBe('draft');

    // A draft edits.
    const edited = await editProgramDraft(draft.id, { holdDays: 45 });
    expect(edited.holdDays).toBe(45);

    const published = await publishProgram({
      id: draft.id,
      approvedByOxyUserId: `oxy-approver-${TAG}`,
    });
    expect(published.status).toBe('active');
    expect(published.approvedByOxyUserId).toBe(`oxy-approver-${TAG}`);

    // And a published one does NOT. The refusal is the repository's
    // `status = 'draft'` predicate, which a mocked update would accept.
    await expect(editProgramDraft(draft.id, { holdDays: 1 })).rejects.toThrow();
    const reread = await db
      .select({ holdDays: referralPrograms.holdDays })
      .from(referralPrograms)
      .where(eq(referralPrograms.id, draft.id));
    expect(reread[0]?.holdDays).toBe(45);
  }, 120_000);

  it('pauses, resumes and ends without touching anything durable', async () => {
    const draft = await createProgramDraft({
      name: `Levers ${TAG}`,
      description: 'Fixture',
      publicTermsSummary: 'Terms.',
      family: 'buyer_referral',
      eligiblePartnerTypes: ['user'],
      eligibleSubjectKinds: ['oxy_user'],
      markets: [],
      currencies: [],
      channels: [],
      commercialModes: [],
      attributionPolicy: 'last_touch',
      attributionWindowDays: 30,
      qualifyingEventPolicy: 'first_qualifying_paid_order',
      commissionRuleRef: `rule-lev-${TAG}:1`,
      holdDays: 60,
      payoutPolicyRef: `payout-lev-${TAG}`,
      termsVersion: 'terms-2026-08-01',
      disclosureVersion: 'disclosure-2026-08-01',
      createdByOxyUserId: `oxy-op-${TAG}`,
      cohortKeys: [],
      effectiveStartAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    trackedProgramIds.push(draft.programId);
    trackedProgramVersionIds.push(draft.id);
    await publishProgram({ id: draft.id, approvedByOxyUserId: `oxy-approver-${TAG}` });

    const paused = await pauseProgram({
      id: draft.id,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'Incident',
    });
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).not.toBeNull();

    const resumed = await resumeProgram({
      id: draft.id,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'Cleared',
    });
    expect(resumed.status).toBe('active');

    // `ended` had a status, a CHECK, an event action and a timestamp stamp
    // since #142, and NOTHING performed the transition until #147.
    const ended = await endProgram({
      id: draft.id,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'Business decision',
    });
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();

    // Idempotent: two operators pressing the same button converge instead of
    // the second getting a conflict about a decision already taken.
    const again = await endProgram({
      id: draft.id,
      actorOxyUserId: `oxy-op2-${TAG}`,
      reason: 'Business decision',
    });
    expect(again.status).toBe('ended');
    expect(again.endedAt?.getTime()).toBe(ended.endedAt?.getTime());
  }, 120_000);
});
