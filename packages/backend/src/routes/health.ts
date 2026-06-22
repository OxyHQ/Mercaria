import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../lib/redis.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid recomputing the snapshot on every probe.

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
}

let healthCache: { data: HealthSnapshot; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

function getHealthSnapshot(): HealthSnapshot {
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
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', (_req, res) => {
  try {
    const snapshot = getHealthSnapshot();
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
