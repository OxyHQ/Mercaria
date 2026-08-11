/**
 * Guest-commerce governance against a REAL Postgres server (#111).
 *
 * Every property below is a CHECK, a partial unique index, a trigger or a
 * concurrent upsert, and none of them exists without a server: a mocked insert
 * accepts a statement Postgres refuses outright, so a mocked version of this
 * file would assert that the code composes the right object and say nothing at
 * all about whether the database would keep it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  guestAbuseCounters,
  guestAbuseInterventions,
  guestDataRequests,
  guestLaunchGateSignoffs,
  guestLegalHolds,
  guestRetentionPolicyVersions,
  guestRetentionRuns,
  guestRolloutStageAdvances,
  guestSecuritySignalCounters,
} from '../../db/schema/guestGovernance.js';
import {
  countAbuseAttempt,
  findLiveIntervention,
  recordIntervention,
  reviewIntervention,
} from '../../db/guestGovernance/abuseRepository.js';
import { countSecuritySignal } from '../../db/guestGovernance/signalRepository.js';
import {
  liftLegalHold,
  raiseLegalHold,
  readActiveRetentionRules,
  readPolicyCoverage,
  publishRetentionPolicyVersion,
} from '../../db/guestGovernance/retentionRepository.js';
import {
  readCurrentStage,
  readGateVerdicts,
  recordGateSignoff,
  recordStageAdvance,
} from '../../db/guestGovernance/rolloutRepository.js';
import { recordDataRequest } from '../../db/guestGovernance/dataRequestRepository.js';
import { proposedRetentionRules } from '../guest-governance/retention.service.js';

/** A unique marker per run, so parallel test files cannot collide. */
const MARKER = randomUUID().slice(0, 8);

/**
 * The connection, bound in `beforeAll`.
 *
 * `getDb()` at MODULE scope throws — the pool is opened by the suite's setup,
 * not by an import — so the handle has to be bound after it, and a `describe`
 * body runs during collection.
 */
let db: Database;


/**
 * Assert that a statement was refused by a TRIGGER carrying a given message.
 *
 * The obvious spelling does not work and the reason is worth stating: drizzle
 * WRAPS the driver error, so `rejects.toThrow(/frozen/)` matches against
 * `"Failed query: update …"` and fails — while `rejects.toThrow()` alone would
 * pass on ANY error, including one from a typo in the fixture. Walking the
 * cause chain is what makes the assertion name the trigger it means.
 * `store-linkage.realdb.test.ts` established the helper; it is duplicated here
 * rather than exported, because a shared test helper between two realdb files
 * is a shared fixture dependency and this domain deliberately has none.
 */
async function expectTriggerRefusal(
  operation: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the statement was not refused at all').toBeDefined();
  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }
  expect(messages.join('\n'), `no error in the cause chain matched ${message}`).toMatch(message);
}

/** A subject digest stand-in. The repository never hashes; the service does. */
function subject(name: string): string {
  return `${MARKER}-${name}`;
}

