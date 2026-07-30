/**
 * Claiming, completing and failing moderation outbox rows.
 *
 * At-least-once: an expired lease is reclaimable and a worker can die mid-flight,
 * so every handler MUST make its downstream effect idempotent using the event
 * `_id`. What differs from an ordinary queue is where retrying STOPS — a failure
 * the SDK marks non-retryable is a defect in the payload, not a blip, and no
 * number of attempts turns two different payloads into one report.
 */

import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  ModerationOutbox,
  MODERATION_OUTBOX_RETENTION_SECONDS,
  type ModerationOutboxKind,
  type ModerationOutboxPayload,
} from '../../models/moderation-outbox.js';
import { log } from '../../lib/logger.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * Generous on purpose: a retryable failure means CrowdSource might still accept
 * this exact payload, and with backoff capped at six hours this is several days
 * of trying. A report that has not landed by then needs a human, not another
 * attempt.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

export interface ModerationOutboxEvent {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The event id for delivering a report.
 *
 * Derived from the REPORT, never from the request: a transaction retry or two
 * concurrent duplicate submissions upsert the SAME row rather than queueing two
 * deliveries. There is exactly one delivery row per report for the life of the
 * report, which is also what keeps the CrowdSource-side idempotency key stable.
 */
export function reportSubmitEventId(reportId: string): string {
  return `moderation:report.submit:${reportId}`;
}

/**
 * The event id for applying an inbound decision.
 *
 * The webhook event id is the key, so a redelivery can never queue the work twice
 * even if the dedupe claim were somehow released.
 */
export function decisionApplyEventId(eventId: string): string {
  return `moderation:decision.apply:${eventId}`;
}

/**
 * Raised when an outbox row is written outside a transaction.
 *
 * Never expected at runtime. It exists so the invariant is ENFORCED rather than
 * reviewed — see {@link enqueueModerationOutboxEvent}.
 */
export class ModerationOutboxTransactionError extends Error {
  constructor(eventId: string) {
    super(
      `Refusing to enqueue moderation outbox event '${eventId}' outside a transaction: ` +
        'the domain write and this row must commit together, or a report is answered 201 ' +
        'and never delivered.',
    );
    this.name = 'ModerationOutboxTransactionError';
  }
}

/**
 * Write the row with the CALLER's session.
 *
 * The session is required, not optional. This is the entire point of the
 * collection: the domain write and this row commit together or not at all. An
 * overload that let a caller enqueue outside a transaction would be the one line
 * that quietly reintroduces "the report was answered 201 and then vanished".
 *
 * The TYPE makes the session mandatory; the runtime check makes it mandatory that
 * the session is ACTUALLY IN a transaction. A required parameter is satisfied by
 * any session — including a bare `startSession()` nobody opened a transaction on,
 * which type-checks perfectly and commits the row on its own. That is the shape of
 * the mistake worth catching: it looks exactly like correct code, it passes any
 * test that only asserts the row exists, and it fails as lost moderation work with
 * no trace on the day something restarts between the two writes.
 *
 * This function is also the ONLY writer of this collection — the dispatcher claims
 * existing rows and never creates one — so there is no second queue that can drift
 * out of sync with the outbox. A job is never the only evidence that work exists,
 * because the row IS the job.
 */
export async function enqueueModerationOutboxEvent(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
  session: ClientSession,
): Promise<string> {
  if (!session.inTransaction()) {
    throw new ModerationOutboxTransactionError(input.eventId);
  }

  const now = new Date();
  /**
   * `timestamps: false` ON THE OPERATION, with both timestamps written here.
   *
   * There are two ways to stop this upsert writing one path through two
   * operators, and they are NOT interchangeable — this is the one that is
   * correct, and the difference only shows up against a real server.
   *
   * The bug being avoided first: the schema declares `timestamps: true`, so on
   * an upsert Mongoose adds `createdAt` to `$setOnInsert` and `updatedAt` to
   * `$set`. Naming either field here as well puts one path under two operators
   * and the server rejects the WHOLE write — "Updating the path 'updatedAt'
   * would create a conflict at 'updatedAt'" — which, inside intake's
   * transaction, aborts the report too. Every report submission fails, from the
   * first one, and nothing in the schema, the types or a mocked driver reveals
   * it.
   *
   * **And it has to be this fix rather than the obvious one.** Simply dropping
   * the explicit timestamps and letting Mongoose own them also clears the error
   * — but it leaves Mongoose's `$set: { updatedAt }` on the update, which turns
   * a repeated enqueue for an event that ALREADY EXISTS into a real write
   * instead of a no-op. A repeat is ordinary: a transaction retry, two
   * concurrent duplicate submissions, a reconciliation sweep re-deriving an
   * event. Meanwhile the dispatcher is taking, renewing and completing leases on
   * these same rows, and a write nobody needed contends with a live lease
   * update. Writing both fields explicitly and disabling Mongoose's timestamps
   * for this one operation keeps the upsert a genuine no-op for an existing row,
   * which is the entire property the deterministic event id exists to give.
   *
   * Measured here on a real replica set: without this, a repeated enqueue bumps
   * `updatedAt`; with it, the row is untouched.
   */
  await ModerationOutbox.updateOne(
    { _id: input.eventId },
    {
      $setOnInsert: {
        _id: input.eventId,
        kind: input.kind,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        availableAt: now,
        expiresAt: new Date(now.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000),
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, session, timestamps: false },
  );
  return input.eventId;
}

function claimFilter(now: Date, eventId?: string): Record<string, unknown> {
  return {
    ...(eventId ? { _id: eventId } : {}),
    $or: [
      { status: 'pending', availableAt: { $lte: now } },
      { status: 'processing', leaseUntil: { $lte: now } },
    ],
  };
}

/**
 * Atomically claim one due row. An expired `processing` lease is reclaimable, so
 * a dead task cannot strand moderation work forever.
 */
export async function claimModerationOutboxEvent(options: {
  leaseOwner: string;
  eventId?: string;
  now?: Date;
  leaseMs?: number;
}): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  return await ModerationOutbox.findOneAndUpdate(
    claimFilter(now, options.eventId),
    {
      $set: {
        status: 'processing',
        leaseOwner: options.leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseMs),
      },
      $inc: { attempts: 1 },
      $unset: { lastError: '' },
    },
    { new: true, sort: { createdAt: 1 } },
  )
    .select('_id kind payload attempts availableAt leaseOwner leaseUntil expiresAt createdAt')
    .lean<ModerationOutboxEvent | null>();
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await ModerationOutbox.updateOne(
    { _id: eventId, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
    {
      $set: { status: 'processed', processedAt: now },
      $unset: { leaseOwner: '', leaseUntil: '', lastError: '' },
    },
  );
  return result.modifiedCount === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await ModerationOutbox.updateOne(
    { _id: eventId, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
    { $set: { leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)) } },
  );
  return result.matchedCount === 1;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

/**
 * Whether trying the same payload again could ever work.
 *
 * Every error `@oxyhq/crowdsource` throws carries `retryable`, which is the only
 * thing a delivery worker needs from it. Anything else — a bug here, a Mongo error
 * — is treated as retryable, because assuming a defect is permanent is how a
 * recoverable outage becomes lost moderation work.
 */
export function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
  }
  return true;
}

