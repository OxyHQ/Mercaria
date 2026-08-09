/**
 * The loop that turns refresh TASKS into #62 RUNS (#68 scheduler 1–4).
 *
 * It deliberately performs no fetch of its own. A task is claimed, the source's
 * fleet-wide budget is taken, and a #62 run is opened in the requested mode —
 * then #62's own dispatcher drives it page by page, through the SAME
 * `runIngestionPage` a scheduled pass goes through. A second fetch path here
 * would be a second place the rights gate, the monotonicity guard, the
 * quarantine gate and the retirement rule all have to be right.
 *
 * ## The LOOP is gated; the durable record never is
 *
 * `OFFER_REFRESH_ENABLED` stops this loop and nothing else. Tasks accumulate
 * while it is off — an alert raised at 3am is served when the loop comes back —
 * which is the house rule and is what makes bringing a feed up by hand a
 * supported thing to do.
 *
 * ## Refusals are recorded, never silently downgraded
 *
 * A task asking for a mode the registered adapter does not declare is
 * DEAD-LETTERED with `unsupported_mode`, not quietly answered with a mode the
 * adapter does have. A targeted refresh silently served as a full snapshot is a
 * quota bill nobody asked for, and against eBay's 5,000-calls-a-day default
 * that is the difference between a working integration and a suspended keyset.
 * The two transient refusals — `rate_limited` and `all_slots_busy` — go back to
 * `pending` with a backoff instead, because they are about this attempt rather
 * than about the request.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findCatalogSourceConfig } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { openSourceRun } from '../../db/ingestion/catalogSourceRunRepository.js';
import {
  claimRefreshTasks,
  completeRefreshTask,
  releaseRefreshTask,
  type OfferRefreshTaskRow,
} from '../../db/offerFreshness/refreshTaskRepository.js';
import {
  claimSourceRefreshLease,
  releaseSourceRefreshLease,
  type SourceRefreshLeaseClaim,
} from '../../db/offerFreshness/refreshLeaseRepository.js';
import { resolveCatalogSourceAdapter } from '../ingestion/registry.js';
import { resolveSourceFreshnessPolicy } from './policy.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * A stable-per-process worker identity.
 *
 * It has to survive across ticks within a process and differ between processes,
 * which is exactly what a module-level value gives. Minted per tick, every
 * reclaim would look like a different task and the owner check would protect
 * nothing.
 */
