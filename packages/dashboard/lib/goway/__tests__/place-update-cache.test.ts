import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Place } from '@goway.to/sdk';
import { useUpdateGoWayPlace } from '../hooks';
import { queryKeys } from '../../queryKeys';

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: vi.fn(() => ({})),
  useQueryClient: vi.fn(),
}));
vi.mock('react', () => ({
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (setup: () => (() => void) | undefined) => {
    const cleanup = setup();
    if (cleanup) effectCleanups.push(cleanup);
  },
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ oxyServices: { session: { accessToken: null } } }),
}));
vi.mock('../../i18n', () => ({ useTranslation: () => ({ locale: 'en' }) }));
vi.mock('../../config', () => ({ GOWAY_API_URL: undefined }));
const clients: QueryClient[] = [];
const effectCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of effectCleanups.splice(0)) cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});

it('a confirmed place update defeats pending old data without overwriting another locale or place', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const old = { id: 'place', contact: { email: 'old@example.test' } } as Place;
  const saved = { ...old, contact: { email: 'saved@example.test' } };
  const key = queryKeys.goway.place('place', 'en');
  const translated = queryKeys.goway.place('place', 'ar');
  const other = queryKeys.goway.place('other', 'en');
  client.setQueryData(key, old);
  client.setQueryData(translated, old);
  client.setQueryData(other, old);
  let release!: () => void;
  const read = client
    .fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise<Place>((resolve) => {
          release = () => resolve(old);
        }),
    })
    .catch(() => undefined);
  vi.mocked(useQueryClient).mockReturnValue(client);
  useUpdateGoWayPlace('place');
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
    onSuccess: (data: Place) => Promise<void>;
  };
  await options.onSuccess(saved);
  release();
  await read;
  expect(client.getQueryData(key)).toEqual(saved);
  expect(client.getQueryData(translated)).toEqual(old);
  expect(client.getQueryState(translated)?.isInvalidated).toBe(true);
  expect(client.getQueryData(other)).toEqual(old);
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});
