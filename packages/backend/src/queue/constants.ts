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

// --- Repeatable-job scheduler ids (colons allowed) --------------------------

/**
 * Stable scheduler ids. `upsertJobScheduler` is idempotent per id, so
 * re-registering on every boot never produces duplicate schedules.
 */
export const SCHEDULER_EXPIRE_RESERVATIONS = 'maintenance:expire-reservations';
export const SCHEDULER_RECOMPUTE_AGGREGATES = 'maintenance:recompute-aggregates';

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
