/**
 * The bounded referral pilot (#149) against a REAL PostgreSQL server.
 *
 * Everything pinned here is a property a mocked repository cannot see: a CHECK,
 * a trigger, a partial unique index, and the convergence an `ON CONFLICT DO
 * NOTHING … RETURNING` gives two observations of one breach. A constraint
 * without a real server behind it is a comment.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created. The one thing worth
 * naming: `referral_pilot_cohorts_active_program_key` is keyed on the
 * PROGRAMME, not on a global pilot key — so two files publishing bounds at once
 * do not contend, which a single global slot would have made them do
 * (`match_policy_versions_active_key`'s hazard, avoided rather than queued for).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  referralCodes,
  referralPartners,
  referralPrograms,
  referralTouches,
} from '../../../db/schema/referrals.js';
import {
  referralPilotCohorts,
  referralPilotPartners,
  referralPilotStopThresholds,
  referralPilotStops,
} from '../../../db/schema/referralPilot.js';
import {
  addReferralPilotPartner,
  addReferralPilotThreshold,
  createReferralPilotCohortDraft,
  findActiveReferralPilotCohort,
  liftReferralPilotStopRow,
  publishReferralPilotCohortVersion,
  raiseReferralPilotStopRow,
  recordReferralPilotReview,
  type NewReferralPilotCohort,
} from '../../../db/referralPilot/pilotRepository.js';
import { createProgramDraft, publishProgram } from '../../referrals/program.service.js';
import { issueCode } from '../../referrals/instrument.service.js';
import { registerCodeTouch } from '../../referrals/touch.service.js';
import { attributeTouch } from '../../referrals/attribution.service.js';
import { applyAsPartner, approvePartner } from '../../referrals/partner.service.js';
import { deleteReferralPilotFixtures } from './pilot-fixture.js';

let db: Database;

const TAG = uuidv7().replace(/-/g, '').slice(-10);
const OPERATOR = `pilot-operator-${TAG}`;

const trackedProgramIds: string[] = [];
const trackedPartnerIds: string[] = [];
const trackedTouchIds: string[] = [];
const trackedCodeIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await deleteReferralPilotFixtures(trackedProgramIds, db);
  if (trackedTouchIds.length > 0) {
    await db.delete(referralTouches).where(inArray(referralTouches.id, trackedTouchIds));
  }
  if (trackedCodeIds.length > 0) {
    await db.delete(referralCodes).where(inArray(referralCodes.id, trackedCodeIds));
  }
  // `referral_codes.partner_id` is `restrict`, so a code minted by a test that
  // FAILED before it could track its id would block the partner delete below —
  // sweep by partner rather than by the tracked list, which is what a teardown
  // scoped to what it created actually means here.
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralTouches).where(inArray(referralTouches.partnerId, trackedPartnerIds));
    await db.delete(referralCodes).where(inArray(referralCodes.partnerId, trackedPartnerIds));
  }
  if (trackedPartnerIds.length > 0) {
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
 * Assert a write was refused BY A NAMED RULE.
 *
 * `rejects.toThrow()` alone also passes when the WRONG rule fired, which on a
 * table carrying a dozen CHECKs is most of the value of the assertion.
 */
async function expectRefusedBy(write: () => Promise<unknown>, rule: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the rule did not fire').toBeDefined();
  expect(refusalTextOf(caught), `expected ${String(rule)}; got: ${String(caught)}`).toMatch(rule);
}

/** Every message and constraint name in a wrapped driver error. */
function refusalTextOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    const named = current as { constraint_name?: unknown; message?: unknown; cause?: unknown };
    if (typeof named.constraint_name === 'string') parts.push(named.constraint_name);
    if (typeof named.message === 'string') parts.push(named.message);
    current = named.cause;
  }
  return parts.join(' | ');
}

/** A published programme, so a cohort has a real version to pin. */
async function makeProgram(label: string): Promise<{ programId: string; versionId: string }> {
  const draft = await createProgramDraft({
    name: `Pilot programme ${label} ${TAG}`,
    description: 'bounds under test',
    publicTermsSummary: 'terms',
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
    commissionRuleRef: `rule-${label}-${TAG}`,
    holdDays: 60,
    payoutPolicyRef: 'stripe-monthly',
    termsVersion: 't1',
    disclosureVersion: 'd1',
    createdByOxyUserId: OPERATOR,
    cohortKeys: [],
  });
  trackedProgramIds.push(draft.programId);
  const published = await publishProgram({ id: draft.id, approvedByOxyUserId: OPERATOR });
  return { programId: draft.programId, versionId: published.id };
}

