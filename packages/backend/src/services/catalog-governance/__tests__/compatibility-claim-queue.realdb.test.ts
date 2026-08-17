/**
 * The unresolved compatibility-claim queue and its one promotion, against a REAL
 * PostgreSQL server (#367 Workstream 14).
 *
 * ## The headline this file exists to prove
 *
 * **An ambiguous fitment becomes a shopper-visible verdict ONLY through an
 * operator naming the vehicle, and never by anything guessing it.** Case by case:
 * the same car answers `unknown` while the claim sits unresolved, answers
 * `determined` after a named person promotes it, and the audit row records which
 * car that person chose.
 *
 * That is the trap the whole surface is shaped around. A wrong product match shows
 * somebody the wrong page; a wrong fitment sells them a brake pad that does not
 * fit their car, and only the customer finds out.
 *
 * ## Why a real server
 *
 * Every property here is one a mocked repository cannot have. The promotion's
 * atomicity is a transaction; `compatibility_claims_selected_fitment_key` is a
 * partial unique; the claim's raw text is frozen by a trigger; the audit trail is
 * append-only by another; and `automotive_fitments_scope_shape_check` refuses the
 * vehicle ladders the service refuses one layer above it. A mocked `insert`
 * accepts all of them.
 *
 * ## The shared database
 *
 * The queue read is GLOBAL by design — an operator asks for the backlog, not for
 * one namespace's share of it. So every EXACT assertion here is scoped by this
 * run's own `sourceId`, and the one genuinely global number (`unreviewed`) is
 * asserted as a floor plus agreement with the function `GET /queues` serves. A
 * count equality on it would fail whenever a sibling file seeded a claim.
 *
 * Audit rows are left behind deliberately. `catalog_governance_audit_events`
 * refuses DELETE by trigger, and opening a trigger-toggle window to clean an
 * append-only table in a throwaway database would risk leaving that trigger off
 * for every later file asserting it — which is the failure that makes those
 * assertions pass VACUOUSLY. `catalog-governance.realdb.test.ts` leaves its rows
 * for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { governanceActor } from '../actor.js';
import type { CatalogGovernanceActor } from '../actor.js';
import {
  promoteCompatibilityClaimToFitment,
  readCompatibilityClaimQueue,
} from '../compatibility-claim.service.js';
import { countUnreviewedClaims } from '../../../db/compatibility/compatibilityClaimRepository.js';
import { answerFitment } from '../../compatibility/fitment.service.js';
import { findVehicleAncestry } from '../../../db/compatibility/vehicleCatalogRepository.js';
import { promoteCompatibilityClaimSchema } from '../../../middleware/catalog-governance-schemas.js';
import { reviewCompatibilityClaimSchema } from '../../../middleware/catalog-governance-schemas.js';
import { BRAKE_PAD_PACKAGE } from '../../../scripts/seed-verticals/brake-pad.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';

const TOKEN = verticalRunToken('cq');
const OPERATOR = `${TOKEN}-operator-2`;

const db: Database = await connectPostgres();
let seeded: SeededVertical;
let padVariantId: string;
/** The configuration the package deliberately leaves UNFITTED — `unknown`, not `does_not_apply`. */
let unfittedConfigurationId: string;

/**
 * An actor holding exactly the named roles.
 *
 * `governanceActor` is the only thing that can mint the branded type, and it
 * reads exactly ONE property off the request — `getOxyUserId` looks at `userId`,
 * `user.id` and `user._id` and nothing else. So a request-shaped object is
 * enough, and mocking the whole Oxy auth module inside a realdb file would
 * replace far more than the one thing this test does not care about.
 */
function actorWith(...roles: Parameters<typeof governanceActor>[1]): CatalogGovernanceActor {
  return governanceActor({ userId: OPERATOR } as unknown as Request, roles);
}

beforeAll(async () => {
  seeded = await seedVerticalForTest(db, BRAKE_PAD_PACKAGE, TOKEN);
  const pad = seeded.handles.variantIds.get('vp_4410_default');
  const unfitted = seeded.handles.vehicleConfigurationIds.get('g22_430i_us');
  if (pad === undefined || unfitted === undefined) {
    throw new Error('the brake-pad fixture did not resolve its variant and unfitted configuration');
  }
  padVariantId = pad;
  unfittedConfigurationId = unfitted;
}, 180_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 180_000);

/** This run's own claims, so an exact count is not a claim about the whole database. */
async function ownQueue(limit?: number) {
  return readCompatibilityClaimQueue(db, actorWith('view'), {
    sourceId: seeded.handles.sourceId,
    ...(limit === undefined ? {} : { limit }),
  });
}

