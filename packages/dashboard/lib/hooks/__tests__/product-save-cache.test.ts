import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Listing } from '@mercaria/shared-types';
import {
  useCreateVariant,
  useDeleteVariant,
  useUpdateProduct,
  useUpdateVariant,
} from '../use-products';
import { queryKeys } from '../../queryKeys';

// Only hook registration is captured; reads, cancellation and cache writes use
// the real TanStack implementation, including unmounted/disabled observers.
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useMutation: vi.fn(() => ({})),
  useQueryClient: vi.fn(),
}));
vi.mock('../../api/products', () => ({}));
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});

const cases = [
  ['update product', useUpdateProduct],
  ['create variant', useCreateVariant],
  ['update variant', useUpdateVariant],
  ['delete variant', useDeleteVariant],
] as const;
for (const mounted of [false, true]) {
  it.each(cases)(
    '%s preserves its confirmed DTO after an old detail read (mounted=' + mounted + ')',
    async (_name, hook) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const key = queryKeys.products.detail('store-a', 'product');
      const otherKey = queryKeys.products.detail('store-b', 'product');
      const old = {
        id: 'product',
        title: 'Before',
        variants: [{ id: 'removed-variant' }, { id: 'retained-variant' }],
      } as Listing;
      const saved = { ...old, title: 'Confirmed', variants: [old.variants[1]] };
      client.setQueryData(key, old);
      client.setQueryData(otherKey, old);
      let release!: () => void;
      let releaseOther!: () => void;
      const pending = client
        .fetchQuery({
          queryKey: key,
          queryFn: () =>
            new Promise<Listing>((resolve) => {
              release = () => resolve(old);
            }),
        })
        .catch(() => undefined);
      const unrelated = client
        .fetchQuery({
          queryKey: otherKey,
          queryFn: () =>
            new Promise<Listing>((resolve) => {
              releaseOther = () => resolve(old);
            }),
        })
        .catch(() => undefined);
      const observer = mounted
        ? new QueryObserver(client, { queryKey: key, queryFn: async () => old, enabled: false })
        : undefined;
      const unsubscribe = observer?.subscribe(() => {});
      try {
        vi.mocked(useQueryClient).mockReturnValue(client);
        hook('store-a', 'product');
        const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
          onSuccess: (product: Listing) => Promise<void>;
        };
        await options.onSuccess(saved);
        expect(client.getQueryData(key)).toEqual(saved);
        expect(client.isFetching({ queryKey: otherKey, exact: true })).toBe(1);
        release();
        releaseOther();
        await Promise.all([pending, unrelated]);
        expect(client.getQueryData(key)).toEqual(saved);
        expect(client.getQueryData(otherKey)).toEqual(old);
      } finally {
        unsubscribe?.();
        observer?.destroy();
      }
    },
  );
}
