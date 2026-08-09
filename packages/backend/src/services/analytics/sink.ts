/**
 * The analytics sink — the ONE reason "analytics loss or delay never blocks
 * search, checkout, the order portal or outbound navigation" (#77 acceptance 7)
 * is a property of the code rather than of everybody's discipline.
 *
 * ## The signature is the guarantee
 *
 * `recordAnalyticsEvent` returns `void`, not `Promise<void>`. A caller
 * therefore has NOTHING to await: there is no promise to forget an `await` on,
 * no promise to accidentally `await`, and no rejection to leak into a commerce
 * handler's `catch`. That is deliberate and it is the whole design — a
 * `Promise<void>` sink is one `await` away from putting a database write on the
 * checkout path, and that `await` gets added by someone debugging a flaky test.
 *
 * Everything else here follows from that one decision.
 *
 * ## Bounded, and it DROPS rather than growing
 *
 * The in-process queue has a hard cap. When it is full the OLDEST pending event
 * is discarded and a counter moves. Dropping the oldest rather than refusing the
 * newest is the right way round for telemetry: during an incident the most
 * recent events are the ones anybody will look at, and a queue that refuses new
 * work while holding stale work is the worst of both.
 *
 * Unbounded would be the intuitive choice and is the dangerous one — a Postgres
 * outage would turn a telemetry write into a memory leak and take the API down
 * with it, which is the failure this module exists to make impossible.
 *
 * ## Loss is ACCEPTABLE here, and that is an argued position
 *
 * A task killed mid-flush loses its buffered events. That is tolerable for
 * exactly one reason, and it is the reason ADR 0001 gives: **financial truth
 * does not live here.** Native paid orders, refunds and marketplace revenue are
 * read from `payments`, `orders`, `refunds` and the ledger — every metric that
 * counts money names one of those as its source, and none of them is
 * reconstructed from an event. What is lost is a fraction of a rate metric's
 * denominator, and the metric definitions say so.
 *
 * If a future metric ever genuinely needed at-least-once delivery, the answer
 * would be a durable outbox row written in the commerce transaction — the
 * moderation and payment outbox shape — and NOT making this queue reliable.
 * The two mechanisms answer different questions and must not be merged.
 *
 * ## Failures are logged and dropped, never propagated
 *
 * The flush's `catch` is the one place in this domain that deliberately
 * swallows an error. It logs it at `error` with the batch size and the reason,
 * and increments `analyticsDroppedEvents`. It does not rethrow, because there
 * is no caller left to rethrow to — the request that produced the event
 * returned long ago, which is the point.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  insertAnalyticsEvents,
  type AnalyticsEventInsert,
} from '../../db/analytics/eventRepository.js';
import {
  insertSearchQueries,
  type AnalyticsSearchQueryInsert,
} from '../../db/analytics/searchQueryRepository.js';

/**
 * How the sink writes. Injectable so a test can make the write THROW and assert
 * the commerce path still succeeds — acceptance 7's own test.
 *
 * Not a general-purpose plugin point: the only two implementations are the real
 * repositories and a test double, and the interface exists so the second one can
 * exist at all.
 */
export interface AnalyticsWriter {
  writeEvents(events: readonly AnalyticsEventInsert[]): Promise<number>;
  writeSearchQueries(records: readonly AnalyticsSearchQueryInsert[]): Promise<number>;
}

const POSTGRES_WRITER: AnalyticsWriter = {
  writeEvents: insertAnalyticsEvents,
  writeSearchQueries: insertSearchQueries,
};

let writer: AnalyticsWriter = POSTGRES_WRITER;

/** Swap the writer. Tests only; production never calls it. */
export function setAnalyticsWriter(next: AnalyticsWriter): void {
  writer = next;
}

/** Restore the Postgres writer. */
export function resetAnalyticsWriter(): void {
  writer = POSTGRES_WRITER;
}

/** The bounded queues. Two, because the two tables are written independently. */
let eventQueue: AnalyticsEventInsert[] = [];
let queryQueue: AnalyticsSearchQueryInsert[] = [];

/**
 * Process-local counters.
 *
 * Local rather than stored, for `ledgerImbalanceAttempts`' reason: the write
 * that would record them is precisely the write that failed. They are exposed on
 * the operator metrics endpoint and in the flush log line, which is where a
 * silently-dropping sink actually gets noticed.
 */
let droppedForCapacity = 0;
let droppedForFailure = 0;
let flushedEvents = 0;
let flushFailures = 0;

let timer: NodeJS.Timeout | undefined;
let flushing = false;

/** What the sink has done since this task started. */
export interface AnalyticsSinkStats {
  readonly queuedEvents: number;
  readonly queuedSearchQueries: number;
  readonly droppedForCapacity: number;
  readonly droppedForFailure: number;
  readonly flushedEvents: number;
  readonly flushFailures: number;
}

/** Read the counters. */
export function analyticsSinkStats(): AnalyticsSinkStats {
  return {
    queuedEvents: eventQueue.length,
    queuedSearchQueries: queryQueue.length,
    droppedForCapacity,
    droppedForFailure,
    flushedEvents,
    flushFailures,
  };
}