describe('the abuse counters and interventions (#111)', () => {

  it('counts concurrently without losing an increment', async () => {
    // The property a read-then-write does NOT have. Twenty concurrent
    // increments against one window must total twenty; a read-then-write lets
    // a burst each read the same value and all pass a limit they collectively
    // exceeded, which is exactly the shape a flood has.
    const windowStartedAt = new Date('2026-08-10T00:00:00.000Z');
    const hash = subject('concurrent');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        countAbuseAttempt(db, {
          scope: 'session_issuance',
          axis: 'network_range',
          subjectHash: hash,
          windowStartedAt,
        }),
      ),
    );
    expect(Math.max(...results)).toBe(20);
    const [row] = await db
      .select({ attemptCount: guestAbuseCounters.attemptCount })
      .from(guestAbuseCounters)
      .where(eq(guestAbuseCounters.subjectHash, hash));
    expect(row?.attemptCount).toBe(20);
  });

  it('keeps ONE live intervention per (pattern, subject) and EXTENDS it', async () => {
    const hash = subject('extend');
    const first = new Date('2026-08-10T01:00:00.000Z');
    const later = new Date('2026-08-10T02:00:00.000Z');
    const idA = await recordIntervention(db, {
      pattern: 'session_farming',
      scope: 'session_issuance',
      axis: 'network_range',
      subjectHash: hash,
      measure: 'cooldown',
      observedCount: 200,
      thresholdCount: 200,
      expiresAt: first,
    });
    const idB = await recordIntervention(db, {
      pattern: 'session_farming',
      scope: 'session_issuance',
      axis: 'network_range',
      subjectHash: hash,
      measure: 'cooldown',
      observedCount: 260,
      thresholdCount: 200,
      expiresAt: later,
    });
    // The SAME row, extended — never a second one an operator would have to
    // lift twice.
    expect(idB).toBe(idA);
    const live = await findLiveIntervention(db, {
      pattern: 'session_farming',
      subjectHash: hash,
      now: new Date('2026-08-10T01:30:00.000Z'),
    });
    expect(live?.expiresAt.toISOString()).toBe(later.toISOString());
  });

  it('reads a live intervention against the CLOCK, not the state column alone', async () => {
    const hash = subject('expired');
    await recordIntervention(db, {
      pattern: 'payment_attempt_churn',
      scope: 'payment_attempt',
      axis: 'guest_checkout',
      subjectHash: hash,
      measure: 'cooldown',
      observedCount: 30,
      thresholdCount: 25,
      expiresAt: new Date('2026-08-10T03:00:00.000Z'),
    });
    // Still `active` in the column; past its deadline in fact. A friction that
    // outlived its deadline because a sweep was late is a person kept waiting
    // by an implementation detail.
    const live = await findLiveIntervention(db, {
      pattern: 'payment_attempt_churn',
      subjectHash: hash,
      now: new Date('2026-08-10T04:00:00.000Z'),
    });
    expect(live).toBeNull();
  });

  it('a review is attributable and dated, and a second review is refused', async () => {
    const hash = subject('review');
    const id = await recordIntervention(db, {
      pattern: 'return_or_support_spam',
      scope: 'support_message',
      axis: 'guest_checkout',
      subjectHash: hash,
      measure: 'cooldown',
      observedCount: 60,
      thresholdCount: 50,
      expiresAt: new Date('2026-08-11T00:00:00.000Z'),
    });
    const first = await reviewIntervention(db, {
      interventionId: id,
      state: 'false_positive',
      reviewedByOxyUserId: 'oxy-operator-1',
      note: 'a school computer lab, not a script',
      now: new Date(),
    });
    expect(first).toBe(true);
    // A CAS on `state = 'active'`: two operators converge and the loser is told
    // rather than silently overwriting the first verdict.
    const second = await reviewIntervention(db, {
      interventionId: id,
      state: 'lifted',
      reviewedByOxyUserId: 'oxy-operator-2',
      note: 'trying again',
      now: new Date(),
    });
    expect(second).toBe(false);
    const [row] = await db
      .select({ state: guestAbuseInterventions.state })
      .from(guestAbuseInterventions)
      .where(eq(guestAbuseInterventions.id, id));
    // The false positive is KEPT, not deleted — "how often is this control
    // wrong" is a metric, and a deleted row answers it with silence.
    expect(row?.state).toBe('false_positive');
  });

  it('refuses an observed count below the threshold that supposedly fired', async () => {
    await expect(
      db.insert(guestAbuseInterventions).values({
        pattern: 'recovery_spraying',
        scope: 'recovery_request',
        axis: 'network_range',
        subjectHash: subject('impossible'),
        measure: 'cooldown',
        observedCount: 3,
        thresholdCount: 60,
        expiresAt: new Date('2026-08-11T00:00:00.000Z'),
      }),
    ).rejects.toThrow();
  });
});

describe('the security signal counters (#111)', () => {

  it('accumulates a DELTA, so a sweep can report a backlog in one write', async () => {
    const windowStartedAt = new Date(`2026-08-10T05:0${MARKER.charCodeAt(0) % 6}:00.000Z`);
    await countSecuritySignal(db, {
      signal: 'cleanup_lag',
      windowStartedAt,
      delta: 40,
    });
    const total = await countSecuritySignal(db, {
      signal: 'cleanup_lag',
      windowStartedAt,
      delta: 2,
    });
    expect(total).toBe(42);
  });

  it('has no subject column at all', async () => {
    const [row] = await db.execute<{ columns: string }>(sql`
      select string_agg(column_name, ',' order by column_name) as columns
      from information_schema.columns
      where table_name = 'guest_security_signal_counters'
    `);
    // The absence IS the design: a subject column would turn a monitoring
    // table into a record of who failed to authenticate.
    expect(row?.columns).not.toContain('subject');
    expect(row?.columns).not.toContain('actor');
    expect(row?.columns).not.toContain('ip');
  });
});

