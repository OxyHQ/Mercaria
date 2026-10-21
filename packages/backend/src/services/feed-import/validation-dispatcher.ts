/**
 * Whole-feed validations, run in the background (`feed_validation_jobs`).
 *
 * A validation reads and stages the WHOLE feed. For a multi-gigabyte file that
 * is minutes, and a request cannot hold that long: the load balancer drops an
 * idle connection after 60 s and the proxy in front of every Oxy API hostname
 * gives an origin 100 s. So `POST …/validate` enqueues a job and answers 202,
 * the client polls the job, and this loop runs it — `validateFeedVersion`,
 * unchanged, so the report an activation cites is exactly the report the
 * request used to write.
 *
 * ## The dispatcher shape every outbox here shares
 *
 * Started on EVERY task, no leader: a claim is `FOR UPDATE SKIP LOCKED` with a
 * lease and an owner check, so N tasks share the queue and a dead task's lease
 * is reclaimed. One job at a time per task — each one downloads and stages a
 * whole feed. The lease is short and RENEWED while the job runs, so a task that
 * dies mid-validation hands the job on within minutes, and a task that loses
 * its lease stops (the renewal aborts the read).
 *
 * A refusal that would answer the same way again (a cap, a misconfiguration, a
 * forbidden container) is `failed` with its reason, once. Anything retryable —
 * a host outage, a storage hiccup, a crash — backs off exponentially, capped,
 * and dead-letters visibly after {@link MAX_ATTEMPTS}.
 *
 * There is no switch. Validation is a read that writes a report; it needs
 * nothing the importer's ingestion loop does, and the operator surface that can
 * request one is mounted whether or not the importer is enabled.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/postgres.js';
import {
  findFeedConfiguration,
  findFeedVersion,
} from '../../db/feedImport/feedConfigurationRepository.js';
import {
  claimFeedValidationJobs,
  completeFeedValidationJob,
  enqueueFeedValidationJob,
  failFeedValidationJob,
  releaseFeedValidationJob,
  renewFeedValidationLease,
  type FeedValidationJobRow,
} from '../../db/feedImport/feedValidationJobRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { FeedImportRefusal } from './errors.js';
import { validateFeedVersion } from './preview.service.js';

/** How long a claim holds before another task may take the job. */
const LEASE_MS = 5 * 60 * 1_000;
/** How often a running job renews it — well inside the lease. */
const RENEW_EVERY_MS = 60 * 1_000;
/** How often a task looks for work. A merchant is waiting on the answer. */
const POLL_INTERVAL_MS = 2_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60 * 1_000;

export function feedValidationBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Enqueue a validation of one version of one configuration — or answer the one
 * already queued or running for it.
 */
export async function requestFeedValidation(input: {
  configurationId: string;
  versionId: string;
  requestedByOxyUserId: string;
  now?: Date;
}): Promise<FeedValidationJobRow> {
  const version = await findFeedVersion(getDb(), input.versionId);
  if (version === undefined || version.configurationId !== input.configurationId) {
    throw notFound('Mapping version not found for this feed');
  }
  return enqueueFeedValidationJob(getDb(), {
    configurationId: input.configurationId,
    versionId: input.versionId,
    requestedByOxyUserId: input.requestedByOxyUserId,
    now: input.now ?? new Date(),
  });
}

export type FeedValidationRunOutcome = 'completed' | 'failed' | 'released' | 'lost';

/** Run one claimed job to an outcome. Never throws: every path is a transition. */
export async function runFeedValidationJob(
  job: FeedValidationJobRow,
  leaseOwner: string,
): Promise<FeedValidationRunOutcome> {
  const controller = new AbortController();
  let lost = false;
  const renewal = setInterval(() => {
    void renewFeedValidationLease({ jobId: job.id, leaseOwner, leaseMs: LEASE_MS })
      .then((held) => {
        if (!held) {
          lost = true;
          controller.abort(new Error('The validation lease was lost.'));
        }
      })
      .catch(() => undefined);
  }, RENEW_EVERY_MS);
  renewal.unref?.();

  try {
    const configuration = await findFeedConfiguration(getDb(), job.configurationId);
    if (configuration === undefined) {
      // Cascades remove the job with its configuration; reaching here means it
      // went mid-claim. Nothing to validate, and nothing to retry.
      await failFeedValidationJob({
        jobId: job.id,
        leaseOwner,
        reason: 'configuration_missing',
        message: 'The feed configuration no longer exists.',
      });
      return 'failed';
    }
    const report = await validateFeedVersion({
      configurationId: job.configurationId,
      versionId: job.versionId,
      sourceId: configuration.sourceId,
      requestedByOxyUserId: job.requestedByOxyUserId,
      signal: controller.signal,
    });
    const completed = await completeFeedValidationJob({
      jobId: job.id,
      leaseOwner,
      reportId: report.id,
    });
    return completed ? 'completed' : 'lost';
  } catch (error: unknown) {
    if (lost) return 'lost';
    if (error instanceof FeedImportRefusal && !error.retryable) {
      await failFeedValidationJob({
        jobId: job.id,
        leaseOwner,
        reason: error.reason,
        message: error.message,
      });
      return 'failed';
    }
    const message =
      error instanceof FeedImportRefusal ? error.message : 'The validation could not finish.';
    const deadLettered = job.attempts >= MAX_ATTEMPTS;
    await releaseFeedValidationJob({
      jobId: job.id,
      leaseOwner,
      deadLettered,
      availableAt: new Date(Date.now() + feedValidationBackoffMs(job.attempts)),
      error: message,
    });
    log.general.warn(
      { err: error, jobId: job.id, attempts: job.attempts, deadLettered },
      '[FeedImport] validation job failed; released with backoff',
    );
    return 'released';
  } finally {
    clearInterval(renewal);
  }
}

/**
 * Claim and run what is due, one job at a time. Exported so a test (or an
 * operator) drains through the same path the loop takes.
 */
export async function drainFeedValidationJobs(options: {
  leaseOwner: string;
  maxJobs: number;
}): Promise<Record<FeedValidationRunOutcome, number>> {
  const outcomes: Record<FeedValidationRunOutcome, number> = {
    completed: 0,
    failed: 0,
    released: 0,
    lost: 0,
  };
  for (let run = 0; run < options.maxJobs; run += 1) {
    const [job] = await claimFeedValidationJobs({
      leaseOwner: options.leaseOwner,
      batchSize: 1,
      leaseMs: LEASE_MS,
    });
    if (job === undefined) break;
    outcomes[await runFeedValidationJob(job, options.leaseOwner)] += 1;
  }
  return outcomes;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
const leaseOwner = `feed-validation:${randomUUID()}`;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainFeedValidationJobs({ leaseOwner, maxJobs: 1 });
  } catch (error: unknown) {
    // The loop survives anything one pass throws.
    log.general.error({ err: error }, '[FeedImport] validation drain failed');
  } finally {
    running = false;
  }
}

/** Begin draining, on every task. Idempotent. */
export function startFeedValidationDispatcher(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  log.general.info(
    { pollIntervalMs: POLL_INTERVAL_MS },
    '[FeedImport] validation dispatcher started',
  );
}

export function stopFeedValidationDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