/** Reset everything. Tests only. */
export function resetAnalyticsSink(): void {
  eventQueue = [];
  queryQueue = [];
  droppedForCapacity = 0;
  droppedForFailure = 0;
  flushedEvents = 0;
  flushFailures = 0;
}

/**
 * Enqueue one event. Returns immediately, always, and never throws.
 *
 * The `try` wraps the ENQUEUE itself, not just the write. That looks
 * over-cautious for two array operations and is not: this function is called
 * from inside checkout and from inside the cart merge transaction's caller, and
 * a `RangeError` from a pathological queue or a bug in a future enrichment step
 * would otherwise surface as a failed order. Nothing about recording telemetry
 * is worth a 500 on a payment.
 */
export function recordAnalyticsEvent(event: AnalyticsEventInsert): void {
  try {
    if (!config.analytics.enabled) return;
    pushBounded(eventQueue, event, config.analytics.queueMaxEvents);
  } catch (error: unknown) {
    // Deliberate swallow — see the module docblock. Logged, counted, and never
    // rethrown, because the caller is a commerce path that must not learn about
    // it.
    droppedForFailure += 1;
    log.general.error({ err: error }, '[Analytics] enqueue failed; the event is dropped');
  }
}

/** Enqueue one search record. Same contract as {@link recordAnalyticsEvent}. */
export function recordSearchQuery(record: AnalyticsSearchQueryInsert): void {
  try {
    if (!config.analytics.enabled) return;
    pushBounded(queryQueue, record, config.analytics.queueMaxEvents);
  } catch (error: unknown) {
    droppedForFailure += 1;
    log.general.error({ err: error }, '[Analytics] search-record enqueue failed; it is dropped');
  }
}

/**
 * Append, discarding the OLDEST when the cap is reached.
 *
 * `splice` rather than a ring buffer: the queue is drained whole on every flush,
 * so it is empty most of the time and the shift cost only appears in the state
 * that is already degraded. A ring buffer would be faster and would be a second
 * data structure to reason about for a case that means "we are already losing
 * data".
 */
function pushBounded<T>(queue: T[], item: T, cap: number): void {
  if (queue.length >= cap) {
    const overflow = queue.length - cap + 1;
    queue.splice(0, overflow);
    droppedForCapacity += overflow;
  }
  queue.push(item);
}

/**
 * Write everything queued.
 *
 * Exported so a test can drive it deterministically instead of waiting for a
 * tick, and so a graceful shutdown can make one last attempt.
 *
 * The batch is taken OUT of the queue before the write, so a failure does not
 * retry it: an analytics write that failed once will usually fail again, and
 * re-queueing it turns a transient database problem into an ever-growing buffer
 * that then hits the cap and drops the NEW events instead — the exact inversion
 * of the priority stated above.
 */
export async function flushAnalyticsSink(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (eventQueue.length > 0 || queryQueue.length > 0) {
      const events = eventQueue.splice(0, config.analytics.flushBatchSize);
      const queries = queryQueue.splice(0, config.analytics.flushBatchSize);
      try {
        if (events.length > 0) {
          flushedEvents += await writer.writeEvents(events);
        }
        if (queries.length > 0) {
          await writer.writeSearchQueries(queries);
        }
      } catch (error: unknown) {
        // The one deliberate swallow. The batch is already out of the queue and
        // is NOT re-queued — see the function docblock.
        flushFailures += 1;
        droppedForFailure += events.length + queries.length;
        log.general.error(
          { err: error, events: events.length, searchQueries: queries.length },
          '[Analytics] flush failed; the batch is dropped. Commerce is unaffected — no metric ' +
            'that counts money reads these rows (#77 identity rule 8).',
        );
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Start the flusher.
 *
 * Runs on EVERY task, like the dispatchers, and for a simpler reason: the queue
 * is process-local, so a task that did not flush would simply lose its own
 * events. There is nothing to coordinate and no lease to take.
 *
 * Idempotent — a second call is a no-op.
 */
export function startAnalyticsSink(): void {
  if (timer !== undefined) return;
  if (!config.analytics.enabled) {
    log.general.info(
      '[Analytics] collection is OFF (ANALYTICS_ENABLED). No events are recorded; the ' +
        'production gate stays shut until the privacy and retention review clears ' +
        '(#77 acceptance 8).',
    );
    return;
  }

  timer = setInterval(() => {
    void flushAnalyticsSink();
  }, config.analytics.flushIntervalMs);
  // Never hold the event loop open for telemetry — `~/Oxy/AGENTS.md`. Without
  // this a Jest/vitest run hangs on a module-level interval, and a graceful
  // shutdown waits on a flush nobody is reading.
  timer.unref?.();

  log.general.info(
    {
      flushIntervalMs: config.analytics.flushIntervalMs,
      queueMaxEvents: config.analytics.queueMaxEvents,
      collectionMode: config.analytics.collectionMode,
    },
    '[Analytics] sink started',
  );
}

/**
 * Stop the flusher and make one last attempt at what is queued.
 *
 * The final flush is best-effort and its failure is already swallowed by
 * `flushAnalyticsSink`; a shutdown that hung waiting for telemetry would be the
 * same bug this module exists to prevent, one lifecycle stage later.
 */
export async function stopAnalyticsSink(): Promise<void> {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  await flushAnalyticsSink();
}
