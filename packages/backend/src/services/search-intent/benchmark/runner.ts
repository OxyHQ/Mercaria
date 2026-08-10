/**
 * The benchmark runner (#95 "Evaluation").
 *
 * Runs the labelled dataset through the PRODUCTION interpreter and computes the
 * eight measures a threshold is recorded against. Pure and database-free, so
 * the whole set runs in CI on every push — the #58 benchmark's decision, and
 * the reason a benchmark that only an operator can run goes stale.
 *
 * ## Every measure has a DENOMINATOR that is the number of cases it applies to
 *
 * Not the number of cases in the dataset. `category_accuracy` over a set where
 * two cases mention a category is a rate over two, and reporting it over
 * twenty-nine would put a 0.93 on a parser that got both wrong. `sampleSize` is
 * carried beside every measurement for exactly that reason, and the enablement
 * gate reads it: a rate off a handful of cases is noise wearing a percentage,
 * and #125's `unmeasured` verdict is the precedent — a threshold nobody
 * measured is not a threshold that was met.
 *
 * ## The false-hard-constraint rate is the one to read
 *
 * It is the only measure whose threshold is a CEILING rather than a floor, and
 * `INTENT_BENCHMARK_FLOOR_MEASURES` states the direction as data precisely so a
 * comparison cannot get it backwards — reading it as a floor would enable the
 * parser exactly when it is inventing requirements. A false hard constraint
 * removes products a shopper would have bought, silently, and they read it as
 * "Mercaria does not sell that".
 */

import type {
  IntentBenchmarkMeasure,
  IntentBenchmarkMeasurement,
  InterpretationMode,
} from '@mercaria/shared-types';
import { interpretDeterministically, type InterpretationDraft } from '../deterministic.js';
import { INTENT_BENCHMARK_DATASET, type IntentBenchmarkCase } from './dataset.js';
import { BENCHMARK_REGISTRIES } from './registry.js';

/**
 * How one case was interpreted.
 *
 * The runner takes an INTERPRETER rather than calling one, so the same dataset
 * measures the deterministic path (the default, and what CI runs) and a
 * model-backed one (what an operator runs before enabling a provider) through
 * identical scoring. Two scorers would let the two paths be judged by different
 * standards, which is the one thing a threshold must not depend on.
 */
export type BenchmarkInterpreter = (
  benchmarkCase: IntentBenchmarkCase,
) => Promise<{ readonly draft: InterpretationDraft; readonly mode: InterpretationMode }>;

/** The deterministic interpreter, wired to the in-memory registries. */
export const deterministicBenchmarkInterpreter: BenchmarkInterpreter = async (benchmarkCase) => ({
  draft: interpretDeterministically({
    query: benchmarkCase.query,
    locale: benchmarkCase.locale,
    ...(benchmarkCase.currency === undefined ? {} : { currency: benchmarkCase.currency }),
    definitions: BENCHMARK_REGISTRIES[benchmarkCase.registry] ?? [],
  }),
  mode: 'deterministic',
});

/** What one case scored, and why. */
export interface BenchmarkCaseOutcome {
  readonly caseId: string;
  readonly mode: InterpretationMode;
  /** The candidate parsed into the expected SHAPE at all. */
  readonly schemaValid: boolean;
  /** Every expectation the case stated and whether it held. */
  readonly failures: readonly string[];
  /** Hard requirements the case forbade and the interpreter produced anyway. */
  readonly falseHardConstraints: readonly string[];
  readonly latencyMs: number;
}

/** A whole run. */
export interface BenchmarkRunReport {
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly caseCount: number;
  readonly measurements: readonly IntentBenchmarkMeasurement[];
  readonly outcomes: readonly BenchmarkCaseOutcome[];
}

/**
 * Run the dataset.
 *
 * `language` filters the cases when one is given, because a run measures ONE
 * language — a parser accurate in Spanish says nothing about German, and a
 * single blended rate is exactly the number that would let one language's
 * accuracy enable another's.
 */
