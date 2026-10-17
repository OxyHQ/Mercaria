/**
 * The loop that schedules and pages ingestion runs (#62 §"PostgreSQL
 * concurrency" 5).
 *
 * Starts on EVERY task, like the moderation, offer, match and backfill
 * dispatchers, and for the same reason: a claim is a `FOR UPDATE SKIP LOCKED`
 * lease with an owner check, so N tasks share the work without handing each
 * other a source, and a dead task's lease is reclaimed rather than stranding a
 * feed halfway through a refresh.
 *
 * ## Two claims, and why they are separate
 *
 * The SOURCE lease says "this task is responsible for feeding this source"; the
 * RUN lease says "this task is driving this pass". They are separate because a
 * pass outlives a tick: a feed of four thousand pages spans many ticks of one run, and
 * collapsing the two would either hold a source lease for an hour or let a
 * second task claim the source mid-pass and open a competing run.
 *
 * ## The LOOP is gated; the durable record never is
 *
 * `CATALOG_INGESTION_ENABLED` stops this loop and nothing else. Sources can be
 * configured, policies reviewed and published, and manual runs opened while it
 * is off — the rows are durable, the cursors are durable, and turning the flag
 * on drains the backlog. That is the `CROWDSOURCE_ENABLED` rule, and it is what
 * makes "bring a new feed up during a quiet window" a supported thing to do.
 *
 * ## Backfills and incremental updates share the same write path
 *
 * Issue concurrency 6, and it is this file's structure rather than a claim: a
 * `backfill` run and an `incremental` run differ ONLY in the `since` watermark
 * they carry, and both are driven page by page through `runIngestionPage`.
 * There is no second ingestion path for the initial load.
 */

import type { CatalogRefreshMode } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  claimDueSources,
  releaseSourceLease,
} from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  claimSourceRuns,
  openSourceRun,
  yieldSourceRun,
} from '../../db/ingestion/catalogSourceRunRepository.js';
import { runIngestionPage, type IngestPageResult } from './ingest.service.js';
import { resolveCatalogSourceAdapter } from './registry.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
/** Set by `stop…`: a tick in progress yields its runs instead of starting more pages. */
let stopRequested = false;

/**
 * A stable-per-process worker identity.
 *
 * The lease owner has to survive across ticks within a process and differ
 * between processes, which is exactly what a module-level value gives. A value
 * minted per tick would make every reclaim look like a different task and defeat
 * the owner check's purpose.
 */
