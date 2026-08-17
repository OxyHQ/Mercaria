import type {
  ApiResponse,
  CurrencyCode,
  FacetResponse,
  FacetScope,
  FacetSelectionEntry,
  FacetSortDirective,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * `POST /facets` — the filter rail, generated from the registry (#367 step 8).
 *
 * A POST because the selection is a nested structure a query string can only
 * carry by inventing a second grammar for the one `FacetSelectionEntry` already
 * defines. It is still a read: nothing here writes.
 *
 * ## The body carries stable KEYS and never a translated word
 *
 * Every `facetKey` and every bucket `key` in a request is the server's own
 * stable identifier, echoed back from a previous response. `FacetLabel.text` is
 * display and travels in the opposite direction only. That is #367's "use
 * stable IDs/keys in URLs/state; translated text is display only" as a property
 * of the request type: {@link FacetSelectionEntry} has no label field to put
 * one in.
 *
 * ## `FACETS_ENABLED` defaults off, and a 404 is a rail that is not offered
 *
 * The caller renders no filters rather than an empty rail with a spinner. A
 * filter set composed on the client to fill the gap would be exactly the
 * per-category hard-coded list #367 exists to delete.
 */
export interface FacetRequestInput {
  readonly scope: FacetScope;
  readonly selection?: readonly FacetSelectionEntry[];
  readonly locale?: string;
  readonly currency?: CurrencyCode;
  readonly sort?: { readonly key: string; readonly direction: string };
}

/** The wire answer, plus the sort the server actually resolved. */
export type FacetReadResult = FacetResponse & { readonly sort?: FacetSortDirective };

export async function fetchFacets(input: FacetRequestInput): Promise<FacetReadResult> {
  const { data } = await apiClient.post<ApiResponse<FacetReadResult>>('/facets', input);
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load filters');
  }
  return data.data;
}
