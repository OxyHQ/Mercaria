/** HTTP routing contract only. Persistence/visibility use real PostgreSQL in
 * review-scopes.realdb.test.ts; these rows are not live-upload evidence. */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxy.so/db';
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (_req: express.Request, res: express.Response) => res.sendStatus(401),
  optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  oxyClient: {},
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock('../../services/review.service.js', async (original) => ({
  ...(await original<typeof import('../../services/review.service.js')>()),
  listPublicReviewMedia: list,
}));
import reviews from '../reviews.js';
import listings from '../listings.js';
let server: Server;
let base: string;
const id = uuidv7();
beforeAll(async () => {
  const app = express();
  app.use('/reviews', reviews);
  app.use('/listings', listings);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ data: [], total: 25 });
});

it.each([
  ['product', `/reviews/product/${id}/media`],
  ['listing', `/listings/${id}/reviews/media`],
])(
  'serves the public %s gallery without requiring a session and preserves media pagination',
  async (kind, path) => {
    const response = await fetch(`${base}${path}?page=2&limit=10`);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledExactlyOnceWith(kind, id, { page: 2, limit: 10 });
    expect(await response.json()).toEqual({
      data: [],
      pagination: {
        page: 2,
        limit: 10,
        total: 25,
        pages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      },
    });
  },
);

it('rejects invalid IDs before reading media', async () => {
  for (const path of ['/reviews/product/not-an-id/media', '/listings/not-an-id/reviews/media']) {
    expect((await fetch(`${base}${path}`)).status).toBe(400);
  }
  expect(list).not.toHaveBeenCalled();
});
