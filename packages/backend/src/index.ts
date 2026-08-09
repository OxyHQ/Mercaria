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

      // Evaluate queued matching subjects (#58). On EVERY task, same lease
      // shape. The LOOP is gated by `MATCH_PIPELINE_ENABLED` and the queue never
      // is, so requests taken while matching is paused drain once it is switched
      // on. This is the loop that closes #57's `native_listing_links` seam: an
      // automatic match writes the attachment and asks the offer converger to
      // run, which is how a native listing becomes a native offer end to end.
      import('./services/matching/match-queue-dispatcher.js')
        .then(({ startMatchQueueDispatcher }) => startMatchQueueDispatcher())
        .catch((err) => log.general.error({ err }, 'Match queue dispatcher import failed'));

      // Page open catalogue-backfill runs (#60). On EVERY task, same lease
      // shape. The LOOP is gated by `CANONICAL_GRAPH_ENABLED` and the run rows
      // never are, so an operator can open a run while the loop is off and it
      // resumes from its cursor once the flag goes on. A canary rollout does not
      // use this loop at all — it pages by hand from `/internal/backfill` — so
      // this exists for the unattended remainder and for resuming after a
      // deploy.
      import('./services/backfill/backfill-dispatcher.js')
        .then(({ startCatalogBackfillDispatcher }) => startCatalogBackfillDispatcher())
        .catch((err) => log.general.error({ err }, 'Catalog backfill dispatcher import failed'));
      // Run operator merge and split jobs (#59). On EVERY task, same lease
      // shape. The LOOP is gated by `CURATION_JOBS_ENABLED` and the REQUEST
      // never is, so a merge an operator scheduled while the loop was off runs
      // when it comes back — the outbox inversion, applied to a job an operator
      // is waiting on. A job BLOCKED on an undecided conflict is deliberately
      // not claimable: retrying a judgement only a person can make would spin
      // this loop and bury real faults among things waiting for review.
      import('./services/curation/curation-dispatcher.js')
        .then(({ startCurationDispatcher }) => startCurationDispatcher())
        .catch((err) => log.general.error({ err }, 'Curation dispatcher import failed'));
      // Schedule and page external ingestion runs (#62). On EVERY task, same
      // lease shape, and TWO claims rather than one: a source lease says which
      // task feeds a source, a run lease says which task is driving the current
      // pass, and a pass outlives a tick. The LOOP is gated by
      // `CATALOG_INGESTION_ENABLED` and neither the source configuration, its
      // reviewed policy nor an open run ever is, so turning the flag on drains
      // the backlog rather than stranding it.
      import('./services/ingestion/ingest-dispatcher.js')
        .then(({ startCatalogIngestionDispatcher }) => startCatalogIngestionDispatcher())
        .catch((err) => log.general.error({ err }, 'Catalog ingestion dispatcher import failed'));

      // Turn refresh TASKS into ingestion RUNS (#68). On EVERY task, with the
      // same lease shape: a claim is `FOR UPDATE SKIP LOCKED` with an owner
      // check, so N tasks share one queue and a dead task's lease is
      // reclaimed. `OFFER_REFRESH_ENABLED` gates the LOOP and nothing durable —
      // an alert raised while it is off is served when it comes back.
      import('./services/offer-freshness/refresh-dispatcher.js')
        .then(({ startOfferRefreshDispatcher }) => startOfferRefreshDispatcher())
        .catch((err: unknown) =>
          log.general.error({ err }, 'Offer refresh dispatcher import failed'),
        );

      // Retire offers whose source's own policy has lapsed, WITH its outage
      // grace (#68). Turning this off cannot make a stale offer visible: the
      // freshness verdict is derived at read time against the live policy, so
      // the sweep only decides when the durable retirement is written down.
      import('./services/offer-freshness/expiry-sweep.js')
        .then(({ startOfferExpirySweep }) => startOfferExpirySweep())
        .catch((err: unknown) => log.general.error({ err }, 'Offer expiry sweep import failed'));
      // Register the universal product-feed adapter (#63) and start its staged-
      // pass sweep. BOTH are gated by `FEED_IMPORT_ENABLED` and neither is a
      // durable record: with the flag off, feed configurations, mapping
      // versions, uploads and reports are all still stored and readable, every
      // run refuses with `adapter_missing`, and turning it on drains the
      // backlog. The sweep exists because a stage is a file on this task's own
      // disk, and a task whose disk fills with abandoned stages stops serving
      // requests.
      import('./services/feed-import/register.js')
        .then(({ registerProductFeedAdapter, startFeedStageSweeper }) => {
          registerProductFeedAdapter();
          startFeedStageSweeper();
        })
        .catch((err) => log.general.error({ err }, 'Feed import adapter registration failed'));

      // Register the eBay Browse adapter (#65). A CALL rather than a module side
      // effect, and for #62's own reason one direction over: an adapter that
      // registered itself on import would be live in every process that pulled
      // the module graph in, including the migration runner and a test that only
      // wanted the normalizer. It is a no-op with `EBAY_ENABLED=false`, which is
      // the default and which leaves every eBay source configurable, reviewable
      // and refusing its runs with `adapter_missing`.
      import('./services/ebay/register.js')
        .then(({ registerEbayBrowseAdapter }) => {
          registerEbayBrowseAdapter();
        })
        .catch((err: unknown) =>
          log.general.error({ err }, 'eBay Browse adapter registration failed'),
        );
      // Register the Awin retailer-network adapter (#66). Gated by
      // `AWIN_ENABLED` and, like #63's, gating nothing durable: with the flag
      // off, publisher accounts, advertisers, feeds, quality snapshots, samples
      // and every #62 row are still stored and readable, every run refuses with
      // `adapter_missing`, and turning it on drains the backlog. Unlike #63 it
      // demands no credential up front — Awin's key is a LOCATOR on a row, so a
      // configuration is storable and reviewable with none present, and a
      // deployment that registers the adapter early gets an honest
      // `auth_failure` naming the missing secret rather than a silent no-op.
      import('./services/awin/register.js')
        .then(({ registerAwinFeedAdapter }) => {
          registerAwinFeedAdapter();
        })
        .catch((err: unknown) => log.general.error({ err }, 'Awin adapter registration failed'));

      // Hand back lapsed supplier holds, release lapsed quotes and evaluate
      // supplier health (#122). On EVERY task, and deliberately WITHOUT a lease:
      // every action it takes is an idempotent compare-and-swap, so N tasks
      // running it produce the same end state as one, and a dead task strands
      // nothing. The LOOP is gated by `SUPPLIER_PREFLIGHT_SWEEP_ENABLED`; what
      // it records is not — a quote's expiry and a hold's supplier deadline are
      // both read against the clock at every use, so turning this off cannot
      // make a stale quote usable, it only stops Mercaria writing down that it
      // lapsed.
      import('./services/supplier-preflight/preflight-sweep.js')
        .then(({ startSupplierPreflightSweep }) => {
          startSupplierPreflightSweep();
        })
        .catch((err: unknown) =>
          log.general.error({ err }, 'Supplier preflight sweep import failed'),
        );

      // Deliver the guest portal's transactional messages (#108). On EVERY
      // task, leased through `FOR UPDATE SKIP LOCKED` like the outboxes above.
      // The LOOP is gated by `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED` and the
      // ROW never is: messages keep being enqueued while it is off and drain
      // when it comes back, so an incident that stops mail going out does not
      // also erase what was owed. With no transport registered — the shipped
      // state, see `services/guest-portal/transport.ts` — every attempt fails
      // `transport_unconfigured` visibly rather than pretending to send.
      import('./services/guest-portal/message.service.js')
        .then(({ startGuestPortalMessageDispatcher }) => startGuestPortalMessageDispatcher())
        .catch((err: unknown) =>
          log.general.error({ err }, 'Guest portal message dispatcher import failed'),
        );

      // Place, cancel, poll and interpret supplier orders (#124). THREE loops,
      // on EVERY task, each gated by its own lever and none of them gating a
      // durable record: with the orchestration off a paid retail order's job is
      // parked, with provider fetch off webhooks are still received and stored,
      // and with event processing off events accumulate and nothing
      // customer-visible moves. The per-supplier kill switch is a different
      // mechanism (`supplier_accounts.state = 'killed'`) and stops NEW
      // submissions while status, cancellation and reconciliation carry on.
      import('./services/supplier-orders/dispatcher.js')
        .then(({ startProcurementDispatchers }) => startProcurementDispatchers())
        .catch((err: unknown) =>
          log.general.error({ err }, 'Procurement dispatcher import failed'),
        );

      // Close #124's two ports with #123's real implementations (ADR 0004 D4).
      //
      // UNCONDITIONAL, and deliberately not behind `MERCARIA_RETAIL_ENABLED`.
      // That flag gates checkout ENTRY (D4 concern 13, D13): a rollback must
      // leave in-flight procurement, refunds and reconciliation draining, and
      // registering these behind it would mean turning retail off stopped
      // authorizing procurement for orders whose buyers had already been
      // charged — the exact opposite of "in-flight POs finish or cancel".
      //
      // On a deployment that has never placed a retail order both are inert:
      // the authorization reader answers `order_not_retail` for every order it
      // is asked about, and the outcome consumer finds no procurement intent
      // and returns.
      import('./services/retail-checkout/registration.js')
        .then(({ registerRetailProcurementPorts }) => registerRetailProcurementPorts())
        .catch((err: unknown) =>
          log.general.error({ err }, 'Retail procurement port registration failed'),
        );

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

      // Discovery analytics (#77). THREE loops, all no-ops when
      // `ANALYTICS_ENABLED` is false — production collection stays off until
      // the privacy and retention review clears (acceptance 8).
      //
      // The sink is the one that matters for correctness: it is what makes
      // "analytics loss or delay never blocks search, checkout, the order
      // portal or outbound navigation" (acceptance 7) true, by moving every
      // write off the request path into a bounded in-process queue that DROPS
      // rather than growing. It runs on every task because the queue is
      // process-local — there is nothing to coordinate and no lease to take.
      import('./services/analytics/sink.js')
        .then(({ startAnalyticsSink }) => startAnalyticsSink())
        .catch((err) => log.general.error({ err }, 'Analytics sink import failed'));

      // Roll a completed day's events into metric buckets. Leased per RUN, like
      // the reconciliation sweeps, so N tasks share it. This is what makes the
      // retention sweep safe: the numbers are written before the rows they came
      // from expire (data-lifecycle rule 2).
      import('./services/analytics/rollup.js')
        .then(({ startAnalyticsRollup }) => startAnalyticsRollup())
        .catch((err) => log.general.error({ err }, 'Analytics rollup import failed'));

      // Null expired search-query text in place. The one retention operation the
      // shared expiry sweep cannot perform — it deletes rows, and this is a
      // redaction that leaves the row and its normalized tokens standing.
      import('./services/analytics/retention.js')
        .then(({ startAnalyticsRetention }) => startAnalyticsRetention())
        .catch((err) => log.general.error({ err }, 'Analytics retention import failed'));

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

        // Stop every background loop before the pool they query through
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
        const { stopCurationDispatcher } = await import(
          './services/curation/curation-dispatcher.js'
        );
        stopCurationDispatcher();
        const { stopStripeAccountReconciler } = await import(
          './services/payments/stripe/account-reconciler.js'
        );
        stopStripeAccountReconciler();
        const { stopPaymentReconciler } = await import(
          './services/payments/reconciliation/runner.js'
        );
        stopPaymentReconciler();
        const { stopOfferOutboxDispatcher } = await import(
          './services/offers/offer-outbox-dispatcher.js'
        );
        stopOfferOutboxDispatcher();
        const { stopMatchQueueDispatcher } = await import(
          './services/matching/match-queue-dispatcher.js'
        );
        stopMatchQueueDispatcher();
        const { stopCatalogBackfillDispatcher } = await import(
          './services/backfill/backfill-dispatcher.js'
        );
        stopCatalogBackfillDispatcher();
        const { stopSupplierPreflightSweep } = await import(
          './services/supplier-preflight/preflight-sweep.js'
        );
        stopSupplierPreflightSweep();
        const { stopCatalogIngestionDispatcher } = await import(
          './services/ingestion/ingest-dispatcher.js'
        );
        stopCatalogIngestionDispatcher();
        const { stopFeedStageSweeper } = await import('./services/feed-import/register.js');
        stopFeedStageSweeper();
        stopExpirySweeper();
        // Analytics last of the loops, and the sink's stop AWAITS one final
        // flush — the only place in this domain anything waits on telemetry.
        // Safe because the flush's own failure is already swallowed and the
        // queue is bounded, so the wait is bounded too; a shutdown that hung on
        // telemetry would be the bug this domain exists to prevent, one
        // lifecycle stage later.
        const { stopAnalyticsRollup } = await import('./services/analytics/rollup.js');
        stopAnalyticsRollup();
        const { stopAnalyticsRetention } = await import('./services/analytics/retention.js');
        stopAnalyticsRetention();
        const { stopAnalyticsSink } = await import('./services/analytics/sink.js');
        await stopAnalyticsSink();
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
