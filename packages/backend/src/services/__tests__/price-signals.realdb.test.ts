/**
 * #82's constraints and acceptance criteria, each against a REAL PostgreSQL
 * server.
 *
 * None of them exists under a mock. Seven are CONSTRAINTS — two biconditional
 * shape CHECKs, a `cardinality` CHECK the obvious `array_length` spelling would
 * silently invert, a seller floor rendered from a shared constant, an overlap
 * rule between two thresholds, a composite foreign key and two partial uniques —
 * and a mocked `insert` accepts every statement the server refuses. Two more are
 * TRIGGERS, which have no mocked counterpart at all.
 *
 * The failure mode the file guards against is a confident label computed off
 * nothing, so the assertions fail LOUDLY on the safe-looking direction: a policy
 * version that stayed editable after it served is as much a failure here as one
 * that could not be published.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS,
  PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR,
  PRICE_SIGNAL_POLICY_KEY,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import {
  priceSignalEvaluations,
  priceSignalFeedback,
  priceSignalPolicyVersions,
  priceSignalRuns,
} from '../../db/schema/priceSignals.js';
import {
  activatePriceSignalPolicyVersion,
  insertPriceSignalPolicyVersion,
} from '../../db/priceSignals/priceSignalPolicyRepository.js';
import { fileOrFindOpenPriceSignalFeedback } from '../../db/priceSignals/priceSignalFeedbackRepository.js';
import { findVerifiedMerchantClaimant } from '../../db/priceSignals/priceSignalSubjectRepository.js';
import { readMerchantCompetitiveness } from '../price-signals/competitiveness.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `price-signal-op-${RUN}`;

const createdPolicyIds: string[] = [];
const createdRunIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/**
 * Assert a write is refused, and report WHY — the whole cause chain.
 *
 * drizzle's own message says "Failed query: …" and the constraint name lives on
 * the `PostgresError` it wraps, so a test matching only the outer message would
 * pass against ANY refusal, including a typo.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

/** A draft with every threshold valid, so a test can vary exactly one. */
function draftValues(version: string, overrides: Record<string, unknown> = {}) {
  return {
    policyKey: `${PRICE_SIGNAL_POLICY_KEY}-${RUN}`,
    version,
    description: `fixture ${version}`,
    minObservations: 4,
    minDistinctSellers: 3,
    minDistinctOffers: 3,
    minCoverageDays: 2,
    recentWindowDays: 30,
    outlierModifiedZThreshold: 3.5,
    outlierMinDeviationBps: 7_500,
    materialDropBps: 500,
    typicalBandBps: 300,
    goodPriceBelowMedianBps: 800,
    strongSampleMultiplier: 2,
    objectiveMetricKeys: [],
    guardrailMetricKeys: ['zero_result_rate'],
    createdByOxyUserId: OPERATOR,
    ...overrides,
  };
}

async function mintDraft(version: string, overrides: Record<string, unknown> = {}) {
  const row = await insertPriceSignalPolicyVersion(draftValues(version, overrides), db);
  createdPolicyIds.push(row.id);
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.delete(priceSignalFeedback).where(
    inArray(priceSignalFeedback.merchantId, safeIds(createdMerchantIds)),
  );
  // The append-only trigger refuses UPDATE and PERMITS DELETE, which is exactly
  // what makes this teardown possible without disabling anything — the shared
  // expiry posture (`analytics_events`, #78's snapshots), not the ledger's.
  await db
    .delete(priceSignalEvaluations)
    .where(inArray(priceSignalEvaluations.runId, safeIds(createdRunIds)));
  await db.delete(priceSignalRuns).where(inArray(priceSignalRuns.id, safeIds(createdRunIds)));
  await db.execute(
    sql`alter table price_signal_policy_versions disable trigger price_signal_policy_versions_immutable_once_serving`,
  );
  await db
    .delete(priceSignalPolicyVersions)
    .where(inArray(priceSignalPolicyVersions.id, safeIds(createdPolicyIds)));
  await db.execute(
    sql`alter table price_signal_policy_versions enable trigger price_signal_policy_versions_immutable_once_serving`,
  );
  await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, safeIds(createdVariantIds)));
  await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, safeIds(createdProductIds)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

