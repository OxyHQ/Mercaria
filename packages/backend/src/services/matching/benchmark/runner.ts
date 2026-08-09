/**
 * The benchmark runner (#58 evaluation).
 *
 * Runs every labelled case through `evaluateMatch` and reports precision,
 * recall, automatic-match coverage and manual-review rate — overall, per
 * category and per source.
 *
 * ## What counts as a POSITIVE prediction, and why review does not
 *
 * A prediction is positive when the outcome is `automatic_match` and it names a
 * variant. `manual_review` and `create_new` are NOT positive predictions, and
 * that is the design rather than a convenience: the matcher's error that matters
 * is a FALSE MERGE, and handing an uncertain case to a person is the correct
 * behaviour, not a near-miss. So a policy that sends everything to review scores
 * precision 1.0 and recall 0.0 — visibly useless rather than invisibly wrong,
 * which is the right way round for a launch gate that favours precision.
 *
 * | | expected a match | expected NO match |
 * |---|---|---|
 * | **predicted the right variant** | true positive | — |
 * | **predicted a variant** | false positive (wrong one) | false positive |
 * | **review or create-new** | false negative | true negative |
 *
 * ## Two numbers this runner cannot give you
 *
 * - **Retrieval recall against a real index.** This runs against an in-memory
 *   catalogue (see `in-memory-source.ts` for exactly what that shares with
 *   production and what it does not). Recall here measures the RULES; recall
 *   against the trigram and `search_tokens` behaviour is what
 *   `matching-writes.realdb.test.ts` exercises end to end.
 * - **Anything about a category the dataset does not cover.** A slice with no
 *   cases reports no numbers at all rather than a vacuous 1.0, and
 *   `openCategoryGate` refuses to open a gate on a slice below the policy's
 *   sample floor — so an uncovered category simply cannot be enabled.
 */

import { config } from '../../../config/index.js';
import { evaluateMatch } from '../pipeline.js';
import type { MatchPolicy } from '../policy.js';
import { matchSubjectKey, type MatchSubject } from '../subject.js';
import { InMemoryCandidateSource, type InMemoryCatalogue } from './in-memory-source.js';
import {
  BENCHMARK_CASES,
  DATASET_VERSION,
  FIXTURE_MPNS,
  FIXTURE_PRODUCTS,
  FIXTURE_VARIANTS,
  datasetChecksum,
  type BenchmarkCase,
} from './dataset.js';

/** The counts one slice measured. Rates are the DATABASE's to derive. */
export interface BenchmarkSlice {
  readonly categoryKey: string;
  readonly sourceKey: string;
  readonly totalCases: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly automaticMatches: number;
  readonly manualReviews: number;
  readonly createNews: number;
}

/** One case's outcome, kept so a failure names the case rather than a number. */
export interface BenchmarkCaseResult {
  readonly caseId: string;
  readonly kind: BenchmarkCase['kind'];
  readonly expectedVariantId: string | null;
  readonly predictedVariantId: string | null;
  readonly outcome: string;
  readonly decidedStage: string;
  readonly confidence: number | null;
  readonly blockers: readonly string[];
  readonly verdict: 'true_positive' | 'false_positive' | 'false_negative' | 'true_negative';
}

export interface BenchmarkResult {
  readonly datasetVersion: string;
  readonly datasetChecksum: string;
  readonly totalCases: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
  /** The `'*'`/`'*'` slice plus one per category and one per source. */
  readonly slices: readonly BenchmarkSlice[];
  readonly cases: readonly BenchmarkCaseResult[];
}

/** Turn one labelled case into the subject the pipeline evaluates. */
export function benchmarkSubject(testCase: BenchmarkCase): MatchSubject {
  return {
    kind: 'source_record',
    key: matchSubjectKey({
      kind: 'source_record',
      sourceId: testCase.sourceKey,
      externalType: 'product',
      externalId: testCase.id,
    }),
    sourceRecordId: testCase.id,
    title: testCase.title,
    ...(testCase.variantText === undefined ? {} : { variantText: testCase.variantText }),
    ...(testCase.brandText === undefined ? {} : { brandText: testCase.brandText }),
    ...(testCase.modelText === undefined ? {} : { modelText: testCase.modelText }),
    categoryKey: testCase.categoryKey,
    identifiers: testCase.identifiers ?? [],
    ...(testCase.merchantSku === undefined ? {} : { merchantSku: testCase.merchantSku }),
    attributes: testCase.attributes ?? [],
    condition: testCase.condition ?? 'new',
  };
}