describe('the retention policy register (#111)', () => {

  it('publishes a complete schedule and reports full coverage', async () => {
    await db.transaction(async (tx) => {
      await publishRetentionPolicyVersion(tx, {
        version: `test-${MARKER}`,
        publishedByOxyUserId: 'oxy-privacy-1',
        now: new Date(),
        rules: proposedRetentionRules().map((rule) => ({
          retentionClass: rule.retentionClass,
          retentionSeconds: rule.retentionSeconds,
          mechanism: rule.mechanism,
          pausableByLegalHold: rule.pausableByLegalHold,
          rationale: rule.rationale,
        })),
      });
    });
    const coverage = await readPolicyCoverage(db);
    // The vacuity floor for the whole schedule: a policy covering nine of
    // thirteen classes and one nobody published look identical to anything
    // that reads one class at a time.
    expect(coverage.missing).toEqual([]);
    const rules = await readActiveRetentionRules(db);
    expect(rules.length).toBe(coverage.covered.length);
    // The `bigint` coercion, pinned: a retention read back as a STRING would
    // make every date arithmetic operand string concatenation.
    const contact = rules.find((rule) => rule.retentionClass === 'plaintext_equivalent_contact');
    expect(typeof contact?.retentionSeconds).toBe('number');
  });

  it('freezes a published version by TRIGGER', async () => {
    const [row] = await db
      .select({ id: guestRetentionPolicyVersions.id })
      .from(guestRetentionPolicyVersions)
      .where(
        and(
          eq(guestRetentionPolicyVersions.status, 'active'),
          eq(guestRetentionPolicyVersions.retentionClass, 'lookup_hash'),
        ),
      )
      .limit(1);
    await expectTriggerRefusal(
      db
        .update(guestRetentionPolicyVersions)
        .set({ retentionSeconds: 1 })
        .where(eq(guestRetentionPolicyVersions.id, String(row?.id))),
      /frozen/,
    );
  });

  it('refuses a `none` mechanism carrying a retention figure', async () => {
    // The IMPLICATION the schema states. The contradiction it refuses is the
    // dangerous one: a class saying "never deleted" with a TTL beside it.
    await expect(
      db.insert(guestRetentionPolicyVersions).values({
        version: `bad-${MARKER}`,
        retentionClass: 'transaction_record',
        retentionSeconds: 60,
        mechanism: 'none',
        pausableByLegalHold: 'no',
        rationale: 'contradictory',
      }),
    ).rejects.toThrow();
  });

  it('ACCEPTS a sweep with no fixed offset, which the biconditional would not have', async () => {
    // The fixture that exercises the distinction, and the reason the CHECK is
    // an implication: three real classes have a sweep whose deadline is stamped
    // on the row or applied by CASCADE, so they carry no offset at all.
    await db.insert(guestRetentionPolicyVersions).values({
      version: `offsetless-${MARKER}`,
      retentionClass: 'abandoned_cart',
      retentionSeconds: null,
      mechanism: 'expiry_sweep',
      pausableByLegalHold: 'no',
      rationale: 'the cart leaves with the credential that owned it, by CASCADE',
    });
  });

  it('refuses a run whose counters do not SUM to what it examined', async () => {
    // #60's vacuity floor, an EQUALITY and never `<=`: a pass that swallowed a
    // row cannot write a row at all.
    await expect(
      db.insert(guestRetentionRuns).values({
        retentionClass: 'plaintext_equivalent_contact',
        policyVersion: `test-${MARKER}`,
        mode: 'apply',
        status: 'completed',
        examinedCount: 10,
        minimizedCount: 3,
        deletedCount: 0,
        skippedHeldCount: 1,
        failedCount: 1,
        finishedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('refuses a DRY RUN that reports a delete', async () => {
    await expect(
      db.insert(guestRetentionRuns).values({
        retentionClass: 'plaintext_equivalent_contact',
        policyVersion: `test-${MARKER}`,
        mode: 'dry_run',
        status: 'completed',
        examinedCount: 1,
        minimizedCount: 0,
        deletedCount: 1,
        skippedHeldCount: 0,
        failedCount: 0,
        finishedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('legal holds pause ONE class for ONE group (#111 retention rule 7)', () => {
  const groupId = `grp-${MARKER}`;

  it('converges two operators raising the same hold onto one row', async () => {
    const first = await raiseLegalHold(db, {
      checkoutGroupId: groupId,
      retentionClass: 'plaintext_equivalent_contact',
      reason: 'open_dispute',
      raisedByOxyUserId: 'oxy-legal-1',
    });
    const second = await raiseLegalHold(db, {
      checkoutGroupId: groupId,
      retentionClass: 'plaintext_equivalent_contact',
      reason: 'open_dispute',
      raisedByOxyUserId: 'oxy-legal-2',
    });
    expect(second).toBe(first);
  });

  it('does not pause a DIFFERENT class for the same group', async () => {
    // The whole point of scoping a hold to a class: a dispute over one order
    // must not freeze every abandoned cart on the deployment.
    const rows = await db
      .select({ retentionClass: guestLegalHolds.retentionClass })
      .from(guestLegalHolds)
      .where(eq(guestLegalHolds.checkoutGroupId, groupId));
    expect(rows.map((row) => row.retentionClass)).toEqual(['plaintext_equivalent_contact']);
  });

  it('a lift is attributable, dated and explained — and a second is refused', async () => {
    const [row] = await db
      .select({ id: guestLegalHolds.id })
      .from(guestLegalHolds)
      .where(eq(guestLegalHolds.checkoutGroupId, groupId));
    const lifted = await liftLegalHold(db, {
      holdId: String(row?.id),
      liftedByOxyUserId: 'oxy-legal-1',
      liftReason: 'the dispute closed in the buyer’s favour',
      now: new Date(),
    });
    expect(lifted).toBe(true);
    const again = await liftLegalHold(db, {
      holdId: String(row?.id),
      liftedByOxyUserId: 'oxy-legal-1',
      liftReason: 'again',
      now: new Date(),
    });
    expect(again).toBe(false);
  });

  it('refuses a lift with no reason', async () => {
    const [row] = await db
      .insert(guestLegalHolds)
      .values({
        checkoutGroupId: `grp2-${MARKER}`,
        retentionClass: 'security_audit_event',
        reason: 'fraud_investigation',
        raisedByOxyUserId: 'oxy-legal-1',
      })
      .returning({ id: guestLegalHolds.id });
    await expect(
      db
        .update(guestLegalHolds)
        .set({ liftedAt: new Date(), liftedByOxyUserId: 'oxy-legal-1' })
        .where(eq(guestLegalHolds.id, String(row?.id))),
    ).rejects.toThrow();
  });

  it('allows the hold to be RE-RAISED after a lift', async () => {
    // A lifted row does not occupy the partial unique, which is what makes a
    // reopened dispute expressible.
    const reraised = await raiseLegalHold(db, {
      checkoutGroupId: groupId,
      retentionClass: 'plaintext_equivalent_contact',
      reason: 'open_dispute',
      raisedByOxyUserId: 'oxy-legal-1',
    });
    expect(reraised).toBeTruthy();
  });
});

describe('a data request is audited and never claims full deletion (#111)', () => {

  it('records a receipt whose retained classes each name a reason', async () => {
    const requestId = await db.transaction(async (tx) =>
      recordDataRequest(tx, {
        checkoutGroupId: `grp3-${MARKER}`,
        kind: 'deletion',
        proof: 'verified_portal_grant',
        sourceGrantId: `grant-${MARKER}`,
        state: 'partially_completed',
        dispositions: [
          { dataClass: 'guest_session_metadata', disposition: 'deleted', affectedRowCount: 1 },
          {
            dataClass: 'payment_refund_dispute_ledger_payout',
            disposition: 'retained_under_obligation',
            retainedReason: 'financial_record',
            affectedRowCount: 0,
          },
        ],
        now: new Date(),
      }),
    );
    const [row] = await db
      .select()
      .from(guestDataRequests)
      .where(eq(guestDataRequests.id, requestId));
    expect(row?.erasedClasses).toEqual(['guest_session_metadata']);
    expect(row?.retainedClasses).toEqual(['payment_refund_dispute_ledger_payout']);
    expect(row?.retainedReasons).toEqual(['financial_record']);
  });

  it('refuses a retained class with no reason beside it', async () => {
    // `cardinality`, never `array_length` — on an empty array the latter is
    // NULL and a CHECK reads NULL as SATISFIED, so the obvious spelling admits
    // exactly the row it refuses.
    await expect(
      db.insert(guestDataRequests).values({
        checkoutGroupId: `grp4-${MARKER}`,
        kind: 'deletion',
        proof: 'completed_oxy_claim',
        requestedByOxyUserId: 'oxy-buyer-1',
        state: 'partially_completed',
        erasedClasses: [],
        retainedClasses: ['payment_refund_dispute_ledger_payout'],
        retainedReasons: [],
        completedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('refuses a proof whose handle does not match it', async () => {
    // An `email_match` proof is unrepresentable, and so is a portal grant with
    // no grant id — the two halves of "email alone cannot authorize".
    await expect(
      db.insert(guestDataRequests).values({
        checkoutGroupId: `grp5-${MARKER}`,
        kind: 'export',
        proof: 'verified_portal_grant',
        state: 'completed',
        completedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('the rollout gate (#111 acceptance 8)', () => {

  it('a WITHDRAWAL is a later row, and the latest verdict wins', async () => {
    await recordGateSignoff(db, {
      stage: 'stage_1_staff_canary',
      gate: 'security_review_complete',
      discipline: 'security',
      satisfied: true,
      signedByOxyUserId: 'oxy-sec-1',
      note: 'reviewed',
    });
    // Explicit spacing: a uuid v7 key is NOT monotonic within a millisecond, so
    // two sign-offs written in the same one would order arbitrarily and the
    // "latest wins" assertion would be testing the generator's luck.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordGateSignoff(db, {
      stage: 'stage_1_staff_canary',
      gate: 'security_review_complete',
      discipline: 'security',
      satisfied: false,
      signedByOxyUserId: 'oxy-sec-1',
      note: 'withdrawn: a new finding',
    });
    const verdicts = await readGateVerdicts(db, 'stage_1_staff_canary');
    const security = verdicts.find((verdict) => verdict.gate === 'security_review_complete');
    expect(security?.satisfied).toBe(false);
  });

  it('a sign-off cannot be EDITED or deleted', async () => {
    const [row] = await db
      .select({ id: guestLaunchGateSignoffs.id })
      .from(guestLaunchGateSignoffs)
      .limit(1);
    await expectTriggerRefusal(
      db
        .update(guestLaunchGateSignoffs)
        .set({ satisfied: 'yes' })
        .where(eq(guestLaunchGateSignoffs.id, String(row?.id))),
      /append-only/,
    );
    await expectTriggerRefusal(
      db.delete(guestLaunchGateSignoffs).where(eq(guestLaunchGateSignoffs.id, String(row?.id))),
      /append-only/,
    );
  });

  it('records a REFUSED advance, and the current stage does not move', async () => {
    const before = await readCurrentStage(db);
    await recordStageAdvance(db, {
      stage: 'stage_2_pilot_merchants',
      outcome: 'refused',
      refusal: 'gate_unsatisfied',
      unsatisfiedGates: ['security_review_complete', 'transactional_sender_authenticated'],
      requestedByOxyUserId: 'oxy-eng-1',
    });
    expect(await readCurrentStage(db)).toEqual(before);
  });

  it('refuses a PERMITTED advance that names an unsatisfied gate', async () => {
    await expect(
      db.insert(guestRolloutStageAdvances).values({
        stage: 'stage_2_pilot_merchants',
        outcome: 'permitted',
        unsatisfiedGates: ['security_review_complete'],
        requestedByOxyUserId: 'oxy-eng-1',
      }),
    ).rejects.toThrow();
  });

  it('refuses a REFUSED advance with no refusal reason', async () => {
    await expect(
      db.insert(guestRolloutStageAdvances).values({
        stage: 'stage_2_pilot_merchants',
        outcome: 'refused',
        unsatisfiedGates: [],
        requestedByOxyUserId: 'oxy-eng-1',
      }),
    ).rejects.toThrow();
  });
});

beforeAll(async () => {
  // The suite's throwaway, fully-migrated database is created by
  // `vitest.pg.globalSetup.ts`; this opens a pool against it. There is
  // deliberately NO truncate here — a per-file wipe would delete the fixtures a
  // sibling file is mid-way through using.
  db = await connectPostgres();
});

afterAll(async () => {
  // Every row this file writes is keyed on MARKER except the signal counters,
  // whose key is (signal, window) and which a sibling could therefore share.
  // They are removed; nothing else is, because the retention policy versions,
  // the sign-offs and the advances are read by no other file.
  await db.delete(guestSecuritySignalCounters);
  await closePostgres();
});
