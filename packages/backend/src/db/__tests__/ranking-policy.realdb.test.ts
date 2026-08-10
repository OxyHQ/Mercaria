/**
 * The ranking policy register against a REAL Postgres server (#74).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: the immutability trigger, the two one-arm-per-key partial uniques, the
 * activation transaction's supersede-then-claim ordering, and the CHECKs that
 * make an unevaluable or unarmed policy unrepresentable.
 *
 * The guardrail CHECK is the one to read. It is spelled `cardinality(...) >= 1`,
 * and `array_length(col, 1)` — the spelling a reader reaches for first — is NULL
 * on an empty array while a CHECK rejects only FALSE. The obvious form would
 * therefore ADMIT exactly the row the constraint exists to refuse, and nothing
 * but a real server can tell the two apart.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { rankingPolicyVersions } from '../schema/ranking.js';
import {
  activateRankingPolicyVersion,
  archiveRankingPolicyVersion,
  insertRankingPolicyVersion,
  setRankingPolicyCanary,
  stopRankingPolicyCanary,
  type NewRankingPolicyVersion,
} from '../ranking/rankingPolicyRepository.js';
import { resolveRankingPolicy } from '../../services/ranking/policy.service.js';
import { OFFER_COMPARISON_POLICY_KEY } from '../../services/ranking/policy.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
/** A run-scoped key, so the partial uniques are not contended across files. */
const KEY = `offer-comparison-test-${RUN}`;
const OPERATOR = `operator-${RUN}`;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await db
    .delete(rankingPolicyVersions)
    .where(inArray(rankingPolicyVersions.policyKey, [KEY, OFFER_COMPARISON_POLICY_KEY]));
  await closePostgres();
});

