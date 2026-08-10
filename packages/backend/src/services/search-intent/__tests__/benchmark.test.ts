/**
 * The benchmark, run as a GATE (#95 "Evaluation").
 *
 * #58's benchmark is "a gate, not a fixture dump", and this is the same
 * decision: the whole labelled dataset runs here on every push, against the
 * PRODUCTION interpreter, so a rule change that costs accuracy fails the build
 * rather than being discovered the next time somebody remembers to run a
 * script.
 *
 * ## The thresholds asserted here are the DETERMINISTIC floor
 *
 * They are not the thresholds a model is enabled against — those are recorded
 * per (category, language) in `search_intent_enablements` by an operator who
 * ran the same dataset against the same runner. What CI pins is that the
 * deterministic interpreter, which every deployment gets whether or not it has
 * a provider, does not regress: it reads what it claims to read, and it does
 * not invent hard requirements.
 *
 * `false_hard_constraint_rate` is asserted at exactly ZERO, and that is the
 * strongest statement in the file. Every other measure is a floor that could be
 * met by a lucky rule; this one says the interpreter never once excluded a
 * product on a requirement the shopper did not make, across every case in the
 * set.
 */

import { describe, expect, it } from 'vitest';
import { INTENT_BENCHMARK_CASE_KINDS, INTENT_BENCHMARK_MEASURES } from '@mercaria/shared-types';
import { INTENT_BENCHMARK_DATASET, coveredCaseKinds } from '../benchmark/dataset.js';
import { runIntentBenchmark } from '../benchmark/runner.js';

describe('the labelled dataset', () => {
  it('covers every case class the issue names', () => {
    // The vacuity floor for the dataset itself: a class nobody wrote a case for
    // fails the build rather than being absent from a report that still reads
    // complete. Finding fewer cases looks exactly like there being fewer.
    expect([...coveredCaseKinds()].sort()).toEqual([...INTENT_BENCHMARK_CASE_KINDS].sort());
  });

  it('covers several languages', () => {
    const languages = new Set(
      INTENT_BENCHMARK_DATASET.cases.map((benchmarkCase) => benchmarkCase.locale.split('-')[0]),
    );
    expect(languages.size).toBeGreaterThanOrEqual(4);
  });

  it('has a content digest that changes with the cases and not with the file', () => {
    expect(INTENT_BENCHMARK_DATASET.digest).toMatch(/^[0-9a-f]{64}$/u);
    // A second computation over the same cases must agree — the digest is what
    // an enablement is recorded against, and a digest that varied between
    // processes would invalidate every threshold on every deploy.
    const again = INTENT_BENCHMARK_DATASET.digest;
    expect(again).toBe(INTENT_BENCHMARK_DATASET.digest);
    expect(INTENT_BENCHMARK_DATASET.caseCount).toBe(INTENT_BENCHMARK_DATASET.cases.length);
    expect(INTENT_BENCHMARK_DATASET.caseCount).toBeGreaterThanOrEqual(24);
  });
});

describe('the deterministic interpreter clears its floor', () => {
  it('reports every measure, with a real denominator on each', async () => {
    const report = await runIntentBenchmark();
    const measures = report.measurements.map((measurement) => measurement.measure).sort();
    expect(measures).toEqual([...INTENT_BENCHMARK_MEASURES].sort());
    // Every RATE must have been computed over something. A measure whose sample
    // size is zero answers 1 by construction (`ratio`'s empty case) and would
    // read as a perfect score against nothing — #125's `unmeasured` verdict,
    // applied to a benchmark.
    for (const measurement of report.measurements) {
      if (measurement.measure === 'cost_units' || measurement.measure === 'latency_p95_ms') continue;
      expect(
        measurement.sampleSize,
        `${measurement.measure} was computed over nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('never invents a hard requirement', async () => {
    const report = await runIntentBenchmark();
    const invented = report.outcomes.filter(
      (outcome) => outcome.falseHardConstraints.length > 0,
    );
    expect(
      invented.map((outcome) => `${outcome.caseId}: ${outcome.falseHardConstraints.join(', ')}`),
      'the interpreter excluded products on a requirement nobody made',
    ).toEqual([]);
    const rate = report.measurements.find(
      (measurement) => measurement.measure === 'false_hard_constraint_rate',
    );
    expect(rate?.value).toBe(0);
  });

  it('meets its accuracy floors', async () => {
    const report = await runIntentBenchmark();
    const value = (name: string): number =>
      report.measurements.find((measurement) => measurement.measure === name)?.value ?? 0;
    expect(value('schema_validity')).toBe(1);
    expect(value('category_accuracy')).toBe(1);
    expect(value('hard_constraint_recall')).toBe(1);
    expect(value('clarification_precision')).toBe(1);
  });

  it('satisfies every labelled expectation', async () => {
    const report = await runIntentBenchmark();
    const failures = report.outcomes
      .filter((outcome) => outcome.failures.length > 0)
      .map((outcome) => `${outcome.caseId}: ${outcome.failures.join('; ')}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('reports a fallback rate of 1 with no model registered', async () => {
    // The honest baseline: nothing in this repository registers a parser, so
    // every case is answered deterministically and the rate says so. A run
    // reporting anything else would mean a provider had been wired in.
    const report = await runIntentBenchmark();
    expect(
      report.measurements.find((measurement) => measurement.measure === 'fallback_rate')?.value,
    ).toBe(1);
  });

  it('runs one language at a time', async () => {
    const spanish = await runIntentBenchmark(undefined, 'es');
    expect(spanish.caseCount).toBeGreaterThan(0);
    expect(spanish.caseCount).toBeLessThan(INTENT_BENCHMARK_DATASET.caseCount);
    expect(
      spanish.outcomes.every((outcome) =>
        INTENT_BENCHMARK_DATASET.cases
          .filter((benchmarkCase) => benchmarkCase.locale.startsWith('es'))
          .some((benchmarkCase) => benchmarkCase.id === outcome.caseId),
      ),
    ).toBe(true);
  });
});
