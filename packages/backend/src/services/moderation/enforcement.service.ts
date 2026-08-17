/**
 * Carrying out a decision, exactly once.
 *
 * Two guarantees, and everything here exists for one of them.
 *
 * **Once.** The idempotency key is `decisionId + revision + action`, and
 * `moderation_enforcements_decision_revision_action_key` IS that key. Each action
 * CLAIMS its row before doing anything; a second attempt — a redelivered webhook,
 * a reclaimed outbox lease, an operator replay — loses the insert and does
 * nothing. Reading "have I done this?" and then acting would leave the gap between
 * the two, which is exactly when a redelivery arrives.
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
 *
 * ## What the port changed, and what it did not
 *
 * A duplicate claim now arrives as `null` from the repository rather than as a
 * driver error to classify by code — so "another delivery owns this action" and
 * "the database could not answer" are structurally different results instead of
 * two branches of one `catch`. The rest is the same algorithm against different
 * storage, on purpose: this file is where a subtle rewrite would cost a double
 * takedown.
 */

import type { Decision } from '@oxyhq/crowdsource-contracts';
import { isLiveEntityId } from '@oxyhq/db';
import type {
  AbuseReportedType,
  ListingStatus,
  ModerationEnforcementAction,
  OrderStatus,
} from '@mercaria/shared-types';
import {
  claimModerationEnforcement,
  deleteModerationEnforcement,
  findLatestAppliedEnforcement,
  markModerationEnforcementApplied,
  recordModerationEnforcementNotApplied,
  type EnforcementPreviousState,
} from '../../db/moderation/moderationEnforcementRepository.js';
import {
  findListingById,
  setListingStatusIfIn,
  updateListingColumns,
} from '../../db/catalog/listingRepository.js';
import { getDb } from '../../db/postgres.js';
import {
  findReviewById,
  scopedTargetOfReview,
  setReviewStatusIfIn,
  type ReviewRecord,
} from '../../db/reviews/reviewRepository.js';
import { rebuildScopedAggregate } from '../reviews/review-aggregate.service.js';
import {
  findFreezableOrderIdsForListing,
  setOrderModerationHold,
} from '../../db/orders/orderRepository.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { planEnforcement, type PlannedEnforcementAction } from './enforcement-plan.js';
import { notifySellerOfRequestedChanges } from './seller-notification.js';
import { requestNativeOfferSync } from '../offers/native-offer.service.js';

