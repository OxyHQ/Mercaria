import { useQuery } from '@tanstack/react-query';
import type { FacetScope, FacetSelectionEntry } from '@mercaria/shared-types';
import { fetchFacets, type FacetReadResult } from '@/lib/api/facets';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCatalogContext } from './context';
import { serializeFacetSelection } from './facet-selection';

/**
 * The filter rail for one scope (#367 workstream 10).
 *
 * ## Which facets exist is the SERVER's answer, always
 *
 * Nothing here composes, filters, orders or suppresses a facet. The response
 * already carries the ordering the versioned metadata decided, the suppressions
 * with their reasons, the counts at the right grain and the localized labels;
 * re-deciding any of them would be the per-category filter list #367 deletes.
 *
 * ## A 404 is "no rail", never an empty rail
 *
 * `FACETS_ENABLED` defaults off. `enabled` is not conditioned on the flag —
 * the client cannot see it — so the query runs and fails, and consumers read
 * `data === undefined` as "this deployment offers no filters here". They render
 * no rail rather than an empty one: an empty rail says there is nothing to
 * filter by, which is a different and false statement.
 */

/** Two minutes: counts move with the catalogue, and a rail is read repeatedly. */
const FACET_STALE_TIME = 1000 * 60 * 2;

export interface UseFacetsInput {
  readonly scope: FacetScope | undefined;
  readonly selection: readonly FacetSelectionEntry[];
  readonly sort?: { readonly key: string; readonly direction: string };
}

/**
 * The scope, as a cache key.
 *
 * Named fields rather than `JSON.stringify(scope)`: a key built from a
 * serialization depends on property ORDER, and a refactor that moved one field
 * would silently split every cached rail in two.
 */
function scopeKey(scope: FacetScope): string {
  return scope.kind === 'category'
    ? `category:${scope.categoryId}:${scope.includeDescendants === true ? '1' : '0'}`
    : `products:${[...scope.canonicalProductIds].sort().join(',')}`;
}

/**
 * The selection, as a cache key.
 *
 * Reuses the URL serializer rather than composing a second encoding: two
 * spellings of one selection would give the cached rail and the shared link
 * different identities, so a shopper opening their own link would refetch what
 * they were already looking at — or, worse, read a rail cached under a
 * selection that differed only in how it was written down.
 */
function selectionKey(entries: readonly FacetSelectionEntry[]): string {
  return serializeFacetSelection(entries) ?? '';
}

export function useFacets(input: UseFacetsInput): ReturnType<typeof useQuery<FacetReadResult>> {
  const context = useCatalogContext();
  const { scope, selection, sort } = input;

  return useQuery<FacetReadResult>({
    queryKey: queryKeys.catalog.facets(
      scope === undefined ? '' : scopeKey(scope),
      selectionKey(selection),
      context.locale,
      context.currency,
    ),
    enabled: scope !== undefined,
    staleTime: FACET_STALE_TIME,
    retry: false,
    queryFn: () =>
      fetchFacets({
        // `enabled` guarantees a scope, and the non-null branch is written as a
        // throw rather than a `!` so a future caller that removes `enabled` gets
        // a named failure instead of a silent `undefined` on the wire.
        scope: requireScope(scope),
        ...(selection.length === 0 ? {} : { selection }),
        locale: context.locale,
        currency: context.currency,
        ...(sort === undefined ? {} : { sort }),
      }),
  });
}

function requireScope(scope: FacetScope | undefined): FacetScope {
  if (scope === undefined) {
    throw new Error('A facet read needs a scope; the query should have been disabled.');
  }
  return scope;
}
