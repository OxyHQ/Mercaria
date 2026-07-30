/**
 * ModerationEvent — the webhook dedupe claim, shared across tasks.
 *
 * `@oxyhq/crowdsource-express` defaults to an IN-PROCESS store, which is correct
 * for a single instance and wrong for Mercaria: the API runs several ECS Fargate
 * tasks behind one ALB, so the two copies of a redelivered event routinely land on
 * DIFFERENT tasks. An in-process store would dedupe only the task unlucky enough
 * to receive both, and the other copy would be enforced a second time — the exact
 * double-enforcement the claim exists to prevent.
 *
 * A claim is an INSERT, not a read-then-write: whoever wins the unique `_id` runs
 * the handler. A handler that throws releases its claim so §10.9's retry still
 * works, which is why `release` deletes rather than marking failed.
 */

import mongoose, { Schema, Model } from 'mongoose';

/**
 * How long a claim is remembered.
 *
 * Comfortably longer than CrowdSource's retry schedule — the claim must outlive
 * every redelivery of the event it covers, or the last retry looks new.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface IModerationEvent {
  /** The CrowdSource event id, exactly as delivered. */
  _id: string;
  eventType: string;
  claimedAt: Date;
  completedAt?: Date;
  expiresAt: Date;
}

const ModerationEventSchema = new Schema<IModerationEvent>(
  {
    _id: { type: String, required: true },
    eventType: { type: String, required: true },
    claimedAt: { type: Date, required: true },
    completedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { _id: false, versionKey: false },
);

ModerationEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ModerationEvent: Model<IModerationEvent> =
  mongoose.models.ModerationEvent ||
  mongoose.model<IModerationEvent>('ModerationEvent', ModerationEventSchema);
