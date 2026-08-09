/**
 * Constraint evaluation: the four properties the module exists to hold, plus the
 * operator table and the explanation.
 *
 * Pure — no database, no clock. The evaluator takes facts and returns outcomes,
 * which is what lets these cases be exhaustive rather than representative.
 */

import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_EVALUATION_VERSION,
  type AttributeConstraint,
  type CommerceConstraint,
  type ConstraintGroup,
  type HardConstraint,
  type PreferenceConstraint,
  type TaxonomyConstraint,
  type TextPreference,
  type ValidatedConstraintSet,
} from '@mercaria/shared-types';
import {
  evaluateCandidate,
  type CandidateFacts,
  type EvaluableFact,
} from '../constraint-evaluation.js';
import { explainEvaluation } from '../constraint-explanation.js';

const RAM_16GB: EvaluableFact = {
  attributeKey: 'ram_capacity',
  definitionVersion: 1,
  normalizedNumber: 16_000_000_000,
  sourceBacked: true,
};
const SCREEN_355MM: EvaluableFact = {
  attributeKey: 'screen_size',
  definitionVersion: 1,
  normalizedNumber: 355.6,
  sourceBacked: true,
};

function facts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    productId: 'product-1',
    productFacts: [],
    variantFacts: new Map(),
    offerFacts: new Map(),
    ...overrides,
  };
}

function validated(
  hard: readonly HardConstraint[],
  preferences: readonly PreferenceConstraint[] = [],
): ValidatedConstraintSet {
  return {
    hard,
    preferences,
    evaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    definitionVersions: {},
    brand: 'validated-constraint-set',
  };
}

function attributeConstraint(
  overrides: Partial<AttributeConstraint> & Pick<AttributeConstraint, 'predicate'>,
): AttributeConstraint {
  return {
    kind: 'attribute',
    id: overrides.id ?? 'c1',
    scope: overrides.scope ?? 'product',
    explanation: overrides.explanation ?? 'a requirement',
    strength: overrides.strength ?? 'hard',
    missingDataPolicy: overrides.missingDataPolicy ?? 'exclude_when_unknown',
    attributeKey: overrides.attributeKey ?? 'ram_capacity',
    definitionVersion: overrides.definitionVersion ?? 1,
    ...(overrides.axis === undefined ? {} : { axis: overrides.axis }),
    predicate: overrides.predicate,
  };
}

describe('a hard constraint unsatisfied excludes', () => {
  it('and the verdict is derived from the hard outcomes alone', () => {
    const constraint = attributeConstraint({
      predicate: { op: 'gte', value: { type: 'measurement', magnitude: 32, unit: 'GB' } },
    }) as HardConstraint;

    const evaluation = evaluateCandidate(validated([constraint]), facts({ productFacts: [RAM_16GB] }));
    expect(evaluation.verdict).toBe('excluded');
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('failed');

    // And the SAME facts against a satisfiable bound are included, so the
    // exclusion is a property of the comparison and not of the fixture.
    const satisfiable = attributeConstraint({
      predicate: { op: 'gte', value: { type: 'measurement', magnitude: 16, unit: 'GB' } },
    }) as HardConstraint;
    const included = evaluateCandidate(
      validated([satisfiable]),
      facts({ productFacts: [RAM_16GB] }),
    );
    expect(included.verdict).toBe('included');
    expect(included.hardOutcomes[0]?.satisfaction).toBe('satisfied');
  });

  it('never lets a preference change the verdict, however many fail', () => {
    const preference = attributeConstraint({
      id: 'p1',
      strength: 'preference',
      predicate: { op: 'gte', value: { type: 'measurement', magnitude: 64, unit: 'GB' } },
    }) as PreferenceConstraint;

    const evaluation = evaluateCandidate(
      validated([], [preference, { ...preference, id: 'p2' }]),
      facts({ productFacts: [RAM_16GB] }),
    );
    expect(evaluation.verdict).toBe('included');
    expect(evaluation.preferenceScore).toBe(0);
    expect(evaluation.preferenceOutcomes.every((o) => o.satisfaction === 'failed')).toBe(true);
  });
});

