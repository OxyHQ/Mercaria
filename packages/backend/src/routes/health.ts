import { Router } from 'express';
import mongoose from 'mongoose';
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

interface HealthSnapshot {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  mongodb: 'connected' | 'connecting' | 'disconnecting' | 'disconnected';
  redis: 'connected' | 'unavailable';
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  /** Present only when a payment rail with an inbound event stream is configured. */
  payments?: {
    webhooks: WebhookHealth;
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

async function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const mongoState = mongoose.connection.readyState;
  const mongoStatus = mongoState === 1 ? 'connected'
    : mongoState === 2 ? 'connecting'
    : mongoState === 3 ? 'disconnecting'
    : 'disconnected';

  const mem = process.memoryUsage();
  const redis = getRedisClient();
  const redisStatus = redis ? 'connected' : 'unavailable';

  const isHealthy = mongoState === 1;
  const webhooks = await getWebhookHealth();

  const snapshot: HealthSnapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    mongodb: mongoStatus,
    redis: redisStatus,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
    ...(webhooks ? { payments: { webhooks } } : {}),
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', async (_req, res) => {
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
});

// Liveness probe: process is running -> 200
// Used by k8s/DO App Platform to detect crashed processes
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: MongoDB connected -> 200
// Used by load balancers to decide if this instance should receive traffic
router.get('/ready', (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  if (!mongoReady) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }
  res.status(200).json({ status: 'ready' });
});

export default router;