async function makePartner(label: string): Promise<string> {
  const { partner } = await applyAsPartner({
    ownerType: 'user',
    ownerId: `pilot-owner-${label}-${TAG}`,
    displayName: `Pilot partner ${label}`,
    termsVersion: 't1',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);
  await approvePartner({ partnerId: partner.id, actorOxyUserId: OPERATOR, reason: 'test' });
  return partner.id;
}

function draftInput(
  program: { programId: string; versionId: string },
  overrides: Partial<NewReferralPilotCohort> = {},
): NewReferralPilotCohort {
  return {
    cohortKey: `pilot-${program.programId}`,
    version: 1,
    subject: 'customer_acquisition',
    legalEntity: 'Mercaria Pilot SL',
    programOwnerOxyUserId: OPERATOR,
    programId: program.programId,
    programVersionId: program.versionId,
    markets: ['ES'],
    payoutCurrency: 'EUR',
    // Both instants are safely in the PAST. Nothing here attributes, so the
    // window's relation to the real clock is irrelevant — and a fixture pinned
    // to a date the clock is still travelling toward breaks CI for whoever
    // pushes on the day it arrives, in a file they did not touch (#253).
    startsAt: new Date('2025-01-01T00:00:00.000Z'),
    endsAt: new Date('2025-07-01T00:00:00.000Z'),
    maxAttributionsPerPartner: 50,
    maxAttributionsTotal: 200,
    rewardBudgetMinor: 500_000,
    manualReviewRequired: true,
    rationale: 'bounds under test',
    ...overrides,
  };
}

describe('the gate is REACHABLE, not merely present', () => {
  it('refuses a new attribution for a programme with no active cohort', async () => {
    // The isolation test asserts the gate is IMPORTED and its refusal spelled;
    // both survive a `if (false && …)` around the branch. Only driving a real
    // attribution proves the refusal is reachable, and this case is what goes
    // red when somebody unwires it — measured, by exactly that mutation.
    const program = await makeProgram('unbounded');
    const partnerId = await makePartner('unbounded');
    const code = await issueCode({
      partnerId,
      programId: program.programId,
      requestedCode: `pilot-none-${TAG}`,
    });
    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: {
        actor: { kind: 'oxy_user', ref: `buyer-none-${TAG}` },
        clientSurface: 'web',
        consentMode: 'granted',
      },
    });

    const outcome = await attributeTouch(touch.touch.id);
    expect(outcome).toEqual({ outcome: 'refused', reason: 'pilot_not_admitted' });

    // …and the TOUCH survives: #149 gates the loop, never the durable record,
    // so bounds published later resolve evidence taken before them.
    const rows = await db
      .select({ id: referralTouches.id })
      .from(referralTouches)
      .where(eq(referralTouches.id, touch.touch.id));
    expect(rows).toHaveLength(1);
    trackedTouchIds.push(touch.touch.id);
    trackedCodeIds.push(code.id);
  });
});