/* ────────────────────────────────────────────────────────────────────────── */

describe('the policy version register', () => {
  it('refuses an EMPTY guardrail list — `cardinality`, never `array_length`', async () => {
    // The empty-array fixture is the ONLY one that can tell the two spellings
    // apart: `array_length('{}', 1)` is NULL, a CHECK rejects only FALSE, so the
    // obvious spelling ADMITS exactly the row this constraint exists to refuse.
    const message = await rejectionMessage(() =>
      db.insert(priceSignalPolicyVersions).values(draftValues(`empty-guardrail-${RUN}`, {
        guardrailMetricKeys: [],
      })),
    );
    expect(message).toContain('price_signal_policy_versions_evaluation_plan_check');
  });

  it('refuses a seller floor below the shared constant', async () => {
    const message = await rejectionMessage(() =>
      db.insert(priceSignalPolicyVersions).values(draftValues(`thin-market-${RUN}`, {
        minDistinctSellers: PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR - 1,
      })),
    );
    expect(message).toContain('price_signal_policy_versions_sample_floor_check');
  });

  it('refuses a `good_price` threshold that OVERLAPS the typical band', async () => {
    // Overlapping thresholds make one price satisfy both verdicts, and which one
    // a shopper sees would be decided by the order of the comparisons in the
    // code rather than by the row.
    const message = await rejectionMessage(() =>
      db.insert(priceSignalPolicyVersions).values(draftValues(`overlap-${RUN}`, {
        typicalBandBps: 900,
        goodPriceBelowMedianBps: 800,
      })),
    );
    expect(message).toContain('price_signal_policy_versions_thresholds_check');
  });

  it('refuses a metric key #77 has not defined', async () => {
    const message = await rejectionMessage(() =>
      db.insert(priceSignalPolicyVersions).values(draftValues(`unknown-metric-${RUN}`, {
        guardrailMetricKeys: ['a_number_nobody_defined'],
      })),
    );
    expect(message).toContain('price_signal_policy_versions_guardrail_metrics_check');
  });

  it('freezes every threshold once a version leaves `draft`', async () => {
    const draft = await mintDraft(`freeze-${RUN}`);
    // A DRAFT is editable — the negative half, without which the trigger could
    // be refusing everything and this test would still pass.
    await db
      .update(priceSignalPolicyVersions)
      .set({ minObservations: 9 })
      .where(eq(priceSignalPolicyVersions.id, draft.id));

    const activated = await activatePriceSignalPolicyVersion(draft.id, OPERATOR, new Date(), db);
    expect(activated?.status).toBe('active');

    const message = await rejectionMessage(() =>
      db
        .update(priceSignalPolicyVersions)
        .set({ goodPriceBelowMedianBps: 2_000 })
        .where(eq(priceSignalPolicyVersions.id, draft.id)),
    );
    expect(message).toContain('has served');

    // …and the LIFECYCLE columns still move, or activation and rollback would be
    // impossible. That is the other half the trigger has to get right.
    await db
      .update(priceSignalPolicyVersions)
      .set({ status: 'superseded', supersededAt: new Date() })
      .where(eq(priceSignalPolicyVersions.id, draft.id));
    const [after] = await db
      .select({ status: priceSignalPolicyVersions.status })
      .from(priceSignalPolicyVersions)
      .where(eq(priceSignalPolicyVersions.id, draft.id));
    expect(after?.status).toBe('superseded');
  });

  it('permits at most ONE active version per key', async () => {
    const first = await mintDraft(`active-a-${RUN}`);
    const second = await mintDraft(`active-b-${RUN}`);
    await activatePriceSignalPolicyVersion(first.id, OPERATOR, new Date(), db);

    // Activating the second SUPERSEDES the first inside one transaction; the
    // supersede runs FIRST because the partial unique refuses two active rows,
    // and reversing the order makes every activation fail against the index.
    const promoted = await activatePriceSignalPolicyVersion(second.id, OPERATOR, new Date(), db);
    expect(promoted?.status).toBe('active');

    const active = await db
      .select({ id: priceSignalPolicyVersions.id })
      .from(priceSignalPolicyVersions)
      .where(
        sql`${priceSignalPolicyVersions.policyKey} = ${`${PRICE_SIGNAL_POLICY_KEY}-${RUN}`}
            and ${priceSignalPolicyVersions.status} = 'active'`,
      );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(second.id);
  });
});

