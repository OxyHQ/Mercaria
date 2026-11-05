/**
 * CORS on the real `createApp()` chain: `createOxyCors` over the ONE origin list
 * (`lib/allowed-origins.ts`), built once.
 *
 * - an allowed origin is echoed exactly and is NOT credentialed (commerce
 *   carries a bearer header, never an ambient cookie);
 * - any other browser origin is REFUSED (403, no CORS headers) — no reflection,
 *   no wildcard, and not merely left unreadable: a simple cross-site POST
 *   needs no preflight, so withholding headers alone would still run it;
 * - only the two referral-cookie migration paths are credentialed;
 * - the retired service-signing headers are not offered.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function preflight(path: string, origin: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
}

describe('the credentialed origin allow-list', () => {
  it('echoes an allowed origin exactly, without credentials', async () => {
    const res = await preflight('/cart', 'https://mercaria.co');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mercaria.co');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('gives any other origin no CORS headers — never a reflection or a wildcard', async () => {
    const res = await preflight('/cart', 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not offer the retired service-signing headers', async () => {
    const res = await fetch(`${base}/cart`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://mercaria.co', 'Access-Control-Request-Method': 'GET' },
    });
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowed).toContain('authorization');
    for (const retired of ['x-signature', 'x-oxy-user-id', 'x-service-name', 'x-timestamp']) {
      expect(allowed).not.toContain(retired);
    }
  });

  it("refuses a foreign origin's simple POST before any handler, even with a cookie", async () => {
    for (const path of ['/cart/items', '/referrals/legacy-cookie-exchange']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'text/plain',
          Cookie: 'mercaria_ref=planted',
        },
        body: 'x',
      });
      expect(res.status, path).toBe(403);
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });

  it('judges only browsers: a request with no Origin is not refused for it', async () => {
    const res = await fetch(`${base}/cart`, { method: 'GET' });
    expect(res.status).not.toBe(403);
  });

  it('credentials only the referral-cookie migration paths', async () => {
    const res = await preflight('/referrals/legacy-cookie-exchange', 'https://mercaria.co');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mercaria.co');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
