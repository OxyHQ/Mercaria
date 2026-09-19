/**
 * Centralized BullMQ queue names + numeric tunables for the Mercaria
 * marketplace async-job system.
 *
 * Every queue name, attempt count, backoff interval, concurrency, retention
 * count, and cadence is declared here as a named constant — no magic numbers
 * leak into the queue/worker code. Queue names contain NO colons (BullMQ
 * rejects `:` in a queue name); scheduler/job ids MAY contain colons.
 */

// --- Time helpers -----------------------------------------------------------

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MINUTES_PER_HOUR = 60;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;

// --- Queue names (NO colons) ------------------------------------------------

/**
 * Order-event notifications + rating-aggregate recomputes + low-inventory
 * alerts. High-volume, short-lived event work.
 */
export const MARKETPLACE_EVENTS_QUEUE = 'marketplace-events';

/**
 * Periodic maintenance (repeatable jobs): expire stale reservations + the daily
 * rating-aggregate sweep. Concurrency pinned to 1 so a repeatable job never
 * overlaps itself.
 */
export const MARKETPLACE_MAINTENANCE_QUEUE = 'marketplace-maintenance';

/**
 * Connector sync work: initial catalog backfills (`connection.backfill`) and
 * inbound-webhook processing (`webhook.process`). Both talk to external commerce
 * platforms (Shopify, …), so this queue is separate from the fast event queue —
 * a slow/failing external API must never starve order-event notifications.
 */
export const MARKETPLACE_SYNC_QUEUE = 'marketplace-sync';

/**
 * Digital-asset inspection (#1015 W4): reading an uploaded file's bytes and
 * measuring what is genuinely derivable from them.
 *
 * A FOURTH queue rather than a job on the sync queue, and the reason is the shape
 * of the work rather than tidiness. Everything on `marketplace-sync` is
 * IO-bound — it waits on Shopify — so three of them overlap happily. An
 * inspection is CPU-bound and memory-heavy: it holds up to
 * `MAX_INSPECTED_FILE_BYTES` of a creator's file and spends seconds walking it,
 * on a runtime with one thread. Sharing a queue would make a single 200 MB upload
 * the reason a merchant's catalogue stopped re-pricing, and the concurrency that
 * is right for one is wrong for the other.
 */
export const MARKETPLACE_DIGITAL_QUEUE = 'marketplace-digital';

// --- Events worker tunables -------------------------------------------------

/** Total attempts for an event job (1 initial + retries). */
export const EVENTS_JOB_ATTEMPTS = 5;

/** Base delay for the events exponential backoff (ms). */
export const EVENTS_BACKOFF_BASE_MS = 5 * MS_PER_SECOND;

/** Concurrency for the events worker (per process). */
export const EVENTS_WORKER_CONCURRENCY = 5;

// --- Maintenance worker tunables --------------------------------------------

/** Total attempts for a maintenance job (1 initial + retries). */
export const MAINTENANCE_JOB_ATTEMPTS = 3;

/**
 * Concurrency for the maintenance worker. MUST be 1 so a repeatable
 * maintenance job (reservation sweep, aggregate sweep) never overlaps itself.
 */
export const MAINTENANCE_WORKER_CONCURRENCY = 1;

// --- Sync worker tunables ---------------------------------------------------

/** Total attempts for a connector-sync job (1 initial + retries). */
export const SYNC_JOB_ATTEMPTS = 3;

/**
 * Base delay for the sync exponential backoff (ms). Larger than the events base:
 * a failed external-API call (rate limit, transient 5xx) should back off well
 * clear of the platform's own retry/limit windows before retrying.
 */
export const SYNC_BACKOFF_BASE_MS = 10 * MS_PER_SECOND;

/**
 * Concurrency for the sync worker (per process). Modest — external platforms
 * enforce their own per-app rate limits, so a low ceiling keeps us well within
 * them while still overlapping a backfill with live webhook processing.
 */
export const SYNC_WORKER_CONCURRENCY = 3;

// --- Digital-inspection worker tunables (#1015 W4) ---------------------------

/**
 * Total attempts for a digital-inspection job (1 initial + retries).
 *
 * Three, and they are for INFRASTRUCTURE only. Every conclusion about the file
 * itself — corrupt, too large, unsupported, a format that is not what the row
 * claims — is recorded as a verdict and the job SUCCEEDS, because a deterministic
 * parse refusal would produce the identical refusal twice more and record it
 * nowhere. What is worth retrying is a storage timeout or a database blip, which
 * is exactly the split `services/digital/inspection/bytes.ts` documents as the
 * port's contract.
 */
