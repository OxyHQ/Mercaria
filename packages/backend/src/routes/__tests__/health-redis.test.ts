/**
 * `/health`'s `redis` field reports whether Redis ANSWERS (issue #369).
 *
 * The defect this pins was an object-existence check —
 * `redis: getRedisClient() ? 'connected' : 'unavailable'` — which reported
 * `connected` for a client that had never reached a server and for one whose
 * `retryStrategy` had given up reconnecting for good. `unavailable` could
 * therefore only ever mean "`REDIS_URL` is unset or unparseable"; it could
 * never mean "Redis is down".
 *
 * ## Only the SERVER is faked, and two of the three fakes are real sockets
 *
 * Every case below builds a REAL `ioredis` client through the REAL
 * `getRedisClient()`, by pointing `REDIS_URL` at an address this file controls.
 * Nothing stubs `ping`, nothing stubs the client and nothing stubs
 * `checkRedisHealth` — so what is measured is the shipped function against a
 * real socket. The three server behaviours are the three that matter:
 *
 *  - **a closed port** — a client that exists and cannot reach a server. This is
 *    the case that would have FAILED against the old code, which answered
 *    `connected` for it;
 *  - **a port that accepts and never speaks** — the reason the probe is bounded
 *    at all, since the ALB's own health-check timeout is 5s;
 *  - **a server that answers `PONG`** — the POSITIVE CONTROL, without which a
 *    `checkRedisHealth` hardcoded to `unreachable` would pass every other case
 *    here.
 *
 * The fourth case has no server because it has no client: with `REDIS_URL`
 * unset, `not_configured` is a deliberate, working deployment (an in-memory
 * rate-limit bucket and inline jobs) and must not read as an outage.
 *
 * ## The readiness decision is pinned too, and it is the dangerous half
 *
 * The ALB health-checks `GET /` on this router with matcher `200-399`, and the
 * handler answers 503 whenever `status` is `degraded`. So the last case asserts
 * that an UNREACHABLE Redis leaves `status` healthy and the response 200:
 * feeding Redis into `status` would deregister every task 90 seconds into a
 * Redis blip. Postgres is the independent variable there and is the one thing
 * stubbed, because the property under test is what the redis field does NOT do.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

vi.mock('../../db/postgres.js', () => ({
  checkPostgresHealth: () => Promise.resolve(true),
  assertMigrationsCurrent: () => Promise.resolve(),
}));

/** Everything a case opened, torn down in `afterEach` whatever the case did. */
const openTcpServers: net.Server[] = [];
const acceptedSockets: net.Socket[] = [];
const openServers: Server[] = [];
let disconnectRedis: (() => void) | null = null;
const originalRedisUrl = process.env.REDIS_URL;