export async function runIntentBenchmark(
  interpreter: BenchmarkInterpreter = deterministicBenchmarkInterpreter,
  language?: string,
): Promise<BenchmarkRunReport> {
  const cases =
    language === undefined
      ? INTENT_BENCHMARK_DATASET.cases
      : INTENT_BENCHMARK_DATASET.cases.filter((benchmarkCase) =>
          benchmarkCase.locale.toLowerCase().startsWith(`${language.toLowerCase()}-`) ||
          benchmarkCase.locale.toLowerCase() === language.toLowerCase(),
        );

  const outcomes: BenchmarkCaseOutcome[] = [];
  const latencies: number[] = [];
  let categoryApplicable = 0;
  let categoryCorrect = 0;
  let hardApplicable = 0;
  let hardRecalled = 0;
  let clarificationApplicable = 0;
  let clarificationCorrect = 0;
  let falseHardApplicable = 0;
  let falseHardOccurrences = 0;
  let schemaValid = 0;
  let modelCount = 0;

  for (const benchmarkCase of cases) {
    const started = Date.now();
    let draft: InterpretationDraft | undefined;
    let mode: InterpretationMode = 'deterministic';
    try {
      const interpreted = await interpreter(benchmarkCase);
      draft = interpreted.draft;
      mode = interpreted.mode;
    } catch {
      // An interpreter that THREW produced no schema-valid answer, which is
      // exactly what `schema_validity` measures. Rethrowing would abandon the
      // run and report nothing, and a run that reports nothing is a run whose
      // thresholds nobody can compare against.
      draft = undefined;
    }
    const latencyMs = Date.now() - started;
    latencies.push(latencyMs);
    if (mode === 'model') modelCount += 1;

    if (draft === undefined) {
      outcomes.push({
        caseId: benchmarkCase.id,
        mode,
        schemaValid: false,
        failures: ['the interpreter produced no answer'],
        falseHardConstraints: [],
        latencyMs,
      });
      continue;
    }
    schemaValid += 1;

    const expectation = benchmarkCase.expect;
    const failures: string[] = [];
    const hardKeys = draft.requirements
      .filter((requirement) => requirement.strength === 'hard')
      .map((requirement) => requirement.attributeKey);
    const preferenceKeys = draft.requirements
      .filter((requirement) => requirement.strength === 'preference')
      .map((requirement) => requirement.attributeKey);

    if (expectation.categorySlug !== undefined) {
      categoryApplicable += 1;
      if (draft.categorySlug?.slug === expectation.categorySlug) categoryCorrect += 1;
      else failures.push(`category ${draft.categorySlug?.slug ?? 'none'} ≠ ${expectation.categorySlug}`);
    }

    for (const key of expectation.hardAttributeKeys ?? []) {
      hardApplicable += 1;
      if (hardKeys.includes(key)) hardRecalled += 1;
      else failures.push(`missing hard requirement ${key}`);
    }
    for (const key of expectation.preferenceAttributeKeys ?? []) {
      if (!preferenceKeys.includes(key)) failures.push(`missing preference ${key}`);
    }

    const falseHardConstraints: string[] = [];
    for (const key of expectation.mustNotProduceHard ?? []) {
      falseHardApplicable += 1;
      if (hardKeys.includes(key)) {
        falseHardOccurrences += 1;
        falseHardConstraints.push(key);
        failures.push(`invented hard requirement ${key}`);
      }
    }

    if (expectation.budget !== undefined) {
      const budget = draft.budget;
      if (budget === undefined) failures.push('missing budget');
      else {
        if (budget.basis !== expectation.budget.basis) {
          failures.push(`budget basis ${budget.basis} ≠ ${expectation.budget.basis}`);
        }
        if (budget.currency !== expectation.budget.currency) {
          failures.push(`budget currency ${budget.currency} ≠ ${expectation.budget.currency}`);
        }
        if (budget.maxMinor !== expectation.budget.maxMinor) {
          failures.push(`budget max ${String(budget.maxMinor)} ≠ ${String(expectation.budget.maxMinor)}`);
        }
        if (budget.minMinor !== expectation.budget.minMinor) {
          failures.push(`budget min ${String(budget.minMinor)} ≠ ${String(expectation.budget.minMinor)}`);
        }
      }
    }
    if (expectation.noBudget === true && draft.budget !== undefined) {
      failures.push('invented a budget');
    }

    for (const group of expectation.conditionGroups ?? []) {
      if (!(draft.condition?.groups ?? []).includes(group)) failures.push(`missing condition ${group}`);
    }
    if (expectation.officialChannelOnly === true && draft.officialChannelOnly !== true) {
      failures.push('missing official-channel leaning');
    }
    if (expectation.nearby === true && draft.nearby !== true) failures.push('missing nearby leaning');

    for (const kind of expectation.unresolvedKinds ?? []) {
      if (!draft.unresolved.some((entry) => entry.kind === kind)) {
        failures.push(`missing unresolved report ${kind}`);
      }
    }

    if (expectation.clarificationKinds !== undefined) {
      for (const kind of expectation.clarificationKinds) {
        clarificationApplicable += 1;
        if (draft.ambiguities.includes(kind)) clarificationCorrect += 1;
        else failures.push(`missing clarification ${kind}`);
      }
    }
    if (expectation.noClarification === true) {
      clarificationApplicable += 1;
      if (draft.ambiguities.length === 0) clarificationCorrect += 1;
      else failures.push(`asked ${draft.ambiguities.join(', ')} when it should have asked nothing`);
    }

    outcomes.push({
      caseId: benchmarkCase.id,
      mode,
      schemaValid: true,
      failures,
      falseHardConstraints,
      latencyMs,
    });
  }

  const total = cases.length;
  const measure = (
    name: IntentBenchmarkMeasure,
    value: number,
    sampleSize: number,
  ): IntentBenchmarkMeasurement => ({ measure: name, value, sampleSize });

  return {
    datasetVersion: INTENT_BENCHMARK_DATASET.version,
    datasetDigest: INTENT_BENCHMARK_DATASET.digest,
    caseCount: total,
    measurements: [
      measure('schema_validity', ratio(schemaValid, total), total),
      measure('category_accuracy', ratio(categoryCorrect, categoryApplicable), categoryApplicable),
      measure('hard_constraint_recall', ratio(hardRecalled, hardApplicable), hardApplicable),
      // The one CEILING. Zero applicable cases would make `ratio` answer 1,
      // which for a ceiling is the worst possible score rather than the best —
      // so its empty case answers 0 explicitly.
      measure(
        'false_hard_constraint_rate',
        falseHardApplicable === 0 ? 0 : falseHardOccurrences / falseHardApplicable,
        falseHardApplicable,
      ),
      measure(
        'clarification_precision',
        ratio(clarificationCorrect, clarificationApplicable),
        clarificationApplicable,
      ),
      measure('latency_p95_ms', percentile(latencies, 0.95), total),
      // The deterministic interpreter costs nothing and reports so. A
      // model-backed interpreter's cost is the provider's to report, and this
      // runner does not invent one — a fabricated cost is worse than none,
      // because a budget decision would rest on it.
      measure('cost_units', 0, total),
      measure('fallback_rate', ratio(total - modelCount, total), total),
    ],
    outcomes,
  };
}

/** A rate, with an empty denominator answering 1 — "nothing was got wrong". */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * The p95 of a sample.
 *
 * Nearest-rank, so the answer is always an observed value rather than an
 * interpolation between two — a latency budget is compared against something
 * that actually happened.
 */
function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
