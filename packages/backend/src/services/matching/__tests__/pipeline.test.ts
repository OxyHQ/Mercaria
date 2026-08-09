/**
 * The pipeline's ordered stages, its refusals, and #58 acceptance 6.
 *
 * Every case here runs `evaluateMatch` against the in-memory fixture catalogue —
 * the SAME function production runs — so these are properties of the shipped
 * pipeline rather than of a test double standing in for it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { MatchSubject } from '../subject.js';
import { matchSubjectKey } from '../subject.js';
import { evaluateMatch } from '../pipeline.js';
import { clearSemanticScorer, registerSemanticScorer } from '../semantic.js';
import { InMemoryCandidateSource } from '../benchmark/in-memory-source.js';
import {
  BENCHMARK_CASES,
  FIXTURE_MPNS,
  FIXTURE_PRODUCTS,
  FIXTURE_VARIANTS,
} from '../benchmark/dataset.js';
import { benchmarkSubject, defaultBenchmarkPolicy } from '../benchmark/runner.js';
import { gs1CheckDigit } from '../../canonical/identifiers.js';

function catalogue(overrides: Partial<ConstructorParameters<typeof InMemoryCandidateSource>[0]> = {}) {
  return new InMemoryCandidateSource({
    products: FIXTURE_PRODUCTS,
    variants: FIXTURE_VARIANTS,
    mpns: FIXTURE_MPNS,
    ...overrides,
  });
}

function ean(payload: string): string {
  const payload12 = payload.padStart(12, '0');
  return `${payload12}${String(gs1CheckDigit(payload12))}`;
}

function subject(overrides: Partial<MatchSubject> = {}): MatchSubject {
  return {
    kind: 'source_record',
    key: matchSubjectKey({
      kind: 'source_record',
      sourceId: 'test',
      externalType: 'product',
      externalId: 'sub-1',
    }),
    sourceRecordId: 'rec-1',
    title: 'Apple iPhone 15 Pro 256GB Titanio Negro',
    brandText: 'Apple',
    categoryKey: 'smartphones',
    identifiers: [],
    attributes: [
      { key: 'storage', normalizedValue: '256000000000b', displayValue: '256 GB' },
      { key: 'color', normalizedValue: 'titanio negro', displayValue: 'Titanio Negro' },
    ],
    condition: 'new',
    ...overrides,
  };
}

afterEach(() => {
  clearSemanticScorer();
});

describe('the ordered stages', () => {
  it('stops at the identifier stage when a valid GTIN resolves, with NULL confidence', async () => {
    const result = await evaluateMatch(
      subject({ identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }] }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.decidedStage).toBe('global_identifier');
    expect(result.outcome).toBe('automatic_match');
    expect(result.matchedCanonicalVariantId).toBe('var-iphone15pro-256-black');
    // A deterministic stage records NO number. `match_decisions_confidence_stage_check`
    // refuses one, and a number on an identifier match could only read as doubt
    // about a fact nobody doubted.
    expect(result.confidence).toBeNull();
    expect(result.reasonCodes).toContain('gtin_exact_match');
  });

  it('falls through to title retrieval when no identifier is present', async () => {
    const result = await evaluateMatch(subject(), defaultBenchmarkPolicy(), catalogue());
    expect(['normalized_attributes', 'candidate_retrieval']).toContain(result.decidedStage);
    expect(result.reasonCodes).toContain('no_identifier_present');
    // A heuristic stage records a NUMBER, which is the other half of the CHECK.
    expect(result.confidence).not.toBeNull();
  });

  it('scopes an MPN by brand rather than resolving it globally (ADR 0002 D14)', async () => {
    // The fixture gives ONE MPN to two variants under two different brands, so a
    // lookup that ignored brand would pick whichever id sorted first.
    const meta = await evaluateMatch(
      subject({
        title: 'Quest 3',
        brandText: 'Meta',
        categoryKey: 'vr-headsets',
        identifiers: [{ scheme: 'mpn', rawValue: 'WAU28T64ES' }],
        attributes: [
          { key: 'storage', normalizedValue: '128000000000b', displayValue: '128 GB' },
        ],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(meta.decidedStage).toBe('brand_scoped_identifier');
    expect(meta.matchedCanonicalVariantId).toBe('var-quest3-128');

    const bosch = await evaluateMatch(
      subject({
        title: 'Bosch Serie 6 WAU28T64ES',
        brandText: 'Bosch',
        categoryKey: 'appliances',
        identifiers: [{ scheme: 'mpn', rawValue: 'WAU28T64ES' }],
        attributes: [],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(bosch.decidedStage).toBe('brand_scoped_identifier');
    expect(bosch.matchedCanonicalVariantId).toBe('var-bosch-default');
  });

  it('reuses an existing attachment instead of re-deriving it', async () => {
    const source = catalogue();
    source.findExistingAttachment = (): Promise<{
      canonicalVariantId: string;
      canonicalProductId: string;
    } | null> =>
      Promise.resolve({
        canonicalVariantId: 'var-iphone15pro-512-black',
        canonicalProductId: 'prd-iphone-15-pro',
      });
    const result = await evaluateMatch(subject(), defaultBenchmarkPolicy(), source);
    expect(result.decidedStage).toBe('existing_source_link');
    expect(result.matchedCanonicalVariantId).toBe('var-iphone15pro-512-black');
    expect(result.reasonCodes).toContain('existing_link_reused');
  });
});

describe('the refusals #58 makes structural', () => {
  it('a valid CONFLICTING GTIN blocks the merge and names the identifiers', async () => {
    const result = await evaluateMatch(
      subject({
        identifiers: [
          { scheme: 'ean', rawValue: ean('194253715') },
          { scheme: 'ean', rawValue: ean('194253716') },
        ],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.outcome).toBe('manual_review');
    expect(result.blockers).toContain('conflicting_identifier');
    // The audit array is non-empty EXACTLY when the blocker is present — the
    // invariant `upsertMatchDecision` refuses to store a violation of.
    expect(result.conflictingIdentifiers.length).toBeGreaterThan(0);
  });

  it('an INVALID identifier is not a conflict — it is a typo, and it is dropped', async () => {
    const valid = ean('194253715');
    const broken = `${valid.slice(0, 12)}${String((Number(valid.slice(12)) + 1) % 10)}`;
    const result = await evaluateMatch(
      subject({ identifiers: [{ scheme: 'ean', rawValue: broken }] }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.blockers).not.toContain('conflicting_identifier');
    expect(result.conflictingIdentifiers).toEqual([]);
    // It still matched on the other evidence, which is the point: a mistyped
    // barcode must not poison an otherwise clear listing.
    expect(result.outcome).toBe('automatic_match');
  });

  it('a brand disagreement blocks the merge unless an evidenced alias resolves it', async () => {
    const counterfeit = await evaluateMatch(
      subject({ brandText: 'Goophone' }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(counterfeit.blockers).toContain('brand_mismatch');
    expect(counterfeit.outcome).not.toBe('automatic_match');

    // `facebook technologies` is an ALIAS row on the brand — the evidence.
    const rebranded = await evaluateMatch(
      subject({
        title: 'Quest 3 128GB',
        brandText: 'Facebook Technologies',
        categoryKey: 'vr-headsets',
        attributes: [
          { key: 'storage', normalizedValue: '128000000000b', displayValue: '128 GB' },
        ],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(rebranded.blockers).not.toContain('brand_mismatch');
    expect(rebranded.outcome).toBe('automatic_match');
  });

  it('an accessory never becomes the product whose name it contains', async () => {
    const result = await evaluateMatch(
      subject({
        title: 'Protector de pantalla cristal templado para iPhone 15 Pro',
        brandText: undefined,
        categoryKey: 'phone-accessories',
        attributes: [],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.matchedCanonicalVariantId).not.toBe('var-iphone15pro-256-black');
    expect(result.outcome).not.toBe('automatic_match');
  });

  it('a missing variant axis produces a review, never an invented value', async () => {
    const result = await evaluateMatch(
      subject({
        attributes: [
          { key: 'storage', normalizedValue: '256000000000b', displayValue: '256 GB' },
        ],
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.blockers).toContain('missing_required_attributes');
    expect(result.outcome).not.toBe('automatic_match');
  });

  it('an operator-rejected pair is dropped from the running and never re-proposed', async () => {
    const blockedSubject = subject({
      identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }],
    });
    const source = catalogue({
      blocks: { [blockedSubject.key]: ['var-iphone15pro-256-black'] },
    });
    const result = await evaluateMatch(blockedSubject, defaultBenchmarkPolicy(), source);
    expect(result.matchedCanonicalVariantId).not.toBe('var-iphone15pro-256-black');
  });

  it('a closed category gate blocks a heuristic match and NOT an identifier one', async () => {
    const closed = catalogue({ categoryAutomatic: (): boolean => false });

    const heuristic = await evaluateMatch(subject(), defaultBenchmarkPolicy(), closed);
    expect(heuristic.blockers).toContain('category_gate_closed');
    expect(heuristic.outcome).toBe('manual_review');

    // An identifier match is not this pipeline's JUDGEMENT — it is a check digit
    // and a single active owner — so it has no error rate a benchmark could
    // measure and no gate governs it. Gating it would make a fresh deployment
    // unable to attach a single barcode-bearing listing.
    const deterministic = await evaluateMatch(
      subject({ identifiers: [{ scheme: 'ean', rawValue: ean('194253715') }] }),
      defaultBenchmarkPolicy(),
      closed,
    );
    expect(deterministic.blockers).not.toContain('category_gate_closed');
    expect(deterministic.outcome).toBe('automatic_match');
  });

  it('two indistinguishable candidates go to review together, not to a coin flip', async () => {
    // Two products with the SAME name and the same everything: nothing can
    // separate them, so `minCandidateSeparation` refuses to pick.
    const twins = catalogue({
      products: [
        ...FIXTURE_PRODUCTS,
        {
          productId: 'prd-twin',
          name: 'iPhone 15 Pro',
          brandNames: ['apple'],
          categoryKey: 'smartphones',
          modelCode: 'A2848',
          axes: ['storage', 'color'],
        },
      ],
      variants: [
        ...FIXTURE_VARIANTS,
        {
          variantId: 'var-twin-256-black',
          productId: 'prd-twin',
          name: '256 GB, Titanio Negro',
          attributes: { storage: '256000000000b', color: 'titanio negro' },
        },
      ],
    });
    const result = await evaluateMatch(subject(), defaultBenchmarkPolicy(), twins);
    expect(result.blockers).toContain('ambiguous_candidates');
    expect(result.outcome).toBe('manual_review');
  });

  it('a merchant SKU is recorded and never compared across sources (rule 6)', async () => {
    const result = await evaluateMatch(
      subject({
        title: 'Telefono premium 2024',
        brandText: undefined,
        attributes: [],
        // A SKU that LOOKS exactly like the iPhone's GTIN.
        merchantSku: ean('194253715'),
      }),
      defaultBenchmarkPolicy(),
      catalogue(),
    );
    expect(result.reasonCodes).toContain('sku_scoped_to_source');
    expect(result.matchedCanonicalVariantId).toBeNull();
  });
});

describe('#58 acceptance 6: the deterministic pipeline runs with semantics disabled', () => {
  it('produces IDENTICAL decisions with a scorer registered and with none, since the policy says off', async () => {
    const policy = defaultBenchmarkPolicy();
    const source = catalogue();

    const withoutScorer = [];
    for (const testCase of BENCHMARK_CASES) {
      withoutScorer.push(await evaluateMatch(benchmarkSubject(testCase), policy, source));
    }

    // A scorer that would reorder EVERYTHING if it were ever consulted. The
    // policy's `semanticEnabled` is false and `config.matching.semanticEnabled`
    // is false, so it must never be reached.
    let calls = 0;
    registerSemanticScorer({
      id: 'test-scorer',
      score: (request): Promise<ReadonlyMap<string, number>> => {
        calls += 1;
        return Promise.resolve(new Map([...request.candidates.keys()].map((id) => [id, 1])));
      },
    });

    const withScorer = [];
    for (const testCase of BENCHMARK_CASES) {
      withScorer.push(await evaluateMatch(benchmarkSubject(testCase), policy, source));
    }

    expect(calls, 'a disabled scorer must not be called even once').toBe(0);
    expect(withScorer.map((entry) => entry.outcome)).toEqual(
      withoutScorer.map((entry) => entry.outcome),
    );
    expect(withScorer.map((entry) => entry.matchedCanonicalVariantId)).toEqual(
      withoutScorer.map((entry) => entry.matchedCanonicalVariantId),
    );
    expect(withScorer.map((entry) => entry.decidedStage)).toEqual(
      withoutScorer.map((entry) => entry.decidedStage),
    );

    // The vacuity floor: an empty dataset would satisfy every equality above.
    expect(withoutScorer.length).toBe(BENCHMARK_CASES.length);
    expect(withoutScorer.length).toBeGreaterThan(40);
  });

  it('never reaches a stage past `candidate_retrieval` while semantics are off', async () => {
    const policy = defaultBenchmarkPolicy();
    const source = catalogue();
    for (const testCase of BENCHMARK_CASES) {
      const result = await evaluateMatch(benchmarkSubject(testCase), policy, source);
      expect(result.decidedStage).not.toBe('semantic_assist');
      expect(result.reasonCodes).not.toContain('semantic_reranked');
    }
  });
});