export const DIGITAL_JOB_ATTEMPTS = 3;

/**
 * Base delay for the digital-inspection exponential backoff (ms).
 *
 * Longer than the sync base: the failures that reach a retry here are an object
 * store or a database under pressure, and re-reading a 200 MB object five seconds
 * after the last attempt failed is how a worker turns a blip into a load problem.
 */
export const DIGITAL_BACKOFF_BASE_MS = 15 * MS_PER_SECOND;

/**
 * Concurrency for the digital-inspection worker (per process) — TWO, and the
 * number is derived rather than chosen.
 *
 * An inspection holds at most `MAX_INSPECTED_FILE_BYTES` (256 MiB) of file bytes,
 * plus the working set of the geometry census. Two concurrent jobs is therefore
 * ~512 MiB of worst-case resident file data, which a container sized for this API
 * survives; four would not, and one would make a single large upload block every
 * other creator's queue. The ceiling and this number are a PAIR — change either
 * and re-derive the other.
 */
export const DIGITAL_WORKER_CONCURRENCY = 2;

// --- Job retention ----------------------------------------------------------

/** Completed jobs retained for observability before automatic removal. */
export const REMOVE_ON_COMPLETE_COUNT = 500;

/** Failed jobs retained for debugging before automatic removal. */
export const REMOVE_ON_FAIL_COUNT = 2000;

// --- Repeatable-job cadences ------------------------------------------------

/**
 * Cadence of the reservation-sweep job: every 5 minutes a periodic job expires
 * `pending_payment` orders older than `config.orders.reservationTtlMs`.
 */
export const RESERVATION_SWEEP_INTERVAL_MS = 5 * MS_PER_MINUTE;

/** Cron for the daily rating-aggregate drift-correction sweep (03:00 daily). */
export const AGGREGATE_SWEEP_CRON = '0 3 * * *';

/**
 * Cron for the daily SCOPED review-aggregate rebuild (#76), 03:20 daily.
 *
 * Twenty minutes after the legacy sweep, not beside it: the two walk disjoint
 * sets of reviews (`findPublishedReviewTargets` excludes scoped rows, and
 * `findScopedReviewTargets` returns only them), and staggering them keeps a
 * shared Postgres from taking both scans at once for no benefit.
 */
export const SCOPED_AGGREGATE_SWEEP_CRON = '20 3 * * *';

/**
 * Cron for the #76 legacy-review classification job, 03:40 daily.
 *
 * After the aggregate sweeps, because classifying a review moves it between two
 * aggregates and the job rebuilds both itself — running it first would leave the
 * sweeps deriving figures the classification was about to invalidate.
 */
export const REVIEW_CLASSIFICATION_CRON = '40 3 * * *';

/**
 * Cadence of the connector reconcile sweep: every 6 hours a periodic job re-pulls
 * every connected `pull`/`bidirectional` product catalog. This is the SAFETY NET
 * for missed real-time webhooks — a dropped `products/*` webhook is re-converged at
 * the next sweep (re-price + delete-reconciliation). Only materializes under Redis
 * (the scheduler is Redis-only); without Redis there is no periodic sweep.
 */
export const CONNECTOR_RECONCILE_INTERVAL_MS = 6 * MS_PER_HOUR;

/**
 * Cadence of the connector webhook re-registration sweep (#262): every 15
 * minutes, a bounded pass over the connections whose registration did not finish.
 *
 * Deliberately far finer than the six-hour catalogue reconcile beside it, and not
 * folded into it. A connection with no real-time sync is a shop whose prices and
 * stock stop tracking the platform BETWEEN scheduled pulls, so the useful cadence
 * is minutes; and the retry is a capped exponential backoff, which a six-hour tick
 * would flatten into "one attempt every six hours" for the whole budget. The
 * population is derived and normally EMPTY, so a healthy deployment's pass is one
 * indexed read.
 */
export const CONNECTOR_WEBHOOK_REGISTRATION_SWEEP_INTERVAL_MS = 15 * MS_PER_MINUTE;

// --- Repeatable-job scheduler ids (colons allowed) --------------------------

/**
 * Stable scheduler ids. `upsertJobScheduler` is idempotent per id, so
 * re-registering on every boot never produces duplicate schedules.
 */
