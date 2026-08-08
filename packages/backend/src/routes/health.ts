/**
 * Liveness, readiness and the operator-facing health snapshot.
 *
 * ## `mongodb` is gone from the payload, not renamed
 *
 * The snapshot used to report `mongodb: mongoose.connection.readyState`, and the
 * task no longer opens Mongo at all — so keeping the key under any spelling would
 * report a connection nothing uses. It is a breaking change to the body of
 * `GET /health`, deliberately: a monitor still alerting on `mongodb` should fail
 * loudly on a missing key rather than read `disconnected` forever and be muted.
 *
 * ## `/ready` answers a different question from `/health`
 *
 * `/health` is for a human reading a dashboard, so it is cached and cheap.
 * `/ready` decides whether a load balancer sends this task traffic, so it is
 * neither: it issues a real `select 1` (a pool can exist while the server behind
 * it is unreachable — the cheap synchronous answer is the one that reports ready
 * during an outage) and then asserts the MIGRATION LEDGER is current.
 *
 * The ledger half is what makes a rolling deploy safe. A task whose image expects
 * columns the database has not been migrated to yet answers every request with a
 * column error; drizzle selects by NAME, so there is no partial degradation, just
 * 500s. Failing readiness instead keeps that task out of the load balancer until
 * the migration lands, which is the point of the pre/post deploy-phase markers in
 * `db/migrate.ts` — a task AHEAD of its database must not serve, while a task
 * BEHIND its database (an old image mid-rollout, whose journal is a prefix of
 * what is applied) still reads as ready, because a `pre` migration is by
 * definition compatible with the image still serving.
 */

import { Router } from 'express';
import { assertMigrationsCurrent, checkPostgresHealth } from '../db/postgres.js';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid recomputing the snapshot on every probe.

interface HealthSnapshot {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  postgres: 'connected' | 'unavailable';
  redis: 'connected' | 'unavailable';
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

let healthCache: { data: HealthSnapshot; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

async function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  // A real round trip, not a `db !== null` flag — see `checkPostgresHealth`,
  // which never throws because an unreachable database is a health RESULT.
  const postgresConnected = await checkPostgresHealth();

  const mem = process.memoryUsage();
  const redis = getRedisClient();

  const snapshot: HealthSnapshot = {
    status: postgresConnected ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres: postgresConnected ? 'connected' : 'unavailable',
    redis: redis ? 'connected' : 'unavailable',
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', (_req, res) => {
  void (async () => {
    try {
      const snapshot = await getHealthSnapshot();
      const statusCode = snapshot.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(snapshot);
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Health check failed');
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
      });
    }
  })();
});

// Liveness probe: process is running -> 200.
// Deliberately touches nothing else: a liveness probe that queries a database
// restarts the task during a database outage, turning a recoverable dependency
// failure into a crash loop.
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness probe: this task can serve requests -> 200.
 *
 * Two conditions, reported as distinct reasons so an operator can tell "the
 * database is down" from "this image is ahead of the schema" — they call for
 * opposite responses.
 */
router.get('/ready', (_req, res) => {
  void (async () => {
    // Connectivity FIRST, and separately, so the ledger check below cannot be
    // the thing that reports an outage: it reads the ledger table, so a database
    // that is simply down would otherwise surface as `migrations_pending` and
    // send an operator to look at a deploy that is fine.
    if (!(await checkPostgresHealth())) {
      res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
      return;
    }

    try {
      await assertMigrationsCurrent();
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Readiness: migrations are not current');
      res.status(503).json({ status: 'not_ready', reason: 'migrations_pending' });
      return;
    }

    res.status(200).json({ status: 'ready' });
  })();
});

export default router;
