import http from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectPostgres } from './db/postgres.js';
import { startExpirySweeper, stopExpirySweeper } from './db/expirySweeper.js';
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
 * Open the store before serving traffic.
 *
 * ONE store. Every route this API serves reads and writes Postgres — including
 * the payment domain and its balanced ledger. There is no second connect call
 * beside this one and no store to fall back to.
 *
 * `config.postgres.url` is required at config load, so an unconfigured task
 * never reaches here — a task that served checkout without it would take a POS
 * sale, fail to record the payment, and answer 500 from inside a completed
 * transaction. `connectPostgres` then issues a real `select 1` before publishing
 * its handle, so an unREACHABLE database also fails at startup rather than on
 * the first user request.
 */
connectPostgres()
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
      // a claim is a `FOR UPDATE SKIP LOCKED` lease with an owner check, so N
      // tasks share the work and a dead task's lease is reclaimed. No-ops when
      // CrowdSource is off — the LOOP is gated, never the durable record, so
      // reports taken while it is disabled deliver once it is switched on.
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

      // Converge native offers (#57). The third dispatcher, on the same lease
      // shape as the two above and gated the same way — a catalogue write keeps
      // enqueuing while `OFFER_MATERIALIZATION_ENABLED` is off, so switching it
      // on drains the backlog rather than stranding it. Unlike the two above,
      // its jobs are a FIXED POINT rather than a delivery: one row per listing,
      // and running it twice changes nothing the second time.
      import('./services/offers/offer-outbox-dispatcher.js')
        .then(({ startOfferOutboxDispatcher }) => startOfferOutboxDispatcher())
        .catch((err) => log.general.error({ err }, 'Offer outbox dispatcher import failed'));

      // Retry stored Stripe events whose processing failed, and pick up any
      // whose task died between storing and interpreting them. Also on EVERY
      // task, same lease shape. The webhook ingress processes inline after
      // storing, so on a healthy path this loop finds nothing — it exists so
      // that "a 200 means stored, never processed" is a mechanism rather than a
      // comment. No-ops entirely when Stripe is not configured.
      import('./services/payments/stripe/event-dispatcher.js')
        .then(({ startStripeEventDispatcher }) => startStripeEventDispatcher())
        .catch((err) => log.general.error({ err }, 'Stripe event dispatcher import failed'));

      // Re-read connected accounts Stripe has not told us about lately. A missed
      // `account.updated` is silent by construction — nothing here knows about
      // an event it never received — so the only thing that can notice is a
      // sweep that does not depend on having been told (ADR 0001, sequence 6).
      // Needs no lease: a sync is an OBSERVATION, and the repository's
      // compare-and-swap on `last_synced_at` keeps the freshest one whichever
      // task wrote it. No-ops entirely when Stripe is not configured.
      import('./services/payments/stripe/account-reconciler.js')
        .then(({ startStripeAccountReconciler }) => startStripeAccountReconciler())
        .catch((err) => log.general.error({ err }, 'Stripe account reconciler import failed'));

      // Compare Mercaria's payments, transfers, refunds, payouts and ledger
      // against what the rail actually holds (#50). Webhooks are the normal
      // event path and are not a substitute for this: an event that was never
      // delivered is invisible to everything that waits to be told, which is why
      // ADR 0001's operational appendix makes reconciliation a requirement
      // rather than a nicety.
      //
      // On EVERY task, like the dispatchers, but leased per JOB — these sweeps
      // page through a provider list with a shared cursor, so unlike an account
      // sync two tasks running one concurrently would each skip the pages the
      // other consumed. No-ops entirely when Stripe is not configured.
      import('./services/payments/reconciliation/runner.js')
        .then(({ startPaymentReconciler }) => startPaymentReconciler())
        .catch((err) => log.general.error({ err }, 'Payment reconciler import failed'));

      // Reap expired rows. Postgres has no TTL index, so nothing sweeps unless
      // this loop does — without it the tables in `db/expiryTargets.ts` grow
      // forever, with no error and no failing test.
      // Started on every task for the same reason as the dispatchers: the delete
      // is idempotent, so a leader would only add a way for nobody to sweep at
      // all.
      startExpirySweeper();

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

        // Stop all FOUR background loops before the pool they query through
        // goes. They share the pool `closePostgres` is about to end, so a loop
        // still claiming or sweeping would throw on a closed connection during
        // every shutdown. A dispatcher's stop only stops it claiming NEW work — the
        // row already in flight is allowed to reach a durable state rather than
        // leaving a held lease for another task to wait out.
        const { stopModerationOutboxDispatcher } = await import(
          './services/moderation/outbox-dispatcher.js'
        );
        stopModerationOutboxDispatcher();
        const { stopPaymentOutboxDispatcher } = await import(
          './services/payments/outbox-dispatcher.js'
        );
        stopPaymentOutboxDispatcher();
        const { stopStripeEventDispatcher } = await import(
          './services/payments/stripe/event-dispatcher.js'
        );
        stopStripeEventDispatcher();
        const { stopStripeAccountReconciler } = await import(
          './services/payments/stripe/account-reconciler.js'
        );
        stopStripeAccountReconciler();
        const { stopPaymentReconciler } = await import(
          './services/payments/reconciliation/runner.js'
        );
        stopPaymentReconciler();
        stopExpirySweeper();
        log.general.info('Background loops stopped');

        // Close the Postgres pool, last: everything above may still be draining
        // through it, and connections left open are held against the instance
        // until the task is killed.
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
    log.general.error({ err: error }, 'Failed to connect to PostgreSQL');
    process.exit(1);
  });
