/**
 * Closing the review item a merge or a split was requested FROM (#893, epic
 * #367 line 340).
 *
 * ## The defect, measured rather than reasoned
 *
 * `requestMerge` and `requestSplit` both accept a `reviewItemId`, store it on
 * the job and stamp it on the revision. Driven end to end against a real server
 * — an operator raises `suspected_duplicate` between two products, requests the
 * merge FROM that item, the merge completes — **the item is still `open`, still
 * naming the loser, which is now a tombstone.** The question was answered by the
 * act that named it, and the queue goes on asking it.
 *
 * `CURATION_RESOLUTIONS` has said what that outcome is called since the
 * vocabulary was written: `merged`, and `split` beside it. Before this module
 * NOTHING wrote either — `closeReviewItem` had exactly one caller,
 * `resolveItem`, which is an operator typing into the HTTP surface. So the two
 * resolutions that name what a job did were reachable only by a person doing
 * the job's bookkeeping by hand, and reachable only if they remembered.
 *
 * ## What it deliberately does NOT do
 *
 * It closes the ONE item the job was requested from, and no other. An unrelated
 * open item that happens to be about the loser stays open: dismissing it would
 * be a machine taking an operator's decision, and it is a worse version of the
 * repointing that `POLYMORPHIC_ENTITY_REFERENCES` already refuses for this table
 * ("rehoming either side would silently change the question after the fact").
 * What such an item gets instead is the annotation in `subject-redirect.ts`, so
 * the person deciding it can see that its subject was merged away.
 *
 * ## Idempotency is the CAS, not a check
 *
 * `closeReviewItem` updates `WHERE state IN ('open','in_review')` and returns
 * the row, so an EMPTY result IS the "already closed" answer — the
 * `moderation_events` claim shape. A re-run of a completed job, an operator who
 * closed the item by hand first, and two workers racing all converge on one
 * closure with no read-then-write in between.
 */

import type { CurationResolution } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { closeReviewItem, findReviewItemById } from '../../db/curation/curationRepository.js';
import { recordRevision } from './revision.js';

/** What a job needs to carry for its originating item to be closable. */
export interface JobReviewItemClosure {
  readonly reviewItemId: string | null;
  readonly requestedByOxyUserId: string;
  readonly reason: string;
  /** Exactly one of these, matching `catalog_revisions_job_check`. */
  readonly mergeJobId?: string;
  readonly splitJobId?: string;
}

/**
 * Close the item this job was requested from, if it named one and it is open.
 *
 * Returns whether THIS call closed it. `false` covers both "the job named no
 * item" and "the item was already closed", which are the same thing to a
 * caller — there is nothing left to do either way — and are told apart in the
 * record by whether `catalog_merge_jobs.review_item_id` is null.
 *
 * Runs in the CALLER's transaction. That placement is the whole guarantee: the
 * closure and the job's own completion commit together, so there is no instant
 * at which a job is `done` and the question it answered is still being asked.
 */
export async function closeJobReviewItem(
  job: JobReviewItemClosure,
  resolution: Extract<CurationResolution, 'merged' | 'split'>,
  db: DatabaseOrTransaction,
): Promise<boolean> {
  const itemId = job.reviewItemId;
  if (itemId === null) return false;

  const item = await findReviewItemById(itemId, db);
  // The pointer is `on delete set null`, so a missing row means the item was
  // deleted between the request and the completion. Nothing to close, and
  // nothing to report: the job's own record already says which item it named.
  if (!item) return false;

  const closed = await closeReviewItem(
    {
      id: itemId,
      state: 'resolved',
      resolution,
      // The JOB's reason, verbatim. Composing a sentence around it would risk
      // `catalog_review_items_reason_length_check` on a reason already at the
      // limit, and the composition is unnecessary: `resolution` says a merge or
      // a split closed this, `resolved_by_oxy_user_id` says who asked for it,
      // and the revision below carries the job id.
      resolutionReason: job.reason,
      resolvedByOxyUserId: job.requestedByOxyUserId,
    },
    db,
  );
  if (!closed) return false;

  await recordRevision(
    {
      // The item's OWN subject, not the job's winner. A merge records every one
      // of its own revisions against the LOSER (`requestMerge`, `approveMerge`),
      // so following the tombstone here would make the queue's half of the
      // trail land somewhere the merge's half does not — and `catalog_revisions`
      // is `untouched` by a merge precisely because one entity's history must
      // not move onto another's.
      entityType: item.subjectType,
      entityId: item.subjectId,
      action: 'correct',
      actorKind: 'operator',
      actorOxyUserId: job.requestedByOxyUserId,
      reason: job.reason,
      note: `review item ${item.kind} closed as ${resolution} by the job it was requested from`,
      ...(job.mergeJobId ? { mergeJobId: job.mergeJobId } : {}),
      ...(job.splitJobId ? { splitJobId: job.splitJobId } : {}),
      reviewItemId: item.id,
      before: { state: item.state },
      after: { state: 'resolved', resolution },
    },
    db,
  );
  return true;
}
