import http from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';
import { connectPostgres } from './db/postgres.js';
import { config } from './config/index.js';
import { createApp } from './app.js';
import { log } from './lib/logger.js';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification.js';


// Socket.io
import { initSocket } from './socket.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

const app = createApp();
// Local dev default only — ECS injects PORT explicitly (oxy-infra
// terraform-uswest2/app-services.tf sets it to 3001). 4160 is Mercaria's slot
// in the per-app port map so several Oxy backends can run side by side.
const PORT = parseInt(process.env.PORT || '4160', 10);

// Create HTTP server with optimized settings
const server = http.createServer({
  // Increase max header size for long authentication tokens
  maxHeaderSize: 16384,
  keepAlive: true,
  keepAliveTimeout: 65000, // Slightly higher than default
}, app);

// Handle HTTP server errors (e.g. EADDRINUSE)
server.on('error', (error: NodeJS.ErrnoException) => {
  log.general.error({ err: error }, '[Server] HTTP server error');
  if (error.code === 'EADDRINUSE') {
    log.general.error({ port: PORT }, 'Port already in use');
    process.exit(1);
  }
});

server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server);

// The middleware chain and routes live in `app.ts` so they can be built without
// listening — see that file for why the webhook mount order is asserted there.

// Process-level error handlers — prevent crashes from taking down all users.
process.on('unhandledRejection', (reason) => {
  // AbortError: intentional cancellation — suppress
  if (isAbortError(reason)) return;

  // Fatal: OOM, worker failures — must exit
  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  // Transient network: ECONNRESET, ETIMEDOUT, etc.
  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  // Everything else: log as error but keep running
  log.general.error({ reason: reason instanceof Error ? reason : String(reason) }, '[Process] Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

/**
 * Open both stores before serving traffic.
 *
 * Mercaria is mid-migration and BOTH are live. Mongo is still where orders,
 * listings and everything else lives; the PAYMENT domain — payments, attempts,
 * provider events, transfers, payouts and the balanced ledger — is
 * Postgres-native, and `DATABASE_URL` is therefore no longer optional.
 *
 * Its absence is a HARD failure rather than a degraded boot. A task that served
 * checkout without it would take a POS sale, fail to record the payment, and
 * answer 500 from inside a completed transaction — which reads as an outage of
 * the register rather than as the misconfiguration it is. Failing at boot puts
 * the error where an operator can act on it.
 *
 * `connectPostgres` issues a real `select 1` before publishing its handle, so an
 * unreachable database fails HERE rather than on the first user request.
 */
async function connectStores(): Promise<void> {
  await connectDB();
  if (!config.postgres.url) {
    throw new Error(
      'DATABASE_URL is not set. The payment domain and its ledger are served from ' +
        'PostgreSQL; a task without it cannot record a payment. Start a local server ' +
        'with: docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }
  await connectPostgres();
}

connectStores()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log.general.info({ port: PORT }, `API Server running on http://0.0.0.0:${PORT}`);
      // Verify Redis connectivity (non-blocking)
      import('./lib/redis.js').then(({ getRedisClient }) => {
        const redis = getRedisClient();
        if (redis) {
          redis.ping()
            .then(() => log.general.info('Redis readiness check passed'))
            .catch((err) => log.general.warn({ err }, 'Redis readiness check failed — rate limiting will fail-open'));
        } else {
          log.general.info('Redis not configured (REDIS_URL not set) — rate limiting disabled');
        }
      }).catch((err) => log.general.error({ err }, 'Redis readiness import failed'));

      // Drain the moderation outbox. Started on EVERY task, not just a leader:
      // claims are Mongo leases with an owner check, so N tasks share the work
      // and a dead task's lease is reclaimed. No-ops when CrowdSource is off —
      // the LOOP is gated, never the durable record, so reports taken while it
      // is disabled deliver once it is switched on.
      import('./services/moderation/outbox-dispatcher.js')
        .then(({ startModerationOutboxDispatcher }) => startModerationOutboxDispatcher())
        .catch((err) =>
          log.general.error({ err }, 'Moderation outbox dispatcher import failed'),
        );

      // Drain the payment outbox. Started on EVERY task, for the same reason
      // the moderation one is: claims are Postgres leases with an owner check,
      // so N tasks share the work and a dead task's lease is reclaimed. The LOOP
      // is gated by config, never the durable record — rows written while it is
      // off deliver once it is switched on.
      import('./services/payments/outbox-dispatcher.js')
        .then(({ startPaymentOutboxDispatcher }) => startPaymentOutboxDispatcher())
        .catch((err) =>
          log.general.error({ err }, 'Payment outbox dispatcher import failed'),
        );

      // Start marketplace queue workers when Redis is configured; otherwise
      // async jobs run inline via the producers.
      import('./queue/connection.js').then(({ isQueueEnabled }) => {
        if (isQueueEnabled()) {
          import('./queue/workers.js').then(({ startWorkers }) => startWorkers())
            .catch((err) => log.general.error({ err }, 'startWorkers import failed'));
        } else {
          log.general.info('Marketplace queue disabled (REDIS_URL not set) — async jobs run inline');
        }
      }).catch((err) => log.general.error({ err }, 'Queue connection import failed'));
    });

    // Graceful shutdown handler
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.general.info(`Received ${signal}. Starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        log.general.info('HTTP server closed (no new connections)');
      });

      // Give in-flight requests 30 seconds to complete
      const forceTimeout = setTimeout(() => {
        log.general.error('Force exit after 30s grace period');
        process.exit(1);
      }, 30_000);
      forceTimeout.unref();

      try {
        // Close Socket.IO connections
        const { getIO } = await import('./socket.js');
        const io = getIO();
        if (io) {
          await new Promise<void>((resolve) => io.close(() => resolve()));
          log.general.info('Socket.IO closed');
        }

        // Stop marketplace queue workers BEFORE closing Redis.
        const { shutdownQueues } = await import('./queue/workers.js');
        await shutdownQueues();
        log.general.info('Marketplace queues closed');

        // Close Redis connections
        const { closeRedis } = await import('./lib/redis.js');
        await closeRedis();
        log.general.info('Redis connections closed');

        // Stop claiming new payment work, then close both stores.
        const { stopPaymentOutboxDispatcher } = await import(
          './services/payments/outbox-dispatcher.js'
        );
        stopPaymentOutboxDispatcher();

        // Close MongoDB connection
        const mongoose = await import('mongoose');
        await mongoose.default.connection.close();
        log.general.info('MongoDB connection closed');

        // Close the PostgreSQL pool
        const { closePostgres } = await import('./db/postgres.js');
        await closePostgres();
        log.general.info('PostgreSQL pool closed');

        clearTimeout(forceTimeout);
        log.general.info('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        log.general.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    log.general.error({ err: error }, 'Failed to open the MongoDB and PostgreSQL stores');
    process.exit(1);
  });