const LEASE_OWNER = `ingest-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Open a run for every source that is due.
 *
 * A source whose provider has no registered adapter is SKIPPED without opening
 * a run, and its lease is released with the ordinary cadence delay. Opening one
 * would force a health outcome onto a run that never fetched anything, and
 * every value in that vocabulary would be a lie about the provider — the honest
 * report is `adapterRegistered: false` on the operator surface, which is where
 * it appears.
 */
async function scheduleDueSources(now: Date): Promise<number> {
  const db = getDb();
  const claimed = await claimDueSources(db, {
    leaseOwner: LEASE_OWNER,
    batchSize: config.catalogIngestion.batchSize,
    leaseMs: config.catalogIngestion.leaseMs,
    now,
  });

  let opened = 0;
  for (const source of claimed) {
    const adapter = resolveCatalogSourceAdapter(source.provider);
    if (adapter === undefined) {
      log.general.debug(
        { sourceId: source.sourceId, provider: source.provider },
        '[Ingestion] no adapter registered; source skipped',
      );
      await releaseSourceLease(db, {
        sourceId: source.sourceId,
        leaseOwner: LEASE_OWNER,
        nextRunAt: new Date(now.getTime() + (source.fetchCadenceSeconds ?? 3_600) * 1_000),
        now,
      });
      continue;
    }

    /**
     * WHICH mode this pass runs in — the adapter's declaration decides (#68
     * scheduler 1).
     *
     * An adapter that cannot enumerate completely never gets `full_snapshot`,
     * which is the mode whose outcome can authorise retiring what a pass did
     * not see. An eBay-style Browse adapter is exactly that case: no call it
     * has enumerates a marketplace, so a snapshot it was scheduled for would
     * either lie about completeness or retire a catalogue on a search result.
     *
     * The fallback is `incremental` and never `full_snapshot`, because the
     * safe direction on an unclear capability is the mode that retires nothing.
     */
    const wantsSnapshot = source.lastSuccessAt === null;
    const mode: CatalogRefreshMode =
      wantsSnapshot && adapter.refreshModes.includes('full_snapshot')
        ? 'full_snapshot'
        : adapter.refreshModes.includes('incremental')
          ? 'incremental'
          : adapter.refreshModes.includes('query_driven')
            ? 'query_driven'
            : 'incremental';

    // `openSourceRun` converges on the open-run partial unique, so a source
    // whose previous pass is still running gets that pass back rather than a
    // second one. `lastSuccessAt` is the incremental watermark; its absence
    // asks for a FULL enumeration, which is the only kind that may retire.
    await openSourceRun(db, {
      sourceId: source.sourceId,
      kind: source.lastSuccessAt === null ? 'backfill' : 'incremental',
      refreshMode: mode,
      since: mode === 'full_snapshot' ? null : source.lastSuccessAt,
      requestedByOxyUserId: null,
      now,
    });
    opened += 1;
  }
  return opened;
}

/**
 * Drive every claimable run, page after page, for one tick's budget.
 *
 * Round-robin: each claimed run gets a page per round, and a run that still has
 * pages stays in the next round while `tickBudgetMs` lasts. A run left over
 * when the budget runs out is YIELDED — handed back to the queue due now — so
 * the next tick, on this task or another, picks it up at once. Before this a
 * tick drove one page and left the run leased: the next claim waited for the
 * lease to expire, and Scryfall advanced a page every two minutes.
 *
 * Rate limits are the adapters' own and they hold across rounds: the open-data
 * transport spaces requests per host (Scryfall 120 ms, Steam 1.5 s), and
 * eBay spends a fleet-wide daily budget. Driving the next page sooner never
 * makes a request leave sooner than its provider allows.
 */
async function driveRuns(now: Date): Promise<IngestPageResult[]> {
  const tickStartedAt = Date.now();
  // The caller's `now`, moved on by the time this tick has spent: every page
  // stamps and checks its lease against the instant it actually runs.
  const clock = () => new Date(now.getTime() + (Date.now() - tickStartedAt));
  const withinBudget = () =>
    !stopRequested && Date.now() - tickStartedAt < config.catalogIngestion.tickBudgetMs;

  let round = await claimSourceRuns(getDb(), {
    leaseOwner: LEASE_OWNER,
    batchSize: config.catalogIngestion.batchSize,
    leaseMs: config.catalogIngestion.leaseMs,
    now,
  });

  const results: IngestPageResult[] = [];
  while (round.length > 0) {
    const next: typeof round = [];
    for (const run of round) {
      // Sequential rather than concurrent, deliberately: a source's rate-limit
      // policy is per source, and N pages in flight against one provider is the
      // shape that gets an integration banned. Parallelism across SOURCES comes
      // from the several ECS tasks each claiming their own.
      //
      // Each page is isolated. Every run in the batch is already leased (and
      // its `attempts` counted), so a page that throws must not abandon the
      // rest: they would sit leased and undriven until the lease expired, be
      // claimed again beside the same failing run, and starve for as long as it
      // kept failing. In October 2026 one wedged Open Prices run did exactly
      // that to every other keyless source for a week — thousands of claims,
      // a page an hour. The failing run is dropped from this tick and keeps its
      // lease, so it is retried on expiry.
      try {
        const result = await runIngestionPage({
          runId: run.id,
          leaseOwner: LEASE_OWNER,
          now: clock(),
        });
        results.push(result);
        if (result.hasMore) next.push(run);
      } catch (error: unknown) {
        log.general.error(
          { err: error, runId: run.id, sourceId: run.sourceId },
          '[Ingestion] page failed; the rest of the batch continues',
        );
      }
    }
    if (!withinBudget()) {
      for (const run of next) {
        await yieldSourceRun(getDb(), { id: run.id, leaseOwner: LEASE_OWNER, now: clock() });
      }
      break;
    }
    round = next;
  }
  return results;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    await scheduleDueSources(now);
    const pages = await driveRuns(now);
    if (pages.length > 0) {
      log.general.debug({ pages: pages.length }, '[Ingestion] pages driven');
    }
  } catch (error: unknown) {
    // The loop must survive anything one source throws, or one bad feed stops
    // ingestion for the life of the process.
    log.general.error({ err: error }, '[Ingestion] dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin scheduling. Idempotent — a second call is a no-op. */
export function startCatalogIngestionDispatcher(): void {
  if (timer !== undefined) return;
  stopRequested = false;
  if (!config.catalogIngestion.enabled) {
    log.general.info(
      '[Ingestion] catalog ingestion disabled; sources configured now are stored and will ' +
        'run once CATALOG_INGESTION_ENABLED is on',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.catalogIngestion.pollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.catalogIngestion.pollIntervalMs,
      batchSize: config.catalogIngestion.batchSize,
    },
    '[Ingestion] dispatcher started',
  );
}

/**
 * Stop claiming new work. A page already in flight reaches a durable state, and
 * the tick then yields its runs rather than leaving them leased to a task that
 * is going away.
 */
export function stopCatalogIngestionDispatcher(): void {
  stopRequested = true;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Drive one tick now — the operator's button and the test harness's entry.
 *
 * The SAME two steps the loop performs, so a manual drain is never a second
 * implementation of the schedule.
 */
export async function drainCatalogIngestion(now: Date = new Date()): Promise<IngestPageResult[]> {
  await scheduleDueSources(now);
  return driveRuns(now);
}
