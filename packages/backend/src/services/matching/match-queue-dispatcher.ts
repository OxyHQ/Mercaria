/**
 * The match-queue dispatcher — the `offer_outboxes` dispatcher, ported.
 *
 * Runs on EVERY task. Claims are `FOR UPDATE SKIP LOCKED` with an owner check,
 * so N ECS tasks drain one queue without handing each other the same row and a
 * dead task's expired lease is reclaimable.
 *
 * **The LOOP is gated, never the durable record.** With
 * `MATCH_PIPELINE_ENABLED=false` the queue still accepts rows — every catalogue
 * write, every observation, every operator request keeps enqueueing — and they
 * drain the moment it is switched on. Gating the enqueue instead would silently
 * lose every request taken while matching was paused, which is the failure the
 * moderation outbox's own note warns about.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  claimMatchQueue,
  completeMatchQueue,
  releaseMatchQueue,
  type MatchQueueRow,
} from '../../db/matching/matchQueueRepository.js';
import { runMatch } from './match.service.js';

/**
 * After this many failures a row is dead-lettered rather than retried forever.
 *
 * A visible `dead_letter` is the point: a subject the pipeline cannot evaluate
 * is an operator's problem, and a row retrying silently at ten-minute intervals
 * is how that problem stays invisible for a month.
 */
export const MAX_MATCH_ATTEMPTS = 8;

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 10 * 60 * 1_000;
const LEASE_MS = 60_000;
/** Per PROCESS, not per claim: a lease belongs to a worker, not to a batch. */
const LEASE_OWNER = `match-queue-${randomUUID()}`;

function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export interface MatchQueueDrainResult {
  readonly claimed: number;
  readonly evaluated: number;
  readonly attached: number;
  readonly skipped: number;
  readonly failed: number;
}

interface JobOutcome {
  readonly completed: boolean;
  readonly attached: boolean;
  readonly skipped: boolean;
}

async function handleJob(job: MatchQueueRow, now: Date): Promise<JobOutcome> {
  try {
    const result =
      job.subjectKind === 'native_variant' && job.productVariantId !== null
        ? await runMatch({ kind: 'native_variant', productVariantId: job.productVariantId }, { now })
        : job.sourceRecordId !== null
          ? await runMatch({ kind: 'source_record', sourceRecordId: job.sourceRecordId }, { now })
          : null;

    if (result === null) {
      // The row's shape CHECK makes this unreachable through the enqueue, so
      // reaching it means somebody wrote the table directly. Dead-letter rather
      // than retry: no number of attempts fixes a row that names no subject.
      await releaseMatchQueue({
        id: job.id,
        leaseOwner: LEASE_OWNER,
        deadLettered: true,
        availableAt: now,
        error: 'Queue row names neither a product variant nor a source record.',
        now,
      });
      return { completed: false, attached: false, skipped: false };
    }

    const completed = await completeMatchQueue(job.id, LEASE_OWNER, now);
    if (!completed) {
      // The lease was reclaimed mid-run. The outcome is discarded rather than
      // written over somebody else's — the decision itself is idempotent, so
      // the run that holds the lease will reach the same answer.
      log.general.warn(
        { subjectKey: job.subjectKey },
        '[Matching] lease was reclaimed; discarding this run',
      );
    }
    return {
      completed,
      attached: result.attached,
      skipped: result.skipped !== null,
    };
  } catch (err) {
    const deadLettered = job.attempts >= MAX_MATCH_ATTEMPTS;
    await releaseMatchQueue({
      id: job.id,
      leaseOwner: LEASE_OWNER,
      deadLettered,
      availableAt: new Date(now.getTime() + backoffFor(job.attempts)),
      error: err instanceof Error ? err.message : String(err),
      now,
    });
    log.general.error(
      { err, subjectKey: job.subjectKey, attempts: job.attempts, deadLettered },
      '[Matching] evaluation failed',
    );
    return { completed: false, attached: false, skipped: false };
  }
}

/**
 * Claim and process ONE bounded batch.
 *
 * Exported so tests and the operator surface drain deterministically without
 * waiting on a timer.
 */
export async function drainMatchQueue(
  options: { batchSize?: number; now?: Date } = {},
): Promise<MatchQueueDrainResult> {
  const now = options.now ?? new Date();
  const jobs = await claimMatchQueue({
    leaseOwner: LEASE_OWNER,
    batchSize: options.batchSize ?? config.matching.queueBatchSize,
    leaseMs: LEASE_MS,
    now,
  });

  let evaluated = 0;
  let attached = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of jobs) {
    const outcome = await handleJob(job, now);
    if (outcome.completed) evaluated += 1;
    else failed += 1;
    if (outcome.attached) attached += 1;
    if (outcome.skipped) skipped += 1;
  }

  return { claimed: jobs.length, evaluated, attached, skipped, failed };
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await drainMatchQueue();
    if (result.claimed > 0) {
      log.general.debug({ ...result }, '[Matching] queue drained');
    }
  } catch (err) {
    log.general.error({ err }, '[Matching] queue drain failed');
  } finally {
    running = false;
  }
}

export function startMatchQueueDispatcher(): void {
  if (timer !== undefined) return;
  if (!config.matching.pipelineEnabled) {
    log.general.info(
      '[Matching] pipeline disabled; requests are stored and will run once enabled',
    );
    return;
  }
  timer = setInterval(() => {
    void tick();
  }, config.matching.queuePollIntervalMs);
  // Never hold the event loop open — a housekeeping interval that does hangs
  // every Jest/vitest run non-deterministically.
  timer.unref?.();
  log.general.info(
    {
      pollIntervalMs: config.matching.queuePollIntervalMs,
      batchSize: config.matching.queueBatchSize,
    },
    '[Matching] queue dispatcher started',
  );
}

export function stopMatchQueueDispatcher(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
