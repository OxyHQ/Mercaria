/**
 * The analytics retention work the shared expiry sweep cannot do (#77 data
 * lifecycle).
 *
 * ## Two of the three mechanisms are already elsewhere, and that is deliberate
 *
 *  - **Row deletion** is `db/expiryTargets.ts` plus `db/expirySweeper.ts` — six
 *    entries, one per table with its own deadline. Nothing here duplicates it.
 *    A second sweep would be a second thing to keep in step with the first, and
 *    the failure mode of a retention sweep that disagrees with itself is data
 *    that outlives its policy silently.
 *  - **Pseudonym rotation** happens in `identity.ts`, on demand, when the
 *    current epoch is older than the configured interval. Rotation on a timer
 *    would fire on a task that may never derive an identity; rotation on use
 *    fires exactly when it matters and costs one extra read per epoch.
 *
 * What is left is the one operation that is neither: **redacting the query text
 * in place while the row survives.** `ExpirySweepTarget` deletes rows and has no
 * way to null a column, and nulling `analytics_search_queries.redacted_text` at
 * `text_expires_at` is the mechanical execution of "raw query text is never
 * retained; the redacted form lives 30 days".
 *
 * ## The ordering against the rollup is load-bearing
 *
 * The rollup writes a day's aggregates before that day's rows reach any
 * retention horizon — `ANALYTICS_QUERY_TEXT_RETENTION_DAYS` is 30 and the
 * rollup runs a day behind. So a top-queries report survives the text it was
 * derived from, which is data-lifecycle rule 2 ("aggregate before deleting raw
 * events where appropriate") and the reason "appropriate" is the query table
 * rather than every table.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { countUnredactedExpiredQueries, redactExpiredQueryText } from '../../db/analytics/searchQueryRepository.js';
import { countOverdueSalts } from '../../db/analytics/pseudonymSaltRepository.js';

/** How many records one pass redacts. Bounded, like every other sweep here. */
const REDACTION_BATCH_SIZE = 1_000;

/** What one retention pass did. */
export interface AnalyticsRetentionOutcome {
  readonly queriesRedacted: number;
}

/**
 * Redact one bounded batch of expired query text.
 *
 * Exported so a test and an operator can drive it deterministically. Bounded
 * rather than draining: a sweep that ran until done would hold a long
 * transaction on the highest-volume table in the schema, and a cold start after
 * an outage would be the slowest possible moment to deploy.
 */
export async function runAnalyticsRetention(now = new Date()): Promise<AnalyticsRetentionOutcome> {
  const queriesRedacted = await redactExpiredQueryText(now, REDACTION_BATCH_SIZE);
  if (queriesRedacted > 0) {
    log.general.info(
      { queriesRedacted },
      '[Analytics] redacted expired search-query text; the normalized tokens survive',
    );
  }
  return { queriesRedacted };
}

/**
 * The two numbers that say whether retention is actually happening.
 *
 * Both must be ZERO on a healthy deployment, and both are on the operator
 * surface. A retention policy nobody measures is a retention policy nobody has
 * — and these two in particular fail SILENTLY: an un-nulled query text and an
 * un-swept salt both leave the system working perfectly while the guarantee
 * they underpin has quietly stopped being true.
 */
export interface AnalyticsRetentionHealth {
  /** Records past `text_expires_at` that still carry text. */
  readonly unredactedExpiredQueries: number;
  /** Salt epochs past their deletion deadline that still exist. */
  readonly overdueSalts: number;
}

/** Read the retention health counters. */
export async function readAnalyticsRetentionHealth(
  now = new Date(),
): Promise<AnalyticsRetentionHealth> {
  return {
    unredactedExpiredQueries: await countUnredactedExpiredQueries(now),
    overdueSalts: await countOverdueSalts(now),
  };
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runAnalyticsRetention();
  } catch (error: unknown) {
    // Logged and swallowed so the timer survives. Unlike the sink's swallow,
    // this one loses nothing: the deadline is a column, so the next pass finds
    // exactly the same rows and redacts them then.
    log.general.error({ err: error }, '[Analytics] retention pass failed; will retry');
  } finally {
    running = false;
  }
}

/**
 * Start the retention loop. Idempotent.
 *
 * Runs on EVERY task, like the expiry sweeper it sits beside. The update is
 * idempotent (a row with no text is not selected), so N tasks racing costs a
 * duplicate statement and nothing else — and a leader would only add a way for
 * nobody to redact at all.
 *
 * Gated on `enabled` because a deployment that collects nothing has nothing to
 * redact. That is the one place in this domain where gating the LOOP also gates
 * the work, and it is safe for the reason the outbox rule exists to protect
 * against: there are no durable records being written meanwhile.
 */
export function startAnalyticsRetention(): void {
  if (timer !== undefined) return;
  if (!config.analytics.enabled) return;

  timer = setInterval(() => {
    void tick();
  }, config.analytics.rollupIntervalMs);
  // Never hold the event loop open for a poll — `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info('[Analytics] search-query text redaction sweep started');
}

/** Stop the retention loop. */
export function stopAnalyticsRetention(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
