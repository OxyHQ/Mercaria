import type { QueryClient } from '@tanstack/react-query';
import type { Listing, PaginatedResponse } from '@mercaria/shared-types';
import type { BulkStatusResult } from './bulk-product-status';
import { queryKeys } from './queryKeys';

export async function publishBulkStatus(client: QueryClient, storeId: string, result: BulkStatusResult, stillAuthorized: () => boolean) {
  if (!stillAuthorized()) return;
  const key = ['stores', storeId, 'products'];
  await client.cancelQueries({ queryKey: key });
  // A session switch can clear the cache while cancellation is awaiting reads.
  if (!stillAuthorized()) return;
  const updated = new Map(result.updated.map(product => [product.id, product]));
  for (const product of result.updated) client.setQueryData(queryKeys.products.detail(storeId, product.id), product);
  // Keep confirmed statuses visible while pagination/filter totals refetch.
  client.setQueriesData<PaginatedResponse<Listing>>({ queryKey: key, predicate: query => typeof query.queryKey[3] === 'object' }, current =>
    current ? { ...current, data: current.data.map(product => updated.get(product.id) ?? product) } : current);
  await client.invalidateQueries({ queryKey: key });
}
