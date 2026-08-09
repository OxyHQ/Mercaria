/**
 * Request schemas for the matching operator surface (#58).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types` rather than being retyped, so a schema cannot accept
 * a value the database CHECK then refuses.
 *
 * `.strict()` is doing real work here, and specifically: **no schema in this
 * file carries an `outcome`, a `confidence`, a `blockers` list or a
 * `matchedCanonicalVariantId`.** All four are the pipeline's to compute, and a
 * request shape able to carry one would be an HTTP route around the whole
 * decision procedure — an operator could post `outcome: 'automatic_match'` with
 * an empty blocker list and get exactly the false merge every CHECK in the
 * schema exists to prevent.
 *
 * Nor is there a schema for creating a canonical product. `create_new` is a
 * RECOMMENDATION; minting is ADR 0002 D23's backfill (#60) and #59's tooling.
 */

import { z } from 'zod';
import { MATCH_SUBJECT_KINDS, MATCH_SWEEP_JOBS, type MatchSubjectKind, type MatchSweepJob } from '@mercaria/shared-types';

const SUBJECT_KIND_VALUES = MATCH_SUBJECT_KINDS as readonly [MatchSubjectKind, ...MatchSubjectKind[]];
const SWEEP_JOB_VALUES = MATCH_SWEEP_JOBS as readonly [MatchSweepJob, ...MatchSweepJob[]];

const entityId = z.string().trim().min(1).max(64);
const subjectKey = z.string().trim().min(1).max(256);
/** A reason is MANDATORY on every write here, and an empty one is not a reason. */
const reason = z.string().trim().min(1).max(2_000);
const probability = z.number().min(0).max(1);
const weight = z.number().min(0).max(100);

/**
 * Draft a policy version.
 *
 * The thresholds a caller may set are bounded HERE and again by
 * `match_policy_versions_thresholds_check` and
 * `match_policy_versions_benchmark_bar_check`. The duplication is deliberate:
 * the schema turns a bad value into a 400 naming the field, and the CHECK makes
 * the bound true for every writer, including one that never went through a
 * route.
 */
export const createMatchPolicySchema = z
  .object({
    versionKey: z.string().trim().min(1).max(64),
    description: reason,
    autoMinConfidence: probability,
    reviewMinConfidence: probability,
    minCandidateSeparation: probability,
    maxCandidates: z.number().int().min(1).max(500),
    minTitleSimilarity: probability,
    weightIdentifier: weight,
    weightBrand: weight,
    weightModel: weight,
    weightAttribute: weight,
    weightTitle: weight,
    weightCategory: weight,
    weightSemantic: weight.optional(),
    semanticEnabled: z.boolean().optional(),
    /** Launch thresholds favour precision; the floor is CHECKed at 0.95 too. */
    minBenchmarkPrecision: z.number().min(0.95).max(1),
    minBenchmarkSamples: z.number().int().min(20).max(1_000_000),
  })
  .strict();

/**
 * Open a category gate.
 *
 * The caller names the measurement and NOT the precision: the observed numbers
 * are read off the cited slice, so an operator cannot open a gate by typing a
 * number that no run produced.
 */
export const openCategoryGateSchema = z
  .object({
    policyVersionId: entityId,
    categoryKey: z.string().trim().min(1).max(128),
    benchmarkCategoryId: entityId,
    reason,
  })
  .strict();

export const closeCategoryGateSchema = z.object({ reason }).strict();

/** Record a rejected pair. Exactly one target, refused at the schema. */
export const rejectMatchPairSchema = z
  .object({
    subjectKey,
    subjectKind: z.enum(SUBJECT_KIND_VALUES),
    targetCanonicalProductId: entityId.optional(),
    targetCanonicalVariantId: entityId.optional(),
    decisionId: entityId,
    reason,
  })
  .strict()
  .refine(
    (body) =>
      (body.targetCanonicalProductId ? 1 : 0) + (body.targetCanonicalVariantId ? 1 : 0) === 1,
    { message: 'Name exactly one target: a canonical product or a canonical variant.' },
  );

export const clearBlockedPairSchema = z.object({ reason }).strict();

/**
 * Record a review verdict.
 *
 * `approved` and `rejected` and nothing else — a reviewer cannot set
 * `not_required` or re-open a `pending`, because both would let a person edit
 * the queue rather than answer it.
 */
export const reviewMatchDecisionSchema = z
  .object({
    verdict: z.enum(['approved', 'rejected']),
    note: reason,
  })
  .strict();

/** Run one bounded page of a bulk sweep. */
export const runMatchSweepSchema = z
  .object({
    job: z.enum(SWEEP_JOB_VALUES),
    limit: z.number().int().min(1).max(5_000).optional(),
  })
  .strict();

/** Evaluate ONE subject now, rather than waiting for the dispatcher. */
export const evaluateSubjectSchema = z
  .object({
    productVariantId: entityId.optional(),
    sourceRecordId: entityId.optional(),
  })
  .strict()
  .refine((body) => (body.productVariantId ? 1 : 0) + (body.sourceRecordId ? 1 : 0) === 1, {
    message: 'Name exactly one subject: a product variant or a source record.',
  });
