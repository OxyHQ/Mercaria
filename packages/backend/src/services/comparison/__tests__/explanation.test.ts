/**
 * The explanation adapter, its validator and its deterministic fallback
 * (#96 §"Explanation generation").
 *
 * Two properties carry the whole section, and both are asserted here rather
 * than described:
 *
 *  1. **A draft that adds anything is REJECTED WHOLE**, and the deterministic
 *     table still renders.
 *  2. **The templates would pass the validator**, so the fallback and the
 *     generated path agree on what a grounded sentence is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPARISON_POLICY_VERSION,
  EXPLANATION_SCHEMA_VERSION,
  type ComparisonInput,
  type ExplanationDraft,
  type ExplanationPackage,
} from '@mercaria/shared-types';
import {
  registerExplanationProvider,
  resetExplanationProvider,
  type ExplanationProvider,
} from '../explanation/adapter.port.js';
import { explainComparison } from '../explanation/explanation.service.js';
import { buildExplanationPackage, numericTokens } from '../explanation/package.js';
import { renderTemplateExplanation } from '../explanation/template.js';
import { validateExplanationDraft } from '../explanation/validation.js';
import { buildComparisonTable } from '../table.js';
import { commerce, declared, eur, fact, numberValue, subject } from './fixtures.js';

afterEach(() => {
  resetExplanationProvider();
});

/** A two-product comparison with one differing declared-direction row. */
function sampleInput(): ComparisonInput {
  const table = buildComparisonTable([
    subject('p1', {
      declared: new Map([['warranty_months', declared({ label: 'Warranty' })]]),
      facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(12) })]]),
      commerce: commerce({ lowestItemPrice: eur(29900), lowestKnownTotal: eur(30400) }),
    }),
    subject('p2', {
      declared: new Map([['warranty_months', declared({ label: 'Warranty' })]]),
      facts: new Map([['warranty_months', fact({ key: 'warranty_months', value: numberValue(36) })]]),
      commerce: commerce({ lowestItemPrice: eur(34900), lowestKnownTotal: eur(35400) }),
    }),
  ]);

  return {
    policy: {
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      rankingPolicyVersion: 'test-policy-v1',
      constraintEvaluationVersion: 'ce-1',
      normalizationRuleVersion: 'nr-2',
    },
    evaluatedAt: '2026-08-10T00:00:00.000Z',
    comparisonCurrency: 'EUR',
    conditionGroups: [],
    subjects: [
      {
        ref: 'p1',
        name: 'Alpha',
        acquisition: {
          state: 'purchasable',
          channels: ['external_merchant'],
          leadOfferRef: 'o1',
          eligibleOfferCount: 1,
        },
        offerRefs: ['o1'],
      },
      {
        ref: 'p2',
        name: 'Beta',
        acquisition: { state: 'unavailable', reason: 'no_eligible_offer' },
        offerRefs: [],
      },
    ],
    offers: [
      {
        ref: 'o1',
        subjectRef: 'p1',
        variantRef: 'v1',
        kind: 'external',
        merchantRef: 'm1',
        rank: 1,
        itemPrice: eur(29900),
        deliveryCost: eur(500),
        total: eur(30400),
        taxInclusion: 'inclusive',
        availability: 'in_stock',
        nativeCheckoutEligible: false,
        freshness: 'current',
      },
    ],
    relationships: [],
    priceSignals: [],
    gaps: [],
    table,
    rates: [],
    records: [],
  };
}

describe('the bounded package', () => {
  it('carries no ids, no paths and no hosts', () => {
    const pkg = buildExplanationPackage(sampleInput());
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toContain('recordId');
    expect(serialized).not.toContain('canonicalPath');
    expect(serialized).not.toContain('destinationHost');
    expect(serialized).not.toContain('http');
  });

  it('collects every rendered number into the grounded set', () => {
    const pkg = buildExplanationPackage(sampleInput());
    expect(pkg.groundedValues).toContain('299.00');
    expect(pkg.groundedValues).toContain('12');
    expect(pkg.groundedValues).toContain('36');
    // And a number nobody rendered is not in it.
    expect(pkg.groundedValues).not.toContain('4711');
  });

  it('the citation whitelist holds only refs the package actually shows', () => {
    const pkg = buildExplanationPackage(sampleInput());
    expect(pkg.validRefs).toContain('p1');
    expect(pkg.validRefs).toContain('o1');
    expect(pkg.validRefs).not.toContain('m1');
  });

  it('the numeric extractor finds the tokens a sentence would quote', () => {
    // The mutation self-test for the one regex the whole grounding check rests
    // on: a rotted extractor would find nothing and admit every number.
    expect(numericTokens('299.00 EUR and 12 months')).toEqual(['299.00', '12']);
    expect(numericTokens('no numbers here')).toEqual([]);
    expect(numericTokens('-3 degrees')).toEqual(['-3']);
  });
});

