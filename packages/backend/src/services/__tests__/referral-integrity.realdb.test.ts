/**
 * Referral integrity (#148), against a REAL Postgres server.
 *
 * Everything load-bearing here exists only with a server behind it. A mocked
 * `insert`/`update` accepts every statement this suite exists to see refused:
 *
 *  - `referral_enforcement_actions_forfeiture_basis_check`, which is ADR 0005
 *    D17's whole law — *"signals freeze; only first-party identity evidence
 *    voids"* — as a row shape rather than a branch;
 *  - `referral_enforcement_appeals_independence_check`, whose two comparisons
 *    use `IS DISTINCT FROM` because `<>` against a NULL decider is NULL and a
 *    CHECK reads NULL as SATISFIED, which would make both halves VACUOUS on
 *    every open appeal — exactly the rows they exist to constrain;
 *  - `referral_conduct_policies_conduct_nonempty_check`, which is
 *    `cardinality` and not `array_length` for the reason this repository has
 *    now measured three times;
 *  - four freeze/append-only triggers, each of which refuses an UPDATE a
 *    service is perfectly willing to issue;
 *  - three PARTIAL uniques (`…_live_key`, `…_open_key`, `…_active_key`) whose
 *    `ON CONFLICT` cannot infer an arbiter without repeating the predicate.
 *
 * ## The end-to-end case is #148 acceptance 2
 *
 * *"New attribution can be paused while valid existing earnings continue
 * settling."* Before #148 that was impossible: `referral_partners.state =
 * 'suspended'` stopped new links AND new attribution AND payout at once. The
 * suite drives a `new_attribution_suspension` and asserts the OTHER two gates
 * stay open — which is a fact about three separate call sites and cannot be
 * asserted against a mock of any of them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  REFERRAL_BASES_PERMITTING_FORFEITURE,
  REFERRAL_ENFORCEMENT_ACTIONS,
  REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS,
  REFERRAL_PROHIBITED_CONDUCT_KINDS,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { referralEvents, referralPartners } from '../../db/schema/referrals.js';
import {
  referralConductPolicies,
  referralDisclosureRequirements,
  referralEnforcementActions,
  referralEnforcementAppeals,
  referralRiskSignals,
} from '../../db/schema/referralIntegrity.js';
import {
  imposeEnforcementAction,
  liftEnforcement,
  readEnforcementEffects,
  toEnforcementPartnerView,
} from '../referrals/integrity/enforcement.service.js';
import { decideAppeal, openEnforcementAppeal } from '../referrals/integrity/appeal.service.js';
import { evaluatePartnerRisk } from '../referrals/integrity/risk-evaluation.service.js';

const TAG = uuidv7().slice(-8);
const OPERATOR_A = `op-a-${TAG}`;
const OPERATOR_B = `op-b-${TAG}`;

let db: Database;
const trackedPartnerIds: string[] = [];
const trackedPolicyKeys: string[] = [];
const trackedDisclosureKeys: string[] = [];

/**
 * An approved partner nothing else in the suite shares.
 *
 * A DIRECT insert rather than `insertPartner`, which types its `state` to the
 * three enrollment-entry states (#146) — reaching `approved` through the real
 * service would drag an application and a review into every case here, and what
 * this file is about is what happens to a partner who is already approved.
 */
async function approvedPartner(label: string): Promise<string> {
  const [row] = await db
    .insert(referralPartners)
    .values({
      ownerType: 'user',
      ownerId: `owner-${label}-${TAG}`,
      displayName: `Integrity ${label} ${TAG}`,
      enrollmentMode: 'open_application',
      state: 'approved',
      promotionMethods: ['website'],
    })
    .returning();
  trackedPartnerIds.push(row.id);
  return row.id;
}

/**
 * Assert a statement was refused by the DATABASE, matching the whole error
 * chain.
 *
 * `expect(...).rejects.toThrow(/…/)` matches `error.message`, and drizzle's
 * message is the QUERY WRAPPER — the constraint name and the trigger's own
 * sentence live on `cause`, which is this repository's standing driver gotcha.
 * Walking the chain is what makes an assertion about a CHECK an assertion about
 * that check rather than about the SQL text. Copied from
 * `referral-rewards.realdb.test.ts` rather than shared: a test helper exported
 * from a `*.test.ts` file registers that file's suites in whoever imports it.
 *
 * The `toBeDefined` is the positive control: a statement that did not fail at
 * all would otherwise pass by matching nothing.
 */
