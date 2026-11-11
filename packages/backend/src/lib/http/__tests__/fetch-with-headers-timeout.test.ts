import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithHeadersTimeout } from '../fetch-with-headers-timeout.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchWithHeadersTimeout', () => {
  it('aborts a request whose headers never arrive', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expect(fetchWithHeadersTimeout('https://x.test/o', {}, 20)).rejects.toThrow(
      /No response headers/,
    );
  });

  it('does not cut the body short once headers have arrived', async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response('ok');
    }) as unknown as typeof fetch;
    await fetchWithHeadersTimeout('https://x.test/o', {}, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal?.aborted).toBe(false);
  });
});
