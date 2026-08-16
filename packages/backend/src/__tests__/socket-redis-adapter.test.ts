/**
 * The Socket.IO Redis adapter is ATTACHED, and a room emit actually fans out.
 *
 * #364: `getRedisClient()` built its client without `lazyConnect`, ioredis
 * connects eagerly in the constructor, and `initSocket` then called `.connect()`
 * a second time. ioredis rejects that with `Redis is already connecting/connected`,
 * the `.catch` logged a warning, and the adapter was never attached — on every
 * boot, unconditionally. Two ECS tasks then held isolated in-memory adapters and
 * roughly half of every `notification` emit reached nobody.
 *
 * The trap this file exists to avoid: a green boot is what passes TODAY. The
 * failure was a rejected promise inside a `.catch` that logs and continues, so
 * "call the boot path, assert it does not throw" passes against the broken code
 * and against the fixed code identically — it measures nothing. Every assertion
 * here therefore names the adapter or the fan-out:
 *
 *  - `connect()` is never called (the direct statement of the fix),
 *  - the namespace's adapter IS a `RedisAdapter` (attached),
 *  - the subscriber was subscribed (the adapter wired itself to OUR clients),
 *  - a room emit reaches `pubClient.publish` (the property a second ECS task
 *    depends on — with the in-memory adapter no publish ever happens).
 *
 * The fake clients' `connect()` REJECTS with ioredis's real message, and that is
 * load-bearing rather than decorative: it is what makes reintroducing the
 * double-connect fail here for the same reason it failed in production. A fake
 * whose `connect()` resolved would attach the adapter asynchronously and hide
 * the defect behind a tick.
 */

import http from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisAdapter } from '@socket.io/redis-adapter';

vi.mock('../middleware/auth.js', () => ({
  oxyClient: { authSocket: () => (_socket: unknown, next: () => void) => next() },
}));
vi.mock('../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../db/stores/storeRepository.js', () => ({
  findStoreMember: vi.fn(),
}));

const getSocketAdapterClients = vi.fn();
vi.mock('../lib/redis.js', () => ({
  getSocketAdapterClients: () => getSocketAdapterClients(),
}));

import { initSocket } from '../socket.js';

/**
 * A stand-in for an ioredis client carrying exactly the surface
 * `@socket.io/redis-adapter` uses on this version: `subscribe`, `psubscribe`,
 * `publish`, `on`.
 *
 * It deliberately has NO `sSubscribe`. That method is how the adapter's
 * `isRedisV4Client` tells a node-redis v4 client from an ioredis one, so adding
 * it would silently route the adapter down the other branch and this file would
 * be measuring a code path production never takes.
 */
function fakeRedisClient() {
  return {
    subscribe: vi.fn(),
    psubscribe: vi.fn(),
    publish: vi.fn(),
    on: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(2),
    // ioredis connects in its CONSTRUCTOR, so a second connect on a client that
    // is already connecting rejects exactly like this. Reproduced faithfully so
    // that a reintroduced `.connect()` fails here the way it failed in prod.
    connect: vi.fn().mockRejectedValue(new Error('Redis is already connecting/connected')),
  };
}

let servers: http.Server[] = [];
let ios: Array<{ close: (fn?: () => void) => void }> = [];

function bootSocketServer() {
  const server = http.createServer();
  servers.push(server);
  const io = initSocket(server);
  ios.push(io);
  return io;
}

beforeEach(() => {
  vi.clearAllMocks();
  servers = [];
  ios = [];
});

afterEach(async () => {
  for (const io of ios) {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});

describe('initSocket — Redis adapter attachment (#364)', () => {
  it('attaches the Redis adapter SYNCHRONOUSLY and never calls connect()', () => {
    const pubClient = fakeRedisClient();
    const subClient = fakeRedisClient();
    getSocketAdapterClients.mockReturnValue({ pubClient, subClient });

    const io = bootSocketServer();

    // The whole defect in one assertion: ioredis has already connected, so a
    // second connect can only reject, and the adapter is never attached.
    expect(pubClient.connect).not.toHaveBeenCalled();
    expect(subClient.connect).not.toHaveBeenCalled();

    // Attached, and attached before `initSocket` returned — there is no window
    // in which the server accepts connections with no cross-task fan-out.
    expect(io.of('/').adapter).toBeInstanceOf(RedisAdapter);
  });

  it('wires the adapter to the subscriber client (it subscribed)', () => {
    const pubClient = fakeRedisClient();
    const subClient = fakeRedisClient();
    getSocketAdapterClients.mockReturnValue({ pubClient, subClient });

    bootSocketServer();

    // The adapter issues these in its own constructor, on the ioredis branch.
    // Their absence is what "the adapter was never attached" looks like from
    // the client's side.
    expect(subClient.psubscribe).toHaveBeenCalled();
    expect(subClient.subscribe).toHaveBeenCalled();
    expect(pubClient.psubscribe).not.toHaveBeenCalled();
  });

  it('PUBLISHES a room emit to Redis, so another task can deliver it', () => {
    const pubClient = fakeRedisClient();
    const subClient = fakeRedisClient();
    getSocketAdapterClients.mockReturnValue({ pubClient, subClient });

    const io = bootSocketServer();

    io.to('user:abc').emit('notification', { id: 'n1', title: 'Order shipped' });

    // This is the user-visible property #364 broke. With the in-memory adapter
    // the emit finds no local socket and stops there — no publish, and the task
    // holding that user's socket never hears about it.
    expect(pubClient.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = pubClient.publish.mock.calls[0];
    expect(String(channel)).toContain('socket.io');
    expect(payload).toBeDefined();
  });

  it('falls back to the in-memory adapter when Redis is not configured', () => {
    getSocketAdapterClients.mockReturnValue(null);

    const io = bootSocketServer();

    // The negative control for the three assertions above: this is what a
    // REDIS_URL-less deployment looks like, and it must be distinguishable from
    // a configured one. If the tests above passed here too, they would be
    // measuring nothing about the adapter.
    expect(io.of('/').adapter).not.toBeInstanceOf(RedisAdapter);

    // And a room emit reaches no Redis at all, which is precisely the
    // cross-task gap #364 left every deployment in.
    expect(() => io.to('user:abc').emit('notification', { id: 'n1' })).not.toThrow();
  });
});