describe('the validator refuses every way a summary stops being one', () => {
  const pkg: ExplanationPackage = buildExplanationPackage(sampleInput());

  function draft(overrides: Partial<ExplanationDraft> = {}): ExplanationDraft {
    return {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      summary: [{ text: 'Alpha costs 299.00 EUR.', citedRefs: ['p1'] }],
      points: [],
      constraintEchoes: [],
      ...overrides,
    };
  }

  it('accepts a grounded draft', () => {
    expect(validateExplanationDraft(pkg, draft()).state).toBe('accepted');
  });

  it('refuses a citation the package does not contain', () => {
    const result = validateExplanationDraft(
      pkg,
      draft({ summary: [{ text: 'Alpha is good.', citedRefs: ['p99'] }] }),
    );
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      expect(result.rejections.map((entry) => entry.reason)).toContain(
        'unknown_record_reference',
      );
    }
  });

  it('refuses an uncited factual sentence rather than dropping it', () => {
    const result = validateExplanationDraft(
      pkg,
      draft({ summary: [{ text: 'Alpha is the better buy.', citedRefs: [] }] }),
    );
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      expect(result.rejections.map((entry) => entry.reason)).toContain('uncited_statement');
    }
  });

  it('refuses a number the package never rendered — the invented-figure case', () => {
    // Benchmark scenario 12: the provider computed a difference nobody stored.
    const result = validateExplanationDraft(
      pkg,
      draft({ summary: [{ text: 'Alpha is 50.00 EUR cheaper.', citedRefs: ['p1'] }] }),
    );
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      const introduced = result.rejections.filter((entry) => entry.reason === 'introduced_number');
      expect(introduced).toHaveLength(1);
      expect(introduced[0].detail).toBe('50.00');
    }
  });

  it('refuses a changed constraint result, by name', () => {
    const withConstraint: ExplanationPackage = {
      ...pkg,
      constraints: [
        {
          constraintRef: 'c1',
          constraintId: 'budget',
          explanation: 'Under 300 EUR',
          outcomes: { p1: 'failed' },
        },
      ],
      validRefs: [...pkg.validRefs, 'c1'],
    };
    const result = validateExplanationDraft(
      withConstraint,
      draft({ constraintEchoes: [{ constraintRef: 'c1', subjectRef: 'p1', satisfaction: 'satisfied' }] }),
    );
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      expect(result.rejections.map((entry) => entry.reason)).toContain(
        'constraint_result_changed',
      );
    }
  });

  it('refuses a forbidden topic the model brought from its own training', () => {
    for (const text of [
      'Alpha pays Mercaria a commission, cited at 299.00 EUR.',
      'This retailer is on a premium merchant plan.',
      'Alpha accepts FAIR.',
    ]) {
      const result = validateExplanationDraft(pkg, draft({ summary: [{ text, citedRefs: ['p1'] }] }));
      expect(result.state, text).toBe('rejected');
      if (result.state === 'rejected') {
        expect(result.rejections.map((entry) => entry.reason)).toContain('forbidden_topic');
      }
    }
  });

  it('refuses a draft declaring the wrong schema version', () => {
    const result = validateExplanationDraft(pkg, draft({ schemaVersion: 'cx-99' }));
    expect(result.state).toBe('rejected');
  });

  it('reports EVERY problem rather than the first', () => {
    const result = validateExplanationDraft(
      pkg,
      draft({ summary: [{ text: 'Alpha saves 77.00 EUR on commission.', citedRefs: ['p42'] }] }),
    );
    expect(result.state).toBe('rejected');
    if (result.state === 'rejected') {
      const reasons = new Set(result.rejections.map((entry) => entry.reason));
      expect(reasons).toContain('unknown_record_reference');
      expect(reasons).toContain('introduced_number');
      expect(reasons).toContain('forbidden_topic');
    }
  });
});