export const SCHEDULER_EXPIRE_RESERVATIONS = 'maintenance:expire-reservations';
export const SCHEDULER_RECOMPUTE_AGGREGATES = 'maintenance:recompute-aggregates';
/** Stable scheduler id for the scoped review-aggregate rebuild sweep (#76). */
export const SCHEDULER_REBUILD_REVIEW_AGGREGATES = 'maintenance:rebuild-review-aggregates';
/** Stable scheduler id for the #76 legacy-review classification job. */
export const SCHEDULER_CLASSIFY_LEGACY_REVIEWS = 'maintenance:classify-legacy-reviews';
/** Stable scheduler id for the periodic connector reconcile sweep (sync queue). */
export const SCHEDULER_CONNECTION_RECONCILE = 'sync:connection-reconcile';
/** Stable scheduler id for the #262 webhook re-registration sweep (sync queue). */
export const SCHEDULER_CONNECTION_WEBHOOK_REGISTRATION =
  'sync:connection-webhook-registration';

// --- Job names (colons allowed) ---------------------------------------------

/** Job name: recompute one target's rating aggregate. */
export const JOB_RECOMPUTE_AGGREGATES = 'recompute-aggregates';
/** Job name: deliver order-event notifications. */
export const JOB_ORDER_EVENT_NOTIFICATION = 'order-event-notification';
/** Job name: alert store managers about a low-inventory variant. */
export const JOB_LOW_INVENTORY_ALERT = 'low-inventory-alert';
/** Job name: expire stale `pending_payment` reservations (repeatable). */
export const JOB_EXPIRE_RESERVATIONS = 'expire-reservations';
/** Job name: daily full rating-aggregate sweep (repeatable). */
export const JOB_RECOMPUTE_AGGREGATES_SWEEP = 'recompute-aggregates-sweep';
/** Job name: daily SCOPED review-aggregate rebuild with drift reporting (#76, repeatable). */
export const JOB_REBUILD_REVIEW_AGGREGATES = 'rebuild-review-aggregates';
/** Job name: bounded pass of the #76 legacy-review classification (repeatable). */
export const JOB_CLASSIFY_LEGACY_REVIEWS = 'classify-legacy-reviews';
/** Job name: run an initial catalog backfill for a `pull` connection. */
export const JOB_CONNECTION_BACKFILL = 'connection.backfill';
/** Job name: periodic reconcile sweep — re-pull every connected pull catalog (repeatable). */
export const JOB_CONNECTION_RECONCILE = 'connection.reconcile';
/** Job name: re-register ONE connection's platform webhooks (#262). */
export const JOB_CONNECTION_WEBHOOK_REREGISTER = 'connection.webhook-reregister';
/** Job name: periodic sweep — re-register every unfinished registration (#262, repeatable). */
export const JOB_CONNECTION_WEBHOOK_REGISTRATION_SWEEP = 'connection.webhook-registration-sweep';
/** Job name: audit ONE connection's live webhook subscriptions (#295). */
export const JOB_CONNECTION_WEBHOOK_AUDIT = 'connection.webhook-audit';
/** Job name: process one inbound platform webhook (product/order create/update/delete). */
export const JOB_WEBHOOK_PROCESS = 'webhook.process';
/** Job name: push a store listing OUT to its push/bidirectional connections. */
export const JOB_PRODUCT_PUSH = 'product.push';
/** Job name: pull orders from a `pull` connection into Mercaria. */
export const JOB_ORDER_SYNC = 'order.sync';
/** Job name: pull inventory levels from a `pull` connection into Mercaria. */
export const JOB_INVENTORY_SYNC = 'inventory.sync';
/** Job name: push a Mercaria order's fulfillment OUT to its origin connection. */
export const JOB_FULFILLMENT_PUSH = 'fulfillment.push';

/**
 * Job name: inspect ONE uploaded asset file (#1015 W4).
 *
 * The unit of work, of failure and of idempotence is a FILE: `recordFileInspection`
 * upserts on `(file_id, processor_name, processor_version)`, so a retried job
 * converges on one row, and one corrupt file cannot cost its siblings their
 * measurements.
 */
export const JOB_ASSET_FILE_INSPECT = 'digital.asset-file-inspect';

/**
 * Job name: fan one asset VERSION out to one inspection job per file (#1015 W4).
 *
 * A separate job rather than a loop at the call site, so the caller that finishes
 * an upload enqueues one thing and the enumeration happens on a worker. It
 * deliberately does not advance the version's state — see `inspectAssetVersion`.
 */
export const JOB_ASSET_VERSION_INSPECT = 'digital.asset-version-inspect';
