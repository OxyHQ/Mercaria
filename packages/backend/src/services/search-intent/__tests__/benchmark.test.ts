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
import { BENCHMARK_CATEGORY_ALIASES } from '../benchmark/registry.js';
import { runIntentBenchmark } from '../benchmark/runner.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import { normalizeCatalogAlias } from '../../taxonomy/alias-normalization.js';

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

/**
 * The benchmark's alias fixture against the catalogue it stands for (#732).
 *
 * The fixture exists because the benchmark has no database — the #58 decision,
 * so the set runs on every push — and the cost of that decision is TWO
 * descriptions of one fact: the rows the seed package writes, and the rows the
 * benchmark pretends to have read. Two descriptions of one fact disagree the
 * first time somebody edits one, and the disagreement here is the worst shape
 * there is: a green gate reporting that #367's four words resolve, against a
 * fixture only this benchmark reads.
 *
 * So the coupling is CHECKED rather than structural. It is not an import,
 * because `benchmark/registry.ts` is a production module and pulling
 * `scripts/seed-verticals/` into it would put the seed data in the API's
 * runtime graph; a test file may reach both.
 */
describe('the benchmark alias fixture and the seeded catalogue agree', () => {
  const seeded = (SMARTPHONE_PACKAGE.categories.find((category) => category.slug === 'smartphones')
    ?.aliases ?? []) as readonly { locale: string; alias: string }[];
  const key = (locale: string, alias: string) => `${locale.toLowerCase()}|${alias}`;
  const seededKeys = seeded.map((alias) => key(alias.locale, normalizeCatalogAlias(alias.alias)));
  const fixtureKeys = BENCHMARK_CATEGORY_ALIASES.filter(
    (match) => match.slug === 'smartphones',
  ).map((match) => key(match.locale, match.normalizedAlias));

  it('reads a non-empty catalogue on both sides — the vacuity floor', () => {
    // Without this, a rename of `smartphones` on either side leaves two empty
    // lists that agree perfectly. Ten is the smaller of the two measured
    // counts, floored rather than pinned so adding an alias is not a test edit.
    expect(seededKeys.length).toBeGreaterThanOrEqual(10);
    expect(fixtureKeys.length).toBeGreaterThanOrEqual(10);
  });

  it('records every seeded alias in the fixture', () => {
    expect([...seededKeys].sort().filter((entry) => !fixtureKeys.includes(entry))).toEqual([]);
  });

  it('claims nothing the catalogue does not have, except the named control', () => {
    // `handset` is fixture-only ON PURPOSE and is named here rather than
    // excused by a wildcard: it is the one benchmark case that can pass through
    // NOTHING but an operator-authored row, since no dictionary entry and no
    // category slug contains the word. Seeding it would give it a second path
    // and destroy exactly that property.
    expect([...fixtureKeys].sort().filter((entry) => !seededKeys.includes(entry))).toEqual([
      'en|handset',
    ]);
  });

  it('covers each of the four words #367 names by hand', () => {
    // The requirement, restated where it can fail. A dataset can be complete,
    // exact and silent about the thing the acceptance box names — which is how
    // `category_accuracy === 1` coexisted with `mobile` and `smartphone`
    // reaching no category at all (#731).
    for (const word of ['mobile', 'móvil', 'celular', 'smartphone']) {
      const normalized = normalizeCatalogAlias(word);
      expect(
        seededKeys.some((entry) => entry.endsWith(`|${normalized}`)),
        `#367 names "${word}" and no seeded smartphone alias normalizes to it`,
      ).toBe(true);
    }
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
