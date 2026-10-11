import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { Listing } from '@mercaria/shared-types';
import { publishBulkStatus } from '../bulk-product-status-cache';
import { queryKeys } from '../queryKeys';

it('publishes confirmed DTOs, preserves failed rows/other stores and defeats stale reads', async () => {
  const client = new QueryClient();
  const first = { id: 'first', status: 'draft' } as Listing;
  const failed = { id: 'failed', status: 'draft' } as Listing;
  const saved = { ...first, status: 'active' } as Listing;
  const listKey = queryKeys.products.list('one', 1, '');
  const detailKey = queryKeys.products.detail('one', first.id);
  const otherStore = queryKeys.products.list('two', 1, '');
  const page = { data: [first, failed], pagination: { page: 1, pages: 1, total: 2, limit: 20 } };
  client.setQueryData(listKey, page);
  client.setQueryData(detailKey, first);
  client.setQueryData(otherStore, page);
  let release!: (value: typeof page) => void;
  const older = client
    .fetchQuery({
      queryKey: listKey,
      queryFn: () =>
        new Promise<typeof page>((resolve) => {
          release = resolve;
        }),
    })
    .catch(() => undefined);
  await publishBulkStatus(client, 'one', { updated: [saved], remaining: [] }, () => true);
  release(page);
  await older;
  expect(client.getQueryData(listKey)).toEqual({ ...page, data: [saved, failed] });
  expect(client.getQueryData(detailKey)).toEqual(saved);
  expect(client.getQueryData(otherStore)).toEqual(page);
  client.clear();
});
it('does not repopulate an account cache after identity changes during cancellation', async () => {
  const client = new QueryClient();
  let authorized = true;
  vi.spyOn(client, 'cancelQueries').mockImplementation(async () => {
    authorized = false;
    client.clear();
  });
  await publishBulkStatus(
    client,
    'one',
    { updated: [{ id: 'one', status: 'active' } as Listing], remaining: [] },
    () => authorized,
  );
  expect(client.getQueryCache().getAll()).toEqual([]);
  client.clear();
});
