/**
 * The three stored forms of a proposed label (#367 step 6, ADR 0007 D9).
 *
 * The test that matters is the one asserting the two derived forms DISAGREE on a
 * legal-form suffix. They are not the same string with different names: the
 * normalized form decides CONVERGENCE (is this the same request) and folds
 * `Acme Ltd` to `acme`, while the search form decides RETRIEVAL and keeps `acme
 * ltd` — because a trigram index built over the folded space cannot find
 * `Acme Ltd` for somebody typing it.
 */

import { describe, expect, it } from 'vitest';
import { normalizeProposalLabel } from '../normalization.js';
import { proposalConvergenceKey } from '../proposal.service.js';

describe('normalizeProposalLabel', () => {
  it('keeps the source form VERBATIM, trimmed only', () => {
    expect(normalizeProposalLabel('  Verde Bosque  ').source).toBe('Verde Bosque');
  });

  it('folds accents and case in both derived forms', () => {
    const label = normalizeProposalLabel('Café Crème');
    expect(label.normalized).toBe('cafe creme');
    expect(label.search).toBe('cafe creme');
  });

  it('DISAGREES on a legal suffix, which is why there are two forms', () => {
    const label = normalizeProposalLabel('Acme Ltd');
    // Convergence: `Acme Ltd` and `Acme` are the same request.
    expect(label.normalized).toBe('acme');
    // Retrieval: somebody typing `Acme Ltd` must still find it.
    expect(label.search).toBe('acme ltd');
  });

  it('never strips a name that IS a legal form', () => {
    // `normalizeEntityName`'s own rule, inherited rather than re-implemented: if
    // stripping would consume everything, nothing is stripped.
    expect(normalizeProposalLabel('Limited').normalized).toBe('limited');
  });

  it('collapses punctuation in both forms', () => {
    const label = normalizeProposalLabel('USB-C / Thunderbolt 4');
    expect(label.normalized).toBe('usb c thunderbolt 4');
    expect(label.search).toBe('usb c thunderbolt 4');
  });

  it('reports EMPTY derived forms for a label with no letters or digits', () => {
    // The caller refuses such a submission rather than storing a proposal nobody
    // can converge on or find. An empty string here is the signal, not a bug.
    const label = normalizeProposalLabel('—  ***  —');
    expect(label.normalized).toBe('');
    expect(label.search).toBe('');
  });
});

describe('proposalConvergenceKey', () => {
  /**
   * The service key must compose exactly what the GENERATED column composes, or
   * the pre-check answers a different question from the constraint — silently,
   * in the direction where the constraint refuses a submission the scan said was
   * fine.
   *
   * The column is
   * `type || ':' || coalesce(attribute_definition_id,'') || ':' ||
   *  coalesce(category_id,'') || ':' || coalesce(product_type_definition_id,'')
   *  || ':' || normalized_label`, and a real-server case in
   * `catalog-proposals.realdb.test.ts` compares the two against a stored row.
   * These cases pin the SHAPE without a server.
   */
  it('renders absent context as an empty component, never as `null`', () => {
    expect(
      proposalConvergenceKey({
        type: 'brand',
        attributeDefinitionId: null,
        categoryId: null,
        productTypeDefinitionId: null,
        normalizedLabel: 'acme',
      }),
    ).toBe('brand::::acme');
  });

  it('puts every component in the column’s own order', () => {
    expect(
      proposalConvergenceKey({
        type: 'controlled_value',
        attributeDefinitionId: 'attr1',
        categoryId: 'cat1',
        productTypeDefinitionId: 'pt1',
        normalizedLabel: 'verde bosque',
      }),
    ).toBe('controlled_value:attr1:cat1:pt1:verde bosque');
  });

  it('is INJECTIVE without escaping, because only the last component is free text', () => {
    // A separator inside the label cannot shift a component, since nothing
    // follows it. The other four are a closed tuple member and three uuids, none
    // of which can contain a `:`. This is the difference from #63's identity key,
    // whose components were all free text and had to be escaped — and stating it
    // is what stops somebody "simplifying" this into the ambiguous shape.
    const a = proposalConvergenceKey({
      type: 'brand',
      attributeDefinitionId: null,
      categoryId: null,
      productTypeDefinitionId: null,
      normalizedLabel: 'a:b',
    });
    const b = proposalConvergenceKey({
      type: 'brand',
      attributeDefinitionId: null,
      categoryId: null,
      productTypeDefinitionId: null,
      normalizedLabel: 'a',
    });
    expect(a).not.toBe(b);
    expect(a.startsWith('brand::::')).toBe(true);
  });
});