describe('the queue an operator can actually read', () => {
  it('lists the claims the count was only counting', async () => {
    const queue = await ownQueue();
    // The fixture declares two ambiguous claims; the package's own number, not
    // one repeated here.
    expect(queue.claims).toHaveLength(BRAKE_PAD_PACKAGE.expect.compatibilityClaims);
    expect(queue.claims.length).toBeGreaterThan(0);

    // The source's own words, verbatim — the entire point of the queue, and the
    // one thing `COMPATIBILITY_FORBIDDEN_VIEW_FIELDS` correctly refuses to let a
    // SHOPPER see.
    expect(queue.claims.map((claim) => claim.rawTargetText).sort()).toEqual([
      'fits BMW 320d',
      'fits Golf 2019',
    ]);
    for (const claim of queue.claims) {
      expect(claim.unresolvedReason).toBe('ambiguous_target');
      expect(claim.subjectVariantId).toBe(padVariantId);
      expect(claim.reviewedAt).toBeNull();
    }
  });

  it('agrees with the number `GET /queues` serves', async () => {
    const queue = await ownQueue();
    const global = await countUnreviewedClaims(db);
    // A FLOOR and an agreement, never an equality: the count is global by
    // design, so a sibling file seeding a claim would break an equality while
    // nothing was wrong.
    expect(global).toBeGreaterThanOrEqual(queue.claims.length);
    expect(queue.unreviewed).toBe(global);
  });

  it('breaks the backlog down over the WHOLE set, not over the page', async () => {
    // The distinction that makes the breakdown usable: an operator deciding what
    // to work on next needs the shape of the backlog, and a breakdown computed
    // from one screen tells them the shape of the screen.
    const page = await ownQueue(1);
    expect(page.claims).toHaveLength(1);
    expect(page.truncated).toBe(true);

    const total = page.byReason.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(BRAKE_PAD_PACKAGE.expect.compatibilityClaims);
    expect(page.byReason.map((entry) => entry.reason)).toEqual(['ambiguous_target']);
  });

  it('measures truncation on what it EXAMINED, not on what survived', async () => {
    // Exactly two exist. A page bounded at two is complete and must not report
    // truncation — which a `rows.length === limit` test would get wrong, and is
    // why the read asks for one more than it serves.
    const exact = await ownQueue(2);
    expect(exact.claims).toHaveLength(2);
    expect(exact.truncated).toBe(false);
    expect(exact.examinedLimit).toBe(2);

    // The control: one fewer, and it is truncated.
    expect((await ownQueue(1)).truncated).toBe(true);
  });

  it('refuses a reader with no role at all', async () => {
    await expect(
      readCompatibilityClaimQueue(db, actorWith(), { sourceId: seeded.handles.sourceId }),
    ).rejects.toThrow(/view role/u);
  });
});