/** The default fixture catalogue. */
export function benchmarkCatalogue(): InMemoryCatalogue {
  return { products: FIXTURE_PRODUCTS, variants: FIXTURE_VARIANTS, mpns: FIXTURE_MPNS };
}

interface Tally {
  totalCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  automaticMatches: number;
  manualReviews: number;
  createNews: number;
}

function emptyTally(): Tally {
  return {
    totalCases: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
    automaticMatches: 0,
    manualReviews: 0,
    createNews: 0,
  };
}

/**
 * Run the dataset against a policy.
 *
 * @param cases Defaults to the whole labelled dataset. Passing a subset is how
 *   a mutation test isolates the case a change is supposed to move.
 */
export async function runBenchmark(
  policy: MatchPolicy,
  options: {
    readonly cases?: readonly BenchmarkCase[];
    readonly catalogue?: InMemoryCatalogue;
  } = {},
): Promise<BenchmarkResult> {
  const cases = options.cases ?? BENCHMARK_CASES;
  const source = new InMemoryCandidateSource(options.catalogue ?? benchmarkCatalogue());
  const startedAt = new Date();

  const results: BenchmarkCaseResult[] = [];
  /**
   * Slices, keyed by the PAIR rather than by a joined string.
   *
   * The first draft joined `category` and `source` into one key and split it
   * back apart to build the report — which needs a separator that can appear in
   * neither, and quietly turned the source file BINARY when the separator chosen
   * was a control character. Carrying the two parts in the VALUE removes the
   * question: nothing is joined, so nothing has to be split, and no separator has
   * to be safe.
   */
  const tallies = new Map<string, { categoryKey: string; sourceKey: string; tally: Tally }>();
  const bump = (
    categoryKey: string,
    sourceKey: string,
    apply: (tally: Tally) => void,
  ): void => {
    const key = JSON.stringify([categoryKey, sourceKey]);
    const entry = tallies.get(key) ?? { categoryKey, sourceKey, tally: emptyTally() };
    apply(entry.tally);
    tallies.set(key, entry);
  };

  for (const testCase of cases) {
    const evaluation = await evaluateMatch(benchmarkSubject(testCase), policy, source);
    const predicted =
      evaluation.outcome === 'automatic_match' ? evaluation.matchedCanonicalVariantId : null;

    const verdict: BenchmarkCaseResult['verdict'] =
      predicted === null
        ? testCase.expectedVariantId === null
          ? 'true_negative'
          : 'false_negative'
        : predicted === testCase.expectedVariantId
          ? 'true_positive'
          : 'false_positive';

    results.push({
      caseId: testCase.id,
      kind: testCase.kind,
      expectedVariantId: testCase.expectedVariantId,
      predictedVariantId: predicted,
      outcome: evaluation.outcome,
      decidedStage: evaluation.decidedStage,
      confidence: evaluation.confidence,
      blockers: evaluation.blockers,
      verdict,
    });

    // Three slices per case: the whole run, the category, the source. Written as
    // three keys into one map rather than three passes, so a case can never be
    // counted in one slice and missed in another.
    const slicesForCase: readonly (readonly [string, string])[] = [
      ['*', '*'],
      [testCase.categoryKey, '*'],
      ['*', testCase.sourceKey],
    ];
    for (const [categoryKey, sourceKey] of slicesForCase) {
      bump(categoryKey, sourceKey, (tally) => {
        tally.totalCases += 1;
        if (verdict === 'true_positive') tally.truePositives += 1;
        if (verdict === 'false_positive') tally.falsePositives += 1;
        if (verdict === 'false_negative') tally.falseNegatives += 1;
        if (verdict === 'true_negative') tally.trueNegatives += 1;
        if (evaluation.outcome === 'automatic_match') tally.automaticMatches += 1;
        if (evaluation.outcome === 'manual_review') tally.manualReviews += 1;
        if (evaluation.outcome === 'create_new') tally.createNews += 1;
      });
    }
  }

  const slices: BenchmarkSlice[] = [...tallies.values()]
    .map((entry) => ({
      categoryKey: entry.categoryKey,
      sourceKey: entry.sourceKey,
      ...entry.tally,
    }))
    .sort((left, right) =>
      left.categoryKey === right.categoryKey
        ? left.sourceKey.localeCompare(right.sourceKey)
        : left.categoryKey.localeCompare(right.categoryKey),
    );

  return {
    datasetVersion: DATASET_VERSION,
    datasetChecksum: datasetChecksum(),
    totalCases: cases.length,
    startedAt,
    completedAt: new Date(),
    slices,
    cases: results,
  };
}

