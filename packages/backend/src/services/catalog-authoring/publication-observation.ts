/**
 * What publication attempts this process made, and what they were refused for
 * (#367 W17 line 768).
 *
 * `publish.service.ts` computes an `AuthoringValidationResult` and returns it to
 * the caller; nothing persisted it and the refused branch logged nothing, so
 * "which validations are actually failing" was a question the repository could
 * not answer at all. This is the counter that answers it.
 *
 * ## Process-local, and that is the design rather than a shortcut
 *
 * `services/variant-axes/projection.ts` made this call first and the reasoning
 * carries over exactly: several ECS tasks each observe their own traffic, a
 * durable row per publication attempt would be an analytics table this domain
 * has no business owning, and aggregating across tasks belongs to `oxy-infra`
 * scraping the operator endpoint. It is also why nothing here can fail a
 * publish — see {@link recordPublicationAttempt}.
 *
 * The cost is real and is declared on both metrics rather than hidden: **a
 * deploy zeroes every counter.** That is why they are `since_process_start`
 * with `freshnessSeconds: 0`, which the registry's own biconditional gate ties
 * to membership of `CATALOG_IN_PROCESS_METRIC_SOURCES`.
 *
 * ## Two populations, because a code partitions one of them and not the other
 *
 * An attempt is refused ONCE and carries any number of findings. So:
 *
 * - `attempts` / `refused` answer "how often does a publish bounce", and carry
 *   no per-code breakdown — a refusal with three codes would be counted in
 *   three buckets while the reading claimed they summed to the denominator.
 * - `findingsByCode` answers "which rules are biting", over the population where
 *   a code IS an exact partition: the findings themselves.
 *
 * Reporting the second as a breakdown of the first is the arithmetic mistake
 * this split exists to make impossible.
 *
 * ## The bucket key is a CLOSED tuple
 *
 * `AuthoringValidationCode` has thirty-odd members and gains one only when
 * somebody decides it should. The finding also carries `attributeKey`, and
 * bucketing on that would be an UNBOUNDED metric dimension whose cardinality
 * grows with the registry — the defect the no-property-bag rule prevents one
 * layer down, arriving as a breakdown key instead of a column. A per-attribute
 * instrument is a different one, with its own disclosure argument.
 */

import type { AuthoringValidationCode, AuthoringValidationResult } from '@mercaria/shared-types';

/** What one process has accumulated since it started. */
export interface AuthoringPublicationCounters {
  /** Publication attempts that reached validation. */
  readonly attempts: number;
  /** Of those, the ones validation refused. */
  readonly refused: number;
  /** Findings on refused attempts, by code. A code partitions THIS exactly. */
  readonly findingsByCode: Readonly<Record<string, number>>;
  /** Every finding on every refused attempt — the `findingsByCode` denominator. */
  readonly findings: number;
}

const EMPTY: AuthoringPublicationCounters = {
  attempts: 0,
  refused: 0,
  findingsByCode: Object.freeze({}),
  findings: 0,
};

let counters: AuthoringPublicationCounters = EMPTY;

/**
 * Record one publication attempt and its verdict.
 *
 * Takes the whole `AuthoringValidationResult` rather than a boolean and a list,
 * because the two are derived from one another — `publishable` is DERIVED from
 * the findings by the result's own contract — and passing them separately would
 * let a caller report a refusal with no findings or findings with no refusal.
 *
 * Never throws. A counter that could fail a publish would be a metric deciding
 * whether a merchant's listing goes live, which is the one thing an observation
 * must not be able to do.
 */
export function recordPublicationAttempt(validation: AuthoringValidationResult): void {
  if (validation.publishable) {
    counters = { ...counters, attempts: counters.attempts + 1 };
    return;
  }
  const byCode: Record<string, number> = { ...counters.findingsByCode };
  let added = 0;
  for (const finding of validation.findings) {
    // ERRORS only. A `warning` finding does not refuse anything, and counting it
    // here would make the code shares describe a population that includes
    // advice nobody was blocked by.
    if (finding.severity !== 'error') continue;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    added += 1;
  }
  counters = {
    attempts: counters.attempts + 1,
    refused: counters.refused + 1,
    findingsByCode: byCode,
    findings: counters.findings + added,
  };
}

/** The counters, for the operator surface. */
export function readAuthoringPublicationCounters(): AuthoringPublicationCounters {
  return counters;
}

/** Reset. Test-only seam; production never calls it. */
export function resetAuthoringPublicationCounters(): void {
  counters = EMPTY;
}

/** Narrow a recorded key back to the closed tuple, for a typed reader. */
export function isAuthoringValidationCode(
  value: string,
  codes: readonly AuthoringValidationCode[],
): value is AuthoringValidationCode {
  return (codes as readonly string[]).includes(value);
}