/** The SQLSTATE of a driver error, through drizzle's wrapper. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function draft(overrides: Partial<NewRankingPolicyVersion> = {}): NewRankingPolicyVersion {
  return {
    policyKey: KEY,
    version: `v-${uuidv7().slice(-8)}`,
    description: 'a policy version written by the realdb suite',
    weightItemPrice: 3,
    weightDeliveryCost: 1.5,
    weightTaxInclusion: 0.5,
    weightDeliverySpeed: 1,
    weightCondition: 1,
    weightMerchantRating: 1.5,
    weightReturnPolicy: 0.5,
    weightAvailabilityConfidence: 1,
    weightObservationFreshness: 0.5,
    weightVerifiedRelationship: 1,
    weightPickupProximity: 0.5,
    minReviewCount: 3,
    dominanceWindow: 5,
    dominanceShare: 0.6,
    objectiveMetricKeys: ['native_checkout_conversion'],
    guardrailMetricKeys: ['source_coverage_gap'],
    createdByOxyUserId: OPERATOR,
    ...overrides,
  };
}

describe('the CHECKs a mocked insert would accept', () => {
  it('refuses a policy with NO guardrail metric — the `cardinality` spelling', () => {
    // "Evaluate click and conversion outcomes ALONGSIDE trust guardrails, not as
    // the only objective" (#74 policy rule 5), as a property of the row.
    return expect(
      insertRankingPolicyVersion(draft({ guardrailMetricKeys: [] }), db),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a policy with NO objective metric either', () => {
    return expect(
      insertRankingPolicyVersion(draft({ objectiveMetricKeys: [] }), db),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a metric key nobody has defined', () => {
    return expect(
      insertRankingPolicyVersion(draft({ guardrailMetricKeys: ['invented_metric'] }), db),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses an all-zero policy — a random shuffle wearing a version name', () => {
    return expect(
      insertRankingPolicyVersion(
        draft({
          weightItemPrice: 0,
          weightDeliveryCost: 0,
          weightTaxInclusion: 0,
          weightDeliverySpeed: 0,
          weightCondition: 0,
          weightMerchantRating: 0,
          weightReturnPolicy: 0,
          weightAvailabilityConfidence: 0,
          weightObservationFreshness: 0,
          weightVerifiedRelationship: 0,
          weightPickupProximity: 0,
        }),
        db,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a negative weight', () => {
    return expect(
      insertRankingPolicyVersion(draft({ weightMerchantRating: -1 }), db),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a canary share on a version that is not a canary', () => {
    // The biconditional: a non-canary carrying a share would be a second answer
    // to "who is on the new policy".
    const row = insertRankingPolicyVersion(draft(), db);
    return row.then((created) =>
      expect(
        db
          .update(rankingPolicyVersions)
          .set({ canaryShareBps: 500 })
          .where(eq(rankingPolicyVersions.id, created.id)),
      ).rejects.toSatisfy(isCheckViolation),
    );
  });
});

describe('immutable once it has served traffic', () => {
  it('lets a DRAFT be edited freely', async () => {
    const created = await insertRankingPolicyVersion(draft(), db);
    await db
      .update(rankingPolicyVersions)
      .set({ weightItemPrice: 9 })
      .where(eq(rankingPolicyVersions.id, created.id));
    const [after] = await db
      .select()
      .from(rankingPolicyVersions)
      .where(eq(rankingPolicyVersions.id, created.id));
    expect(after?.weightItemPrice).toBe(9);
  });

  it('refuses a weight edit once the version is serving', async () => {
    const created = await insertRankingPolicyVersion(draft(), db);
    await activateRankingPolicyVersion(
      { id: created.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );

    let caught: unknown;
    try {
      await db
        .update(rankingPolicyVersions)
        .set({ weightItemPrice: 9 })
        .where(eq(rankingPolicyVersions.id, created.id));
    } catch (error) {
      caught = error;
    }
    // A `RAISE … USING ERRCODE = 'restrict_violation'` is SQLSTATE 23001, which
    // neither `isCheckViolation` nor `isUniqueViolation` recognises. Asserting
    // the CODE is what tells a trigger refusal from an unrelated crash, and
    // drizzle wraps the driver error so the code lives on the cause.
    expect(caught, 'the edit SUCCEEDED; the immutability trigger did not fire').toBeDefined();
    expect(sqlStateOf(caught), `expected a trigger refusal, got: ${String(caught)}`).toBe('23001');

    const [after] = await db
      .select()
      .from(rankingPolicyVersions)
      .where(eq(rankingPolicyVersions.id, created.id));
    expect(after?.weightItemPrice).toBe(3);
  });

  it('still lets a canary RAMP, which is a rollout control and not a policy term', async () => {
    const created = await insertRankingPolicyVersion(draft(), db);
    await setRankingPolicyCanary({ id: created.id, shareBps: 500, actorOxyUserId: OPERATOR }, db);
    const ramped = await setRankingPolicyCanary(
      { id: created.id, shareBps: 2_500, actorOxyUserId: OPERATOR },
      db,
    );
    expect(ramped?.canaryShareBps).toBe(2_500);
    expect(ramped?.weightItemPrice).toBe(3);
    await stopRankingPolicyCanary(created.id, db);
  });
});

describe('one arm each, held by the database', () => {
  it('refuses a second ACTIVE version for one key', async () => {
    const first = await insertRankingPolicyVersion(draft(), db);
    await activateRankingPolicyVersion(
      { id: first.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );
    const second = await insertRankingPolicyVersion(draft(), db);
    // Straight to `active` WITHOUT the repository's supersede step — which is
    // what the partial unique exists to refuse.
    await expect(
      db
        .update(rankingPolicyVersions)
        .set({ status: 'active', approvedByOxyUserId: OPERATOR, activatedAt: new Date() })
        .where(eq(rankingPolicyVersions.id, second.id)),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a second CANARY for one key', async () => {
    const first = await insertRankingPolicyVersion(draft(), db);
    await setRankingPolicyCanary({ id: first.id, shareBps: 1_000, actorOxyUserId: OPERATOR }, db);
    const second = await insertRankingPolicyVersion(draft(), db);
    await expect(
      setRankingPolicyCanary({ id: second.id, shareBps: 1_000, actorOxyUserId: OPERATOR }, db),
    ).rejects.toSatisfy(isUniqueViolation);
    await stopRankingPolicyCanary(first.id, db);
  });
});

describe('activation, promotion and rollback', () => {
  it('supersedes the incumbent in ONE transaction, and rolls back the same way', async () => {
    const one = await insertRankingPolicyVersion(draft(), db);
    const two = await insertRankingPolicyVersion(draft(), db);

    await activateRankingPolicyVersion({ id: one.id, policyKey: KEY, actorOxyUserId: OPERATOR }, db);
    const promoted = await activateRankingPolicyVersion(
      { id: two.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );
    expect(promoted?.status).toBe('active');

    const [supersededOne] = await db
      .select()
      .from(rankingPolicyVersions)
      .where(eq(rankingPolicyVersions.id, one.id));
    expect(supersededOne?.status).toBe('superseded');
    expect(supersededOne?.supersededAt).not.toBeNull();

    // The ROLLBACK — acceptance 7, and it is the same call naming the earlier
    // version. Nothing is re-ingested, because a ranking is derived at read time
    // from offers this domain never wrote.
    const rolledBack = await activateRankingPolicyVersion(
      { id: one.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );
    expect(rolledBack?.status).toBe('active');
    const [demoted] = await db
      .select()
      .from(rankingPolicyVersions)
      .where(eq(rankingPolicyVersions.id, two.id));
    expect(demoted?.status).toBe('superseded');
  });

  it('promotes a CANARY and clears its share in the same act', async () => {
    const version = await insertRankingPolicyVersion(draft(), db);
    await setRankingPolicyCanary({ id: version.id, shareBps: 5_000, actorOxyUserId: OPERATOR }, db);
    const promoted = await activateRankingPolicyVersion(
      { id: version.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );
    expect(promoted?.status).toBe('active');
    expect(promoted?.canaryShareBps).toBe(0);
  });

  it('refuses to archive a version that is serving, and permits a draft', async () => {
    const serving = await insertRankingPolicyVersion(draft(), db);
    await activateRankingPolicyVersion(
      { id: serving.id, policyKey: KEY, actorOxyUserId: OPERATOR },
      db,
    );
    expect(await archiveRankingPolicyVersion(serving.id, db)).toBeNull();

    const unpublished = await insertRankingPolicyVersion(draft(), db);
    const archived = await archiveRankingPolicyVersion(unpublished.id, db);
    expect(archived?.status).toBe('archived');
    expect(archived?.archivedAt).not.toBeNull();
  });
});

describe('resolving the policy for a comparison', () => {
  it('answers the BUILT-IN version when nothing is published', async () => {
    // A fresh deployment ranks under a named, versioned, reproducible policy
    // rather than refusing — the deliberate divergence from #58 and #121, whose
    // verdicts have the opposite consequence when they are missing.
    const policy = await resolveRankingPolicy('variant-anything', db);
    expect(policy.source).toBe('builtin');
    expect(policy.version).toMatch(/^builtin-/);
  });

  it('answers the ACTIVE published version once one exists', async () => {
    const created = await insertRankingPolicyVersion(
      draft({ policyKey: OFFER_COMPARISON_POLICY_KEY, weightItemPrice: 7 }),
      db,
    );
    await activateRankingPolicyVersion(
      { id: created.id, policyKey: OFFER_COMPARISON_POLICY_KEY, actorOxyUserId: OPERATOR },
      db,
    );

    const policy = await resolveRankingPolicy('variant-anything', db);
    expect(policy.source).toBe('published');
    expect(policy.arm).toBe('active');
    expect(policy.version).toBe(created.version);
    expect(policy.weights.item_price).toBe(7);
  });

  it('routes every subject to a canary at 100%, and the arm is reported', async () => {
    const canary = await insertRankingPolicyVersion(
      draft({ policyKey: OFFER_COMPARISON_POLICY_KEY, weightItemPrice: 11 }),
      db,
    );
    await setRankingPolicyCanary({ id: canary.id, shareBps: 10_000, actorOxyUserId: OPERATOR }, db);

    const policy = await resolveRankingPolicy('variant-anything', db);
    expect(policy.arm).toBe('canary');
    expect(policy.version).toBe(canary.version);
    expect(policy.weights.item_price).toBe(11);

    await stopRankingPolicyCanary(canary.id, db);
  });
});