describe('the deterministic templates', () => {
  it('render a summary and every sentence WOULD pass the validator', () => {
    // The property that keeps the two halves in agreement: a change to the
    // validator that broke the templates is a red build rather than a paragraph
    // nobody can explain.
    const pkg = buildExplanationPackage(sampleInput());
    const explanation = renderTemplateExplanation(pkg);
    expect(explanation.state).toBe('template');
    if (explanation.state !== 'template') return;

    const result = validateExplanationDraft(pkg, {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      summary: explanation.summary,
      points: explanation.points,
      constraintEchoes: [],
    });
    expect(result.state, JSON.stringify(explanation.summary)).toBe('accepted');
  });

  it('say which product cannot be bought, and never imply it can', () => {
    const pkg = buildExplanationPackage(sampleInput());
    const explanation = renderTemplateExplanation(pkg);
    if (explanation.state !== 'template') throw new Error('expected the template branch');
    expect(explanation.summary.map((entry) => entry.text).join(' ')).toContain(
      'no offer available right now',
    );
  });

  it('carry provenance with no prompt version, because there is no prompt', () => {
    const explanation = renderTemplateExplanation(buildExplanationPackage(sampleInput()));
    if (explanation.state !== 'template') throw new Error('expected the template branch');
    expect(explanation.provenance.provider).toBe('deterministic_template');
    expect(explanation.provenance.promptVersion).toBe('');
    expect(explanation.provenance.comparisonPolicyVersion).toBe(COMPARISON_POLICY_VERSION);
  });
});

describe('the service composes the deterministic answer first', () => {
  it('with NO provider registered it falls back and says so', async () => {
    const { explanation } = await explainComparison(sampleInput());
    expect(explanation.state).toBe('template');
    if (explanation.state === 'template') {
      expect(explanation.rejections.map((entry) => entry.reason)).toEqual([
        'provider_unavailable',
      ]);
    }
  });

  it('a provider that THROWS still produces the deterministic explanation', async () => {
    const provider: ExplanationProvider = {
      id: 'exploding',
      promptVersion: 'p1',
      async draft() {
        throw new Error('upstream is down');
      },
    };
    registerExplanationProvider(provider);
    const { explanation } = await explainComparison(sampleInput());
    expect(explanation.state).toBe('template');
    if (explanation.state === 'template') {
      expect(explanation.rejections.map((entry) => entry.reason)).toEqual(['provider_error']);
    }
  });

  it('a grounded provider is ACCEPTED and its provenance is recorded', async () => {
    const provider: ExplanationProvider = {
      id: 'test-provider',
      promptVersion: 'prompt-7',
      async draft(pkg) {
        return {
          outcome: 'drafted',
          draft: {
            schemaVersion: EXPLANATION_SCHEMA_VERSION,
            summary: [{ text: 'Alpha is listed at 299.00 EUR.', citedRefs: [pkg.subjects[0].ref] }],
            points: [],
            constraintEchoes: [],
          },
        };
      },
    };
    registerExplanationProvider(provider);
    const { explanation } = await explainComparison(sampleInput());
    expect(explanation.state).toBe('generated');
    if (explanation.state === 'generated') {
      expect(explanation.provenance).toEqual({
        provider: 'test-provider',
        promptVersion: 'prompt-7',
        schemaVersion: EXPLANATION_SCHEMA_VERSION,
        comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
      });
    }
  });

  it('an ungrounded provider is refused WHOLE and the templates render instead', async () => {
    const provider: ExplanationProvider = {
      id: 'inventive',
      promptVersion: 'prompt-7',
      async draft(pkg) {
        return {
          outcome: 'drafted',
          draft: {
            schemaVersion: EXPLANATION_SCHEMA_VERSION,
            summary: [
              // One good sentence…
              { text: 'Alpha is listed at 299.00 EUR.', citedRefs: [pkg.subjects[0].ref] },
              // …and one invented figure. The whole draft goes.
              { text: 'Beta is 41.00 EUR dearer.', citedRefs: [pkg.subjects[1].ref] },
            ],
            points: [],
            constraintEchoes: [],
          },
        };
      },
    };
    registerExplanationProvider(provider);
    const { explanation } = await explainComparison(sampleInput());
    expect(explanation.state).toBe('template');
    if (explanation.state === 'template') {
      expect(explanation.rejections.map((entry) => entry.reason)).toContain('introduced_number');
      // The good sentence is gone too — a partial acceptance would leave an
      // argument resting on a claim that is no longer there.
      expect(explanation.summary.some((entry) => entry.text.includes('41.00'))).toBe(false);
    }
  });
});
