/**
 * The labelled benchmark, as a GATE (#58 evaluation, acceptance 5).
 *
 * This is the test that decides whether the rules are good enough to enable
 * automatic matching, so it is written to fail LOUDLY and specifically: a
 * regression prints the case ids that flipped, not a moved decimal.
 *
 * ## Why precision has a floor and recall does not
 *
 * A false merge contaminates every product page and price comparison downstream
 * of it, and it looks exactly like a correct match — nobody reports it, and it is
 * discovered by a customer. A miss produces a review, which a person clears.
 * Those two costs are not comparable, so the gate is asymmetric on purpose:
 * precision has a hard floor and recall is REPORTED and floored only loosely, so
 * a policy that reviewed everything would be visible rather than green.
 *
 * ## The numbers this file measures, and on what
 *
 * The in-memory fixture catalogue (`benchmark/in-memory-source.ts`), which shares
 * scoring and the policy with production byte for byte and simplifies RETRIEVAL.
 * So these are numbers about the RULES. The production retrieval path is
 * exercised end to end by `matching-writes.realdb.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultBenchmarkPolicy,
  formatBenchmarkReport,
  runBenchmark,
  scaleFactor,
  scaledCatalogue,
  slicePrecision,
  sliceRecall,
  type BenchmarkResult,
} from '../benchmark/runner.js';
import { BENCHMARK_CASES, DATASET_VERSION, datasetChecksum } from '../benchmark/dataset.js';

function overall(result: BenchmarkResult) {
  const slice = result.slices.find(
    (candidate) => candidate.categoryKey === '*' && candidate.sourceKey === '*',
  );
  expect(slice, 'the whole-run slice must exist').toBeDefined();
  if (!slice) throw new Error('unreachable');
  return slice;
}

function failures(result: BenchmarkResult, verdict: string): string[] {
  return result.cases
    .filter((entry) => entry.verdict === verdict)
    .map(
      (entry) =>
        `${entry.caseId} [${entry.kind}] expected=${entry.expectedVariantId ?? 'none'} ` +
        `predicted=${entry.predictedVariantId ?? 'none'} outcome=${entry.outcome} ` +
        `stage=${entry.decidedStage} blockers=${entry.blockers.join(',') || 'none'}`,
    );
}

describe('the labelled matching benchmark', () => {
  /**
   * The anti-vacuity floor. Everything below is a rate over these cases, and a
   * broken import, a renamed export or a dataset that lost its cases would make
   * every rate a division over an empty set — which passes.
   */
  it('covers all eight case kinds the issue names, over several categories and sources', () => {
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(40);

    const kinds = new Set(BENCHMARK_CASES.map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual([
      'brand_alias',
      'bundle_accessory',
      'exact_positive',
      'hard_negative',
      'missing_identifier',
      'regional',
      'source_error',
      'variant_only',
    ]);

    expect(new Set(BENCHMARK_CASES.map((entry) => entry.categoryKey)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(BENCHMARK_CASES.map((entry) => entry.sourceKey)).size).toBeGreaterThanOrEqual(4);

    // Both labels must be present, or precision and recall measure one half of
    // the problem: a dataset of positives alone cannot produce a false positive.
    const positives = BENCHMARK_CASES.filter((entry) => entry.expectedVariantId !== null);
    const negatives = BENCHMARK_CASES.filter((entry) => entry.expectedVariantId === null);
    expect(positives.length).toBeGreaterThanOrEqual(15);
    expect(negatives.length).toBeGreaterThanOrEqual(15);

    // Case ids are the handle a failure names; duplicates would hide one.
    expect(new Set(BENCHMARK_CASES.map((entry) => entry.id)).size).toBe(BENCHMARK_CASES.length);
  });

  it('is versioned and content-addressed, and the digest is stable across calls', () => {
    expect(DATASET_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/u);
    const first = datasetChecksum();
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(datasetChecksum()).toBe(first);
  });

  it('meets the precision floor a category gate has to cite, with no false merge', async () => {
    const policy = defaultBenchmarkPolicy();
    const result = await runBenchmark(policy);
    const slice = overall(result);

    // Printed on every run: the numbers a launch decision is made from should
    // not require re-running the suite to read.
    process.stdout.write(`\n${formatBenchmarkReport(result)}\n`);

    const falsePositives = failures(result, 'false_positive');
    expect(
      falsePositives,
      `false merges — the failure this domain exists to prevent:\n${falsePositives.join('\n')}`,
    ).toEqual([]);

    const precision = slicePrecision(slice);
    expect(precision).not.toBeNull();
    expect(precision ?? 0).toBeGreaterThanOrEqual(policy.minBenchmarkPrecision);

    // The sample floor `openCategoryGate` enforces, asserted here too so a
    // dataset that shrank below it fails in the benchmark rather than at the
    // moment somebody tries to open a gate.
    expect(slice.truePositives + slice.falsePositives).toBeGreaterThanOrEqual(
      policy.minBenchmarkSamples,
    );
  });

  it('misses NOTHING it is labelled to match, and names any case that regresses', async () => {
    const result = await runBenchmark(defaultBenchmarkPolicy());
    const slice = overall(result);

    /**
     * The gate is the SET of missed cases, not a recall floor.
     *
     * Measured, by mutation test: a `recall >= 0.6` floor could not see a real
     * regression. Dropping the variant's `pack_count` from the candidate's
     * relation makes the six-pack refuse to match a listing that correctly says
     * "pack de 6" — one false negative out of thirty positives, which leaves
     * recall around 0.97 and the floor green. A floor that cannot see a bug it
     * was written after is not a gate.
     *
     * An empty set is also the honest state to pin: every case here is one
     * somebody labelled, so a case the matcher cannot handle is either a bug to
     * fix or a label to change deliberately — and both should be a red test
     * naming the case, not a decimal drifting under a threshold.
     */
    const missed = failures(result, 'false_negative');
    expect(
      missed,
      `cases the matcher is labelled to match and did not:\n${missed.join('\n')}`,
    ).toEqual([]);
    expect(sliceRecall(slice)).toBe(1);

    // A policy that reviewed EVERYTHING would score precision 1.0. These two are
    // what make the precision gate above mean something: the matcher has to
    // actually match things, and it has to not hand most of the catalogue to a
    // person.
    expect(slice.automaticMatches / slice.totalCases).toBeGreaterThanOrEqual(0.3);
    expect(slice.manualReviews / slice.totalCases).toBeLessThanOrEqual(0.5);
  });

  it('reports per-category and per-source slices, each of them non-vacuous', async () => {
    const result = await runBenchmark(defaultBenchmarkPolicy());
    const categories = result.slices.filter((slice) => slice.sourceKey === '*' && slice.categoryKey !== '*');
    const sources = result.slices.filter((slice) => slice.categoryKey === '*' && slice.sourceKey !== '*');

    expect(categories.length).toBeGreaterThanOrEqual(4);
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const slice of [...categories, ...sources]) {
      expect(slice.totalCases).toBeGreaterThan(0);
      // Every case landed in exactly one confusion cell and one outcome, which
      // is what the two partition CHECKs on `match_benchmark_categories` refuse
      // to store a violation of.
      expect(
        slice.truePositives + slice.falsePositives + slice.falseNegatives + slice.trueNegatives,
      ).toBe(slice.totalCases);
      expect(slice.automaticMatches + slice.manualReviews + slice.createNews).toBe(
        slice.totalCases,
      );
    }
  });

  it('never auto-merges a hard negative, an accessory, a bundle or a source error', async () => {
    const result = await runBenchmark(defaultBenchmarkPolicy());
    const mustNotMerge = new Set(
      BENCHMARK_CASES.filter((entry) => entry.expectedVariantId === null).map((entry) => entry.id),
    );
    const merged = result.cases
      .filter((entry) => mustNotMerge.has(entry.caseId) && entry.predictedVariantId !== null)
      .map((entry) => `${entry.caseId} → ${entry.predictedVariantId ?? ''}`);
    expect(merged, `merged something that must never merge:\n${merged.join('\n')}`).toEqual([]);
  });

  /**
   * The scale pass, opt-in and NOT part of the CI gate.
   *
   * It measures that a bounded retrieval stays bounded, not that the rules are
   * right — and a throughput assertion inside a correctness suite is a flaky test
   * waiting for a loaded runner.
   */
  it('runs against a multiplied catalogue when MATCH_BENCHMARK_SCALE asks for one', async () => {
    const factor = scaleFactor();
    if (factor <= 1) {
      expect(scaledCatalogue(1).products.length).toBeGreaterThan(0);
      return;
    }
    const result = await runBenchmark(defaultBenchmarkPolicy(), {
      catalogue: scaledCatalogue(factor),
    });
    process.stdout.write(`\nscale ×${String(factor)}\n${formatBenchmarkReport(result)}\n`);
    expect(failures(result, 'false_positive')).toEqual([]);
  }, 120_000);
});
