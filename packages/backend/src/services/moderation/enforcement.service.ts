/**
 * Carrying out a decision, exactly once.
 *
 * Two guarantees, and everything here exists for one of them.
 *
 * **Once.** The idempotency key is `decisionId + revision + action`, and the unique
 * index on `ModerationEnforcement` IS that key. Each action CLAIMS its row before
 * doing anything; a second attempt — a redelivered webhook, a reclaimed outbox
 * lease, an operator replay — loses the insert and does nothing. Reading "have I
 * done this?" and then acting would leave the gap between the two, which is
 * exactly when a redelivery arrives.
 *
 * **Reversibly.** Every action that changes state records what the state WAS, and
 * a reversal puts that back. So a restore returns a listing to the status it
 * actually had — `draft` stays `draft` — rather than to a guess at `active`, and
 * releasing a freeze releases exactly the orders that were held rather than
 * everything that happens to be held now.
 *
 * `observe` mode runs all of this except the effect. That is deliberate: the plan,
 * the claim and the record are identical to production, so what the mode proves is
 * exactly what will happen when it is switched off — and the audit trail is real
 * rather than a log line saying a decision was seen.
 */

import mongoose from 'mongoose';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import { ALL_LISTING_STATUSES } from '@mercaria/shared-types';
import type {
  ListingStatus,
  ModerationEnforcementAction,
  OrderStatus,
} from '@mercaria/shared-types';
import {
  ModerationEnforcement,
  type IModerationEnforcement,
} from '../../models/moderation-enforcement.js';
import { isLiveEntityId } from '@oxyhq/db';
import {
  findListingById,
  setListingStatusIfIn,
  updateListingColumns,
} from '../../db/catalog/listingRepository.js';
import { Review } from '../../models/review.js';
import {
  findFreezableOrderIdsForListing,
  setOrderModerationHold,
} from '../../db/orders/orderRepository.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { planEnforcement, type PlannedEnforcementAction } from './enforcement-plan.js';
import { notifySellerOfRequestedChanges } from './seller-notification.js';

export interface EnforcementSubject {
  /** Mercaria's own noun — `listing`, `review`, `seller`, `store`. */
  type: string;
  id: string;
}

export interface EnforcementOutcome {
  action: ModerationEnforcementAction;
  /**
   * `applied` — the effect happened. `recorded` — claimed and deliberately not
   * carried out (observe/manual mode, or there was nothing to do). `duplicate` —
   * another delivery of this same decision revision already handled it.
   */
  result: 'applied' | 'recorded' | 'duplicate';
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/**
 * Order statuses a freeze can still affect.
 *
 * A cancelled or refunded order has already stopped; holding it would record an
 * effect on something that cannot move anyway.
 */
const FREEZABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
];

type EffectResult =
  | {
      changed: true;
      reason?: string;
      previousState?: IModerationEnforcement['previousState'];
    }
  | { changed: false; reason: string };

async function restrictListing(listingId: string): Promise<EffectResult> {
  // `isLiveEntityId`, NOT `mongoose.isValidObjectId`: a listing created after the
  // Postgres cutover carries a uuid v7, which the ObjectId check REJECTS — so the
  // old guard would have refused to enforce against every new listing while
  // reporting a tidy "not a valid id".
  if (!isLiveEntityId(listingId)) {
    return { changed: false, reason: 'The reported listing id is not a valid id' };
  }
  const listing = await findListingById(listingId);
  if (!listing) return { changed: false, reason: 'The reported listing no longer exists' };
  if (listing.status === 'restricted') {
    return { changed: false, reason: 'The listing was already restricted' };
  }

  await updateListingColumns(listingId, { status: 'restricted' });
  return { changed: true, previousState: { listingStatus: listing.status } };
}

async function requestListingChanges(listingId: string): Promise<EffectResult> {
  // See `restrictListing` for why this is not `mongoose.isValidObjectId`.
  if (!isLiveEntityId(listingId)) {
    return { changed: false, reason: 'The reported listing id is not a valid id' };
  }
  const listing = await findListingById(listingId);
  if (!listing) return { changed: false, reason: 'The reported listing no longer exists' };

  /**
   * A restricted listing is NOT sent back to the seller for edits.
   *
   * `restrict` is the stronger, jury-imposed state; turning it into an editable
   * draft would hand control back to the seller and quietly undo an enforcement
   * nobody reversed.
   */
  if (listing.status === 'restricted') {
    return { changed: false, reason: 'The listing is restricted; changes are not requested' };
  }
  if (listing.status === 'draft') {
    return { changed: false, reason: 'The listing was already a draft' };
  }

  await updateListingColumns(listingId, { status: 'draft' });

  // Best-effort: a seller who is not told cannot fix the listing, but a
  // notification failure must not undo an enforcement that already committed.
  await notifySellerOfRequestedChanges({
    listingId,
    listingTitle: listing.title,
    ownerType: listing.ownerType,
    ...(listing.oxyUserId === null ? {} : { oxyUserId: listing.oxyUserId }),
    ...(listing.storeId === null ? {} : { storeId: listing.storeId }),
  });

  return { changed: true, previousState: { listingStatus: listing.status } };
}

