import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithHeadersTimeout } from '../fetch-with-headers-timeout.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchWithHeadersTimeout', () => {
  it('aborts a request whose headers never arrive', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(fetchWithHeadersTimeout('https://x.test/o', {}, 20)).rejects.toThrow(
      /No response headers/,
    );
  });

  it('does not cut the body short once headers have arrived', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response('ok');
    });
    await fetchWithHeadersTimeout('https://x.test/o', {}, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal?.aborted).toBe(false);
  });
});
