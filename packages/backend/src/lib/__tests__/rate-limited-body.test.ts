/**
 * Every 429 this API answers with is JSON in `~/Oxy/docs/api-conventions.md`'s
 * error shape, with `details.retryAfterSeconds` equal to the `Retry-After`
 * header — for BOTH limiter factories, driven through the real
 * express-rate-limit (and, for `makeRateLimiter`, the real `createOxyRateLimit`).
 *
 * Before this, `createOxyRateLimit`'s refusal was a plain-text body and the
 * actor limiter's was the internal `{ success, error: 'RATE_LIMITED' }`
 * envelope, so a consumer had to map 429 from the STATUS whatever the body said.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercariaErrorBodySchema } from '@mercaria/contracts';

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    middleware: {
      auth:
        () =>
        (_req: express.Request, _res: express.Response, next: express.NextFunction): void => {
          next();
        },
    },
  },
}));

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(limiter: express.RequestHandler): Promise<string> {
  const app = express();
  app.use(limiter);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/probe`;
}

async function expectRateLimitedJson(url: string): Promise<void> {
  const first = await fetch(url);
  expect(first.status).toBe(200);
  const refused = await fetch(url);
  expect(refused.status).toBe(429);
  expect(refused.headers.get('content-type') ?? '').toContain('application/json');
  const retryAfter = Number(refused.headers.get('retry-after'));
  expect(Number.isSafeInteger(retryAfter) && retryAfter > 0).toBe(true);
  const body = MercariaErrorBodySchema.parse(await refused.json());
  expect(body.error.code).toBe('rate_limited');
  expect(body.error.details).toEqual({ retryAfterSeconds: retryAfter });
}

describe('the 429 body', () => {
  it('is the convention’s JSON error from makeRateLimiter (createOxyRateLimit)', async () => {
    const { makeRateLimiter } = await import('../rate-limit.js');
    await expectRateLimitedJson(await serve(makeRateLimiter('public-api', { anonymousMax: 1, windowMs: 60_000 })));
  });

  it('is the same body from makeActorRateLimiter', async () => {
    const { makeActorRateLimiter } = await import('../rate-limit.js');
    await expectRateLimitedJson(await serve(makeActorRateLimiter('cart', { identifiedMax: 1, anonymousMax: 1, windowMs: 60_000 })));
  });
});
