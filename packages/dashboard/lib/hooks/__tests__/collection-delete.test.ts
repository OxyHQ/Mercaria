import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Collection } from '@mercaria/shared-types';
import { useDeleteCollection } from '../use-collections';
import { queryKeys } from '../../queryKeys';

// Capture production mutation options; cache and pending queries below are real.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: vi.fn(() => ({})),
  useQueryClient: vi.fn(),
}));
vi.mock('../../api/collections', () => ({}));
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});

it('a confirmed collection deletion defeats older reads without touching another store or collection', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const removed = { id: 'removed' } as Collection;
  const kept = { id: 'kept' } as Collection;
  const listKey = queryKeys.collections.list('store-a');
  const detailKey = queryKeys.collections.detail('store-a', removed.id);
  const keptKey = queryKeys.collections.detail('store-a', kept.id);
  const otherList = queryKeys.collections.list('store-b');
  const otherDetail = queryKeys.collections.detail('store-b', removed.id);
  client.setQueryData(listKey, [removed, kept]);
  client.setQueryData(detailKey, removed);
  client.setQueryData(keptKey, kept);
  client.setQueryData(otherList, [removed]);
  client.setQueryData(otherDetail, removed);
  let releaseList!: (data: Collection[]) => void;
  let releaseDetail!: (data: Collection) => void;
  const oldList = client
    .fetchQuery({
      queryKey: listKey,
      queryFn: () =>
        new Promise<Collection[]>((resolve) => {
          releaseList = resolve;
        }),
    })
    .catch(() => undefined);
  const oldDetail = client
    .fetchQuery({
      queryKey: detailKey,
      queryFn: () =>
        new Promise<Collection>((resolve) => {
          releaseDetail = resolve;
        }),
    })
    .catch(() => undefined);
  expect(client.isFetching()).toBe(2);
  vi.mocked(useQueryClient).mockReturnValue(client);
  useDeleteCollection('store-a');
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
    onSuccess: (result: { id: string; deleted: boolean }, id: string) => Promise<void>;
  };
  await options.onSuccess({ id: removed.id, deleted: true }, removed.id);
  releaseList([removed, kept]);
  releaseDetail(removed);
  await Promise.all([oldList, oldDetail]);
  expect(client.getQueryData(listKey)).toEqual([kept]);
  expect(client.getQueryData(detailKey)).toBeUndefined();
  expect(client.getQueryData(keptKey)).toEqual(kept);
  expect(client.getQueryData(otherList)).toEqual([removed]);
  expect(client.getQueryData(otherDetail)).toEqual(removed);
});
