/**
 * Writing a listing's condition: its key, its disclosures, its evidence and the
 * audit row for every change (#90).
 *
 * ## The whole thing is one transaction, and the gates run INSIDE it
 *
 * `assertConditionEvidence` counts photo rows that the same transaction just
 * wrote, so it has to run after them and before the commit. That ordering is
 * what makes "a used listing requires seller photos" a property of what is
 * STORED rather than of what a request happened to contain: a later write path,
 * an operator correction and a connector sync all go through here and all get
 * counted the same way.
 *
 * It also means the canonical-image trigger has already fired by the time the
 * count runs, so a seller whose only "evidence" was a manufacturer's product
 * shot is refused by the database, naming the file, rather than by a count that
 * would just say "not enough photographs".
 *
 * ## Evidence comes from the listing's OWN gallery
 *
 * There is deliberately no separate upload channel for condition photos. The
 * seller attaches images to the listing as they always have, and the ones that
 * are theirs become evidence rows carrying who attached them and when; the
 * `photoAnnotations` on the request only say which of them show which defect
 * (#90 evidence rule 4). A second channel would mean two places a photograph's
 * ownership could be established, and they could disagree about the one thing
 * this domain has to be sure of.
 */

import {
  CONDITION_DETAIL_KINDS_WITH_SEVERITY,
  conditionEvidencePolicy,
} from '@mercaria/shared-types';
import type { ConditionAssertion, ItemConditionKey } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  insertConditionRevision,
  replaceConditionDetails,
  replaceConditionPhotos,
} from '../../db/condition/conditionRepository.js';
import {
  assertConditionEvidence,
  assertConditionPermittedForCategory,
} from './condition-evidence.service.js';
import type { ResolvedConditionInput } from './condition-input.js';

/** The three `listings` columns a condition write sets. */
export interface ConditionColumns {
  condition: ItemConditionKey;
  conditionAssertion: ConditionAssertion;
  conditionAcknowledgedAt: Date | null;
}

/**
 * The `listings` columns for a resolved client statement — pure.
 *
 * `conditionAcknowledgedAt` is stamped only when the policy asks for an
 * acknowledgement AND the client sent one. Stamping it unconditionally would
 * record a `new` listing's seller as having acknowledged defects they were never
 * asked about, which is the kind of row that reads as consent in a dispute.
 */
export function conditionColumnsFor(
  resolved: ResolvedConditionInput,
  now: Date,
): ConditionColumns {
  const policy = conditionEvidencePolicy(resolved.key);
  const acknowledged = policy.requiresDefectAcknowledgement && resolved.defectsAcknowledged;

  return {
    condition: resolved.key,
    conditionAssertion: resolved.assertion,
    conditionAcknowledgedAt: acknowledged ? now : null,
  };
}

/**
 * Who is asserting the condition.
 *
 * A DISCRIMINATED UNION with no common `oxyUserId` field — the `CommerceActor`
 * device — so the two machine actors cannot be handed an account id and the two
 * human ones cannot be written without one. That is exactly what
 * `listing_condition_revisions_actor_identity_check` enforces, and having the
 * type say it too means the mismatch is a compile error rather than a 23514 in
 * production.
 *
 * `migration` is here because the backfill's revision rows go through the same
 * writer, and giving it its own value is what stops somebody attributing a
 * backfill to whichever operator happened to run it.
 */
export type ConditionActor =
  | { kind: 'seller'; oxyUserId: string }
  | { kind: 'operator'; oxyUserId: string }
  | { kind: 'source' }
  | { kind: 'migration' };

/** The asserting account, when there is one. */
function actorOxyUserId(actor: ConditionActor): string | undefined {
  return actor.kind === 'seller' || actor.kind === 'operator' ? actor.oxyUserId : undefined;
}

/** Everything the evidence write needs about the listing it is writing for. */
export interface ConditionEvidenceWrite {
  listingId: string;
  actor: ConditionActor;
  /** The listing's own gallery file ids, in display order. */
  galleryFileIds: readonly string[];
  resolved: ResolvedConditionInput;
  categoryId: string | null;
  categorySlugs: readonly string[];
  /** The state before this write. Absent on creation. */
  previous?: { key: ItemConditionKey; assertion: ConditionAssertion };
  /** Why the condition moved. Required only when `previous` is present. */
  reason?: string;
  now: Date;
}

