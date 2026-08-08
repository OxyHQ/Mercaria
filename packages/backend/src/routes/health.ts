/**
 * Liveness, readiness and the operator-facing health snapshot.
 *
 * The snapshot names only stores this task actually opens. A key reporting a
 * connection nothing uses is worse than a missing one: a monitor reading it goes
 * green forever instead of failing loudly.
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
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid recomputing the snapshot on every probe.

/**
 * Inbound provider-event queue health (issue #48, security and operations 4).
 *
 * Exposed here rather than on a bespoke endpoint because this is the payload an
 * operator and every uptime check already read, and a number nobody looks at is
 * not observability. Four figures, because they fail differently: `lagSeconds`
 * climbing means the dispatcher has stopped or is losing; `failed` means
 * handlers are erroring but recovering; `deadLetter` is work that will not
 * happen without a person; `oldestUnprocessedAt` is what an operator needs to
 * decide whether either of the last two is old news or happening now.
 */
interface WebhookHealth {
  pending: number;
  failed: number;
  deadLetter: number;
  oldestUnprocessedAt: string | null;
  lagSeconds: number;
}

/**
 * Reconciliation health, COARSE — issue #50's metric 5, reduced to three values.
 *
 * `/health` is public and is read by uptime checks, so it gets the shape of the
 * problem and none of its detail: how many findings are outstanding, how many of
 * them are `critical`, and how long the oldest has been outstanding. The full
 * per-kind breakdown, the correlation keys and the figures behind each finding
 * are on `GET /internal/payments/metrics`, behind the operator gate.
 *
 * Three integers and an instant carry no personal data by construction, which is
 * the same reason the webhook counts above are safe here — and `oldestOpenAt` is
 * the field that turns a count into a decision, because a hundred findings from
 * an hour ago and one from three weeks ago need opposite responses.
 */
interface ReconciliationHealth {
  /** Everything not resolved. */
  open: number;
  /** Of those, the ones that are money being wrong NOW. */
  critical: number;
  /** When the oldest outstanding finding was FIRST seen. */
  oldestOpenAt: string | null;
}

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
  /** Present only when a payment rail with an inbound event stream is configured. */
  payments?: {
    webhooks: WebhookHealth;
    discrepancies?: ReconciliationHealth;
  };
}

let healthCache: { data: HealthSnapshot; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * Read the Stripe event queue's depth, or nothing.
 *
 * Never throws and never degrades the probe. The queue counts are diagnostics
 * about a payment rail, not a statement about whether this task can serve
 * requests — so a Postgres hiccup while reading them must not turn a healthy
 * instance into one the load balancer pulls out of rotation. The 10-second
 * snapshot cache is also what bounds how often this query runs.
 */
async function getWebhookHealth(): Promise<WebhookHealth | undefined> {
  if (!config.payments.stripe.enabled) return undefined;
  try {
    const { stripeWebhookStats } = await import('../services/payments/stripe/event-processor.js');
    return { ...(await stripeWebhookStats()) };
  } catch (error: unknown) {
    log.general.warn({ err: error }, 'Stripe webhook stats unavailable for the health probe');
    return undefined;
  }
}

/**
 * Read the outstanding discrepancy counts, or nothing.
 *
 * Same contract as `getWebhookHealth` above, for the same reason: these are
 * diagnostics ABOUT a payment rail, not a statement about whether this task can
 * serve requests, so a Postgres hiccup while reading them must not pull a
 * healthy instance out of the load balancer. The 10-second snapshot cache is
 * also what bounds how often the aggregate runs.
 */
async function getReconciliationHealth(): Promise<ReconciliationHealth | undefined> {
  if (!config.payments.stripe.enabled) return undefined;
  try {
    const { discrepancyStats } = await import('../db/payments/discrepancyRepository.js');
    const { getDb } = await import('../db/postgres.js');
    const stats = await discrepancyStats(getDb());
    return { open: stats.open, critical: stats.critical, oldestOpenAt: stats.oldestOpenAt };
  } catch (error: unknown) {
    log.general.warn({ err: error }, 'Discrepancy stats unavailable for the health probe');
    return undefined;
  }
}

async function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  // A real round trip, not a `db !== null` flag — see `checkPostgresHealth`,
  // which never throws because an unreachable database is a health RESULT.
  const postgresConnected = await checkPostgresHealth();

  const mem = process.memoryUsage();
  const redis = getRedisClient();
  const [webhooks, discrepancies] = await Promise.all([
    getWebhookHealth(),
    getReconciliationHealth(),
  ]);

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
    ...(webhooks
      ? { payments: { webhooks, ...(discrepancies ? { discrepancies } : {}) } }
      : {}),
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
