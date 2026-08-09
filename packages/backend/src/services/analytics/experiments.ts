/**
 * Deterministic experiment assignment and the guardrails around it (#77
 * "Experimentation").
 *
 * ## Assignment is a pure function and stores nothing
 *
 * `assignVariant` is `sha256(experimentKey:salt:unitRef) mod 10000` mapped onto
 * the arms. Two consequences, and both are the reason it is a function rather
 * than a table:
 *
 *  - A unit gets the same arm from every ECS task, on every request, with no
 *    read. There is no assignment row to be stale, to be missing, or to be
 *    written twice under a race.
 *  - Nothing is STORED about a unit until it is actually EXPOSED. An experiment
 *    that a person never reached leaves no record of them at all, which is the
 *    correct amount of data to hold about somebody who saw nothing.
 *
 * ## What assignment cannot read
 *
 * The unit reference is an Oxy user id or a rotating pseudonym, and
 * `ANALYTICS_EXPERIMENT_ASSIGNMENT_UNITS` has no third member. There is no
 * parameter here that could take an email hash, a card fingerprint or a
 * provider customer id, so experimentation rule 8 ("assignment and analysis
 * cannot use raw guest contact or payment identity") is enforced by the
 * signature rather than by review.
 *
 * ## What an experiment cannot DO
 *
 * Rules 3, 5 and 9 are enforced in the shared-types vocabulary, not here:
 * `ANALYTICS_EXPERIMENT_TREATMENT_KINDS` contains no member that could mean
 * "hide Continue as guest", "auto-create an account", "preselect marketing
 * consent" or "sell organic rank". {@link findForbiddenTreatmentKinds} is the
 * gate that keeps it that way, and `experiment-guardrails.test.ts` runs it.
 *
 * ## Flags roll back independently of analytics (rule 7)
 *
 * Nothing in a rollback path reads this module. A feature flag is
 * `config.*`, evaluated with no database access and no analytics dependency, so
 * an experiment can be turned off while the sink is down, while the rollup is
 * stalled, and while `ANALYTICS_ENABLED` is false. `assignVariant` returning a
 * variant does not make a surface render it — the surface's own flag does.
 */

import { createHash } from 'node:crypto';
import type { AnalyticsExperimentTreatmentKind } from '@mercaria/shared-types';
import {
  ANALYTICS_EXPERIMENT_BUCKETS,
  ANALYTICS_EXPERIMENT_TREATMENT_KINDS,
  ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS,
} from '@mercaria/shared-types';

/** What `assignVariant` needs. A projection of one active experiment version. */
export interface ExperimentAssignmentInput {
  readonly experimentKey: string;
  readonly assignmentSalt: string;
  readonly variants: readonly string[];
  /** Basis points of the bucket space that are IN the test. */
  readonly trafficAllocationBps: number;
}

/**
 * Which bucket a unit falls in, 0…9999.
 *
 * Exported because the traffic gate and the arm split must read the SAME bucket
 * — computing them from two hashes would let a unit be "in the test" under one
 * and land outside every arm under the other.
 */
export function assignmentBucket(input: {
  experimentKey: string;
  assignmentSalt: string;
  unitRef: string;
}): number {
  const digest = createHash('sha256')
    .update(`${input.experimentKey}:${input.assignmentSalt}:${input.unitRef}`)
    .digest();
  // The first four bytes, unsigned, modulo the bucket space. `readUInt32BE`
  // rather than `parseInt` on the hex: the hex form of a 32-bit value exceeds
  // `Number.MAX_SAFE_INTEGER` as soon as anyone takes more digits "to be safe",
  // and the resulting bias is invisible.
  return digest.readUInt32BE(0) % ANALYTICS_EXPERIMENT_BUCKETS;
}

/**
 * The arm a unit is in, or `undefined` when it is outside the allocation.
 *
 * `undefined` is a real answer and is NOT "control": a unit outside the test
 * must not be counted in the control arm, or the holdout and the control become
 * the same population and the comparison measures nothing.
 *
 * Arms split the ALLOCATED range evenly. Uneven splits are deliberately not
 * expressible — a weighted experiment is a legitimate thing to want and a
 * per-arm weight column is a legitimate way to get it; what is not legitimate
 * is inferring weights from an array's shape, which is how a 50/50 test
 * silently becomes 90/10 after somebody adds an arm.
 */
export function assignVariant(
  experiment: ExperimentAssignmentInput,
  unitRef: string,
): string | undefined {
  if (experiment.variants.length < 2) return undefined;
  if (experiment.trafficAllocationBps <= 0) return undefined;

  const bucket = assignmentBucket({
    experimentKey: experiment.experimentKey,
    assignmentSalt: experiment.assignmentSalt,
    unitRef,
  });
  if (bucket >= experiment.trafficAllocationBps) return undefined;

  const perArm = experiment.trafficAllocationBps / experiment.variants.length;
  const index = Math.min(Math.floor(bucket / perArm), experiment.variants.length - 1);
  return experiment.variants[index];
}

/**
 * Any treatment kind whose name matches a forbidden pattern.
 *
 * The gate behind experimentation rules 3, 5 and 9. It scans the POSITIVE
 * vocabulary against the negative list rather than checking a stored value,
 * because the thing that must never exist is the VALUE ITSELF: once
 * `hide_guest_option` is a member of the tuple, every CHECK, every DTO and every
 * operator form accepts it, and no runtime check downstream can un-invent it.
 *
 * Returns the offenders rather than throwing, so the test names them and the
 * mutation self-test can prove the detector detects.
 */
export function findForbiddenTreatmentKinds(
  kinds: readonly string[] = ANALYTICS_EXPERIMENT_TREATMENT_KINDS,
): readonly string[] {
  return kinds.filter((kind) =>
    ANALYTICS_FORBIDDEN_EXPERIMENT_TREATMENTS.some((forbidden) => kind.includes(forbidden)),
  );
}

/**
 * Whether a treatment kind is one this deployment recognises.
 *
 * A narrow helper, and the reason it exists rather than an inline `includes`:
 * the operator surface validates a submitted kind, and doing that against the
 * tuple directly in a controller is how a second, looser copy of the list
 * appears.
 */
export function isKnownTreatmentKind(value: string): value is AnalyticsExperimentTreatmentKind {
  return (ANALYTICS_EXPERIMENT_TREATMENT_KINDS as readonly string[]).includes(value);
}