describe('an evaluation is evidence', () => {
  async function mintRun(policyVersionId: string) {
    const [row] = await db
      .insert(priceSignalRuns)
      .values({ policyVersionId, mode: 'monitor', displayCurrency: 'EUR' })
      .returning();
    if (!row) throw new Error('the run was not written');
    createdRunIds.push(row.id);
    return row;
  }

  async function mintProduct(label: string) {
    const [product] = await db
      .insert(canonicalProducts)
      .values({
        name: `PriceSignal ${label} ${RUN}`,
        normalizedName: `pricesignal ${label} ${RUN}`,
        slug: `pricesignal-${label}-${RUN}`,
      })
      .returning({ id: canonicalProducts.id });
    if (!product) throw new Error('the canonical product was not written');
    createdProductIds.push(product.id);
    return product.id;
  }

  it('refuses an UPDATE and permits a DELETE', async () => {
    const policy = await mintDraft(`append-${RUN}`);
    const run = await mintRun(policy.id);
    const productId = await mintProduct('append');

    const [row] = await db
      .insert(priceSignalEvaluations)
      .values({
        runId: run.id,
        policyVersionId: policy.id,
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        segment: 'new',
        displayCurrency: 'EUR',
        signalKind: 'price_quality_label',
        state: 'measured',
        valueAmount: 1_000,
        deltaBps: -900,
        label: 'good_price',
        confidence: 'sufficient',
        sampleObservations: 6,
        sampleDistinctSellers: 4,
        sampleDistinctOffers: 5,
        sampleCoverageDays: 9,
        sampleOutliersExcluded: 1,
        sampleDeduplicated: 2,
        evaluatedAt: new Date(),
      })
      .returning({ id: priceSignalEvaluations.id });
    if (!row) throw new Error('the evaluation was not written');

    const message = await rejectionMessage(() =>
      db
        .update(priceSignalEvaluations)
        .set({ label: 'above_typical' })
        .where(eq(priceSignalEvaluations.id, row.id)),
    );
    expect(message).toContain('append-only');

    // DELETE is deliberately permitted: erasure on a schedule is the policy, and
    // a trigger refusing it would make retention fail SILENTLY on every row it
    // was asked to remove.
    await db.delete(priceSignalEvaluations).where(eq(priceSignalEvaluations.id, row.id));
  });

  it('refuses a value on an UNMEASURED row, and a reason on a measured one', async () => {
    const policy = await mintDraft(`shape-${RUN}`);
    const run = await mintRun(policy.id);
    const productId = await mintProduct('shape');
    const base = {
      runId: run.id,
      policyVersionId: policy.id,
      scopeKind: 'canonical_product' as const,
      canonicalProductId: productId,
      segment: 'new' as const,
      displayCurrency: 'EUR' as const,
      signalKind: 'lowest_observed_item_price' as const,
      sampleObservations: 0,
      sampleDistinctSellers: 0,
      sampleDistinctOffers: 0,
      sampleCoverageDays: 0,
      sampleOutliersExcluded: 0,
      sampleDeduplicated: 0,
      evaluatedAt: new Date(),
    };

    // A weak sample carrying a number is the failure this whole issue is about.
    const withValue = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({
        ...base,
        state: 'unmeasured',
        unmeasuredReason: 'insufficient_observations',
        valueAmount: 1_000,
      }),
    );
    expect(withValue).toContain('price_signal_evaluations_value_shape_check');

    // …and a measured row carrying an insufficiency reason says both that it
    // knows and that it does not.
    const withReason = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({
        ...base,
        state: 'measured',
        valueAmount: 1_000,
        unmeasuredReason: 'insufficient_observations',
      }),
    );
    expect(withReason).toContain('price_signal_evaluations_unmeasured_shape_check');

    // …and a measured row carrying NO figure at all is refused too, which is the
    // half a one-way implication would admit.
    const withNothing = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({ ...base, state: 'measured' }),
    );
    expect(withNothing).toContain('price_signal_evaluations_value_shape_check');
  });

  it('refuses a confidence with no label — the two are one fact', async () => {
    const policy = await mintDraft(`confidence-${RUN}`);
    const run = await mintRun(policy.id);
    const productId = await mintProduct('confidence');
    const message = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({
        runId: run.id,
        policyVersionId: policy.id,
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        segment: 'new',
        displayCurrency: 'EUR',
        signalKind: 'price_quality_label',
        state: 'measured',
        valueAmount: 1_000,
        confidence: 'strong',
        sampleObservations: 6,
        sampleDistinctSellers: 4,
        sampleDistinctOffers: 5,
        sampleCoverageDays: 9,
        sampleOutliersExcluded: 0,
        sampleDeduplicated: 0,
        evaluatedAt: new Date(),
      }),
    );
    expect(message).toContain('price_signal_evaluations_confidence_shape_check');
  });

  it('makes an evaluation citing ANOTHER policy than its run unrepresentable', async () => {
    const policy = await mintDraft(`composite-a-${RUN}`);
    const other = await mintDraft(`composite-b-${RUN}`);
    const run = await mintRun(policy.id);
    const productId = await mintProduct('composite');

    const message = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({
        runId: run.id,
        // A REAL policy version, so the single-column foreign key is satisfied
        // and only the COMPOSITE one can refuse this — which is the whole point
        // of the composite: a plausible row, refused by a shape.
        policyVersionId: other.id,
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        segment: 'new',
        displayCurrency: 'EUR',
        signalKind: 'typical_recent_range',
        state: 'measured',
        valueLowAmount: 1_000,
        valueHighAmount: 1_200,
        sampleObservations: 6,
        sampleDistinctSellers: 4,
        sampleDistinctOffers: 5,
        sampleCoverageDays: 9,
        sampleOutliersExcluded: 0,
        sampleDeduplicated: 0,
        evaluatedAt: new Date(),
      }),
    );
    expect(message).toContain('price_signal_evaluations_run_policy_fk');
  });

  it('refuses a range whose low end is above its high end', async () => {
    const policy = await mintDraft(`range-${RUN}`);
    const run = await mintRun(policy.id);
    const productId = await mintProduct('range');
    const message = await rejectionMessage(() =>
      db.insert(priceSignalEvaluations).values({
        runId: run.id,
        policyVersionId: policy.id,
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        segment: 'used',
        displayCurrency: 'EUR',
        signalKind: 'typical_recent_range',
        state: 'measured',
        valueLowAmount: 2_000,
        valueHighAmount: 1_000,
        sampleObservations: 6,
        sampleDistinctSellers: 4,
        sampleDistinctOffers: 5,
        sampleCoverageDays: 9,
        sampleOutliersExcluded: 0,
        sampleDeduplicated: 0,
        evaluatedAt: new Date(),
      }),
    );
    expect(message).toContain('price_signal_evaluations_range_shape_check');
  });

  it('refuses a run whose counters do not SUM — the vacuity floor', async () => {
    const policy = await mintDraft(`counters-${RUN}`);
    // Equality, never `<=`: a page that swallowed a subject cannot write a row
    // at all, and a sweep that measured nothing looks exactly like one that went
    // perfectly without it.
    const message = await rejectionMessage(() =>
      db.insert(priceSignalRuns).values({
        policyVersionId: policy.id,
        mode: 'monitor',
        displayCurrency: 'EUR',
        subjectsScanned: 10,
        subjectsMeasured: 4,
        subjectsUnmeasured: 4,
        subjectsFailed: 1,
      }),
    );
    expect(message).toContain('price_signal_runs_subject_counters_check');
  });
});