/**
 * Refuse a condition this category does not accept — call BEFORE the listing
 * row is written.
 *
 * Separate from {@link writeListingConditionEvidence} because the category gate
 * needs no listing to exist and the evidence gate needs one to. Running the
 * category check first means a seller in a restricted category is told so
 * without a row being created and rolled back, and the refusal quotes the
 * operator's recorded reason instead of a generic sentence.
 */
export async function assertConditionAllowed(
  tx: DatabaseOrTransaction,
  input: Pick<ConditionEvidenceWrite, 'resolved' | 'categoryId' | 'categorySlugs'>,
): Promise<void> {
  await assertConditionPermittedForCategory(tx, {
    condition: input.resolved.key,
    categoryId: input.categoryId,
    categorySlugs: input.categorySlugs,
  });
}

/**
 * Write the disclosures and the evidence, run the gate, and append the audit
 * row. Must run inside the listing's own transaction.
 *
 * Order is load-bearing: details first (their ids are what the photo
 * annotations point at), then photos, then the gate that counts them, then the
 * revision. A revision appended before the gate would record a change that the
 * transaction is about to roll back — an audit trail claiming a correction
 * nobody made.
 */
export async function writeListingConditionEvidence(
  tx: DatabaseOrTransaction,
  input: ConditionEvidenceWrite,
): Promise<void> {
  const details = await replaceConditionDetails(
    tx,
    input.listingId,
    input.resolved.details.map((detail, position) => ({
      listingId: input.listingId,
      kind: detail.kind,
      severity: CONDITION_DETAIL_KINDS_WITH_SEVERITY.includes(detail.kind)
        ? (detail.severity ?? null)
        : null,
      note: detail.note?.trim() ? detail.note.trim() : null,
      position,
    })),
  );

  const policy = conditionEvidencePolicy(input.resolved.key);
  const annotations = new Map(
    input.resolved.photoAnnotations.map((annotation) => [annotation.fileId, annotation]),
  );
  const uploader = actorOxyUserId(input.actor);

  // A condition needing photographs needs an ACCOUNT to attribute them to.
  // Refusing here rather than defaulting is #90 evidence rule 3 taken
  // seriously: an evidence row whose owner is a store id, a placeholder or a
  // system marker proves nothing, and the column being NOT NULL would have made
  // it look like it did.
  if (policy.requiresItemPhotos && !uploader) {
    throw validationError(
      'A listing in this condition needs a signed-in seller, so its condition photographs ' +
        'have an owner',
    );
  }

  // A `new` listing carries no evidence rows at all. Writing them anyway would
  // put a moderation queue entry on every sealed retail product in the
  // catalogue, for a claim nobody made.
  const photos =
    policy.requiresItemPhotos && uploader
      ? input.galleryFileIds.map((fileId) => {
          const annotation = annotations.get(fileId);
          const detailIndex = annotation?.detailIndex;
          const detail = detailIndex === undefined ? undefined : details[detailIndex];
          return {
            listingId: input.listingId,
            fileId,
            provenance: 'seller_uploaded' as const,
            uploadedByOxyUserId: uploader,
            uploadedAt: input.now,
            showsDefect: annotation?.showsDefect === true,
            conditionDetailId: detail?.id ?? null,
          };
        })
      : [];

  await replaceConditionPhotos(tx, input.listingId, photos);

  await assertConditionEvidence(tx, {
    listingId: input.listingId,
    condition: input.resolved.key,
    disclosedKinds: input.resolved.details.map((detail) => detail.kind),
    defectsAcknowledged: input.resolved.defectsAcknowledged,
    refurbisherNamed: input.resolved.details.some(
      (detail) => detail.kind === 'repair_or_refurbishment',
    ),
    categoryId: input.categoryId,
    categorySlugs: input.categorySlugs,
  });

  const changed =
    !input.previous ||
    input.previous.key !== input.resolved.key ||
    input.previous.assertion !== input.resolved.assertion;

  // A write that restates the same condition appends nothing. The revision table
  // records CHANGES, and a row per save would bury the corrections a dispute
  // needs to find among hundreds of no-ops.
  if (!changed) return;

  await insertConditionRevision(tx, {
    listingId: input.listingId,
    fromCondition: input.previous?.key ?? null,
    toCondition: input.resolved.key,
    fromAssertion: input.previous?.assertion ?? null,
    toAssertion: input.resolved.assertion,
    actorKind: input.actor.kind,
    actorOxyUserId: uploader ?? null,
    reason:
      input.reason?.trim() || (input.previous ? 'Condition updated' : 'Listing created'),
  });
}