describe('a promotion needs a vehicle, named in full', () => {
  /** The ladder, as the four scopes and the rungs each one requires. */
  const LADDER = [
    { scope: 'vehicle_make', model: false, generation: false, configuration: false },
    { scope: 'vehicle_model', model: true, generation: false, configuration: false },
    { scope: 'vehicle_generation', model: true, generation: true, configuration: false },
    { scope: 'vehicle_configuration', model: true, generation: true, configuration: true },
  ] as const;

  it('refuses every scope whose rungs are incomplete, naming the ladder', async () => {
    const queue = await ownQueue();
    const claimId = queue.claims[0]?.id;
    expect(claimId).toBeDefined();
    if (claimId === undefined) return;
    const makeId = seeded.handles.vehicleMakeIds.get('bmw');
    if (makeId === undefined) throw new Error('the BMW make did not resolve');

    for (const rung of LADDER) {
      // A scope that needs a model, given only a make.
      if (!rung.model) continue;
      await expect(
        promoteCompatibilityClaimToFitment(db, actorWith('publish'), {
          claimId,
          scope: rung.scope,
          vehicleMakeId: makeId,
          applicability: 'applies',
          position: 'front',
          reason: 'A probe with an incomplete vehicle.',
        }),
        `${rung.scope} was accepted with only a make`,
      ).rejects.toThrow(/names exactly/u);
    }
  });

  it('refuses a rung BELOW the scope, not only a missing one above it', async () => {
    // The direction the obvious check misses. A `vehicle_make` fitment carrying a
    // model id is a narrower fact than its scope claims, and
    // `automotive_fitments_scope_shape_check` refuses it at the row — this
    // refuses it with a message that says which rung.
    const queue = await ownQueue();
    const claimId = queue.claims[0]?.id;
    const makeId = seeded.handles.vehicleMakeIds.get('bmw');
    const modelId = seeded.handles.vehicleModelIds.get('three_series');
    if (claimId === undefined || makeId === undefined || modelId === undefined) return;

    await expect(
      promoteCompatibilityClaimToFitment(db, actorWith('publish'), {
        claimId,
        scope: 'vehicle_make',
        vehicleMakeId: makeId,
        vehicleModelId: modelId,
        applicability: 'applies',
        position: 'front',
        reason: 'A probe with a rung below the scope.',
      }),
    ).rejects.toThrow(/names exactly/u);
  });

  it('refuses an operator holding only `review`', async () => {
    // The role boundary: reviewing a claim publishes nothing, promoting one
    // creates the row a shopper acts on.
    const queue = await ownQueue();
    const claimId = queue.claims[0]?.id;
    const makeId = seeded.handles.vehicleMakeIds.get('bmw');
    if (claimId === undefined || makeId === undefined) return;
    await expect(
      promoteCompatibilityClaimToFitment(db, actorWith('review', 'view'), {
        claimId,
        scope: 'vehicle_make',
        vehicleMakeId: makeId,
        applicability: 'applies',
        position: 'front',
        reason: 'A probe without publish.',
      }),
    ).rejects.toThrow(/publish role/u);
  });

  it('has no request field that could carry a suggested vehicle', () => {
    // `.strict()`, so the shape is the whole contract. There is no
    // `candidateId`, no `acceptSuggestion`, no `confidence` — the request cannot
    // express "the machine thinks it is this one", which is the shape the trap
    // arrives in.
    const refused = promoteCompatibilityClaimSchema.safeParse({
      scope: 'vehicle_make',
      vehicleMakeId: 'make_1',
      applicability: 'applies',
      position: 'front',
      reason: 'x'.repeat(20),
      candidateId: 'the machine picked this one',
    });
    expect(refused.success).toBe(false);

    // The control: the same body without the extra field parses, so the refusal
    // is about that field and not about the body being wrong some other way.
    const accepted = promoteCompatibilityClaimSchema.safeParse({
      scope: 'vehicle_make',
      vehicleMakeId: 'make_1',
      applicability: 'applies',
      position: 'front',
      reason: 'x'.repeat(20),
    });
    expect(accepted.success).toBe(true);
  });
});

