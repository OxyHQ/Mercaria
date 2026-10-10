import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Collection } from '@mercaria/shared-types';
import { useSetCollectionProducts, useUpdateCollection } from '../use-collections';
import { queryKeys } from '../../queryKeys';

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useMutation: vi.fn(() => ({})), useQueryClient: vi.fn(),
}));
vi.mock('../../api/collections', () => ({}));
const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.clearAllMocks(); });

it.each(['metadata', 'products'])('the %s response replaces only its collection and defeats older reads', async mode => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const original = { id: 'collection', productIds: ['first'] } as Collection;
  const saved = { ...original, productIds: ['second', 'first'] };
  const other = { id: 'other', productIds: [] } as unknown as Collection;
  const listKey = queryKeys.collections.list('store-a');
  const detailKey = queryKeys.collections.detail('store-a', original.id);
  const otherStore = queryKeys.collections.list('store-b');
  client.setQueryData(listKey, [original, other]); client.setQueryData(detailKey, original); client.setQueryData(otherStore, [original]);
  let releaseList!: (data: Collection[]) => void; let releaseDetail!: (data: Collection) => void;
  const oldList = client.fetchQuery({ queryKey: listKey, queryFn: () => new Promise<Collection[]>(resolve => { releaseList = resolve; }) }).catch(() => undefined);
  const oldDetail = client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise<Collection>(resolve => { releaseDetail = resolve; }) }).catch(() => undefined);
  vi.mocked(useQueryClient).mockReturnValue(client);
  if (mode === 'metadata') useUpdateCollection('store-a', original.id);
  else useSetCollectionProducts('store-a', original.id);
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as { onSuccess: (data: Collection) => Promise<void> };
  await options.onSuccess(saved); releaseList([original, other]); releaseDetail(original); await Promise.all([oldList, oldDetail]);
  expect(client.getQueryData(detailKey)).toEqual(saved); expect(client.getQueryData(listKey)).toEqual([saved, other]);
  expect(client.getQueryData(otherStore)).toEqual([original]);
});