const LEASE_OWNER = `offer-refresh-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/** What one tick did, for the operator's drain button and the tests. */
export interface RefreshTickResult {
  claimed: number;
  opened: number;
  refused: number;
}

/**
 * Capped exponential backoff for a transient refusal.
 *
 * The same shape every Mercaria worker uses, and `attempts` is already
 * incremented by the claim, so the first refusal waits two minutes rather than
 * one. Bounded before the shift so a long outage cannot overflow it into a
 * negative delay.
 */
function backoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1), 10);
  return Math.min(config.offerFreshness.refreshMaxBackoffMs, 60_000 * 2 ** exponent);
}

/**
 * Execute one claimed task.
 *
 * Every exit either completes the task or releases it with a recorded reason,
 * so a claimed row never simply stops being worked on — a task that vanished
 * from the queue with no verdict is the shape of a backlog nobody can explain.
 */
async function driveTask(task: OfferRefreshTaskRow, now: Date): Promise<'opened' | 'refused'> {
  const db = getDb();

  const sourceConfig = await findCatalogSourceConfig(db, task.sourceId);
  if (sourceConfig === undefined) {
    await releaseRefreshTask(db, {
      id: task.id,
      leaseOwner: LEASE_OWNER,
      availableAt: now,
      error: 'The source is no longer configured for ingestion',
      refusal: 'source_unconfigured',
      deadLetter: true,
      now,
    });
    return 'refused';
  }

  const adapter = resolveCatalogSourceAdapter(sourceConfig.provider);
  if (adapter === undefined) {
    await releaseRefreshTask(db, {
      id: task.id,
      leaseOwner: LEASE_OWNER,
      availableAt: now,
      error: `No adapter is registered for provider '${sourceConfig.provider}'`,
      refusal: 'adapter_missing',
      deadLetter: true,
      now,
    });
    return 'refused';
  }

  const resolved = await resolveSourceFreshnessPolicy(task.sourceId, db);
  const permitted = resolved?.permittedRefreshModes ?? [];
  const modeAvailable =
    adapter.refreshModes.includes(task.mode) &&
    (permitted.length === 0 || permitted.includes(task.mode));
  if (!modeAvailable) {
    await releaseRefreshTask(db, {
      id: task.id,
      leaseOwner: LEASE_OWNER,
      availableAt: now,
      error: `Refresh mode '${task.mode}' is not available for this source`,
      refusal: 'unsupported_mode',
      deadLetter: true,
      now,
    });
    return 'refused';
  }

  /**
   * The FLEET-wide budget, taken before the run is opened.
   *
   * Not per process: "how many calls per minute may this source receive across
   * every ECS task" is not a question an in-process bucket can answer. The two
   * refusals are told apart because they need different fixes — one means raise
   * the allowance and back off, the other means raise the concurrency and retry
   * shortly.
   */
  const claim: SourceRefreshLeaseClaim = await claimSourceRefreshLease(
    {
      budget: {
        sourceId: task.sourceId,
        maxConcurrency:
          sourceConfig.rateLimitConcurrency ?? config.offerFreshness.defaultRefreshConcurrency,
        maxCallsPerMinute:
          sourceConfig.rateLimitPerMinute ?? config.offerFreshness.defaultRefreshCallsPerMinute,
      },
      leaseOwner: LEASE_OWNER,
      leaseMs: config.offerFreshness.refreshLeaseMs,
      now,
    },
    db,
  );
  if (claim.outcome === 'refused') {
    await releaseRefreshTask(db, {
      id: task.id,
      leaseOwner: LEASE_OWNER,
      availableAt: new Date(now.getTime() + backoffMs(task.attempts)),
      error: null,
      refusal: claim.reason,
      deadLetter: false,
      now,
    });
    return 'refused';
  }

  try {
    /**
     * `openSourceRun` converges on #62's open-run partial unique, so a source
     * already mid-pass gets that pass back rather than a second one. The task
     * completes either way: what it owed was that a refresh be UNDERWAY, and a
     * pass already running satisfies it.
     *
     * A snapshot asks with NO watermark — `since: null` is what makes it a full
     * enumeration in #62's vocabulary — while every other mode carries the
     * source's last success.
     */
    await openSourceRun(db, {
      sourceId: task.sourceId,
      kind: task.requestedByOxyUserId === null ? 'incremental' : 'manual',
      refreshMode: task.mode,
      ...(task.mode === 'targeted' ? { targetExternalIds: [task.subjectKey] } : {}),
      since: task.mode === 'full_snapshot' ? null : sourceConfig.lastSuccessAt,
      requestedByOxyUserId: task.requestedByOxyUserId,
      now,
    });
    await completeRefreshTask(db, { id: task.id, leaseOwner: LEASE_OWNER, now });
    return 'opened';
  } finally {
    // Released whatever happened: a slot held by a task that threw is a slot
    // nobody can prove is free until its lease lapses, and the whole source
    // waits behind it.
    await releaseSourceRefreshLease(
      { leaseId: claim.leaseId, leaseOwner: LEASE_OWNER, now },
      db,
    );
  }
}

/** Drive one tick — the loop's body, the operator's button and the tests' entry. */
export async function drainOfferRefresh(now: Date = new Date()): Promise<RefreshTickResult> {
  const tasks = await claimRefreshTasks(getDb(), {
    leaseOwner: LEASE_OWNER,
    batchSize: config.offerFreshness.refreshBatchSize,
    leaseMs: config.offerFreshness.refreshLeaseMs,
    now,
  });

  let opened = 0;
  let refused = 0;
  for (const task of tasks) {
    // Sequential rather than concurrent, deliberately: N tasks in flight
    // against one provider is the shape that gets an integration banned, and
    // parallelism across SOURCES comes from the several ECS tasks each claiming
    // their own rows.
    const outcome = await driveTask(task, now);
    if (outcome === 'opened') opened += 1;
    else refused += 1;
  }
  return { claimed: tasks.length, opened, refused };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainOfferRefresh();
    if (result.claimed > 0) {
      log.general.debug({ ...result }, '[OfferFreshness] refresh tick');
    }
  } catch (error: unknown) {
    // The loop must survive anything one source throws, or one bad feed stops
    // every refresh for the life of the process.
    log.general.error({ err: error }, '[OfferFreshness] refresh dispatch failed');
  } finally {
    running = false;
  }
}

/** Begin dispatching. Idempotent — a second call is a no-op. */
export function startOfferRefreshDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.offerFreshness.refreshEnabled) {
    log.general.info(
      '[OfferFreshness] refresh dispatcher disabled; tasks enqueued now are stored and will ' +
        'run once OFFER_REFRESH_ENABLED is on',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.offerFreshness.refreshPollIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    {
      pollIntervalMs: config.offerFreshness.refreshPollIntervalMs,
      batchSize: config.offerFreshness.refreshBatchSize,
    },
    '[OfferFreshness] refresh dispatcher started',
  );
}

/** Stop claiming new work. A task already in flight reaches a durable state. */
export function stopOfferRefreshDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
