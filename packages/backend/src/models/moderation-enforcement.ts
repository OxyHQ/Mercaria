/**
 * ModerationEnforcement — the ledger of what Mercaria did, and the lock that
 * makes it happen exactly once.
 *
 * The unique compound index on `{decisionId, revision, action}` IS the idempotency
 * key. Each action claims its row BEFORE acting; a second attempt — a redelivered
 * webhook, a reclaimed outbox lease, an operator replay — loses the insert and
 * does nothing. Checking "have I done this?" and then acting would leave a gap
 * between the two, and that gap is precisely when a redelivery arrives.
 *
 * `revision` is IN the key, not merely stored beside it. A correction (an accepted
 * appeal) arrives as a NEW revision of the same decision, and its `restore` has to
 * be a different action from the `restrict` it supersedes. Drop `revision` from
 * the key and the restore collides with the removal, loses, and the seller's
 * listing stays down forever — with the case saying it was fine, and no error
 * anywhere.
 *
 * `previousState` is what makes the ledger reversible: every action that changes
 * something records what it changed FROM, so a restore returns the listing to the
 * status it actually had rather than to a guess at `active`.
 */

import mongoose, { Schema, Model } from 'mongoose';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  type ModerationEnforcementAction,
} from '@mercaria/shared-types';

export interface IModerationEnforcement {
  _id: mongoose.Types.ObjectId;
  decisionId: string;
  revision: number;
  action: ModerationEnforcementAction;
  caseId?: string;
  /** Mercaria's own noun and id — `listing`, `review`, `seller`, … */
  subjectType: string;
  subjectId: string;
  /**
   * Whether the effect actually happened.
   *
   * `false` covers three genuinely different situations, which is why `reason` is
   * required alongside it: observe/manual mode declined to act, there was nothing
   * to undo, or the object no longer exists. All three are evidence; none is a
   * failure.
   */
  applied: boolean;
  reason: string;
  /** The recommendation this came from, when it came from one rather than severity. */
  recommendedAction?: string;
  /** What was replaced, so the reversal has something true to put back. */
  previousState?: {
    listingStatus?: string;
    reviewStatus?: string;
    heldOrderIds?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const ModerationEnforcementSchema = new Schema<IModerationEnforcement>(
  {
    decisionId: { type: String, required: true },
    revision: { type: Number, required: true },
    action: {
      type: String,
      enum: MODERATION_ENFORCEMENT_ACTIONS as unknown as string[],
      required: true,
    },
    caseId: { type: String },
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true },
    applied: { type: Boolean, required: true },
    reason: { type: String, required: true },
    recommendedAction: { type: String },
    previousState: {
      listingStatus: { type: String },
      reviewStatus: { type: String },
      heldOrderIds: { type: [String] },
    },
  },
  { timestamps: true },
);

/** Appendix D's idempotency key. The claim that makes enforcement exactly-once. */
ModerationEnforcementSchema.index(
  { decisionId: 1, revision: 1, action: 1 },
  { unique: true },
);

/**
 * "What was done to this object, most recently?" — how a `restore` finds the
 * state its `restrict` displaced.
 */
ModerationEnforcementSchema.index({ subjectType: 1, subjectId: 1, createdAt: -1 });

export const ModerationEnforcement: Model<IModerationEnforcement> =
  mongoose.models.ModerationEnforcement ||
  mongoose.model<IModerationEnforcement>(
    'ModerationEnforcement',
    ModerationEnforcementSchema,
  );
