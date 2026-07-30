/**
 * ModerationOutbox — the durable promise that moderation work will happen.
 *
 * A row here is not a hint that work exists; it IS the work. That distinction is
 * the whole reason the collection exists: an in-memory queue, a BullMQ job or a
 * detached promise are all evidence that evaporates when a task restarts, and
 * moderation work that evaporates does so silently — a reporter was told 201, a
 * case never opened, and nothing anywhere reports an error.
 *
 * So the rule this collection enforces is: nothing may be enqueued that is not
 * written in the SAME transaction as the domain change that owes it. See
 * `enqueueModerationOutboxEvent`, which refuses to write outside one.
 *
 * `_id` is a deterministic string derived from the thing being done, never a
 * generated id. That is what makes a transaction retry, a duplicate submission or
 * a redelivered webhook upsert the same row instead of queueing the work twice.
 */

import mongoose, { Schema, Model } from 'mongoose';

/** Rows are reaped by TTL once terminal — 14 days is long enough to investigate. */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * What an outbox row is for.
 *
 * `report.submit` delivers a stored report to CrowdSource. `decision.apply`
 * carries an inbound decision from the webhook (which must answer fast and must
 * not do the work inline) to the worker that enforces it.
 */
export type ModerationOutboxKind = 'report.submit' | 'decision.apply';

const KINDS: readonly ModerationOutboxKind[] = ['report.submit', 'decision.apply'];

export type ModerationOutboxStatus = 'pending' | 'processing' | 'processed' | 'dead_letter';

const STATUSES: readonly ModerationOutboxStatus[] = [
  'pending',
  'processing',
  'processed',
  'dead_letter',
];

/**
 * The payload, keyed by kind.
 *
 * Deliberately minimal — an id, not a snapshot. The row says WHICH report to
 * deliver; the delivery worker rebuilds the material from the live collections at
 * send time. Storing a composed envelope here instead would freeze a copy of the
 * listing in the queue and make the outbox a second, drifting source of truth.
 */
export interface ModerationOutboxPayload {
  /** `report.submit` — the local `AbuseReport` id. */
  readonly reportId?: string;
  /** `decision.apply` — the verified webhook event, as delivered. */
  readonly event?: Record<string, unknown>;
}

export interface IModerationOutbox {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  status: ModerationOutboxStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  processedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationOutboxSchema = new Schema<IModerationOutbox>(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: KINDS as unknown as string[], required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: STATUSES as unknown as string[],
      default: 'pending',
      required: true,
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, required: true },
    leaseOwner: { type: String },
    leaseUntil: { type: Date },
    lastError: { type: String },
    processedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false },
);

/** The dispatcher's claim query: due work, oldest first. */
ModerationOutboxSchema.index({ status: 1, availableAt: 1, createdAt: 1 });

/** Reclaiming a dead worker's lease. */
ModerationOutboxSchema.index({ status: 1, leaseUntil: 1 });

/**
 * TTL reaper.
 *
 * `expiresAt` is set at insert and never advanced, so a row that never reaches a
 * terminal state still leaves eventually rather than accumulating forever.
 */
ModerationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationOutbox: Model<IModerationOutbox> =
  mongoose.models.ModerationOutbox ||
  mongoose.model<IModerationOutbox>('ModerationOutbox', ModerationOutboxSchema);