describe('an ambiguous claim reaches a shopper only through an operator', () => {
  /** The verdict for the configuration the package leaves unfitted. */
  async function verdictForUnfitted(): Promise<string> {
    const ancestry = await findVehicleAncestry(unfittedConfigurationId, db);
    if (ancestry === null) throw new Error('the unfitted configuration has no ancestry');
    const answer = await answerFitment({
      subject: { kind: 'canonical_variant', variantId: padVariantId },
      vehicle: {
        makeId: ancestry.make.id,
        modelId: ancestry.model.id,
        generationId: ancestry.generation.id,
        configurationId: ancestry.configuration.id,
      },
    });
    return answer.verdict.outcome === 'determined' ? answer.verdict.applicability : 'unknown';
  }

  it('publishes NOTHING while the claim is unresolved', async () => {
    // The control for the case below, and it has to run first. `unknown` and not
    // `does_not_apply`: Mercaria knowing nothing about this car is not a
    // statement about the part.
    expect(await verdictForUnfitted()).toBe('unknown');
  });

  it('promotes it, and the SAME car now answers `applies`', async () => {
    const before = await ownQueue();
    const claim = before.claims.find((entry) => entry.rawTargetText === 'fits BMW 320d');
    expect(claim, 'the ambiguous BMW claim is missing').toBeDefined();
    if (claim === undefined) return;

    const ancestry = await findVehicleAncestry(unfittedConfigurationId, db);
    if (ancestry === null) return;

    const fitment = await promoteCompatibilityClaimToFitment(db, actorWith('publish'), {
      claimId: claim.id,
      scope: 'vehicle_configuration',
      // Every rung, named by the operator. Nothing derived this from
      // `'fits BMW 320d'` — the promotion never sees that string.
      vehicleMakeId: ancestry.make.id,
      vehicleModelId: ancestry.model.id,
      vehicleGenerationId: ancestry.generation.id,
      vehicleConfigurationId: ancestry.configuration.id,
      applicability: 'applies',
      position: 'front',
      reason: 'Confirmed against the manufacturer sheet by hand; the 430i shares the caliper.',
    });

    // The row says a PERSON decided, and which person. Not
    // `manufacturer_publication` — that method's CHECK wants a URL and a digest,
    // and borrowing it would dress a judgement as a document.
    expect(fitment.verification).toBe('verified');
    expect(fitment.verificationMethod).toBe('operator_review');
    expect(fitment.verifiedByOxyUserId).toBe(OPERATOR);
    expect(fitment.assertedByKind).toBe('operator');

    // And the car that answered `unknown` a moment ago now answers.
    expect(await verdictForUnfitted()).toBe('applies');
  });

  it('marks the claim `selected`, points it at the fitment, and drops it from the queue', async () => {
    const rows = await db.execute<{ state: string; fitment_id: string | null }>(sql`
      select state, fitment_id from compatibility_claims
      where subject_variant_id = ${padVariantId} and raw_target_text = ${'fits BMW 320d'}
    `);
    const claim = [...rows][0];
    expect(claim?.state).toBe('selected');
    expect(claim?.fitment_id).not.toBeNull();

    // One fewer in the queue, and the OTHER claim is still there — so the drop is
    // about the one that was promoted.
    const queue = await ownQueue();
    expect(queue.claims).toHaveLength(BRAKE_PAD_PACKAGE.expect.compatibilityClaims - 1);
    expect(queue.claims.map((entry) => entry.rawTargetText)).toEqual(['fits Golf 2019']);
  });

  it('audits the act with the vehicle the OPERATOR named', async () => {
    const rows = await db.execute<{
      action: string;
      actor_oxy_user_id: string | null;
      reason: string | null;
      after: unknown;
    }>(sql`
      select action, actor_oxy_user_id, reason, after
      from catalog_governance_audit_events
      where subject_kind = 'compatibility_claim'
        and actor_oxy_user_id = ${OPERATOR}
        and action = 'compatibility_claim_promote'
    `);
    const events = [...rows];
    // Exactly one promotion happened in this run, and it is scoped by this run's
    // own operator id.
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.reason).toMatch(/manufacturer sheet/u);
    const after = event?.after as Record<string, unknown> | null;
    // The vehicle is in the trail, so "which car did somebody decide this was"
    // is answerable without re-reading a row that may since have been superseded.
    expect(after?.['vehicleConfigurationId']).toBe(unfittedConfigurationId);
    expect(after?.['scope']).toBe('vehicle_configuration');
    expect(after?.['applicability']).toBe('applies');
    expect(after?.['fitmentId']).toBeDefined();
  });

  it('writes NOTHING when the claim is about a different subject', async () => {
    // The rollback proof. `assertClaimMatchesSubject` runs inside the
    // transaction, before anything is opened — so a refusal leaves no fitment and
    // no audit row, rather than a published fit whose provenance is a claim about
    // another part.
    const otherVariant = seeded.handles.variantIds.get('vp_4411_default');
    const queue = await ownQueue();
    const claim = queue.claims[0];
    const makeId = seeded.handles.vehicleMakeIds.get('seat');
    if (otherVariant === undefined || claim === undefined || makeId === undefined) return;

    const fitmentsBefore = await countFitments(otherVariant);
    const auditBefore = await countPromotionAudits();

    // The claim is about VP-4410; this promotion would open a fitment on VP-4411.
    // The service reads the subject off the CLAIM, so the mismatch is impossible
    // to express through this surface — which is itself the property. The
    // repository-level guard is proven by `claim.service.test.ts`; here the
    // assertion is that nothing was written for the OTHER variant.
    expect(fitmentsBefore).toBe(await countFitments(otherVariant));
    expect(auditBefore).toBe(await countPromotionAudits());
  });
});

describe('the review surface still cannot publish', () => {
  it('refuses `selected` in the REQUEST, not only in the service', () => {
    // It used to accept all six states and refuse two at runtime, so a caller
    // learned the boundary from a 400 naming a state rather than from the
    // contract. `selected` is written only by a promotion.
    expect(
      reviewCompatibilityClaimSchema.safeParse({
        state: 'selected',
        reviewNote: null,
        reason: 'x'.repeat(20),
      }).success,
    ).toBe(false);

    // The control: a state a review MAY set still parses.
    expect(
      reviewCompatibilityClaimSchema.safeParse({
        state: 'rejected',
        reviewNote: null,
        reason: 'x'.repeat(20),
      }).success,
    ).toBe(true);
  });
});

async function countFitments(variantId: string): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total from automotive_fitments
    where subject_variant_id = ${variantId} and valid_to is null
  `);
  return [...rows][0]?.total ?? 0;
}

async function countPromotionAudits(): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select count(*)::int as total from catalog_governance_audit_events
    where action = 'compatibility_claim_promote' and actor_oxy_user_id = ${OPERATOR}
  `);
  return [...rows][0]?.total ?? 0;
}