/** Precision for one slice, or `null` when nothing was predicted positive. */
export function slicePrecision(slice: BenchmarkSlice): number | null {
  const predicted = slice.truePositives + slice.falsePositives;
  return predicted === 0 ? null : slice.truePositives / predicted;
}

/** Recall for one slice, or `null` when the slice has no positive cases. */
export function sliceRecall(slice: BenchmarkSlice): number | null {
  const actual = slice.truePositives + slice.falseNegatives;
  return actual === 0 ? null : slice.truePositives / actual;
}

/**
 * A human-readable report, printed by the CI test and by the operator script.
 *
 * Rates are shown as `n/a` rather than `0.0000` when their denominator is zero —
 * "nothing was predicted positive" and "everything predicted was wrong" are the
 * two facts a launch decision most needs to tell apart.
 */
export function formatBenchmarkReport(result: BenchmarkResult): string {
  const rate = (value: number | null): string => (value === null ? '   n/a' : value.toFixed(4));
  const lines: string[] = [
    `dataset ${result.datasetVersion} (${result.datasetChecksum.slice(0, 12)}…) — ${String(result.totalCases)} cases`,
    'category            source        n   prec    rec    auto  review',
  ];
  for (const slice of result.slices) {
    const auto = slice.totalCases === 0 ? null : slice.automaticMatches / slice.totalCases;
    const review = slice.totalCases === 0 ? null : slice.manualReviews / slice.totalCases;
    lines.push(
      [
        slice.categoryKey.padEnd(19),
        slice.sourceKey.padEnd(13),
        String(slice.totalCases).padStart(3),
        rate(slicePrecision(slice)),
        rate(sliceRecall(slice)),
        rate(auto),
        rate(review),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

/**
 * The scale pass, opt-in.
 *
 * `MATCH_BENCHMARK_SCALE=<n>` multiplies the fixture catalogue by `n` — each
 * copy carrying distinct ids and distinct GTINs — so the retrieval bound and the
 * scoring cost are exercised against a catalogue a person could not read, while
 * the CI pass keeps running against one they can. Deliberately NOT in CI: it
 * measures throughput, and a throughput number in a correctness gate is a flaky
 * test waiting for a loaded runner.
 */
export function scaleFactor(): number {
  const raw = process.env.MATCH_BENCHMARK_SCALE;
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

/** Multiply the fixture catalogue, keeping ids and identifiers distinct per copy. */
export function scaledCatalogue(factor: number): InMemoryCatalogue {
  if (factor <= 1) return benchmarkCatalogue();
  const products = [...FIXTURE_PRODUCTS];
  const variants = [...FIXTURE_VARIANTS];
  for (let copy = 1; copy < factor; copy += 1) {
    for (const product of FIXTURE_PRODUCTS) {
      products.push({
        ...product,
        productId: `${product.productId}#${String(copy)}`,
        name: `${product.name} Edicion ${String(copy)}`,
      });
    }
    for (const variant of FIXTURE_VARIANTS) {
      variants.push({
        ...variant,
        variantId: `${variant.variantId}#${String(copy)}`,
        productId: `${variant.productId}#${String(copy)}`,
        // Distinct GTINs per copy: reusing them would make every copy contest
        // the same identifier and measure the dispute path instead of retrieval.
        gtins: (variant.gtins ?? []).map((gtin) => `${String(copy)}${gtin.slice(1)}`),
      });
    }
  }
  return { products, variants, mpns: FIXTURE_MPNS };
}

/** The policy the CI benchmark measures. Exported so a test can perturb it. */
export function defaultBenchmarkPolicy(): MatchPolicy {
  return {
    id: 'benchmark-policy',
    versionKey: 'benchmark',
    autoMinConfidence: 0.9,
    reviewMinConfidence: 0.55,
    minCandidateSeparation: 0.05,
    maxCandidates: 25,
    minTitleSimilarity: 0.2,
    weights: {
      identifierAgreement: 6,
      brandAgreement: 3,
      modelAgreement: 2,
      attributeAgreement: 4,
      titleSimilarity: 1,
      categoryAgreement: 2,
      semanticSimilarity: 0,
    },
    // The default is OFF, and `config.matching.semanticEnabled` is off too — so
    // the CI benchmark measures the deterministic pipeline, which is the one a
    // default deployment runs (#58 acceptance 6).
    semanticEnabled: config.matching.semanticEnabled,
    minBenchmarkPrecision: 0.95,
    minBenchmarkSamples: 20,
  };
}
