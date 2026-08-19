/**
 * The curation job dispatcher — the loop that runs merge and split jobs.
 *
 * The moderation and offer dispatcher shape, unchanged in every part that
 * matters: it runs on EVERY task, claims a bounded batch with
 * `FOR UPDATE SKIP LOCKED`, holds a lease with an owner check on every terminal
 * transition, backs off exponentially with a cap, and dead-letters visibly.
 *
 * ## Gate the LOOP, never the durable record
 *
 * `CURATION_JOBS_ENABLED` stops this loop and nothing else. An operator can
 * still REQUEST a merge with the flag off; the job sits `pending` and runs when
 * the flag comes back. Gating the request instead would make a queue that
 * silently loses the work an operator thought they had scheduled — the inversion
 * `~/Oxy/AGENTS.md` records the payment and moderation outboxes learning.
 *
 * ## `blocked` is not claimable, and that is the point
 *
 * A job waiting on an operator's conflict decision is not an error and must not
 * be retried. Claiming it would spin this loop against a judgement only a person
 * can make, and burying a real fault among things "waiting for review" is the
 * other half of the same mistake.
 *
 * ## Which is why each pass RESUMES before it claims (#663)
 *
 * Not claiming a blocked job is right; leaving one blocked after its condition
 * has cleared is how that became a dead end. `resumeBlockedMergeJobs` asks
 * `mergeJobBlockingState` — the same predicate the phase blocked on — and moves
 * the ones it calls clear back to `pending`, where the ordinary claim below
 * picks them up. It runs FIRST so a job whose child completed since the last
 * pass is resumed and claimed in one tick rather than two.
 *
 * That is not a retry and does not weaken the paragraph above: nothing is
 * claimed, leased or run on the strength of it, and a job whose condition still
 * holds is left exactly where it is.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { claimMergeJobs, claimSplitJobs, releaseMergeJob, releaseSplitJob } from '../../db/curation/jobRepository.js';
import { resumeBlockedMergeJobs, runMergeJob } from './merge.service.js';
import { resumeBlockedSplitJobs, runSplitJob } from './split.service.js';

/** The retry ladder, capped. The moderation outbox's numbers. */
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 8;

function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** A worker identity that is unique per process, so a lease has one owner. */
function leaseOwner(): string {
  return `curation-${process.pid}-${process.env.HOSTNAME ?? 'local'}`;
}

export interface CurationDrainResult {
  readonly mergesRun: number;
  readonly splitsRun: number;
  readonly failures: number;
  /** Blocked jobs whose condition had cleared, returned to `pending` (#663). */
  readonly mergesResumed: number;
  /** The same, for splits (#679). Counted separately: the two park for
   *  different reasons and one collapsing to zero must not hide behind the
   *  other's number. */
  readonly splitsResumed: number;
}

/**
 * Drain one batch of each kind.
 *
 * Exported so the operator surface can run a batch on demand — the same code
 * path the loop takes, so a manual drain and a scheduled one cannot behave
 * differently.
 */
export async function drainCurationJobs(batchSize: number): Promise<CurationDrainResult> {
  const owner = leaseOwner();
  let mergesRun = 0;
  let splitsRun = 0;
  let failures = 0;

  // Before anything is claimed: a blocked job whose condition has cleared is
  // `pending` by the time the claim below runs, so it is resumed AND run in one
  // pass. See the note at the top of this file.
  const mergesResumed = await resumeBlockedMergeJobs(batchSize);
  const splitsResumed = await resumeBlockedSplitJobs(batchSize);

  for (const job of await claimMergeJobs({ leaseOwner: owner, batchSize })) {
    try {
      await runMergeJob(job.id, owner);
      mergesRun += 1;
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      const deadLettered = job.attempts >= MAX_ATTEMPTS;
      await releaseMergeJob({
        id: job.id,
        leaseOwner: owner,
        deadLettered,
        availableAt: new Date(Date.now() + backoffFor(job.attempts)),
        error: message,
      });
      log.general.error(
        { err, jobId: job.id, attempts: job.attempts, deadLettered },
        '[Curation] merge job failed',
      );
    }
  }

  for (const job of await claimSplitJobs({ leaseOwner: owner, batchSize })) {
    try {
      await runSplitJob(job.id, owner);
      splitsRun += 1;
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      const deadLettered = job.attempts >= MAX_ATTEMPTS;
      await releaseSplitJob({
        id: job.id,
        leaseOwner: owner,
        deadLettered,
        availableAt: new Date(Date.now() + backoffFor(job.attempts)),
        error: message,
      });
      log.general.error(
        { err, jobId: job.id, attempts: job.attempts, deadLettered },
        '[Curation] split job failed',
      );
    }
  }

  return { mergesRun, splitsRun, failures, mergesResumed, splitsResumed };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the loop.
 *
 * `.unref?.()` immediately, the convention every module-level `setInterval` in
 * this codebase follows: without it the interval keeps the event loop alive and
 * a Jest or vitest run hangs non-deterministically. The `?.` is for runtimes
 * whose timer has no `unref`.
 */
export function startCurationDispatcher(): void {
  if (timer) return;
  if (!config.catalog.curationJobsEnabled) {
    log.general.info('[Curation] job dispatcher disabled; jobs will queue until it is enabled');
    return;
  }
  const intervalMs = config.catalog.curationPollIntervalMs;
  timer = setInterval(() => {
    void drainCurationJobs(config.catalog.curationBatchSize).catch((err: unknown) => {
      log.general.error({ err }, '[Curation] dispatcher pass failed');
    });
  }, intervalMs);
  timer.unref?.();
  log.general.info({ intervalMs }, '[Curation] job dispatcher started');
}

/** Stop the loop. Used by tests and by a graceful shutdown. */
export function stopCurationDispatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
