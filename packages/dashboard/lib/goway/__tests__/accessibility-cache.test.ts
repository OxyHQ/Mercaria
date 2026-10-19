import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Place } from '@goway.to/sdk';
import { useApplyCapabilityOperations } from '../hooks';
import { queryKeys } from '../../queryKeys';
import type { CapabilityOperation } from '../place-form';

const sdk = vi.hoisted(() => ({ put: vi.fn(), delete: vi.fn() }));
vi.mock('@goway.to/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@goway.to/sdk')>()),
  createGoWayClient: () => ({ places: { capabilities: sdk } }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: vi.fn(() => ({})),
  useQueryClient: vi.fn(),
}));
vi.mock('react', () => ({ useMemo: (factory: () => unknown) => factory() }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ oxyServices: { session: { accessToken: null } } }),
}));
vi.mock('../../i18n', () => ({ useTranslation: () => ({ locale: 'en' }) }));
vi.mock('../../config', () => ({ GOWAY_API_URL: undefined }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((clean) => clean());
  vi.clearAllMocks();
});
const key = queryKeys.goway.place('place', 'en');
const old = { id: 'place', capabilities: [] } as unknown as Place;
const fresh = { ...old, name: 'Confirmed remote place' };
const operation: CapabilityOperation = { kind: 'delete', key: 'accessibility.hearing_loop' };
function setup(read: () => Promise<Place>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(key, old);
  const otherKey = queryKeys.goway.place('other', 'en');
  client.setQueryData(otherKey, old);
  const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(() => {
    unsubscribe();
    client.clear();
  });
  vi.mocked(useQueryClient).mockReturnValue(client);
  // React hooks are mocked here to capture configuration; QueryObserver and QueryClient are real.
  // biome-ignore lint/correctness/useHookAtTopLevel: React Query hooks are mocked here to capture the mutation options
  useApplyCapabilityOperations('place');
  const options = vi.mocked(useMutation).mock.calls.at(-1)![0] as {
    mutationFn: (
      operations: readonly CapabilityOperation[],
    ) => Promise<{ confirmed: boolean; error: unknown }>;
  };
  return { client, run: options.mutationFn, otherKey };
}
it('waits for the real query refresh after DELETE204 before acknowledging the draft', async () => {
  let release!: (value: Place) => void;
  const read = vi.fn(
    () =>
      new Promise<Place>((resolve) => {
        release = resolve;
      }),
  );
  const { client, run, otherKey } = setup(read);
  let settled = false;
  const result = run([operation]).then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  expect(client.getQueryData(key)).toEqual(old);
  release(fresh);
  expect(await result).toEqual({ confirmed: true, error: null });
  expect(client.getQueryData(key)).toEqual(fresh);
  expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
});
it('refreshes partial writes while preserving the actual failed operation error', async () => {
  const failure = new Error('Second operation failed');
  sdk.put.mockResolvedValueOnce(fresh).mockRejectedValueOnce(failure);
  const read = vi.fn(async () => fresh);
  const { client, run } = setup(read);
  await expect(
    run([
      { kind: 'put', key: 'accessibility.hearing_loop', assertion: { value: true } },
      { kind: 'put', key: 'accessibility.step_free_entrance', assertion: { value: true } },
    ]),
  ).rejects.toBe(failure);
  expect(read).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(key)).toEqual(fresh);
});
it('does not claim a successful refresh when GoWay read fails after a confirmed write', async () => {
  const failure = new Error('Read failed');
  const { run } = setup(async () => {
    throw failure;
  });
  expect(await run([operation])).toEqual({ confirmed: false, error: failure });
});