async function expectRejectedBy(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the statement was accepted, not refused').toBeDefined();
  const parts: string[] = [];
  let cursor: unknown = caught;
  while (cursor !== undefined && cursor !== null) {
    const error = cursor as { message?: string; constraint_name?: string; cause?: unknown };
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.constraint_name === 'string') parts.push(error.constraint_name);
    cursor = error.cause === cursor ? undefined : error.cause;
  }
  expect(parts.join('\n')).toMatch(matcher);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // ONE TABLE PER `withTriggerToggleLock` WINDOW, every statement on `tx`.
  // `DISABLE TRIGGER` takes ShareRowExclusive, whose counterparty is an
  // ordinary writer holding RowExclusive — the mutex serialises window against
  // window and cannot see that party, so holding two tables at once deadlocks.
  if (trackedPartnerIds.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_enforcement_appeals disable trigger mercaria_referral_enforcement_appeals_append_only`,
      );
      await tx
        .delete(referralEnforcementAppeals)
        .where(inArray(referralEnforcementAppeals.partnerId, trackedPartnerIds));
      await tx.execute(
        sql`alter table referral_enforcement_appeals enable trigger mercaria_referral_enforcement_appeals_append_only`,
      );
    });

    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_enforcement_actions disable trigger mercaria_referral_enforcement_actions_freeze`,
      );
      await tx
        .delete(referralEnforcementActions)
        .where(inArray(referralEnforcementActions.partnerId, trackedPartnerIds));
      await tx.execute(
        sql`alter table referral_enforcement_actions enable trigger mercaria_referral_enforcement_actions_freeze`,
      );
    });

    // `referral_risk_signals`' trigger is BEFORE UPDATE only — DELETE is
    // deliberately permitted, because the shared expiry sweep is what removes
    // these rows. So this needs no window at all, which is itself the property
    // under test one describe down.
    await db
      .delete(referralRiskSignals)
      .where(inArray(referralRiskSignals.partnerId, trackedPartnerIds));

    await db
      .delete(referralEvents)
      .where(inArray(referralEvents.subjectId, trackedPartnerIds));
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }

  if (trackedPolicyKeys.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_conduct_policies disable trigger mercaria_referral_conduct_policies_immutable`,
      );
      await tx
        .delete(referralConductPolicies)
        .where(inArray(referralConductPolicies.policyKey, trackedPolicyKeys));
      await tx.execute(
        sql`alter table referral_conduct_policies enable trigger mercaria_referral_conduct_policies_immutable`,
      );
    });
  }
  if (trackedDisclosureKeys.length > 0) {
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_disclosure_requirements disable trigger mercaria_referral_disclosure_requirements_immutable`,
      );
      await tx
        .delete(referralDisclosureRequirements)
        .where(inArray(referralDisclosureRequirements.disclosureKey, trackedDisclosureKeys));
      await tx.execute(
        sql`alter table referral_disclosure_requirements enable trigger mercaria_referral_disclosure_requirements_immutable`,
      );
    });
  }

  await closePostgres();
}, 120_000);