describe('missing data', () => {
  it('is `unknown`, and a preference is never reported satisfied on it', () => {
    const preference = attributeConstraint({
      id: 'p1',
      strength: 'preference',
      attributeKey: 'weight',
      predicate: { op: 'lte', value: { type: 'measurement', magnitude: 1.5, unit: 'kg' } },
    }) as PreferenceConstraint;

    const evaluation = evaluateCandidate(validated([], [preference]), facts());
    expect(evaluation.preferenceOutcomes[0]?.satisfaction).toBe('unknown');
    // The score counts SATISFIED only — an unknown contributes nothing, so a
    // catalogue with no data cannot score 1.0 by knowing nothing.
    expect(evaluation.preferenceScore).toBe(0);
    expect(evaluation.verdict).toBe('included');
  });

  it('follows the NAMED policy on a hard constraint, both ways', () => {
    const excluding = attributeConstraint({
      attributeKey: 'weight',
      missingDataPolicy: 'exclude_when_unknown',
      predicate: { op: 'lte', value: { type: 'measurement', magnitude: 1.5, unit: 'kg' } },
    }) as HardConstraint;
    const admitting = { ...excluding, missingDataPolicy: 'admit_and_report_unknown' } as HardConstraint;

    const strict = evaluateCandidate(validated([excluding]), facts());
    expect(strict.verdict).toBe('excluded');
    expect(strict.hardOutcomes[0]?.satisfaction).toBe('failed');
    expect(strict.hardOutcomes[0]?.reason).toContain('exclude_when_unknown');

    const lenient = evaluateCandidate(validated([admitting]), facts());
    expect(lenient.verdict).toBe('included');
    // Admitted, and STILL not satisfied. That distinction is the whole of
    // "cannot quietly downgrade a hard requirement to produce more results".
    expect(lenient.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('variant scope', () => {
  const variantFacts = new Map<string, readonly EvaluableFact[]>([
    [
      'v-256',
      [{ attributeKey: 'storage_capacity', definitionVersion: 1, normalizedNumber: 256e9, sourceBacked: true }],
    ],
    [
      'v-1tb',
      [{ attributeKey: 'storage_capacity', definitionVersion: 1, normalizedNumber: 1e12, sourceBacked: true }],
    ],
  ]);

  const needsTerabyte = attributeConstraint({
    scope: 'variant',
    attributeKey: 'storage_capacity',
    predicate: { op: 'gte', value: { type: 'measurement', magnitude: 1, unit: 'TB' } },
  }) as HardConstraint;

  it("cannot be satisfied by ANOTHER variant's fact (#94 acceptance 4)", () => {
    // Evaluated AS the 256 GB variant, the 1 TB sibling is invisible.
    const asSmall = evaluateCandidate(validated([needsTerabyte]), facts({ variantFacts }), {
      variantId: 'v-256',
    });
    expect(asSmall.verdict).toBe('excluded');
    expect(asSmall.entityId).toBe('v-256');

    const asLarge = evaluateCandidate(validated([needsTerabyte]), facts({ variantFacts }), {
      variantId: 'v-1tb',
    });
    expect(asLarge.verdict).toBe('included');
  });

  it('at PRODUCT scope reports which variants qualified rather than collapsing them', () => {
    const evaluation = evaluateCandidate(validated([needsTerabyte]), facts({ variantFacts }));
    expect(evaluation.verdict).toBe('included');
    expect(evaluation.hardOutcomes[0]?.satisfyingVariantIds).toEqual(['v-1tb']);
  });

  it('answers unknown, not failed, when no variant records the attribute at all', () => {
    const evaluation = evaluateCandidate(
      validated([{ ...needsTerabyte, missingDataPolicy: 'admit_and_report_unknown' }]),
      facts({ variantFacts: new Map([['v-1', []]]) }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('the operator table', () => {
  const cases: readonly [string, AttributeConstraint['predicate'], boolean][] = [
    ['eq matches', { op: 'eq', value: { type: 'measurement', magnitude: 16, unit: 'GB' } }, true],
    ['ne matches', { op: 'ne', value: { type: 'measurement', magnitude: 8, unit: 'GB' } }, true],
    ['gt is strict', { op: 'gt', value: { type: 'measurement', magnitude: 16, unit: 'GB' } }, false],
    ['gte is inclusive', { op: 'gte', value: { type: 'measurement', magnitude: 16, unit: 'GB' } }, true],
    ['lt is strict', { op: 'lt', value: { type: 'measurement', magnitude: 16, unit: 'GB' } }, false],
    ['lte is inclusive', { op: 'lte', value: { type: 'measurement', magnitude: 16, unit: 'GB' } }, true],
    [
      'between, inclusive both ends',
      {
        op: 'between',
        lower: { value: { type: 'measurement', magnitude: 16, unit: 'GB' }, inclusive: true },
        upper: { value: { type: 'measurement', magnitude: 32, unit: 'GB' }, inclusive: true },
      },
      true,
    ],
    [
      'between, EXCLUSIVE lower excludes the endpoint',
      {
        op: 'between',
        lower: { value: { type: 'measurement', magnitude: 16, unit: 'GB' }, inclusive: false },
        upper: { value: { type: 'measurement', magnitude: 32, unit: 'GB' }, inclusive: true },
      },
      false,
    ],
    [
      'in matches a member',
      {
        op: 'in',
        values: [
          { type: 'measurement', magnitude: 8, unit: 'GB' },
          { type: 'measurement', magnitude: 16, unit: 'GB' },
        ],
      },
      true,
    ],
    [
      'not_in excludes a member',
      { op: 'not_in', values: [{ type: 'measurement', magnitude: 16, unit: 'GB' }] },
      false,
    ],
    ['exists', { op: 'exists' }, true],
    ['missing', { op: 'missing' }, false],
  ];

  it.each(cases)('%s', (_name, predicate, expected) => {
    const evaluation = evaluateCandidate(
      validated([attributeConstraint({ predicate }) as HardConstraint]),
      facts({ productFacts: [RAM_16GB] }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe(expected ? 'satisfied' : 'failed');
  });

  it('compares across units, so 16 GB satisfies "at least 16000 MB"', () => {
    const evaluation = evaluateCandidate(
      validated([
        attributeConstraint({
          predicate: { op: 'gte', value: { type: 'measurement', magnitude: 16_000, unit: 'MB' } },
        }) as HardConstraint,
      ]),
      facts({ productFacts: [RAM_16GB] }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('satisfied');
  });

  it('requires EVERY value of a set to clear a negative operator', () => {
    const ports: EvaluableFact[] = [
      { attributeKey: 'ports', definitionVersion: 1, normalizedText: 'usb_c', sourceBacked: true },
      { attributeKey: 'ports', definitionVersion: 1, normalizedText: 'hdmi', sourceBacked: true },
    ];
    // "no HDMI" must NOT be satisfied by a laptop that also has USB-C, which is
    // exactly what a some()-based reading would answer.
    const evaluation = evaluateCandidate(
      validated([
        attributeConstraint({
          attributeKey: 'ports',
          predicate: { op: 'not_in', values: [{ type: 'string', value: 'hdmi' }] },
        }) as HardConstraint,
      ]),
      facts({ productFacts: ports }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('failed');
  });

  it('reads a RANGE fact through the bound that could satisfy the requirement', () => {
    const warranty: EvaluableFact = {
      attributeKey: 'warranty_period',
      definitionVersion: 1,
      normalizedNumber: 31_536_000,
      normalizedNumberMax: 94_608_000,
      rangeLowerInclusive: true,
      rangeUpperInclusive: true,
      sourceBacked: true,
    };
    // "at least two years" is met by a 1–3 year range's upper end…
    const atLeastTwo = evaluateCandidate(
      validated([
        attributeConstraint({
          attributeKey: 'warranty_period',
          predicate: { op: 'gte', value: { type: 'measurement', magnitude: 730, unit: 'd' } },
        }) as HardConstraint,
      ]),
      facts({ productFacts: [warranty] }),
    );
    expect(atLeastTwo.hardOutcomes[0]?.satisfaction).toBe('satisfied');

    // …and "at most six months" is refused through its lower end.
    const atMostSix = evaluateCandidate(
      validated([
        attributeConstraint({
          attributeKey: 'warranty_period',
          predicate: { op: 'lte', value: { type: 'measurement', magnitude: 180, unit: 'd' } },
        }) as HardConstraint,
      ]),
      facts({ productFacts: [warranty] }),
    );
    expect(atMostSix.hardOutcomes[0]?.satisfaction).toBe('failed');
  });

  it('matches a structured component by its AXIS and not by another axis', () => {
    const dimensions: EvaluableFact[] = [
      { attributeKey: 'dimensions', definitionVersion: 1, normalizedNumber: 355.6, componentAxis: 'width', sourceBacked: true },
      { attributeKey: 'dimensions', definitionVersion: 1, normalizedNumber: 16.5, componentAxis: 'depth', sourceBacked: true },
    ];
    const thin = evaluateCandidate(
      validated([
        attributeConstraint({
          attributeKey: 'dimensions',
          axis: 'depth',
          predicate: { op: 'lte', value: { type: 'measurement', magnitude: 20, unit: 'mm' } },
        }) as HardConstraint,
      ]),
      facts({ productFacts: dimensions }),
    );
    expect(thin.hardOutcomes[0]?.satisfaction).toBe('satisfied');

    // The same bound against WIDTH fails — so the axis is genuinely selecting.
    const narrow = evaluateCandidate(
      validated([
        attributeConstraint({
          attributeKey: 'dimensions',
          axis: 'width',
          predicate: { op: 'lte', value: { type: 'measurement', magnitude: 20, unit: 'mm' } },
        }) as HardConstraint,
      ]),
      facts({ productFacts: dimensions }),
    );
    expect(narrow.hardOutcomes[0]?.satisfaction).toBe('failed');
  });
});

describe('bounded OR groups', () => {
  const group = (strength: 'hard' | 'preference'): ConstraintGroup => ({
    kind: 'any_of',
    id: 'g1',
    scope: 'product',
    explanation: 'USB-C or Thunderbolt',
    strength,
    missingDataPolicy: 'exclude_when_unknown',
    members: [
      attributeConstraint({
        id: 'g1a',
        attributeKey: 'ports',
        predicate: { op: 'eq', value: { type: 'string', value: 'usb_c' } },
      }),
      attributeConstraint({
        id: 'g1b',
        attributeKey: 'ports',
        predicate: { op: 'eq', value: { type: 'string', value: 'thunderbolt' } },
      }),
    ],
  });

  it('is satisfied when any member is', () => {
    const evaluation = evaluateCandidate(
      validated([group('hard') as HardConstraint]),
      facts({
        productFacts: [
          { attributeKey: 'ports', definitionVersion: 1, normalizedText: 'usb_c', sourceBacked: true },
        ],
      }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('satisfied');
  });

  it('fails only when EVERY member failed', () => {
    const evaluation = evaluateCandidate(
      validated([group('hard') as HardConstraint]),
      facts({
        productFacts: [
          { attributeKey: 'ports', definitionVersion: 1, normalizedText: 'hdmi', sourceBacked: true },
        ],
      }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('failed');
  });

  it('is UNKNOWN when a member is unknown and none succeeded', () => {
    // One member failed, the other has no data. Collapsing that to `failed`
    // would exclude a product for a fact nobody recorded.
    const mixed: ConstraintGroup = {
      ...group('hard'),
      missingDataPolicy: 'admit_and_report_unknown',
      members: [
        attributeConstraint({
          id: 'g1a',
          attributeKey: 'ports',
          predicate: { op: 'eq', value: { type: 'string', value: 'usb_c' } },
        }),
        attributeConstraint({
          id: 'g1b',
          attributeKey: 'water_resistant',
          predicate: { op: 'is', value: true },
        }),
      ],
    };
    const evaluation = evaluateCandidate(
      validated([mixed as HardConstraint]),
      facts({
        productFacts: [
          { attributeKey: 'ports', definitionVersion: 1, normalizedText: 'hdmi', sourceBacked: true },
        ],
      }),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('commerce constraints read offers and nothing else', () => {
  const underThreeHundred: CommerceConstraint = {
    kind: 'commerce',
    id: 'price',
    scope: 'variant',
    explanation: 'under 300 €',
    strength: 'hard',
    missingDataPolicy: 'exclude_when_unknown',
    predicate: { facet: 'offer_price', op: 'lte', currency: 'EUR', amountMinor: 30_000 },
  };

  it('are UNKNOWN with no offer data, and a static attribute cannot answer them', () => {
    // The candidate carries a `msrp` of 199 € — a real product attribute. It
    // must NOT satisfy an OFFER price constraint (#94 hard-constraint rule 6).
    const withMsrp = facts({
      productFacts: [
        {
          attributeKey: 'msrp',
          definitionVersion: 1,
          normalizedAmountMinor: 19_900,
          sourceBacked: true,
        },
      ],
    });
    const evaluation = evaluateCandidate(
      validated([{ ...underThreeHundred, missingDataPolicy: 'admit_and_report_unknown' } as HardConstraint]),
      withMsrp,
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });

  it('EXCLUDE under the default policy while no offer source is wired', () => {
    const evaluation = evaluateCandidate(validated([underThreeHundred as HardConstraint]), facts());
    expect(evaluation.verdict).toBe('excluded');
  });

  it('are answered from the offer facts once a port supplies them', () => {
    const offerFacts = new Map([
      ['v-1', { lowestPriceMinor: 24_900, currency: 'EUR' as const, availability: ['in_stock'] }],
    ]);
    const evaluation = evaluateCandidate(
      validated([underThreeHundred as HardConstraint]),
      facts({ offerFacts }),
      { variantId: 'v-1' },
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('satisfied');
  });

  it('never converts a price in another currency', () => {
    const offerFacts = new Map([['v-1', { lowestPriceMinor: 24_900, currency: 'USD' as const }]]);
    const evaluation = evaluateCandidate(
      validated([
        { ...underThreeHundred, missingDataPolicy: 'admit_and_report_unknown' } as HardConstraint,
      ]),
      facts({ offerFacts }),
      { variantId: 'v-1' },
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('taxonomy constraints', () => {
  const inElectronics: TaxonomyConstraint = {
    kind: 'taxonomy',
    id: 't1',
    scope: 'product',
    explanation: 'in Electronics',
    strength: 'hard',
    missingDataPolicy: 'exclude_when_unknown',
    subject: 'category',
    op: 'in',
    ids: ['cat-electronics'],
    includeDescendants: true,
  };

  it('match a descendant category only when descendants are included', () => {
    const laptop = facts({ categoryId: 'cat-laptops', categoryAncestorIds: ['cat-electronics'] });
    expect(evaluateCandidate(validated([inElectronics as HardConstraint]), laptop).verdict).toBe(
      'included',
    );

    const exact = { ...inElectronics, includeDescendants: false } as HardConstraint;
    expect(evaluateCandidate(validated([exact]), laptop).verdict).toBe('excluded');
  });

  it('are unknown when the product records no such subject', () => {
    const evaluation = evaluateCandidate(
      validated([
        {
          ...inElectronics,
          subject: 'brand',
          missingDataPolicy: 'admit_and_report_unknown',
        } as HardConstraint,
      ]),
      facts(),
    );
    expect(evaluation.hardOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('a text preference', () => {
  const preference: TextPreference = {
    kind: 'text',
    id: 'txt',
    scope: 'product',
    explanation: 'mentions gaming',
    strength: 'preference',
    query: 'gaming',
    fields: ['name', 'description'],
  };

  it('scores but never excludes', () => {
    const evaluation = evaluateCandidate(
      validated([], [preference as PreferenceConstraint]),
      facts({ text: { name: 'Office laptop', description: 'For spreadsheets' } }),
    );
    expect(evaluation.verdict).toBe('included');
    expect(evaluation.preferenceOutcomes[0]?.satisfaction).toBe('failed');
  });

  it('is unknown, not failed, when there is no text at all', () => {
    const evaluation = evaluateCandidate(validated([], [preference as PreferenceConstraint]), facts());
    expect(evaluation.preferenceOutcomes[0]?.satisfaction).toBe('unknown');
  });
});

describe('the explanation', () => {
  it('separates matched, failed and unknown, and names why a candidate was excluded', () => {
    const hard = attributeConstraint({
      id: 'ram',
      explanation: 'at least 32 GB of memory',
      predicate: { op: 'gte', value: { type: 'measurement', magnitude: 32, unit: 'GB' } },
    }) as HardConstraint;
    const met = attributeConstraint({
      id: 'screen',
      attributeKey: 'screen_size',
      explanation: 'at least 14 inches',
      predicate: { op: 'gte', value: { type: 'measurement', magnitude: 14, unit: 'in' } },
    }) as HardConstraint;
    const unknown = attributeConstraint({
      id: 'weight',
      attributeKey: 'weight',
      explanation: 'under 1.5 kg',
      missingDataPolicy: 'admit_and_report_unknown',
      predicate: { op: 'lte', value: { type: 'measurement', magnitude: 1.5, unit: 'kg' } },
    }) as HardConstraint;

    const evaluation = evaluateCandidate(
      validated([hard, met, unknown]),
      facts({ productFacts: [RAM_16GB, SCREEN_355MM] }),
    );
    const explanation = explainEvaluation(evaluation);

    expect(explanation.included).toBe(false);
    expect(explanation.matched.map((line) => line.constraintId)).toEqual(['screen']);
    expect(explanation.failed.map((line) => line.constraintId)).toEqual(['ram']);
    expect(explanation.unknown.map((line) => line.constraintId)).toEqual(['weight']);
    expect(explanation.summary).toContain('at least 32 GB of memory');
    // Every matched line says whether a recorded observation backs it.
    expect(explanation.matched.every((line) => line.sourceBacked)).toBe(true);
    expect(explanation.unknown.every((line) => line.sourceBacked === false)).toBe(true);
    expect(explanation.evaluationVersion).toBe(CONSTRAINT_EVALUATION_VERSION);
  });

  it('carries no source record, confidence or method anywhere in its output', () => {
    const evaluation = evaluateCandidate(
      validated([
        attributeConstraint({
          predicate: { op: 'exists' },
        }) as HardConstraint,
      ]),
      facts({ productFacts: [RAM_16GB] }),
    );
    const serialized = JSON.stringify(explainEvaluation(evaluation));
    for (const forbidden of ['sourceRecord', 'confidence', 'method', 'normalizationRule=']) {
      expect(serialized.includes(forbidden), `explanation leaked '${forbidden}'`).toBe(false);
    }
  });
});

describe('determinism', () => {
  it('gives the same answer twice over the same inputs', () => {
    const set = validated([
      attributeConstraint({
        predicate: { op: 'gte', value: { type: 'measurement', magnitude: 8, unit: 'GB' } },
      }) as HardConstraint,
    ]);
    const candidate = facts({ productFacts: [RAM_16GB] });
    expect(JSON.stringify(evaluateCandidate(set, candidate))).toBe(
      JSON.stringify(evaluateCandidate(set, candidate)),
    );
  });
});
