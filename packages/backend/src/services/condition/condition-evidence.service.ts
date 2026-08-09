/**
 * The evidence gate: may a listing be published in this condition? (#90 evidence
 * rules 1–4, policy rules 2 and 5, acceptance 4.)
 *
 * ## What "seller-owned photos" is actually enforced by, in three layers
 *
 * 1. **The vocabulary.** `ConditionPhotoProvenance` has only seller-owned
 *    members, so there is no value meaning "a catalogue image" for a write path
 *    to record.
 * 2. **The database.** `mercaria_reject_canonical_condition_photo` refuses a
 *    `file_id` any `canonical_images` row already claims. This is the layer that
 *    matters, because the attack is not an enum value — it is a seller
 *    attaching the manufacturer's own product shot, whose file id is a perfectly
 *    ordinary Oxy media id that this service has no way to recognise.
 * 3. **This gate.** Counts only photos in `EVIDENTIAL_CONDITION_PHOTO_STATES`,
 *    so a listing whose evidence was rejected stops meeting its condition's
 *    requirement rather than keeping a pass it earned once.
 *
 * The gate runs INSIDE the listing's own transaction, after the detail and photo
 * rows are written, because it counts rows the same statement produced — the
 * canonical-image trigger has already fired by then, so a listing whose only
 * "evidence" was a stock photograph fails on the trigger rather than here, with
 * a message that says which file.
 *
 * ## Why refusals name the reason and not the remedy
 *
 * Each refusal says what is missing in the seller's own terms. None of them
 * says anything about another seller, another listing, or the moderation state
 * of a specific photo beyond its own listing — the review-domain rule, applied
 * for the same reason: a refusal is a message to one person about their own
 * item.
 */

import {
  CONDITION_DISCLOSURE_KINDS,
  conditionEvidencePolicy,
} from '@mercaria/shared-types';
import type { ConditionDetailKind, ItemConditionKey } from '@mercaria/shared-types';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import { countEvidentialConditionPhotos } from '../../db/condition/conditionRepository.js';
import { findApplicablePolicies } from '../../db/condition/conditionPolicyRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';

/** Everything the gate needs about the listing under evaluation. */
export interface ConditionEvidenceFacts {
  listingId: string;
  condition: ItemConditionKey;
  /** The kinds the seller actually disclosed, in this write. */
  disclosedKinds: readonly ConditionDetailKind[];
  /** Whether the seller affirmatively acknowledged them. */
  defectsAcknowledged: boolean;
  /** Whether a refurbishment party was named — a `repair_or_refurbishment` detail. */
  refurbisherNamed: boolean;
  categoryId: string | null;
  categorySlugs: readonly string[];
}

/**
 * Refuse a condition this category does not permit (#90 policy rule 5).
 *
 * Runs FIRST and separately from the evidence checks, because "you may not sell
 * a used one of these here" is a different answer from "you have not shown me
 * enough" and a seller told the second when the first applies will keep
 * uploading photographs.
 *
 * The refusal quotes the operator's own recorded reason. A generic message would
 * be safe and useless: safety and legal restrictions are exactly the ones a
 * seller needs stated.
 */
export async function assertConditionPermittedForCategory(
  tx: DatabaseOrTransaction,
  facts: Pick<ConditionEvidenceFacts, 'condition' | 'categoryId' | 'categorySlugs'>,
): Promise<void> {
  const policies = await findApplicablePolicies(tx, facts.categoryId, facts.categorySlugs);
  const blocking = policies.find((policy) => policy.conditionKey === facts.condition);
  if (!blocking) return;

  throw conflict(`This category does not accept this condition: ${blocking.reason}`);
}

/**
 * Refuse a listing whose evidence does not meet its own condition's policy.
 *
 * Reads `CONDITION_EVIDENCE_POLICIES` and never asks "is the condition used" —
 * the `claim-methods.ts` device from #83. Adding a taxonomy key therefore
 * changes one table, and this function needs no edit at all.
 */
export async function assertConditionEvidence(
  tx: DatabaseOrTransaction,
  facts: ConditionEvidenceFacts,
): Promise<void> {
  const policy = conditionEvidencePolicy(facts.condition);

  if (policy.requiresItemPhotos) {
    const photos = await countEvidentialConditionPhotos(tx, facts.listingId);
    if (photos < policy.minimumItemPhotos) {
      throw validationError(
        `A listing in this condition needs at least ${policy.minimumItemPhotos} ` +
          `photograph${policy.minimumItemPhotos === 1 ? '' : 's'} of the actual item. ` +
          'Catalogue and manufacturer images cannot stand in for them.',
      );
    }
  }

  if (policy.requiresDefectAcknowledgement) {
    if (!facts.defectsAcknowledged) {
      throw validationError(
        'Confirm that you have described the defects and missing parts of this item before publishing it',
      );
    }
    const disclosed = facts.disclosedKinds.some((kind) => CONDITION_DISCLOSURE_KINDS.includes(kind));
    if (!disclosed) {
      throw validationError(
        'Describe the wear, faults or missing parts of this item — or say there are none by ' +
          'choosing a condition that does not require it',
      );
    }
  }

  if (policy.requiresRefurbisherAttribution && !facts.refurbisherNamed) {
    throw validationError(
      'A refurbished listing must say who refurbished it, as a repair or refurbishment detail',
    );
  }
}
