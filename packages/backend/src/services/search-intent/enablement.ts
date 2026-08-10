/**
 * May the model parser run for this request (#95 deterministic-fallback rule 7,
 * acceptance 7).
 *
 * Four gates, evaluated in a fixed order, and each answers with the
 * {@link IntentFallbackReason} it would produce — so "why did this fall back"
 * is a value from a closed set at the moment the decision is made, rather than
 * something reconstructed afterwards from a log.
 *
 * ```
 * NL_INTENT_ENABLED        →  parser_disabled
 * a registered parser      →  provider_unconfigured
 * the cohort kill switch   →  cohort_blocked
 * the benchmark enablement →  not_enabled_for_category_language
 * ```
 *
 * ## The benchmark gate is acceptance 7 and it needs TWO rows
 *
 * "Benchmark thresholds are recorded before enabling the parser by category and
 * language" is two facts, not one, and they fail differently: a parser measured
 * on Spanish says nothing about German, and a parser measured on Spanish
 * laptops says nothing about Spanish refrigerators. So the language-wide row
 * and the category row must BOTH exist and both say yes. A request with no
 * resolved category needs only the language row, because there is no category
 * to have measured — and that is the honest reading rather than a loophole: an
 * uncategorised query is exactly the case the language-wide run covers.
 *
 * ## And it compares the DIGEST, not just the flag
 *
 * An enablement carries the `dataset_digest` of the run that justified it. If
 * somebody edits the labelled dataset — adds a case, changes an expectation —
 * the live digest changes and every enablement recorded against the old one
 * stops matching. The parser falls back until somebody re-runs the benchmark
 * and re-enables, which is the only reading of "thresholds are recorded before
 * enabling" that survives the dataset being editable. A flag alone would leave
 * a deployment enabled against measurements that no longer describe anything.
 */

import type { IntentFallbackReason } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { readEnablements } from '../../db/searchIntent/benchmarkRepository.js';
import { hasShoppingIntentParser } from './parser.port.js';

/** What the gate needs to decide. */
export interface EnablementInput {
  /** ISO 639-1, derived from the request's locale. */
  readonly language: string;
  /** ISO 3166-1 alpha-2, when the request named one. */
  readonly market?: string;
  /** The category the deterministic pass resolved, when it resolved one. */
  readonly categoryId?: string;
  /** The live dataset's digest, so a stale enablement stops matching. */
  readonly datasetDigest: string;
  /** The caller asked for a deterministic answer (#95 client rule 5). */
  readonly deterministicOnly: boolean;
}

/** Whether the model may run, and the reason it may not. A string discriminant. */
export type EnablementDecision =
  | { readonly status: 'model_permitted' }
  | { readonly status: 'deterministic'; readonly reason: IntentFallbackReason };

/**
 * Whether one cohort is on the incident block list.
 *
 * A cohort is `<MARKET>:<language>`, and both `<MARKET>:*` and `*:<language>`
 * match it — so an incident in one market is one value and a bad language model
 * is one value, without either needing the full cross product. Everything is
 * compared UPPERCASED, because `blockedListEnv` uppercases what it reads and a
 * comparison against a lowercase language would silently never match, which is
 * a kill switch that does not kill.
 */
export function isCohortBlocked(
  market: string | undefined,
  language: string,
  blocked: readonly string[],
): boolean {
  if (blocked.length === 0) return false;
  const marketPart = (market ?? '').toUpperCase();
  const languagePart = language.toUpperCase();
  const candidates = [`${marketPart}:${languagePart}`, `${marketPart}:*`, `*:${languagePart}`];
  return candidates.some((candidate) => blocked.includes(candidate));
}

/**
 * Decide whether a model may be asked.
 *
 * Reads the database only when the three cheap gates have passed, which is not
 * an optimisation: with the feature off — the default — this function makes no
 * query at all, so adopting #95 costs a deployment that has not enabled it
 * exactly nothing on the hottest path it adds.
 */
export async function decideEnablement(
  db: DatabaseOrTransaction,
  input: EnablementInput,
): Promise<EnablementDecision> {
  if (input.deterministicOnly) {
    // The shopper asked for plain text search. It is not a fallback in the sense
    // the metric counts — but it IS a deterministic answer, and every
    // deterministic answer carries a reason, so it reuses the disabled one
    // rather than growing a member that would inflate the incident metric with
    // a shopper's own preference.
    return { status: 'deterministic', reason: 'parser_disabled' };
  }
  if (!config.searchIntent.enabled) {
    return { status: 'deterministic', reason: 'parser_disabled' };
  }
  if (!hasShoppingIntentParser()) {
    return { status: 'deterministic', reason: 'provider_unconfigured' };
  }
  if (isCohortBlocked(input.market, input.language, config.searchIntent.blockedCohorts)) {
    return { status: 'deterministic', reason: 'cohort_blocked' };
  }

  const rows = await readEnablements(input.language, input.categoryId, db);
  const languageOk =
    rows.languageRow !== undefined &&
    rows.languageRow.enabled &&
    rows.languageRow.datasetDigest === input.datasetDigest;
  if (!languageOk) {
    return { status: 'deterministic', reason: 'not_enabled_for_category_language' };
  }
  if (input.categoryId === undefined) return { status: 'model_permitted' };

  const categoryOk =
    rows.categoryRow !== undefined &&
    rows.categoryRow.enabled &&
    rows.categoryRow.datasetDigest === input.datasetDigest;
  return categoryOk
    ? { status: 'model_permitted' }
    : { status: 'deterministic', reason: 'not_enabled_for_category_language' };
}