async function hideReview(reviewId: string): Promise<EffectResult> {
  if (!mongoose.isValidObjectId(reviewId)) {
    return { changed: false, reason: 'The reported review id is not a valid id' };
  }
  const review = await Review.findById(reviewId)
    .select('status')
    .lean<{ status?: string } | null>();
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (review.status === 'hidden') {
    return { changed: false, reason: 'The review was already hidden' };
  }

  await Review.updateOne({ _id: reviewId }, { $set: { status: 'hidden' } });
  return { changed: true, previousState: { reviewStatus: review.status ?? 'published' } };
}

/**
 * Hold every live order carrying the reported listing.
 *
 * The ids are recorded so the release puts back exactly this set. Releasing "every
 * held order for this listing" instead would clear a freeze imposed by a DIFFERENT,
 * still-open case the moment this one was overturned.
 */
async function freezeOrdersForListing(listingId: string): Promise<EffectResult> {
  const orderIds = await findFreezableOrderIdsForListing(listingId, FREEZABLE_ORDER_STATUSES);

  if (orderIds.length === 0) {
    return { changed: false, reason: 'No live orders carry this listing' };
  }

  await setOrderModerationHold(orderIds, true);
  return { changed: true, previousState: { heldOrderIds: orderIds } };
}

/**
 * Undo whatever this subject's most recent APPLIED enforcement did.
 *
 * Reads the ledger rather than assuming, because "restore" means different things
 * depending on what was done: republish at the previous status, unhide the review,
 * release exactly the orders that were frozen. A restore with nothing to undo is
 * recorded as such — evidence that we looked, rather than a silent no-op.
 */
async function restoreSubject(subject: EnforcementSubject): Promise<EffectResult> {
  const previous = await ModerationEnforcement.findOne({
    subjectType: subject.type,
    subjectId: subject.id,
    action: { $in: ['restrict', 'request_changes', 'freeze_transaction'] },
    applied: true,
  })
    .sort({ createdAt: -1 })
    .lean<IModerationEnforcement | null>();

  if (!previous) {
    return { changed: false, reason: 'Nothing had been enforced against this subject' };
  }

  if (previous.action === 'freeze_transaction') {
    const heldOrderIds = previous.previousState?.heldOrderIds ?? [];
    if (heldOrderIds.length === 0) {
      return { changed: false, reason: 'The freeze recorded no held orders' };
    }
    // No id-shape filter: an order id is `text` now and holds a 24-hex ObjectId
    // for a pre-cutover row and a uuid v7 for a newer one, so `isValidObjectId`
    // would silently drop exactly the orders created after the migration —
    // leaving a frozen order nobody can release.
    await setOrderModerationHold(heldOrderIds, false);
    return { changed: true };
  }

  if (subject.type === 'review') {
    const restoredStatus = previous.previousState?.reviewStatus ?? 'published';
    const result = await Review.updateOne(
      { _id: subject.id, status: 'hidden' },
      { $set: { status: restoredStatus } },
    );
    return result.modifiedCount === 1
      ? { changed: true }
      : { changed: false, reason: 'The review was not hidden' };
  }

  /**
   * Restored to what it WAS, read off the row that changed it — never to a
   * hardcoded `active`. A listing that was a draft when it was restricted must not
   * be PUBLISHED by a correction: that would put an item on sale its seller had
   * never listed.
   */
  // `previousState.listingStatus` is a bare `String` on the enforcement row — the
  // schema deliberately did not constrain it — so it is NARROWED here rather than
  // trusted. An unrecognised value restores to `active`, which is what the
  // `?? 'active'` fallback already meant; the difference is that a value the
  // `listings_status_check` constraint would refuse now cannot reach the write and
  // turn an accepted appeal into a failed one.
  const stored = previous.previousState?.listingStatus;
  const restoredStatus: ListingStatus =
    stored !== undefined && (ALL_LISTING_STATUSES as readonly string[]).includes(stored)
      ? (stored as ListingStatus)
      : 'active';
  const restored = await setListingStatusIfIn(subject.id, restoredStatus, ['restricted', 'draft']);
  return restored
    ? { changed: true }
    : { changed: false, reason: 'The listing was neither restricted nor awaiting changes' };
}