describe('a published cohort is frozen, and a widening is a new version', () => {
  it('refuses every bound change once the version is active', async () => {
    const program = await makeProgram('freeze');
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    // A DRAFT is still editable — the freeze must not fire before publication.
    await db
      .update(referralPilotCohorts)
      .set({ maxAttributionsTotal: 300 })
      .where(eq(referralPilotCohorts.id, draft.id));

    const published = await publishReferralPilotCohortVersion({
      cohortId: draft.id,
      publishedByOxyUserId: OPERATOR,
    });
    expect(published?.status).toBe('active');

    await expectRefusedBy(
      () =>
        db
          .update(referralPilotCohorts)
          .set({ maxAttributionsTotal: 999 })
          .where(eq(referralPilotCohorts.id, draft.id)),
      /immutable once published/i,
    );
  });

  it('refuses a partner or a threshold added to a PUBLISHED cohort', async () => {
    const program = await makeProgram('grow');
    const partner = await makePartner('grow');
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    await addReferralPilotPartner({
      cohortId: draft.id,
      partnerId: partner,
      addedByOxyUserId: OPERATOR,
      note: 'first',
    });
    await publishReferralPilotCohortVersion({
      cohortId: draft.id,
      publishedByOxyUserId: OPERATOR,
    });

    const second = await makePartner('grow2');
    await expectRefusedBy(
      () =>
        addReferralPilotPartner({
          cohortId: draft.id,
          partnerId: second,
          addedByOxyUserId: OPERATOR,
          note: 'sneaked in',
        }),
      /cannot gain or change referral_pilot_partners rows/i,
    );
    await expectRefusedBy(
      () =>
        addReferralPilotThreshold({
          cohortId: draft.id,
          metric: 'privacy_incident',
          unit: 'count',
          thresholdValue: 0,
          windowHours: 0,
          scope: 'pilot',
        }),
      /cannot gain or change referral_pilot_stop_thresholds rows/i,
    );
  });

  it('permits exactly one ACTIVE version per programme, superseding the incumbent', async () => {
    const program = await makeProgram('supersede');
    const first = await createReferralPilotCohortDraft(draftInput(program));
    await publishReferralPilotCohortVersion({
      cohortId: first.id,
      publishedByOxyUserId: OPERATOR,
    });
    const second = await createReferralPilotCohortDraft(
      draftInput(program, { version: 2, supersedesCohortId: first.id }),
    );
    await publishReferralPilotCohortVersion({
      cohortId: second.id,
      publishedByOxyUserId: OPERATOR,
    });

    const active = await findActiveReferralPilotCohort(program.programId);
    expect(active?.version).toBe(2);
    const rows = await db
      .select({ status: referralPilotCohorts.status })
      .from(referralPilotCohorts)
      .where(eq(referralPilotCohorts.id, first.id));
    expect(rows[0]?.status).toBe('superseded');
  });

  it('refuses a version above 1 that names no predecessor, and a v1 that names one', async () => {
    const program = await makeProgram('chain');
    await expectRefusedBy(
      () => createReferralPilotCohortDraft(draftInput(program, { version: 2 })),
      /supersedes_check/,
    );
    const first = await createReferralPilotCohortDraft(draftInput(program));
    await expectRefusedBy(
      () =>
        createReferralPilotCohortDraft(
          draftInput(program, { version: 1, supersedesCohortId: first.id, cohortKey: `x-${TAG}` }),
        ),
      /supersedes_check/,
    );
  });
});

describe('the bounds a cohort may hold', () => {
  it('refuses an ACTIVE cohort with an empty market list', async () => {
    // `cardinality`, never `array_length`: the latter is NULL on `{}` and a
    // CHECK reads NULL as SATISFIED, so the obvious spelling admits exactly the
    // empty list it exists to refuse.
    const program = await makeProgram('markets');
    const draft = await createReferralPilotCohortDraft(draftInput(program, { markets: [] }));
    await expectRefusedBy(
      () =>
        publishReferralPilotCohortVersion({
          cohortId: draft.id,
          publishedByOxyUserId: OPERATOR,
        }),
      /markets_check/,
    );
  });

  it('refuses a market that is not ISO-3166 alpha-2, even beside a valid one', async () => {
    const program = await makeProgram('iso');
    const draft = await createReferralPilotCohortDraft(
      draftInput(program, { markets: ['ES', 'spain'] }),
    );
    await expectRefusedBy(
      () =>
        publishReferralPilotCohortVersion({
          cohortId: draft.id,
          publishedByOxyUserId: OPERATOR,
        }),
      /markets_check/,
    );
  });

  it('refuses an end date at or before its start, and a total cap below the per-partner one', async () => {
    const program = await makeProgram('bounds');
    await expectRefusedBy(
      () =>
        createReferralPilotCohortDraft(
          draftInput(program, {
            startsAt: new Date('2025-06-01T00:00:00.000Z'),
            endsAt: new Date('2025-06-01T00:00:00.000Z'),
          }),
        ),
      /window_check/,
    );
    await expectRefusedBy(
      () =>
        createReferralPilotCohortDraft(
          draftInput(program, { maxAttributionsPerPartner: 100, maxAttributionsTotal: 50 }),
        ),
      /caps_check/,
    );
    await expectRefusedBy(
      () => createReferralPilotCohortDraft(draftInput(program, { rewardBudgetMinor: 0 })),
      /caps_check/,
    );
  });
});

