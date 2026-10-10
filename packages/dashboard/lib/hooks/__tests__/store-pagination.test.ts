import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, useQuery, type QueryObserverOptions } from '@tanstack/react-query';
import { useProducts } from '../use-products';
import { useOrders } from '../use-orders';
import { useCustomers } from '../use-customers';

// Capture the hooks' production options, then exercise them with the real query
// observer. No React Native renderer or alternate Metro module graph is needed.
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: vi.fn(() => ({})),
}));
vi.mock('../../api/products', () => ({}));
vi.mock('../../api/orders', () => ({}));
vi.mock('../../api/customers', () => ({}));

const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach(client => client.clear());
  vi.clearAllMocks();
});

/* eslint-disable react-hooks/rules-of-hooks -- useQuery is mocked above to capture options; these calls invoke no React hooks. */
const hooks = [
  { name: 'products', read: (store: string, page: number) => useProducts(store, page, '') },
  { name: 'orders', read: (store: string, page: number) => useOrders(store, page, 'all') },
  { name: 'customers', read: (store: string, page: number) => useCustomers(store, page, '') },
];
/* eslint-enable react-hooks/rules-of-hooks */

describe.each(hooks)('$name pagination', ({ read }) => {
  it('retains the same store while paging, clears on store change, and ignores late prior-store responses', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    const options = (store: string, page: number): QueryObserverOptions => {
      read(store, page);
      const captured = vi.mocked(useQuery).mock.calls.at(-1)?.[0];
      if (!captured) throw new Error('The hook did not configure a query');
      return captured as QueryObserverOptions;
    };
    const firstPage = { rows: [{ id: 'store-a-row-1' }] };
    const secondPage = { rows: [{ id: 'store-a-row-2' }] };
    const otherStore = { rows: [{ id: 'store-b-row-1' }] };
    const firstOptions = options('store-a', 1);
    client.setQueryData(firstOptions.queryKey, firstPage);
    const observer = new QueryObserver(client, firstOptions);
    const unsubscribe = observer.subscribe(() => undefined);
    let resolvePage!: (value: unknown) => void;
    let resolveStore!: (value: unknown) => void;
    const pendingPage = new Promise(resolve => { resolvePage = resolve; });
    const pendingStore = new Promise(resolve => { resolveStore = resolve; });

    try {
      expect(observer.getCurrentResult().data).toEqual(firstPage);
      observer.setOptions({ ...options('store-a', 2), queryFn: () => pendingPage });
      expect(observer.getCurrentResult()).toMatchObject({ data: firstPage, isPlaceholderData: true, fetchStatus: 'fetching' });

      observer.setOptions({ ...options('store-b', 1), queryFn: () => pendingStore });
      expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isPlaceholderData: false, fetchStatus: 'fetching' });
      resolveStore(otherStore);
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(otherStore));
      resolvePage(secondPage);
      await vi.waitFor(() => expect(client.getQueryData(options('store-a', 2).queryKey)).toEqual(secondPage));
      expect(observer.getCurrentResult().data).toEqual(otherStore);
    } finally {
      unsubscribe();
      observer.destroy();
    }
  });
});

/* eslint-disable react-hooks/rules-of-hooks -- mocked useQuery only captures production query options. */
const filterCases = [
  { name: 'product search', read: (changed: boolean) => useProducts('store-a', 1, changed ? 'jacket' : '') },
  { name: 'product status', read: (changed: boolean) => useProducts('store-a', 1, '', changed ? 'active' : 'all') },
  { name: 'order status', read: (changed: boolean) => useOrders('store-a', 1, changed ? 'paid' : 'all') },
];
/* eslint-enable react-hooks/rules-of-hooks */

describe.each(filterCases)('$name filter', ({ read }) => {
  it('clears rows immediately while a different filter is pending', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(client);
    const options = (changed: boolean): QueryObserverOptions => {
      read(changed);
      return vi.mocked(useQuery).mock.calls.at(-1)![0] as QueryObserverOptions;
    };
    const initial = options(false);
    client.setQueryData(initial.queryKey, { data: [{ id: 'unfiltered-row' }] });
    const observer = new QueryObserver(client, initial);
    const unsubscribe = observer.subscribe(() => undefined);
    let resolve!: (value: unknown) => void;
    try {
      expect(observer.getCurrentResult().data).toBeDefined();
      observer.setOptions({ ...options(true), queryFn: () => new Promise(done => { resolve = done; }) });
      expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isPlaceholderData: false, fetchStatus: 'fetching' });
      resolve({ data: [{ id: 'matching-row' }] });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ data: [{ id: 'matching-row' }] }));
    } finally { unsubscribe(); observer.destroy(); }
  });
});
