import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MerchantLocationPublication } from '@mercaria/shared-types';
import { useSaveLocationPublication } from '../use-location-publication';
import { queryKeys } from '../../queryKeys';

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useMutation: vi.fn(() => ({})), useQueryClient: vi.fn(),
}));
vi.mock('../../api/locations', () => ({}));
const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.clearAllMocks(); });

it('the first saved publication replaces null and defeats an older read only for its location/store', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const saved = { id: 'publication', locationId: 'location', lowStockThreshold: 3 } as MerchantLocationPublication;
  const key = queryKeys.locationPublication('store-a', 'location');
  const other = queryKeys.locationPublication('store-b', 'location');
  client.setQueryData(key, null); client.setQueryData(other, null);
  let release!: () => void;
  const oldRead = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<null>(resolve => { release = () => resolve(null); }) }).catch(() => undefined);
  vi.mocked(useQueryClient).mockReturnValue(client);
  useSaveLocationPublication('store-a', 'location');
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as { onSuccess: (data: MerchantLocationPublication) => Promise<void> };
  await options.onSuccess(saved); release(); await oldRead;
  expect(client.getQueryData(key)).toEqual(saved);
  expect(client.getQueryData(other)).toBeNull();
});