describe('merchant correction reports', () => {
  async function mintMerchant(label: string, claimant: string | null) {
    const [merchant] = await db
      .insert(merchants)
      .values({
        name: `PriceSignal ${label} ${RUN}`,
        slug: `pricesignal-merchant-${label}-${RUN}`,
        ...(claimant === null
          ? {}
          : { claimState: 'claimed' as const, claimedByOxyUserId: claimant, claimedAt: new Date() }),
      })
      .returning({ id: merchants.id });
    if (!merchant) throw new Error('the merchant was not written');
    createdMerchantIds.push(merchant.id);
    return merchant.id;
  }

  async function mintProduct(label: string) {
    const [product] = await db
      .insert(canonicalProducts)
      .values({
        name: `PriceSignal ${label} ${RUN}`,
        normalizedName: `pricesignal ${label} ${RUN}`,
        slug: `pricesignal-${label}-${RUN}`,
      })
      .returning({ id: canonicalProducts.id });
    if (!product) throw new Error('the canonical product was not written');
    createdProductIds.push(product.id);
    return product.id;
  }

  it('converges two identical reports on ONE open row', async () => {
    const claimant = `claimant-${RUN}`;
    const merchantId = await mintMerchant('converge', claimant);
    const productId = await mintProduct('converge');
    const values = {
      merchantId,
      reportedByOxyUserId: claimant,
      scopeKind: 'canonical_product' as const,
      canonicalProductId: productId,
      segment: 'new' as const,
      displayCurrency: 'EUR' as const,
      signalKind: 'price_quality_label' as const,
      reason: 'stale_observation' as const,
      note: 'the first note',
    };

    const first = await fileOrFindOpenPriceSignalFeedback(values, db);
    // A second submission carrying a DIFFERENT note must not overwrite the note
    // an operator may already be working from.
    const second = await fileOrFindOpenPriceSignalFeedback({ ...values, note: 'a later note' }, db);

    expect(second.id).toBe(first.id);
    expect(second.note).toBe('the first note');

    // …and a RESOLVED report leaves the partial index, so the same complaint can
    // legitimately be filed again later.
    await db
      .update(priceSignalFeedback)
      .set({ status: 'resolved', resolvedAt: new Date(), resolvedByOxyUserId: OPERATOR })
      .where(eq(priceSignalFeedback.id, first.id));
    const third = await fileOrFindOpenPriceSignalFeedback(values, db);
    expect(third.id).not.toBe(first.id);
  });

  it('refuses a closed report with no actor, and an open one with a resolution', async () => {
    const claimant = `claimant-shape-${RUN}`;
    const merchantId = await mintMerchant('shape', claimant);
    const productId = await mintProduct('feedback-shape');
    const base = {
      merchantId,
      reportedByOxyUserId: claimant,
      scopeKind: 'canonical_product' as const,
      canonicalProductId: productId,
      segment: 'new' as const,
      displayCurrency: 'EUR' as const,
      signalKind: 'lowest_observed_item_price' as const,
      reason: 'scale_error' as const,
    };

    const closedWithoutActor = await rejectionMessage(() =>
      db.insert(priceSignalFeedback).values({ ...base, status: 'resolved', resolvedAt: new Date() }),
    );
    expect(closedWithoutActor).toContain('price_signal_feedback_resolution_shape_check');

    const openWithResolution = await rejectionMessage(() =>
      db.insert(priceSignalFeedback).values({
        ...base,
        status: 'open',
        resolvedAt: new Date(),
        resolvedByOxyUserId: OPERATOR,
      }),
    );
    expect(openWithResolution).toContain('price_signal_feedback_resolution_shape_check');
  });
});