describe('the forfeiture law is a row shape (ADR 0005 D17)', () => {
  it('refuses every forfeiting action on a risk-signal basis, in the DATABASE', async () => {
    const partnerId = await approvedPartner('forfeit');
    // Straight at the table, past every service: this is the layer that has to
    // hold when a service bug, a future caller or `psql` gets it wrong.
    for (const action of REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS) {
      await expectRejectedBy(
      db.insert(referralEnforcementActions).values({
          partnerId,
          action,
          scope: action === 'attribution_invalidated' ? 'attribution' : 'conversion',
          subjectId: `subject-${TAG}`,
          basis: 'risk_signal',
          reason: 'a velocity anomaly',
          evidenceSignalIds: [uuidv7()],
          startsAt: new Date(),
          imposedByOxyUserId: OPERATOR_A,
        }),
      /forfeiture_basis_check/,
    );
    }
    // The floor: the loop must have run. A derived set that became empty would
    // pass every assertion above by making none.
    expect(REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS.length).toBeGreaterThan(0);
  });

  it('ADMITS the same actions on every basis the derivation permits', async () => {
    const partnerId = await approvedPartner('forfeit-ok');
    // The positive control. Without it, a CHECK that refused EVERYTHING would
    // pass the case above and nobody would notice until an operator could not
    // invalidate a genuine self-referral.
    for (const basis of REFERRAL_BASES_PERMITTING_FORFEITURE) {
      const [row] = await db
        .insert(referralEnforcementActions)
        .values({
          partnerId,
          action: 'attribution_invalidated',
          scope: 'attribution',
          subjectId: `attr-${basis}-${TAG}`,
          basis,
          reason: 'the converting account is the partner',
          evidenceSignalIds: [],
          startsAt: new Date(),
          imposedByOxyUserId: OPERATOR_A,
        })
        .returning();
      expect(row.basis).toBe(basis);
    }
    expect(REFERRAL_BASES_PERMITTING_FORFEITURE).not.toContain('risk_signal');
  });

  it('refuses a risk-signal action that names no signal', async () => {
    const partnerId = await approvedPartner('no-evidence');
    await expectRejectedBy(
      db.insert(referralEnforcementActions).values({
        partnerId,
        action: 'payout_hold',
        scope: 'partner',
        subjectId: partnerId,
        basis: 'risk_signal',
        reason: 'we saw a pattern',
        evidenceSignalIds: [],
        startsAt: new Date(),
        imposedByOxyUserId: OPERATOR_A,
      }),
      /signal_evidence_check/,
    );
  });

  it('the service refuses before the database does, and says why', async () => {
    const partnerId = await approvedPartner('service-refusal');
    await expect(
      imposeEnforcementAction({
        partnerId,
        action: 'conversion_rejected',
        scope: 'conversion',
        subjectId: `conv-${TAG}`,
        basis: 'risk_signal',
        reason: 'a velocity anomaly',
        evidenceSignalIds: [uuidv7()],
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toThrow(/signals freeze, only first-party identity evidence voids/);
  });
});

describe('scoped enforcement — #148 acceptance 2', () => {
  it('pauses NEW attribution while payout and link issuance stay open', async () => {
    const partnerId = await approvedPartner('scoped');
    await imposeEnforcementAction({
      partnerId,
      action: 'new_attribution_suspension',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'risk_signal',
      reason: 'conversion velocity under review',
      evidenceSignalIds: [uuidv7()],
      actorOxyUserId: OPERATOR_A,
    });

    const effects = await readEnforcementEffects(db, partnerId);
    expect(effects.newAttributionSuspended).toBe(true);
    // The two that must NOT move. This is the whole issue: before #148 the only
    // lever was `referral_partners.state = 'suspended'`, which raises all three.
    expect(effects.payoutHeld).toBe(false);
    expect(effects.newLinksSuspended).toBe(false);
    expect(effects.terminated).toBe(false);
  });

  it('holds payout while attribution and link issuance stay open', async () => {
    const partnerId = await approvedPartner('hold');
    await imposeEnforcementAction({
      partnerId,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'pending a documentation review',
      actorOxyUserId: OPERATOR_A,
    });
    const effects = await readEnforcementEffects(db, partnerId);
    expect(effects.payoutHeld).toBe(true);
    expect(effects.newAttributionSuspended).toBe(false);
    expect(effects.newLinksSuspended).toBe(false);
  });

  it('a program removal names its program and leaves the others alone', async () => {
    const partnerId = await approvedPartner('removal');
    await imposeEnforcementAction({
      partnerId,
      action: 'program_removal',
      scope: 'program_partner',
      subjectId: `${partnerId}:prog-a-${TAG}`,
      programId: `prog-a-${TAG}`,
      basis: 'operator_finding',
      reason: 'off-policy promotion in this program',
      actorOxyUserId: OPERATOR_A,
    });
    const effects = await readEnforcementEffects(db, partnerId);
    expect(effects.removedFromProgramIds).toEqual([`prog-a-${TAG}`]);
    expect(effects.newAttributionSuspended).toBe(false);
  });

  it('refuses a program-scoped action carrying no program, and the reverse', async () => {
    const partnerId = await approvedPartner('program-shape');
    await expectRejectedBy(
      db.insert(referralEnforcementActions).values({
        partnerId,
        action: 'program_removal',
        scope: 'program_partner',
        subjectId: `${partnerId}:x`,
        basis: 'operator_finding',
        reason: 'no program named',
        evidenceSignalIds: [],
        startsAt: new Date(),
        imposedByOxyUserId: OPERATOR_A,
      }),
      /program_shape_check/,
    );
    await expectRejectedBy(
      db.insert(referralEnforcementActions).values({
        partnerId,
        action: 'payout_hold',
        scope: 'partner',
        subjectId: partnerId,
        programId: `prog-${TAG}`,
        basis: 'operator_finding',
        reason: 'a partner-wide action naming a program',
        evidenceSignalIds: [],
        startsAt: new Date(),
        imposedByOxyUserId: OPERATOR_A,
      }),
      /program_shape_check/,
    );
  });

  it('an EXPIRED action stops biting with no sweep having run', async () => {
    const partnerId = await approvedPartner('expiry');
    const past = new Date(Date.now() - 60_000);
    await db.insert(referralEnforcementActions).values({
      partnerId,
      action: 'new_attribution_suspension',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'a fourteen-day suspension that has run out',
      evidenceSignalIds: [],
      startsAt: new Date(past.getTime() - 60_000),
      expiresAt: past,
      imposedByOxyUserId: OPERATOR_A,
    });
    const effects = await readEnforcementEffects(db, partnerId);
    // The row is still `lifted_at is null`, so the SQL returns it — expiry is
    // applied by the derivation against the caller's clock, which is why the
    // two cannot disagree about "now".
    expect(effects.newAttributionSuspended).toBe(false);
  });

  it('converges two operators on ONE live action', async () => {
    const partnerId = await approvedPartner('converge');
    const impose = () =>
      imposeEnforcementAction({
        partnerId,
        action: 'payout_hold',
        scope: 'partner',
        subjectId: partnerId,
        basis: 'operator_finding',
        reason: 'the same conclusion, reached twice',
        actorOxyUserId: OPERATOR_A,
      });
    await impose();
    await expect(impose()).rejects.toThrow(/already stands/);
  });
});

describe('an enforcement decision is frozen and lifted once', () => {
  it('refuses an edit to the decision, permits the lift, refuses a second lift', async () => {
    const partnerId = await approvedPartner('freeze');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'partner_warning',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'undisclosed promotion, first instance',
      actorOxyUserId: OPERATOR_A,
    });

    // The edit that would walk around the forfeiture CHECK: a CHECK is
    // evaluated per statement, so promoting the basis afterwards would leave a
    // forfeiting action recorded on a signal.
    await expectRejectedBy(
      db
        .update(referralEnforcementActions)
        .set({ basis: 'identity_evidence' })
        .where(eq(referralEnforcementActions.id, action.id)),
      /frozen/,
    );
    await expectRejectedBy(
      db
        .update(referralEnforcementActions)
        .set({ reason: 'a different reason entirely' })
        .where(eq(referralEnforcementActions.id, action.id)),
      /frozen/,
    );
    await expectRejectedBy(
      db.delete(referralEnforcementActions).where(eq(referralEnforcementActions.id, action.id)),
      /never deleted/,
    );

    const lifted = await liftEnforcement({
      actionId: action.id,
      reason: 'the partner disclosed and corrected',
      actorOxyUserId: OPERATOR_B,
    });
    expect(lifted.liftedAt).toBeDefined();
    await expect(
      liftEnforcement({
        actionId: action.id,
        reason: 'again',
        actorOxyUserId: OPERATOR_A,
      }),
    ).rejects.toThrow(/already been lifted/);
  });

  it('refuses a partial lift', async () => {
    const partnerId = await approvedPartner('partial-lift');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'pending review',
      actorOxyUserId: OPERATOR_A,
    });
    await expectRejectedBy(
      db
        .update(referralEnforcementActions)
        .set({ liftedAt: new Date() })
        .where(eq(referralEnforcementActions.id, action.id)),
      /lift_shape_check/,
    );
  });
});

