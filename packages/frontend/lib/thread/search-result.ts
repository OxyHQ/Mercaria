import type { SearchResult } from '@mercaria/shared-types';

/**
 * What a `searchProducts` call returned, read from its structured output
 * (`{ search: { results } }`) and never from anything the model wrote — so a
 * card in the thread can only show something the catalogue actually returned.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ENTITY_KINDS: ReadonlySet<unknown> = new Set([
  'brand',
  'product_family',
  'merchant',
  'storefront',
]);

function isSearchResult(value: unknown): value is SearchResult {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.kind === 'product'
      ? typeof value.canonicalProductId === 'string' && Array.isArray(value.conditionGroups)
      : ENTITY_KINDS.has(value.kind) && typeof value.slug === 'string')
  );
}

/** The results of one `searchProducts` call and the query it searched. */
export function searchOfResult(result: { input?: Record<string, unknown>; output: unknown }): {
  query: string;
  results: SearchResult[];
} {
  const query = typeof result.input?.query === 'string' ? result.input.query.trim() : '';
  const search = isRecord(result.output) ? result.output.search : undefined;
  const results =
    isRecord(search) && Array.isArray(search.results) ? search.results.filter(isSearchResult) : [];
  return { query, results };
}
