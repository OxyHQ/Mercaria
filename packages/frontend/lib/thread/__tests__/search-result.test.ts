import { describe, expect, it } from 'vitest';
import { searchOfResult } from '../search-result';

const product = {
  kind: 'product',
  canonicalProductId: 'p-1',
  slug: 'linen-shirt',
  name: 'Linen shirt',
  conditionGroups: ['new'],
  matchStages: ['lexical'],
  relevance: 0.4,
};
const brand = { kind: 'brand', brandId: 'b-1', slug: 'acme', name: 'Acme' };

describe('searchOfResult', () => {
  it("reads the catalogue's results and the query from the tool's own output", () => {
    expect(
      searchOfResult({
        input: { query: '  linen ' },
        output: { search: { results: [product, brand], truncated: false } },
      }),
    ).toEqual({ query: 'linen', results: [product, brand] });
  });

  it('drops anything that is not a search result rather than drawing it', () => {
    const { results } = searchOfResult({
      input: { query: 'linen' },
      output: {
        search: {
          results: [
            product,
            { kind: 'product', name: 'No id', conditionGroups: [] },
            { kind: 'listing', slug: 'x', name: 'Unknown kind' },
            'Linen shirt',
            null,
          ],
        },
      },
    });
    expect(results).toEqual([product]);
  });

  it('draws nothing for an output that is not a search', () => {
    expect(searchOfResult({ output: 'Found three shirts' })).toEqual({ query: '', results: [] });
    expect(searchOfResult({ input: { query: 3 }, output: { search: {} } })).toEqual({
      query: '',
      results: [],
    });
  });
});