/**
 * The effect of one action, or why there was none.
 *
 * A `changed: false` result means the action was claimed and correctly did nothing
 * — the listing is already gone, there was no restriction to undo. That is a
 * different thing from a failure, and it is recorded as such.
 */
async function applyEffect(
  action: ModerationEnforcementAction,
  subject: EnforcementSubject,
): Promise<EffectResult> {
  if (action === 'none' || action === 'manual_review') {
    return { changed: false, reason: `Action '${action}' has no effect by definition` };
  }

  if (action === 'restore') return await restoreSubject(subject);

  if (subject.type === 'review') {
    return action === 'restrict'
      ? await hideReview(subject.id)
      : {
          changed: false,
          reason: `Mercaria has no '${action}' effect for a reported review`,
        };
  }

  if (subject.type !== 'listing') {
    /**
     * A reported SELLER or STORE is not Mercaria's to sanction — Oxy owns
     * accounts, and an application reaching into another product's user state is
     * exactly what the one-way reputation rule forbids. Recorded for a human.
     */
    return {
      changed: false,
      reason: `Mercaria has no '${action}' effect for a reported ${subject.type}`,
    };
  }

  switch (action) {
    case 'restrict':
      return await restrictListing(subject.id);
    case 'request_changes':
      return await requestListingChanges(subject.id);
    case 'freeze_transaction':
      return await freezeOrdersForListing(subject.id);
    default:
      return { changed: false, reason: `Unhandled action '${action}'` };
  }
}

/**
 * Whether this mode is allowed to carry out this action.
 *
 * `manual` permits only `restore` — the one action that can only ever give a
 * seller their listing back. Everything that takes something away waits for a
 * human until the mode is `automatic`.
 */
function modeAllows(action: ModerationEnforcementAction): boolean {
  switch (config.crowdSource.enforcementMode) {
    case 'automatic':
      return true;
    case 'manual':
      return action === 'restore';
    case 'observe':
    default:
      return false;
  }
}

/** Carry out every action a decision plans, each exactly once. */
export async function enforceDecision(
  decision: Decision,
  subject: EnforcementSubject,
): Promise<EnforcementOutcome[]> {
  const planned = planEnforcement(decision);
  const outcomes: EnforcementOutcome[] = [];

  for (const entry of planned) {
    outcomes.push(await enforceOne(decision, subject, entry));
  }
  return outcomes;
}

async function enforceOne(
  decision: Decision,
  subject: EnforcementSubject,
  planned: PlannedEnforcementAction,
): Promise<EnforcementOutcome> {
  const allowed = modeAllows(planned.action);

  /**
   * CLAIM FIRST, then act.
   *
   * The row is inserted with the outcome we intend, and only then is the effect
   * attempted. Losing this insert means another delivery of this same decision
   * revision already owns the action, so this one stops — which is what makes a
   * redelivered webhook harmless.
   */
  let claim: IModerationEnforcement;
  try {
    const [created] = await ModerationEnforcement.create([
      {
        decisionId: decision.id,
        revision: decision.revision,
        action: planned.action,
        caseId: decision.caseId,
        subjectType: subject.type,
        subjectId: subject.id,
        applied: false,
        reason: allowed
          ? planned.reason
          : `${planned.reason} (not applied: enforcement mode is ${config.crowdSource.enforcementMode})`,
        ...(planned.recommendedAction === undefined
          ? {}
          : { recommendedAction: planned.recommendedAction }),
      },
    ]);
    claim = created;
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return { action: planned.action, result: 'duplicate' };
    }
    throw error;
  }

  if (!allowed) {
    return { action: planned.action, result: 'recorded' };
  }

  let effect: EffectResult;
  try {
    effect = await applyEffect(planned.action, subject);
  } catch (error: unknown) {
    /**
     * The effect threw, so the claim must go — otherwise this action can never be
     * retried and the listing stays in whatever half-state the failure left.
     * Releasing is the whole reason the claim is a row rather than a flag.
     */
    await ModerationEnforcement.deleteOne({ _id: claim._id });
    throw error;
  }

  if (!effect.changed) {
    await ModerationEnforcement.updateOne(
      { _id: claim._id },
      { $set: { applied: false, reason: effect.reason ?? planned.reason } },
    );
    return { action: planned.action, result: 'recorded' };
  }

  await ModerationEnforcement.updateOne(
    { _id: claim._id },
    {
      $set: {
        applied: true,
        ...(effect.previousState === undefined
          ? {}
          : { previousState: effect.previousState }),
      },
    },
  );

  log.moderation.info(
    {
      decisionId: decision.id,
      revision: decision.revision,
      action: planned.action,
      subjectType: subject.type,
      subjectId: subject.id,
    },
    '[Moderation] enforcement applied',
  );
  return { action: planned.action, result: 'applied' };
}