export interface EnforcementSubject {
  /**
   * Mercaria's own noun — `listing`, `review`, `seller`, `store`.
   *
   * The UNION rather than `string`, because `moderation_enforcements.subject_type`
   * carries `moderation_enforcements_subject_type_check` over exactly this set: a
   * value outside it is now a failed write at claim time rather than a row that
   * reads back as a noun nothing can act on.
   */
  type: AbuseReportedType;
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

/** The actions a `restore` can undo — the ones that took something away. */
const REVERSIBLE_ACTIONS: readonly ModerationEnforcementAction[] = [
  'restrict',
  'request_changes',
  'freeze_transaction',
];

type EffectResult =
  | {
      changed: true;
      reason?: string;
      previousState?: EnforcementPreviousState;
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
  /**
   * The comparison projection is asked to catch up (#57 native rules 2 and 5).
   *
   * It is NOT what stops the item being bought — `deriveNativeCheckoutEligibility`
   * reads `listings.status` live, so the restriction above already did that, in
   * this statement, with no queue between it and the buyer. This request is so a
   * product page stops SHOWING the restricted listing among its offers, which is
   * a display fact and correctly eventual.
   */
  // The root connection, stated (#584): the status write above committed on its own.
  await requestNativeOfferSync(listingId, getDb());
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
  // A draft is not offerable either — see `restrictListing` for why this is a
  // display catch-up and not the thing that stops a sale.
  // The root connection, stated (#584): the status write above committed on its own.
  await requestNativeOfferSync(listingId, getDb());

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
  // `isLiveEntityId` for the same reason as `restrictListing`: a review written
  // after the cutover carries a uuid v7, and the old ObjectId check would have
  // refused to hide any of them while reporting a tidy "not a valid id".
  if (!isLiveEntityId(reviewId)) {
    return { changed: false, reason: 'The reported review id is not a valid id' };
  }
  const review = await findReviewById(reviewId);
  if (!review) return { changed: false, reason: 'The reported review no longer exists' };
  if (review.status === 'hidden') {
    return { changed: false, reason: 'The review was already hidden' };
  }

  // A conditional write in ONE statement, not a read-then-write: the read above
  // is for the REASON and the previous state, and a redelivery racing it must
  // still hide the review exactly once.
  const hidden = await setReviewStatusIfIn(reviewId, 'hidden', ['published']);
  if (!hidden) return { changed: false, reason: 'The review was already hidden' };

  await refreshAggregateForReview(review, 'hide');

  return { changed: true, previousState: { reviewStatus: review.status } };
}

/**
 * Re-derive the scoped aggregate a review belongs to, after its status moved.
 *
 * #76 moderation rule 3: a hidden review leaves the aggregate counts and rating
 * "through an idempotent rebuild or transactional update". This is the idempotent
 * rebuild, called at the moment the status changed rather than left to the daily
 * sweep — a jury hiding a defamatory review and its star still counting for
 * twenty-four hours is not an acceptable window.
 *
 * It runs AFTER the CAS and is deliberately best-effort: the enforcement already
 * committed, the rebuild is idempotent, and the sweep re-derives it anyway, so a
 * failure here must not turn a successful takedown into a retryable one that
 * would re-claim its ledger row. A legacy review with no scope has its
 * projection maintained by the legacy sweep instead.
 */
async function refreshAggregateForReview(
  review: ReviewRecord,
  occasion: 'hide' | 'restore',
): Promise<void> {
  const target = scopedTargetOfReview(review);
  if (!target) return;
  try {
    await rebuildScopedAggregate(target.scope, target.targetId);
  } catch (err) {
    log.moderation.warn(
      { err, reviewId: review.id, occasion },
      'Review aggregate rebuild after moderation failed (the sweep will re-derive it)',
    );
  }
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
  const previous = await findLatestAppliedEnforcement(
    subject.type,
    subject.id,
    REVERSIBLE_ACTIONS,
  );

  if (!previous) {
    return { changed: false, reason: 'Nothing had been enforced against this subject' };
  }

  if (previous.action === 'freeze_transaction') {
    const heldOrderIds = previous.previousState.heldOrderIds ?? [];
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
    const restoredStatus = previous.previousState.reviewStatus ?? 'published';
    const restored = await setReviewStatusIfIn(subject.id, restoredStatus, ['hidden']);
    if (!restored) return { changed: false, reason: 'The review was not hidden' };
    // The review is visible again, so its rating counts again — the same
    // idempotent rebuild the takedown ran, in the other direction.
    const review = await findReviewById(subject.id);
    if (review) await refreshAggregateForReview(review, 'restore');
    return { changed: true };
  }

  /**
   * Restored to what it WAS, read off the row that changed it — never to a
   * hardcoded `active`. A listing that was a draft when it was restricted must not
   * be PUBLISHED by a correction: that would put an item on sale its seller had
   * never listed.
   *
   * No runtime narrowing here any more, and that is the port working rather than a
   * guard going missing: Mongo declared `previousState.listingStatus` as a bare
   * `String`, so a value `listings_status_check` would refuse could be stored and
   * only fail at RESTORE time — when a seller is waiting. The column now carries
   * `moderation_enforcements_previous_listing_status_check` over the SAME set as
   * its destination, so a bad value fails the write that created it and what comes
   * back is already a `ListingStatus`.
   */
  const restoredStatus: ListingStatus = previous.previousState.listingStatus ?? 'active';
  /**
   * A `restrict` can also be undone from `archived`, and ONLY a `restrict` (#402).
   *
   * A restricted listing that was then archived was unrelistable: the restore was
   * refused by its own predicate and reported that the listing had never been
   * restricted. #402 closed the merchant-driven half of that at
   * `catalog-write.archiveListing`, but two connector paths still archive from any
   * status on purpose — a `product_delete` webhook and the delete reconciliation
   * after a fully-completed backfill — because a product genuinely gone upstream is
   * gone whatever Mercaria decided. That is only safe if an appeal can still reach
   * it, which is this line. It also repairs the rows the escapes already made.
   *
   * `request_changes` deliberately does NOT get `archived`. It leaves the listing
   * a `draft`, which is a status the seller fully controls, so archiving from
   * there is an ordinary delete of their own listing — and republishing that on a
   * correction would put an item back on sale its seller had deleted, which is the
   * same harm as restoring to a hardcoded `active` one paragraph up. A `restrict`
   * carries no such ambiguity: a seller can neither PATCH nor (since #402) archive
   * their way out of one, so a restricted listing that is now `archived` did not
   * get there by a decision anybody made about wanting it gone.
   */
  const restorableFrom: ListingStatus[] =
    previous.action === 'restrict'
      ? ['restricted', 'draft', 'archived']
      : ['restricted', 'draft'];
  /**
   * `restoredStatus` can be `archived`: moderation may restrict a listing that
   * was ALREADY archived, and this restore writes back what it replaced rather
   * than a hardcoded `active`. So this is a status writer that archives (#390),
   * and it names its own cause.
   *
   * `moderation_restore` is deliberately NOT undone by an upstream republish,
   * even where the original archive was a connector's. The listing has since
   * been through a restriction and an appeal — a decision by somebody else
   * about this same listing — and a connector reaching back through that to
   * relist it would be exactly the "remote fact overruling a local decision"
   * this issue exists to prevent. It stays archived; `restoreSubject` is
   * already the path that reaches it (#402).
   */
  const restored = await setListingStatusIfIn(
    subject.id,
    restoredStatus,
    restorableFrom,
    restoredStatus === 'archived' ? 'moderation_restore' : undefined,
  );
  if (!restored) {
    return { changed: false, reason: 'The listing was not in a state this restore can undo' };
  }
  // The other direction of the same request: a relisted item has to come BACK
  // into the comparison surface, and an accepted appeal that left the offer
  // retired would restore the listing and nothing a shopper can see.
  // The root connection, stated (#584): the CAS above committed on its own.
  await requestNativeOfferSync(subject.id, getDb());
  return { changed: true };
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
   * redelivered webhook harmless. A `null` is that loss; anything else that goes
   * wrong throws, and must, because "the ledger could not answer" is not the same
   * claim as "somebody else has it".
   */
  const claim = await claimModerationEnforcement({
    decisionId: decision.id,
    revision: decision.revision,
    action: planned.action,
    ...(decision.caseId === undefined ? {} : { caseId: decision.caseId }),
    subjectType: subject.type,
    subjectId: subject.id,
    reason: allowed
      ? planned.reason
      : `${planned.reason} (not applied: enforcement mode is ${config.crowdSource.enforcementMode})`,
    ...(planned.recommendedAction === undefined
      ? {}
      : { recommendedAction: planned.recommendedAction }),
  });

  if (claim === null) {
    return { action: planned.action, result: 'duplicate' };
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
    await deleteModerationEnforcement(claim.id);
    throw error;
  }

  if (!effect.changed) {
    await recordModerationEnforcementNotApplied(claim.id, effect.reason);
    return { action: planned.action, result: 'recorded' };
  }

  await markModerationEnforcementApplied(claim.id, effect.previousState ?? {});

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