export interface ModerationOutboxFailure {
  released: boolean;
  deadLettered: boolean;
}

/**
 * Release a failed claim with backoff — or stop.
 *
 * Stopping is not an optimisation. A 409 means this `externalReportId` already
 * exists at CrowdSource with a different body, and a 422 means the envelope is not
 * processable. Both need the PAYLOAD to change, so they become `dead_letter`
 * immediately and stay visible with their error rather than accumulating attempts
 * nobody reads.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, '_id' | 'attempts'>,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ModerationOutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableDeliveryError(error);
  const deadLettered = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;

  const result = await ModerationOutbox.updateOne(
    { _id: event._id, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
    {
      $set: {
        status: deadLettered ? 'dead_letter' : 'pending',
        availableAt: deadLettered ? now : nextAttemptAt(event.attempts, now),
        lastError: message.slice(0, 2_000),
      },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
  return { released: result.modifiedCount === 1, deadLettered };
}

export type ModerationOutboxHandler = (event: ModerationOutboxEvent) => Promise<void>;

interface LeaseHeartbeatResult {
  lost: boolean;
  error?: unknown;
}

function startLeaseHeartbeat(options: {
  eventId: string;
  leaseOwner: string;
  leaseMs: number;
}): { stop: () => Promise<LeaseHeartbeatResult> } {
  const renewIntervalMs = Math.max(
    MIN_LEASE_RENEW_INTERVAL_MS,
    Math.floor(options.leaseMs / 3),
  );
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    const renewal = renewModerationOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) lost = true;
      })
      .catch((error: unknown) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
  };

  const timer = setInterval(renew, renewIntervalMs);
  // Never keep the event loop alive for a heartbeat — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  return {
    async stop(): Promise<LeaseHeartbeatResult> {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      return { lost, error: renewalError };
    },
  };
}

export interface ModerationDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Drain up to `batchSize` due rows. Bounded, at-least-once, lease-protected. */
export async function dispatchModerationOutbox(options: {
  handler: ModerationOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<ModerationDispatchResult> {
  const leaseOwner = options.leaseOwner ?? `moderation:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming NEW work but lets the row already in flight reach a
    // durable state.
    if (options.signal?.aborted) break;

    const event = await claimModerationOutboxEvent({ leaseOwner, leaseMs });
    if (!event) break;

    const heartbeat = startLeaseHeartbeat({ eventId: event._id, leaseOwner, leaseMs });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error: unknown) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      log.moderation.warn(
        {
          eventId: event._id,
          kind: event.kind,
          attempts: event.attempts,
          err: heartbeatResult.error,
        },
        '[ModerationOutbox] lease lost during delivery',
      );
      continue;
    }

    if (deliveryError) {
      failed += 1;
      const outcome = await failModerationOutboxEvent(event, leaseOwner, deliveryError);
      const context = {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
        err: deliveryError,
      };
      // A dead letter is moderation work that will not happen without a human, so
      // it must not be discoverable only by reading a warn-level log line.
      if (outcome.deadLettered) {
        deadLettered += 1;
        log.moderation.error(context, '[ModerationOutbox] event dead-lettered');
      } else {
        log.moderation.warn(context, '[ModerationOutbox] delivery failed, will retry');
      }
      if (!outcome.released) {
        log.moderation.warn(
          { eventId: event._id, kind: event.kind },
          '[ModerationOutbox] lease lost before failure release',
        );
      }
      continue;
    }

    const completed = await completeModerationOutboxEvent(event._id, leaseOwner);
    if (!completed) {
      failed += 1;
      log.moderation.warn(
        { eventId: event._id, kind: event.kind, attempts: event.attempts },
        '[ModerationOutbox] lease lost before completion',
      );
      continue;
    }
    processed += 1;
  }

  return { processed, failed, deadLettered };
}