describe('the expansion review is dated, attributed and written once', () => {
  it('records all four columns together and refuses a second review', async () => {
    const program = await makeProgram('review');
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    await publishReferralPilotCohortVersion({
      cohortId: draft.id,
      publishedByOxyUserId: OPERATOR,
    });

    const reviewed = await recordReferralPilotReview({
      cohortId: draft.id,
      decision: 'continue',
      reviewedByOxyUserId: OPERATOR,
      rationale: 'the measured window supports continuing',
      closes: false,
    });
    expect(reviewed?.reviewDecision).toBe('continue');
    expect(reviewed?.reviewedAt).not.toBeNull();

    // A CAS on "no review yet": a second one finds nothing to write.
    const again = await recordReferralPilotReview({
      cohortId: draft.id,
      decision: 'end',
      reviewedByOxyUserId: OPERATOR,
      rationale: 'changed my mind',
      closes: true,
    });
    expect(again).toBeUndefined();

    // …and the trigger refuses a hand-written edit of the same columns.
    await expectRefusedBy(
      () =>
        db
          .update(referralPilotCohorts)
          .set({ reviewDecision: 'expand' })
          .where(eq(referralPilotCohorts.id, draft.id)),
      /written once/i,
    );
  });

  it('refuses a partial review, and a `closed` version with none', async () => {
    const program = await makeProgram('partial');
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    await expectRefusedBy(
      () =>
        db
          .update(referralPilotCohorts)
          .set({ reviewDecision: 'expand' })
          .where(eq(referralPilotCohorts.id, draft.id)),
      /review_check/,
    );
    await expectRefusedBy(
      () =>
        db
          .update(referralPilotCohorts)
          .set({ status: 'closed' })
          .where(eq(referralPilotCohorts.id, draft.id)),
      /closed_check/,
    );
  });
});