describe('the appeal path is independent, by CHECK', () => {
  it('refuses the imposer as the decider and the appellant as the decider', async () => {
    const partnerId = await approvedPartner('independence');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'pending a review',
      actorOxyUserId: OPERATOR_A,
    });
    const appellant = `partner-owner-${TAG}`;
    const appeal = await openEnforcementAppeal({
      actionId: action.id,
      partnerId,
      submittedByOxyUserId: appellant,
      reason: 'the documentation was supplied a week ago',
    });

    // Straight at the table, past the service's own two guards — this is the
    // layer that holds when a future caller forgets them.
    await expectRejectedBy(
      db
        .update(referralEnforcementAppeals)
        .set({
          state: 'accepted',
          decidedByOxyUserId: OPERATOR_A,
          decisionReason: 'I withdraw my own action',
          decidedAt: new Date(),
        })
        .where(eq(referralEnforcementAppeals.id, appeal.id)),
      /independence_check/,
    );
    await expectRejectedBy(
      db
        .update(referralEnforcementAppeals)
        .set({
          state: 'accepted',
          decidedByOxyUserId: appellant,
          decisionReason: 'I decide my own appeal',
          decidedAt: new Date(),
        })
        .where(eq(referralEnforcementAppeals.id, appeal.id)),
      /independence_check/,
    );
  });

  it('an ACCEPTED appeal lifts the action as a compensating record', async () => {
    const partnerId = await approvedPartner('overturn');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'new_attribution_suspension',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'risk_signal',
      reason: 'refund concentration over the trailing window',
      evidenceSignalIds: [uuidv7()],
      actorOxyUserId: OPERATOR_A,
    });
    const appeal = await openEnforcementAppeal({
      actionId: action.id,
      partnerId,
      submittedByOxyUserId: `owner-${TAG}`,
      reason: 'the refunds were one shipment lost in transit',
    });
    await decideAppeal({
      appealId: appeal.id,
      decision: 'accepted',
      reason: 'confirmed with the carrier',
      actorOxyUserId: OPERATOR_B,
    });

    const [row] = await db
      .select()
      .from(referralEnforcementActions)
      .where(eq(referralEnforcementActions.id, action.id));
    expect(row.liftedAt).not.toBeNull();
    expect(row.appealState).toBe('accepted');
    // The compensating record, not an erasure: the original decision survives
    // exactly as recorded.
    expect(row.reason).toBe('refund concentration over the trailing window');
    expect(row.basis).toBe('risk_signal');
    const effects = await readEnforcementEffects(db, partnerId);
    expect(effects.newAttributionSuspended).toBe(false);
  });

  it('converges two submissions on ONE open appeal, and decides once', async () => {
    const partnerId = await approvedPartner('appeal-converge');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'partner_warning',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'a first warning',
      actorOxyUserId: OPERATOR_A,
    });
    const open = () =>
      openEnforcementAppeal({
        actionId: action.id,
        partnerId,
        submittedByOxyUserId: `owner-${TAG}`,
        reason: 'two devices, one intent',
      });
    const first = await open();
    const second = await open();
    expect(second.id).toBe(first.id);

    await decideAppeal({
      appealId: first.id,
      decision: 'rejected',
      reason: 'the promotion was genuinely undisclosed',
      actorOxyUserId: OPERATOR_B,
    });
    await expect(
      decideAppeal({
        appealId: first.id,
        decision: 'accepted',
        reason: 'a second reviewer disagreeing',
        actorOxyUserId: `op-c-${TAG}`,
      }),
    ).rejects.toThrow(/already been decided/);
  });

  it('answers somebody else’s action with the same 404 as a missing one', async () => {
    const mine = await approvedPartner('appeal-mine');
    const theirs = await approvedPartner('appeal-theirs');
    const action = await imposeEnforcementAction({
      partnerId: theirs,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: theirs,
      basis: 'operator_finding',
      reason: 'not yours',
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      openEnforcementAppeal({
        actionId: action.id,
        partnerId: mine,
        submittedByOxyUserId: `owner-${TAG}`,
        reason: 'enumerating other partners',
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      openEnforcementAppeal({
        actionId: uuidv7(),
        partnerId: mine,
        submittedByOxyUserId: `owner-${TAG}`,
        reason: 'a made-up id',
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('risk signals are observations, and they expire', () => {
  it('records nothing for a partner inside every threshold', async () => {
    const partnerId = await approvedPartner('quiet');
    const written = await evaluatePartnerRisk({ partnerId });
    // A "nothing found" row would make the signal table a heartbeat with the
    // findings buried in it.
    expect(written).toEqual([]);
  });

  it('refuses an UPDATE and PERMITS a DELETE', async () => {
    const partnerId = await approvedPartner('signal-lifecycle');
    const [row] = await db
      .insert(referralRiskSignals)
      .values({
        partnerId,
        subjectType: 'partner',
        subjectId: partnerId,
        kind: 'repeated_conversion_pattern',
        severity: 'elevated',
        observedValue: 31,
        thresholdValue: 20,
        windowStart: new Date(Date.now() - 86_400_000),
        windowEnd: new Date(),
        recordedByKind: 'system',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    await expectRejectedBy(
      db
        .update(referralRiskSignals)
        .set({ observedValue: 3 })
        .where(eq(referralRiskSignals.id, row.id)),
      /append-only/,
    );
    // DELETE is the retention sweep's, and a trigger refusing it would make
    // that sweep fail silently on every row it was obliged to remove.
    await db.delete(referralRiskSignals).where(eq(referralRiskSignals.id, row.id));
    const after = await db
      .select()
      .from(referralRiskSignals)
      .where(eq(referralRiskSignals.id, row.id));
    expect(after).toHaveLength(0);
  });

  it('refuses a system-recorded manual finding', async () => {
    const partnerId = await approvedPartner('manual');
    await expectRejectedBy(
      db.insert(referralRiskSignals).values({
        partnerId,
        subjectType: 'partner',
        subjectId: partnerId,
        kind: 'manual_evidence',
        severity: 'high',
        observedValue: 1,
        windowStart: new Date(),
        windowEnd: new Date(),
        recordedByKind: 'system',
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
      /manual_kind_check|recorded_by_check/,
    );
  });
});

describe('the conduct policy is versioned and frozen', () => {
  it('refuses a version that prohibits NOTHING', async () => {
    const policyKey = `conduct-empty-${TAG}`;
    trackedPolicyKeys.push(policyKey);
    // `cardinality`, not `array_length`: on an empty array the latter is NULL
    // and a CHECK reads NULL as SATISFIED, so the obvious spelling ADMITS
    // exactly the row this refuses.
    await expectRejectedBy(
      db.insert(referralConductPolicies).values({
        policyKey,
        version: 1,
        prohibitedConduct: [],
        termsVersion: 'partner-2026-08',
        summary: 'a policy that forbids nothing',
        effectiveFrom: new Date(),
      }),
      /conduct_nonempty_check/,
    );
  });

  it('refuses a prohibition outside the published vocabulary', async () => {
    const policyKey = `conduct-bogus-${TAG}`;
    trackedPolicyKeys.push(policyKey);
    await expectRejectedBy(
      db.insert(referralConductPolicies).values({
        policyKey,
        version: 1,
        prohibitedConduct: ['being generally unhelpful'],
        termsVersion: 'partner-2026-08',
        summary: 'free text',
        effectiveFrom: new Date(),
      }),
      /conduct_check/,
    );
  });

  it('freezes a published version and keeps ONE active per key', async () => {
    const policyKey = `conduct-live-${TAG}`;
    trackedPolicyKeys.push(policyKey);
    const [draft] = await db
      .insert(referralConductPolicies)
      .values({
        policyKey,
        version: 1,
        prohibitedConduct: [...REFERRAL_PROHIBITED_CONDUCT_KINDS],
        termsVersion: 'partner-2026-08',
        summary: 'every prohibition',
        effectiveFrom: new Date(),
      })
      .returning();

    await db
      .update(referralConductPolicies)
      .set({ status: 'active', publishedAt: new Date(), publishedByOxyUserId: OPERATOR_A })
      .where(eq(referralConductPolicies.id, draft.id));

    await expectRejectedBy(
      db
        .update(referralConductPolicies)
        .set({ summary: 'quietly reworded after somebody broke it' })
        .where(eq(referralConductPolicies.id, draft.id)),
      /immutable/,
    );

    const [second] = await db
      .insert(referralConductPolicies)
      .values({
        policyKey,
        version: 2,
        prohibitedConduct: ['spam_or_unsolicited_messaging'],
        termsVersion: 'partner-2026-08',
        summary: 'a second live version',
        effectiveFrom: new Date(),
      })
      .returning();
    await expectRejectedBy(
      db
        .update(referralConductPolicies)
        .set({ status: 'active', publishedAt: new Date(), publishedByOxyUserId: OPERATOR_A })
        .where(eq(referralConductPolicies.id, second.id)),
      /active_key/,
    );
  });

  it('refuses a draft carrying a publisher, and a published one carrying none', async () => {
    const policyKey = `conduct-pub-${TAG}`;
    trackedPolicyKeys.push(policyKey);
    // The single-biconditional form is SATISFIED when both halves are false,
    // which is why the constraint is written as two.
    await expectRejectedBy(
      db.insert(referralConductPolicies).values({
        policyKey,
        version: 1,
        status: 'draft',
        prohibitedConduct: ['impersonation'],
        termsVersion: 'partner-2026-08',
        summary: 'a draft that claims a publisher',
        effectiveFrom: new Date(),
        publishedByOxyUserId: OPERATOR_A,
      }),
      /publication_check/,
    );
    await expectRejectedBy(
      db.insert(referralConductPolicies).values({
        policyKey,
        version: 2,
        status: 'active',
        prohibitedConduct: ['impersonation'],
        termsVersion: 'partner-2026-08',
        summary: 'published by nobody',
        effectiveFrom: new Date(),
      }),
      /publication_check/,
    );
  });
});

describe('the partner projection carries no operator identity', () => {
  it('emits no forbidden field on a REAL row', async () => {
    const partnerId = await approvedPartner('projection');
    await imposeEnforcementAction({
      partnerId,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'risk_signal',
      reason: 'under review',
      evidenceSignalIds: [uuidv7()],
      actorOxyUserId: OPERATOR_A,
    });
    const [row] = await db
      .select()
      .from(referralEnforcementActions)
      .where(eq(referralEnforcementActions.partnerId, partnerId));
    const view = toEnforcementPartnerView(row, new Date());
    // The runtime walk beside the static scan — #92's two-gate rule. A static
    // scan proves the code does not name them today; this proves the object
    // does not carry them.
    const serialized = JSON.stringify(view);
    for (const field of [
      'imposedByOxyUserId',
      'liftedByOxyUserId',
      'evidenceSignalIds',
      'subjectId',
      'basis',
    ]) {
      expect(Object.keys(view)).not.toContain(field);
    }
    expect(serialized).not.toContain(OPERATOR_A);
    expect(view.appealable).toBe(true);
  });
});

describe('the vocabulary is closed and consistent', () => {
  it('records exactly the twelve enforcement actions', () => {
    expect(REFERRAL_ENFORCEMENT_ACTIONS).toHaveLength(12);
  });
});

describe('the constraints are LOAD-BEARING (mutation self-tests)', () => {
  /**
   * Each case DROPS or REWRITES one constraint inside a transaction that is
   * ROLLED BACK, and asserts the statement it refuses is then ADMITTED.
   *
   * The `graph-plan-regression.realdb.test.ts` device. Without it every case
   * above passes just as happily against a database where the insert failed for
   * an unrelated reason — a typo in a column name, a foreign key, a NOT NULL —
   * and a constraint that stopped enforcing anything would be invisible.
   *
   * A transaction rather than a `withTriggerToggleLock` window: `ALTER TABLE …
   * DROP CONSTRAINT` is transactional in PostgreSQL, and the rollback is what
   * makes a throw safe. There is no `DISABLE TRIGGER` here, so no lock to hold.
   */
  it('WITHOUT the forfeiture CHECK, a signal-based void is ADMITTED', async () => {
    const partnerId = await approvedPartner('mutate-forfeit');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`alter table referral_enforcement_actions
              drop constraint referral_enforcement_actions_forfeiture_basis_check`,
        );
        const [row] = await tx
          .insert(referralEnforcementActions)
          .values({
            partnerId,
            action: 'attribution_invalidated',
            scope: 'attribution',
            subjectId: `mutant-${TAG}`,
            basis: 'risk_signal',
            reason: 'a velocity anomaly voiding money',
            evidenceSignalIds: [uuidv7()],
            startsAt: new Date(),
            imposedByOxyUserId: OPERATOR_A,
          })
          .returning();
        // The mutation is visible: the row the CHECK refuses now exists.
        expect(row.basis).toBe('risk_signal');
        expect(row.action).toBe('attribution_invalidated');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // And the constraint is back, because the whole thing rolled back.
    await expectRejectedBy(
      db.insert(referralEnforcementActions).values({
        partnerId,
        action: 'attribution_invalidated',
        scope: 'attribution',
        subjectId: `mutant-after-${TAG}`,
        basis: 'risk_signal',
        reason: 'the same statement, refused again',
        evidenceSignalIds: [uuidv7()],
        startsAt: new Date(),
        imposedByOxyUserId: OPERATOR_A,
      }),
      /forfeiture_basis_check/,
    );
  });

  it('with `array_length` instead of `cardinality`, an EMPTY prohibition set is ADMITTED', async () => {
    const policyKey = `mutate-cardinality-${TAG}`;
    trackedPolicyKeys.push(policyKey);
    // The exact substitution this repository has now measured four times:
    // `array_length` is NULL on an empty array and a CHECK reads NULL as
    // SATISFIED, so the obvious spelling admits exactly the row it refuses.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`alter table referral_conduct_policies
              drop constraint referral_conduct_policies_conduct_nonempty_check`,
        );
        await tx.execute(
          sql`alter table referral_conduct_policies
              add constraint referral_conduct_policies_conduct_nonempty_check
              check (array_length(prohibited_conduct, 1) >= 1)`,
        );
        const [row] = await tx
          .insert(referralConductPolicies)
          .values({
            policyKey,
            version: 1,
            prohibitedConduct: [],
            termsVersion: 'partner-2026-08',
            summary: 'a policy that forbids nothing',
            effectiveFrom: new Date(),
          })
          .returning();
        expect(row.prohibitedConduct).toEqual([]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
  });

  it('WITHOUT the independence CHECK, the imposer decides their own appeal', async () => {
    const partnerId = await approvedPartner('mutate-independence');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'payout_hold',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'operator_finding',
      reason: 'pending a review',
      actorOxyUserId: OPERATOR_A,
    });
    const appeal = await openEnforcementAppeal({
      actionId: action.id,
      partnerId,
      submittedByOxyUserId: `owner-${TAG}`,
      reason: 'please reconsider',
    });

    // ONE TABLE, the lock taken, and the matching `enable trigger` issued in
    // the same callback — the `advisory-lock-census` rules, which apply to a
    // mutation window exactly as they apply to a teardown's. The final throw
    // rolls the DDL and the row back together; the explicit re-enable is what
    // makes the window correct even if the rollback did not happen.
    await expect(
      withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table referral_enforcement_appeals
              disable trigger mercaria_referral_enforcement_appeals_append_only`,
        );
        await tx.execute(
          sql`alter table referral_enforcement_appeals
              drop constraint referral_enforcement_appeals_independence_check`,
        );
        const [row] = await tx
          .update(referralEnforcementAppeals)
          .set({
            state: 'accepted',
            decidedByOxyUserId: OPERATOR_A,
            decisionReason: 'I withdraw my own action',
            decidedAt: new Date(),
          })
          .where(eq(referralEnforcementAppeals.id, appeal.id))
          .returning();
        expect(row.decidedByOxyUserId).toBe(OPERATOR_A);
        expect(row.imposedByOxyUserId).toBe(OPERATOR_A);
        await tx.execute(
          sql`alter table referral_enforcement_appeals
              enable trigger mercaria_referral_enforcement_appeals_append_only`,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The positive control on the ROLLBACK: the CHECK is back, so the same
    // statement is refused again. Without this the case would pass just as
    // happily against a database it had permanently disarmed.
    await expectRejectedBy(
      db
        .update(referralEnforcementAppeals)
        .set({
          state: 'accepted',
          decidedByOxyUserId: OPERATOR_A,
          decisionReason: 'again',
          decidedAt: new Date(),
        })
        .where(eq(referralEnforcementAppeals.id, appeal.id)),
      /independence_check/,
    );
  });

  it('WITHOUT the decision freeze, a recorded basis can be promoted after the fact', async () => {
    const partnerId = await approvedPartner('mutate-freeze');
    const action = await imposeEnforcementAction({
      partnerId,
      action: 'partner_warning',
      scope: 'partner',
      subjectId: partnerId,
      basis: 'risk_signal',
      reason: 'a velocity anomaly',
      evidenceSignalIds: [uuidv7()],
      actorOxyUserId: OPERATOR_A,
    });
    await expect(
      withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table referral_enforcement_actions
              disable trigger mercaria_referral_enforcement_actions_freeze`,
        );
        const [row] = await tx
          .update(referralEnforcementActions)
          .set({ basis: 'identity_evidence', reason: 'a different reason entirely' })
          .where(eq(referralEnforcementActions.id, action.id))
          .returning();
        expect(row.basis).toBe('identity_evidence');
        await tx.execute(
          sql`alter table referral_enforcement_actions
              enable trigger mercaria_referral_enforcement_actions_freeze`,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The positive control on the rollback: the trigger is back.
    await expectRejectedBy(
      db
        .update(referralEnforcementActions)
        .set({ basis: 'identity_evidence' })
        .where(eq(referralEnforcementActions.id, action.id)),
      /frozen/,
    );
  });
});