describe('the competitiveness surface is gated by #83, and names no competitor', () => {
  async function mintMerchant(label: string, claimant: string | null, claimed: boolean) {
    const [merchant] = await db
      .insert(merchants)
      .values({
        name: `PriceSignal ${label} ${RUN}`,
        slug: `pricesignal-gate-${label}-${RUN}`,
        ...(claimant === null
          ? {}
          : {
              claimState: claimed ? ('claimed' as const) : ('claim_pending' as const),
              claimedByOxyUserId: claimant,
              claimedAt: new Date(),
            }),
      })
      .returning({ id: merchants.id });
    if (!merchant) throw new Error('the merchant was not written');
    createdMerchantIds.push(merchant.id);
    return merchant.id;
  }

  it('answers the VERIFIED claimant and nobody else', async () => {
    const claimant = `gate-claimant-${RUN}`;
    const verified = await mintMerchant('verified', claimant, true);
    const pending = await mintMerchant('pending', claimant, false);
    const unclaimed = await mintMerchant('unclaimed', null, false);

    expect(await findVerifiedMerchantClaimant(verified, db)).toBe(claimant);
    // A PENDING claim answers null, which is the fixture that tells the verdict
    // read from a claimant read: both rows carry the same `claimed_by_oxy_user_id`
    // and only the state differs.
    expect(await findVerifiedMerchantClaimant(pending, db)).toBeNull();
    expect(await findVerifiedMerchantClaimant(unclaimed, db)).toBeNull();
  });

  it('refuses a caller who is not the claimant with the SAME 404 an unclaimed merchant gets', async () => {
    const claimant = `gate-owner-${RUN}`;
    const merchantId = await mintMerchant('owned', claimant, true);
    const unclaimed = await mintMerchant('nobody', null, false);

    const wrongCaller = await rejectionMessage(() =>
      readMerchantCompetitiveness({
        merchantId,
        oxyUserId: `somebody-else-${RUN}`,
        segment: 'new',
        currency: 'EUR',
        limit: 5,
      }),
    );
    const noClaim = await rejectionMessage(() =>
      readMerchantCompetitiveness({
        merchantId: unclaimed,
        oxyUserId: claimant,
        segment: 'new',
        currency: 'EUR',
        limit: 5,
      }),
    );
    // Indistinguishable, deliberately: a different refusal would let anybody
    // enumerate which merchants have been claimed.
    expect(wrongCaller).toContain('Merchant not found');
    expect(noClaim).toContain('Merchant not found');
  });

  it('emits no forbidden field anywhere in a REAL response', async () => {
    const claimant = `walk-claimant-${RUN}`;
    const merchantId = await mintMerchant('walk', claimant, true);

    const response = await readMerchantCompetitiveness({
      merchantId,
      oxyUserId: claimant,
      segment: 'new',
      currency: 'EUR',
      limit: 5,
    });

    // A RUNTIME walk beside the static scan, which is #92's two-gate rule: the
    // static one catches a DECLARED field and only this one catches a field a
    // serializer spread in.
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        seen.add(key);
        walk(child);
      }
    };
    walk(response);

    // The vacuity floor: an empty response would satisfy every prohibition below
    // while proving nothing, so the walk must have SEEN the fields it does emit.
    expect(seen.has('merchantId')).toBe(true);
    expect(seen.has('coverage')).toBe(true);
    for (const forbidden of MERCHANT_COMPETITIVENESS_FORBIDDEN_FIELDS) {
      expect(seen.has(forbidden), `the response carries \`${forbidden}\``).toBe(false);
    }
  });
});
