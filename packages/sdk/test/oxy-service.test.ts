import { describe, expect, it, vi } from 'vitest';
import { mercariaForOxyService, MERCARIA_SERVICE_AUDIENCE } from '../src/server';
import type { MercariaServiceOptions } from '../src/server';
import type { MercariaFetch } from '../src/runtime';
import { productWire } from './fixtures';

function transport() {
  return {
    fetch: vi.fn<MercariaFetch>(async () => new Response(JSON.stringify(productWire()))),
    dispose: vi.fn(),
  };
}
describe('public catalogue workload factory', () => {
  it('pins the receiver, preserves public DTOs and leaves authentication to Oxy', async () => {
    const linked = transport();
    const oxy = { createServiceClient: vi.fn(() => linked) };
    const client = mercariaForOxyService(oxy, { apiBaseUrl: 'https://mercaria.test' });
    const product = await client.products.get('prod_1');
    expect(product.ref).toEqual({ kind: 'product', id: 'prod_1' });
    expect(oxy.createServiceClient).toHaveBeenCalledExactlyOnceWith({
      baseURL: 'https://mercaria.test',
      audience: MERCARIA_SERVICE_AUDIENCE,
    });
    expect(linked.fetch.mock.calls[0]?.[0]).toBe('https://mercaria.test/public/v1/products/prod_1');
    expect(linked.fetch.mock.calls[0]?.[1].headers.Authorization).toBeUndefined();
    expect('materials' in client).toBe(false);
    client.dispose();
    expect(linked.dispose).toHaveBeenCalledOnce();
  });
  it('refuses a second auth/fetch source and disposes a transport on invalid options', () => {
    const linked = transport();
    const oxy = { createServiceClient: vi.fn(() => linked) };
    expect(() =>
      mercariaForOxyService(oxy, { getAccessToken: () => 'external' } as MercariaServiceOptions),
    ).toThrow('owns authentication');
    expect(oxy.createServiceClient).not.toHaveBeenCalled();
    expect(() => mercariaForOxyService(oxy, { timeoutMs: 0 })).toThrow('timeoutMs');
    expect(linked.dispose).toHaveBeenCalledOnce();
  });
  it('does not retry downstream failures or bypass caller cancellation', async () => {
    const linked = transport();
    linked.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'service_unavailable', message: 'offline' } }), {
        status: 503,
      }),
    );
    const client = mercariaForOxyService({ createServiceClient: () => linked });
    await expect(client.products.get('prod_1')).rejects.toMatchObject({ status: 503 });
    expect(linked.fetch).toHaveBeenCalledOnce();
    const abort = new AbortController();
    abort.abort();
    await expect(client.products.get('prod_1', { signal: abort.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(linked.fetch).toHaveBeenCalledOnce();
  });
});
