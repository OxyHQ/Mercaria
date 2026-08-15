/**
 * `REDIS_URL`'s database index reaches every client built from it (#298).
 *
 * The bug this pins was silent and in the PERMISSIVE direction: `parseRedisUrl`
 * decomposed the URL into fields and never read its path, so
 * `redis://host:6379/9` connected to db 0 — measured with the app's own client.
 * A database index is how an operator isolates one service's keyspace on a
 * shared Redis, so the operator got isolation they believed in and did not
 * have, with nothing in a log or a health check to say otherwise.
 *
 * Every case here asserts the index the URL NAMED, never merely that some index
 * is present: `expect(db).toBe(9)` alone is satisfied by a hardcoded 9, so each
 * assertion is paired with a different index and with the negative control
 * below — a URL naming no index must yield no index, which is what separates
 * "we read the path" from "we set a constant that happened to match".
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRedisConnection } from '../redis.js';
import { getQueueConnection, isQueueEnabled } from '../../queue/connection.js';

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

/**
 * `getRedisConnection` re-reads `process.env.REDIS_URL` on every call and
 * `getQueueConnection` reads through it, so both are exercised against a plain
 * environment change — no module reset, which is also how they are reached in
 * production.
 */
function withUrl(url: string | undefined) {
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;
}

/**
 * The two CLIENT getters cache their ioredis instance in a module-level
 * singleton, so only they need a fresh module graph. Kept to the three cases
 * that build a real client: every reset re-registers the module graph's process
 * listeners, and a dozen of them trips Node's max-listeners warning.
 */
async function loadClientsWith(url: string) {
  vi.resetModules();
  withUrl(url);
  return import('../redis.js');
}

afterEach(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  vi.restoreAllMocks();
});

describe('REDIS_URL database index', () => {
  describe('the shared config reads the path', () => {
    it('carries the index the URL named, and a different URL a different index', () => {
      // Two indices rather than one: a hardcoded constant can satisfy either
      // case alone and cannot satisfy both.
      withUrl('redis://127.0.0.1:6379/9');
      expect(getRedisConnection()?.db).toBe(9);

      withUrl('redis://127.0.0.1:6379/3');
      expect(getRedisConnection()?.db).toBe(3);
    });

    it('carries db 0 when the URL names it explicitly', () => {
      // 0 is a real index and the one a truthiness guard silently drops. It is
      // behaviourally identical to the default TODAY, which is exactly why a
      // guard that drops it would go unnoticed.
      withUrl('redis://127.0.0.1:6379/0');
      expect(getRedisConnection()?.db).toBe(0);
    });

    it('reads the index through TLS URLs and past credentials', () => {
      withUrl('rediss://user:secret@example.test:6380/7');
      const config = getRedisConnection();
      expect(config?.db).toBe(7);
      // The index must not have been read AT THE COST of the other fields.
      expect(config?.host).toBe('example.test');
      expect(config?.port).toBe(6380);
      expect(config?.password).toBe('secret');
      expect(config?.username).toBe('user');
    });

    // The negative control. Without it, every assertion above is also satisfied
    // by a parser that sets an index unconditionally.
    it('sets NO index when the URL names none', () => {
      withUrl('redis://127.0.0.1:6379');
      expect(getRedisConnection()?.db).toBeUndefined();

      // A trailing slash names no index either — `new URL().pathname` is '/'.
      withUrl('redis://127.0.0.1:6379/');
      expect(getRedisConnection()?.db).toBeUndefined();
    });
  });

  describe('a malformed index is refused, never defaulted to db 0', () => {
    // Landing on db 0 is the exact harm #298 measured, so an index that cannot
    // be honoured must not be discarded. Refusing costs an in-memory rate
    // limiter and inline jobs — both correct — and it is loud.
    it.each([
      ['non-numeric', 'redis://127.0.0.1:6379/abc'],
      ['negative', 'redis://127.0.0.1:6379/-1'],
      ['fractional', 'redis://127.0.0.1:6379/1.5'],
      ['beyond a safe integer', `redis://127.0.0.1:6379/${'9'.repeat(20)}`],
    ])('refuses a %s index rather than silently using db 0', (_label, url) => {
      withUrl(url);
      expect(getRedisConnection()).toBeNull();
      expect(isQueueEnabled()).toBe(false);
    });
  });

  describe('every consumer carries it', () => {
    /**
     * The census that matters. `getQueueConnection` rebuilds BullMQ's options
     * field by field rather than spreading the shared config, so it is the one
     * consumer that drops a field by omission — which is how the queues, the
     * rate-limit buckets and the Socket.IO adapter all ended up sharing db 0.
     */
    it('BullMQ options carry the index', () => {
      withUrl('redis://127.0.0.1:6379/9');
      expect(getQueueConnection()).toMatchObject({ db: 9, maxRetriesPerRequest: null });
    });

    it('BullMQ options carry an explicit db 0', () => {
      // The case a truthiness guard drops. Behaviourally identical to the
      // default today, so nothing else in the suite would notice.
      withUrl('redis://127.0.0.1:6379/0');
      expect(getQueueConnection()).toMatchObject({ db: 0 });
    });

    it('BullMQ options carry NO index when the URL names none', () => {
      withUrl('redis://127.0.0.1:6379');
      expect(getQueueConnection()).not.toHaveProperty('db');
    });

    it.each([
      ['getRedisClient', (m: typeof import('../redis.js')) => m.getRedisClient()],
      ['getRedisSubClient', (m: typeof import('../redis.js')) => m.getRedisSubClient()],
    ])('%s connects on the index', async (_label, build) => {
      // The real ioredis instance, because the shared config reaching it is the
      // claim — reading it off the config object would prove only that the
      // object has the field. Port 1 never accepts, and `disconnect()` stops
      // the retry loop synchronously without the `quit()` round trip a
      // never-connected client cannot complete.
      const redis = await loadClientsWith('redis://127.0.0.1:1/9');
      const client = build(redis);
      expect(client?.options.db).toBe(9);
      client?.disconnect();
    });

    it('an ioredis client carries NO explicit index when the URL names none', async () => {
      // ioredis's own default is 0, so this asserts the parser passed nothing
      // rather than asserting a value it would have had either way.
      const redis = await loadClientsWith('redis://127.0.0.1:1');
      const client = redis.getRedisClient();
      expect(client?.options.db).toBe(0);
      expect(redis.getRedisConnection()?.db).toBeUndefined();
      client?.disconnect();
    });
  });
});