afterEach(async () => {
  disconnectRedis?.();
  disconnectRedis = null;
  // `close()` stops new connections and WAITS for open ones, so the silent
  // server — whose whole point is a connection nobody ends — hangs the hook
  // until every accepted socket is destroyed first.
  for (const socket of acceptedSockets.splice(0)) socket.destroy();
  await Promise.all(
    [...openTcpServers.splice(0), ...openServers.splice(0)].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

async function startTcpServer(
  onConnection: (socket: net.Socket) => void,
): Promise<number> {
  const server = net.createServer((socket) => {
    acceptedSockets.push(socket);
    onConnection(socket);
  });
  openTcpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * A port nothing listens on: bind one, read it, give it back.
 *
 * A hardcoded port would be a guess about the host running the suite; binding
 * and releasing asks the kernel for one it considers free.
 */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * The smallest server ioredis will call `ready`.
 *
 * It answers the readiness `INFO` (ioredis reads `loading:` out of it) and
 * `PING`, which is the whole of what `checkRedisHealth` issues. Replying to
 * every command with one canned string instead would leave the client stuck in
 * its ready check, which is the failing case wearing the passing case's clothes.
 */
function respondingRedis(socket: net.Socket): void {
  socket.on('data', (chunk) => {
    for (const [, command] of chunk.toString('utf8').matchAll(/\$\d+\r\n([A-Za-z]+)\r\n/g)) {
      switch (command.toUpperCase()) {
        case 'INFO': {
          const info = '# Server\r\nredis_version:7.0.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
          break;
        }
        case 'PING':
          socket.write('+PONG\r\n');
          break;
        default:
          socket.write('+OK\r\n');
      }
    }
  });
}

/**
 * A fresh `lib/redis.js` with `REDIS_URL` set to `url`.
 *
 * `getRedisClient` caches a module-level singleton, so each case needs its own
 * module instance; `vi.resetModules()` is what gives it one. The teardown
 * `disconnect()`s rather than calling `closeRedis()`, because `quit()` on a
 * client that never reached a server is itself a command that has to reach one.
 */
async function loadRedisModule(url: string | undefined) {
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;
  vi.resetModules();
  const module = await import('../../lib/redis.js');
  disconnectRedis = () => module.getRedisClient()?.disconnect();
  return module;
}

describe('checkRedisHealth', () => {
  it('reports a client that exists and cannot reach a server as unreachable', async () => {
    const port = await closedPort();
    const redis = await loadRedisModule(`redis://127.0.0.1:${port}`);

    // The premise of the case, and of the whole issue: the OBJECT exists. The
    // old field derived `connected` from exactly this.
    expect(redis.getRedisClient()).not.toBeNull();

    const health = await redis.checkRedisHealth();

    expect(health).toBe('unreachable');
    expect(health).not.toBe('connected');
  });

  it('reports a server that answers PING as connected', async () => {
    const port = await startTcpServer(respondingRedis);
    const redis = await loadRedisModule(`redis://127.0.0.1:${port}`);

    await expect(redis.checkRedisHealth()).resolves.toBe('connected');
  });

  it('reports an unset REDIS_URL as not_configured, distinctly from an outage', async () => {
    const redis = await loadRedisModule(undefined);

    expect(redis.getRedisClient()).toBeNull();
    await expect(redis.checkRedisHealth()).resolves.toBe('not_configured');
  });

  it('bounds a server that accepts and never answers, well inside the ALB timeout', async () => {
    // Accepts the connection and says nothing — the case a `client !== null`
    // check and an unbounded `ping()` both get wrong, in opposite ways.
    const port = await startTcpServer(() => {});
    const redis = await loadRedisModule(`redis://127.0.0.1:${port}`);

    const startedAt = Date.now();
    const health = await redis.checkRedisHealth();
    const elapsedMs = Date.now() - startedAt;

    expect(health).toBe('unreachable');
    // The live target group allows 5s per check. The bound asserted is the
    // PROPERTY — the probe terminates well inside that — and not which of the
    // two mechanisms delivered it: `withRedisTimeout` is 1s and the client's own
    // `commandTimeout` is 2s, so this stays green if the wrapper is removed
    // (measured). Tightening it to discriminate them would pin a 500ms margin on
    // a runner this repo's vitest config already documents as contended.
    expect(elapsedMs).toBeLessThan(4_000);
  });
});

describe('the /health snapshot', () => {
  async function readHealth(): Promise<{ status: number; body: unknown }> {
    const { default: expressModule } = await import('express');
    const { default: healthRouter } = await import('../health.js');
    const app: express.Express = expressModule();
    app.use('/health', healthRouter);

    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, () => resolve(started));
    });
    openServers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: response.status, body: await response.json() };
  }

  it('serves the unreachable verdict rather than an existence flag', async () => {
    const port = await closedPort();
    await loadRedisModule(`redis://127.0.0.1:${port}`);

    const { body } = await readHealth();

    expect(body).toMatchObject({ redis: 'unreachable' });
  });

  it('does NOT let an unreachable Redis degrade the status the ALB reads', async () => {
    const port = await closedPort();
    await loadRedisModule(`redis://127.0.0.1:${port}`);

    const { status, body } = await readHealth();

    // Postgres is stubbed healthy above, so `status` here is a statement about
    // the redis field alone. A 503 would deregister the task.
    expect(body).toMatchObject({ redis: 'unreachable', status: 'healthy' });
    expect(status).toBe(200);
  });
});