describe('stops converge, lift once, and are append-only', () => {
  async function activeCohort(label: string): Promise<string> {
    const program = await makeProgram(label);
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    const published = await publishReferralPilotCohortVersion({
      cohortId: draft.id,
      publishedByOxyUserId: OPERATOR,
    });
    if (!published) throw new Error('fixture: cohort did not publish');
    return published.id;
  }

  it('converges two observations of one breach onto ONE row', async () => {
    const cohortId = await activeCohort('stop');
    const raise = {
      cohortId,
      metric: 'privacy_incident' as const,
      scope: 'pilot' as const,
      scopeRef: '',
      origin: 'automatic' as const,
      raisedByOxyUserId: null,
      observedValue: 1,
      thresholdValue: 0,
      detail: 'first',
    };
    expect(await raiseReferralPilotStopRow(raise)).toEqual({ raised: true });
    // The empty RETURNING set IS the "already stopped" answer — a read-then-
    // write lets two evaluations both see "no stop" and both page.
    expect(await raiseReferralPilotStopRow({ ...raise, detail: 'second' })).toEqual({
      raised: false,
    });
    const rows = await db
      .select({ id: referralPilotStops.id, detail: referralPilotStops.detail })
      .from(referralPilotStops)
      .where(eq(referralPilotStops.cohortId, cohortId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe('first');
  });

  it('pins the origin/raiser biconditional in BOTH directions', async () => {
    const cohortId = await activeCohort('origin');
    await expectRefusedBy(
      () =>
        raiseReferralPilotStopRow({
          cohortId,
          metric: 'privacy_incident',
          scope: 'pilot',
          scopeRef: '',
          origin: 'automatic',
          raisedByOxyUserId: OPERATOR,
          observedValue: 1,
          thresholdValue: 0,
          detail: 'automatic with a raiser',
        }),
      /origin_raiser_check/,
    );
    await expectRefusedBy(
      () =>
        raiseReferralPilotStopRow({
          cohortId,
          metric: 'privacy_incident',
          scope: 'pilot',
          scopeRef: '',
          origin: 'operator',
          raisedByOxyUserId: null,
          observedValue: 1,
          thresholdValue: 0,
          detail: 'operator with no raiser',
        }),
      /origin_raiser_check/,
    );
  });

  it('lifts once, refuses a second lift, and refuses DELETE outright', async () => {
    const cohortId = await activeCohort('lift');
    await raiseReferralPilotStopRow({
      cohortId,
      metric: 'privacy_incident',
      scope: 'pilot',
      scopeRef: '',
      origin: 'automatic',
      raisedByOxyUserId: null,
      observedValue: 1,
      thresholdValue: 0,
      detail: 'raised',
    });
    const [row] = await db
      .select({ id: referralPilotStops.id })
      .from(referralPilotStops)
      .where(eq(referralPilotStops.cohortId, cohortId));
    const stopId = row?.id;
    expect(stopId).toBeDefined();
    if (stopId === undefined) return;

    expect(
      await liftReferralPilotStopRow({
        stopId,
        liftedByOxyUserId: OPERATOR,
        reason: 'the cause was addressed',
      }),
    ).toBe(true);
    // A CAS, so a second lift finds nothing.
    expect(
      await liftReferralPilotStopRow({
        stopId,
        liftedByOxyUserId: OPERATOR,
        reason: 'again',
      }),
    ).toBe(false);

    await expectRefusedBy(
      () => db.delete(referralPilotStops).where(eq(referralPilotStops.id, stopId)),
      /append-only/i,
    );
    await expectRefusedBy(
      () =>
        db
          .update(referralPilotStops)
          .set({ observedValue: 0 })
          .where(eq(referralPilotStops.id, stopId)),
      /immutable/i,
    );

    // …and the lifted row leaves the live key free, so the same condition can
    // be raised again. A pilot that stopped, was restarted and stopped again is
    // the most important thing in its own history.
    expect(
      await raiseReferralPilotStopRow({
        cohortId,
        metric: 'privacy_incident',
        scope: 'pilot',
        scopeRef: '',
        origin: 'automatic',
        raisedByOxyUserId: null,
        observedValue: 2,
        thresholdValue: 0,
        detail: 'again',
      }),
    ).toEqual({ raised: true });
  });

  it('forces an empty scopeRef on a pilot stop and a non-empty one otherwise', async () => {
    const cohortId = await activeCohort('scope');
    await expectRefusedBy(
      () =>
        raiseReferralPilotStopRow({
          cohortId,
          metric: 'privacy_incident',
          scope: 'pilot',
          scopeRef: 'partner-1',
          origin: 'automatic',
          raisedByOxyUserId: null,
          observedValue: 1,
          thresholdValue: 0,
          detail: 'pilot stop naming a subject',
        }),
      /scope_ref_check/,
    );
    await expectRefusedBy(
      () =>
        raiseReferralPilotStopRow({
          cohortId,
          metric: 'privacy_incident',
          scope: 'partner',
          scopeRef: '',
          origin: 'automatic',
          raisedByOxyUserId: null,
          observedValue: 1,
          thresholdValue: 0,
          detail: 'partner stop naming nobody',
        }),
      /scope_ref_check/,
    );
  });

  it('permits one threshold per metric and refuses a second', async () => {
    const program = await makeProgram('threshold');
    const draft = await createReferralPilotCohortDraft(draftInput(program));
    await addReferralPilotThreshold({
      cohortId: draft.id,
      metric: 'privacy_incident',
      unit: 'count',
      thresholdValue: 0,
      windowHours: 0,
      scope: 'pilot',
    });
    // Two rows for one metric would let a lenient one hide a strict one.
    await expectRefusedBy(
      () =>
        addReferralPilotThreshold({
          cohortId: draft.id,
          metric: 'privacy_incident',
          unit: 'count',
          thresholdValue: 100,
          windowHours: 0,
          scope: 'pilot',
        }),
      /cohort_metric_key/,
    );
    // …and a rate above its own denominator is not a threshold.
    await expectRefusedBy(
      () =>
        addReferralPilotThreshold({
          cohortId: draft.id,
          metric: 'refund_or_dispute_rate',
          unit: 'rate_bps',
          thresholdValue: 10_001,
          windowHours: 720,
          scope: 'pilot',
        }),
      /stop_thresholds_value_check/,
    );
    await db
      .delete(referralPilotStopThresholds)
      .where(eq(referralPilotStopThresholds.cohortId, draft.id));
    await db.delete(referralPilotPartners).where(eq(referralPilotPartners.cohortId, draft.id));
  });
});
