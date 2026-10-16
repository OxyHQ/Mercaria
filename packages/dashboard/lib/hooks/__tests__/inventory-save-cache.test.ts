import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InventoryLevelDTO } from '@mercaria/shared-types';
import { useSetVariantLevelInventory } from '../use-products';
import { queryKeys } from '../../queryKeys';

// Capture actual hook callbacks while exercising TanStack's real cache lifecycle.
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

it.each([false, true])(
  'confirmed inventory survives an older read while the panel is inactive (mounted=%s)',
  async (mounted) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const key = queryKeys.products.levels('store-a', 'product', 'variant');
    const otherKey = queryKeys.products.levels('store-b', 'product', 'variant');
    const old: InventoryLevelDTO[] = [
      { locationId: 'front', locationName: 'Front', available: 7 },
      { locationId: 'back', locationName: 'Back', available: 5 },
    ];
    const saved = [{ ...old[0], available: 3 }, old[1]];
    client.setQueryData(key, old);
    client.setQueryData(otherKey, old);
    let release!: () => void;
    let releaseOther!: () => void;
    const pending = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<InventoryLevelDTO[]>((resolve) => {
            release = () => resolve(old);
          }),
      })
      .catch(() => undefined);
    const unrelated = client
      .fetchQuery({
        queryKey: otherKey,
        queryFn: () =>
          new Promise<InventoryLevelDTO[]>((resolve) => {
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
      // biome-ignore lint/correctness/useHookAtTopLevel: React Query hooks are mocked here to capture the mutation options
      useSetVariantLevelInventory('store-a', 'product');
      const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
        onSuccess: (
          levels: InventoryLevelDTO[],
          variables: { variantId: string; locationId: string; available: number },
        ) => Promise<void>;
      };
      await options.onSuccess(saved, { variantId: 'variant', locationId: 'front', available: 3 });
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
