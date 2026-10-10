/** HTTP contract with the Oxy principal stubbed at its existing boundary.
 * PostgreSQL persistence/concurrency/visibility are exercised in review-scopes.realdb.test.ts. */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxy.so/db';

const stubs = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization !== 'Bearer fixture') { res.sendStatus(401); return; }
    req.userId = 'oxy-helpful-reader';
    next();
  },
  oxyClient: {},
}));
vi.mock('@oxy.so/core/server', async original => ({
  ...await original<typeof import('@oxy.so/core/server')>(),
  getRequiredOxyUserId: (req: express.Request) => req.userId,
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../services/reviews/review-helpfulness.service.js', async original => ({
  ...await original<typeof import('../../services/reviews/review-helpfulness.service.js')>(),
  listReviewHelpfulness: stubs.list,
  updateReviewHelpfulness: stubs.update,
}));
import router from '../reviews.js';

let server: Server;
let base: string;
const id = uuidv7();
const headers = { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' };
const vote = { reviewId: id, helpfulnessCount: 1, markedAsHelpfulByMe: true, canUpdateHelpfulness: true };
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/reviews', router);
  await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reviews`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  stubs.list.mockResolvedValue([vote]);
  stubs.update.mockResolvedValue(vote);
});

describe('review helpfulness HTTP boundary', () => {
  it('requires an Oxy principal on reads and writes before calling the service', async () => {
    expect((await fetch(`${base}/helpfulness?ids=${id}`)).status).toBe(401);
    expect((await fetch(`${base}/${id}/helpfulness`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"helpful":true}' })).status).toBe(401);
    expect(stubs.list).not.toHaveBeenCalled();
    expect(stubs.update).not.toHaveBeenCalled();
  });
  it('batches personal reads, derives identity from the principal and prevents shared caching', async () => {
    const res = await fetch(`${base}/helpfulness?ids=${id},${id}`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(((await res.json()) as { data: unknown }).data).toEqual([vote]);
    expect(stubs.list).toHaveBeenCalledWith('oxy-helpful-reader', [id]);
  });
  it('passes true and false as desired state without accepting a client voter', async () => {
    for (const helpful of [true, false]) {
      const res = await fetch(`${base}/${id}/helpfulness`, { method: 'PUT', headers, body: JSON.stringify({ helpful }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(((await res.json()) as { data: unknown }).data).toEqual(vote);
      expect(stubs.update).toHaveBeenLastCalledWith('oxy-helpful-reader', id, helpful);
    }
  });
  it('rejects malformed ids, unbounded reads and identity/counter injection', async () => {
    for (const body of [{ helpful: 'true' }, { helpful: true, oxyUserId: 'other' }, { helpful: true, helpfulnessCount: 5 }]) {
      expect((await fetch(`${base}/${id}/helpfulness`, { method: 'PUT', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await fetch(`${base}/bad-id/helpfulness`, { method: 'PUT', headers, body: '{"helpful":true}' })).status).toBe(400);
    for (const query of ['', `ids=${id}&oxyUserId=other`, `ids=${Array.from({ length: 51 }, () => uuidv7()).join(',')}`]) {
      expect((await fetch(`${base}/helpfulness?${query}`, { headers })).status).toBe(400);
    }
    expect(stubs.update).not.toHaveBeenCalled();
    expect(stubs.list).not.toHaveBeenCalled();
  });
});
