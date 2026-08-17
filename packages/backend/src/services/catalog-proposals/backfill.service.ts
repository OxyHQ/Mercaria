/**
 * The idempotent backfill an approval owes (#367 step 6, ADR 0007 D9).
 *
 * D9: *"On approval the canonical entity is created or linked and affected drafts
 * and listings are backfilled **idempotently**."* Two things make that word real
 * here, and neither is a convention:
 *
 * 1. **The affected set is ENUMERATED, not re-derived.**
 *    `catalog_proposal_references` names every draft answer and every retained
 *    listing claim that was waiting when the request was made. Re-deriving the
 *    set at approval time from a label would give a different answer on the retry
 *    than on the first attempt — a merchant edited a draft in between — which is
 *    exactly the shape an idempotent job cannot have.
 * 2. **Each reference is CLAIMED by a compare-and-swap**
 *    (`backfilled_at IS NULL`), whose empty result set IS the "already applied"
 *    answer. A read-then-write lets two operators pressing the same repair both
 *    see NULL and both apply.
 *
 * ## The vacuity floor, and why the outcome is a discriminated union
 *
 * A pass over a proposal nobody was waiting on and a pass whose work is finished
 * produce the same four zeroes. `nothing_to_apply` names the first, from
 * `referencesTotal` counted over the POPULATION rather than over what the pass
 * did — so an operator reading a report can tell "there was nothing to do" from
 * "it is done", which is the difference between a job that ran and one that
 * measured nothing while reporting success.
 *
 * ## What a backfill NEVER does
 *
 * It does not publish anything, does not move a listing's status, does not touch
 * inventory and does not decide a proposal. It settles answers that were waiting
 * on a decision somebody else made, and every write it performs is conditional on
 * the target still being in the state it is correcting — so a merchant who
 * answered differently in the meantime keeps their answer.
 */

import type { AuthoringCanonicalRefKind, CatalogProposalBackfill } from '@mercaria/shared-types';
import { isResolvedCatalogProposalState } from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import type { Database } from '../../db/postgres.js';
import {
  bumpDraftVersionAfterBackfill,
  resolveDraftValueToCanonicalReference,
  resolveDraftValueToControlledValue,
  resolveListingClaimToControlledValue,
} from '../../db/catalogProposals/backfillRepository.js';
import {
  claimProposalReferenceForBackfill,
  findProposal,
  insertReviewEvent,
  listPendingProposalReferences,
  readProposalReferenceCounters,
  type CatalogProposalReferenceRow,
  type CatalogProposalRow,
} from '../../db/catalogProposals/proposalRepository.js';

/**
 * What a resolved proposal MEANS for a stored answer.
 *
 * A total mapping over `CatalogProposalType`, as a discriminated union with a
 * string discriminant. The third member is the one worth reading: a category, a
 * product type and an attribute are CLASSIFICATION and SCHEMA, not answers, so a
 * draft value can never be one — and a reference claiming otherwise is refused
 * loudly instead of being stamped as applied, which would report work that was
 * never done.
 */
type BackfillShape =
  | { readonly kind: 'controlled_value' }
  | { readonly kind: 'canonical_reference'; readonly refKind: AuthoringCanonicalRefKind }
  | { readonly kind: 'not_a_stored_answer' };

function backfillShapeFor(type: CatalogProposalRow['type']): BackfillShape {
  switch (type) {
    case 'controlled_value':
      return { kind: 'controlled_value' };
    case 'brand':
      return { kind: 'canonical_reference', refKind: 'brand' };
    case 'product_family':
      return { kind: 'canonical_reference', refKind: 'canonical_product_family' };
    case 'canonical_product':
      return { kind: 'canonical_reference', refKind: 'canonical_product' };
    case 'canonical_variant':
      return { kind: 'canonical_reference', refKind: 'canonical_variant' };
    case 'category':
    case 'product_type':
    case 'attribute':
      return { kind: 'not_a_stored_answer' };
    default:
      // Total over today's tuple; a member added later lands here and REFUSES,
      // which is the safe direction — the alternative is stamping a reference as
      // backfilled having applied nothing to it.
      return { kind: 'not_a_stored_answer' };
  }
}

export interface RunProposalBackfillInput {
  readonly proposalId: string;
  readonly operatorOxyUserId: string;
  readonly pageSize?: number;
}

/**
 * Apply one page of a resolved proposal's backfill.
 *
 * PAGED rather than exhaustive, because a popular controlled value can have
 * hundreds of drafts waiting and a single unbounded pass would hold one
 * transaction over all of them. Each reference is its own transaction, so a
 * failure on one leaves every earlier one applied and the rest claimable —
 * per-record isolation, the `examineSubject` ruling from #60.
 */
export async function runProposalBackfill(
  db: Database,
  input: RunProposalBackfillInput,
): Promise<CatalogProposalBackfill> {
  const proposal = await findProposal(db, input.proposalId);
  if (proposal === null) throw notFound('No such proposal.');
  if (!isResolvedCatalogProposalState(proposal.state)) {
    throw conflict('Only an approved or merged proposal has anything to backfill.');
  }
  const resolvedEntityId = proposal.resolvedEntityId;
  if (resolvedEntityId === null) {
    // Unreachable for a row `catalog_proposals_resolution_check` admitted: a
    // resolved state and a null entity is precisely what that biconditional
    // refuses. The throw is here because the alternative — treating it as
    // nothing to do — would report a clean pass over a broken row.
    throw conflict('This proposal is resolved but names no entity.');
  }

  const counters = await readProposalReferenceCounters(db, input.proposalId);
  if (counters.total === 0) {
    // The vacuity floor. NOT `applied` with four zeroes: nobody was waiting on
    // this proposal, which is a different fact from "the work is finished" and
    // the one that otherwise reads as success.
    return { outcome: 'nothing_to_apply', referencesTotal: 0 };
  }

  const shape = backfillShapeFor(proposal.type);
  const pageSize = input.pageSize ?? config.catalogProposals.backfillPageSize;
  const pending = await listPendingProposalReferences(db, input.proposalId, pageSize);

  let appliedNow = 0;
  for (const reference of pending) {
    const applied = await applyOneReference(db, {
      proposal,
      reference,
      shape,
      resolvedEntityId,
      operatorOxyUserId: input.operatorOxyUserId,
    });
    if (applied) appliedNow += 1;
  }

  const after = await readProposalReferenceCounters(db, input.proposalId);
  if (appliedNow > 0) {
    await insertReviewEvent(db, {
      proposalId: input.proposalId,
      action: 'backfill_applied',
      actorKind: 'operator',
      actorOxyUserId: input.operatorOxyUserId,
      fromState: proposal.state,
      toState: proposal.state,
      // The counters, in the timeline, so "it says it backfilled 40" is checkable
      // against the population rather than against the pass's own claim.
      reason: `applied ${appliedNow} of ${after.total}; ${after.remaining} remaining`,
      at: new Date(),
    });
  }

  return {
    outcome: 'applied',
    referencesTotal: after.total,
    referencesBackfilled: after.backfilled,
    referencesRemaining: after.remaining,
    appliedNow,
  };
}

/**
 * One reference, in its own transaction.
 *
 * The CLAIM comes first and the write second, deliberately. Reversed, a crash
 * between the two would leave the value written and the reference unclaimed, and
 * the retry would re-apply — harmless for these two idempotent statements today,
 * and a trap for whichever write is added next. Claim-then-write means a crash
 * leaves a reference stamped whose value write did not land, which the
 * conditional predicates make recoverable by hand and which the operator surface
 * reports as remaining work, because the target row is still in its old state.
 */
async function applyOneReference(
  db: Database,
  input: {
    readonly proposal: CatalogProposalRow;
    readonly reference: CatalogProposalReferenceRow;
    readonly shape: BackfillShape;
    readonly resolvedEntityId: string;
    readonly operatorOxyUserId: string;
  },
): Promise<boolean> {
  // Destructured to a `const` BEFORE the transaction callback, and not read as
  // `input.shape` inside it: TypeScript discards a property narrowing across a
  // closure boundary, because nothing stops the object being mutated before the
  // callback runs. The local const carries the narrowing in.
  const shape = input.shape;
  if (shape.kind === 'not_a_stored_answer') {
    // A category, a product type or an attribute cannot be a stored answer, so a
    // reference to one is a defect somewhere else. Left UNCLAIMED and logged: a
    // stamp here would report work that was never done and would remove the one
    // signal that says so.
    log.general.warn(
      { proposalId: input.proposal.id, referenceId: input.reference.id, type: input.proposal.type },
      'Catalog proposal reference cannot be backfilled: this proposal type is not a stored answer.',
    );
    return false;
  }

  return db.transaction(async (tx) => {
    const claimed = await claimProposalReferenceForBackfill(tx, input.reference.id, new Date());
    // The EMPTY result set IS the "already applied" answer — another pass, or
    // another operator, got here first.
    if (claimed === null) return false;

    if (input.reference.kind === 'authoring_draft_value') {
      const draftValueId = input.reference.draftValueId;
      const draftId = input.reference.draftId;
      if (draftValueId === null || draftId === null) return false;

      const changed =
        shape.kind === 'controlled_value'
          ? await resolveDraftValueToControlledValue(tx, draftValueId, input.resolvedEntityId)
          : await resolveDraftValueToCanonicalReference(
              tx,
              draftValueId,
              shape.refKind,
              input.resolvedEntityId,
            );
      // The version bump belongs to a row this pass actually rewrote. Bumping it
      // for an answer the author had already changed would 409 their next save
      // over a write nobody made.
      if (changed) await bumpDraftVersionAfterBackfill(tx, draftId);
      return true;
    }

    const claimId = input.reference.listingClaimId;
    if (claimId === null) return false;
    if (shape.kind !== 'controlled_value') {
      // A retained listing claim has an `enum_value_id` and a `normalized_value`
      // and nothing that could hold a canonical entity. Refusing here rather
      // than inventing a column is the same ruling `not_a_stored_answer` makes.
      log.general.warn(
        { proposalId: input.proposal.id, referenceId: input.reference.id },
        'A listing attribute claim can only be settled by a controlled-value proposal.',
      );
      return true;
    }
    if (
      input.proposal.attributeDefinitionId === null ||
      input.proposal.attributeDefinitionVersion === null
    ) {
      return true;
    }
    await resolveListingClaimToControlledValue(tx, claimId, {
      attributeDefinitionId: input.proposal.attributeDefinitionId,
      attributeDefinitionVersion: input.proposal.attributeDefinitionVersion,
      enumValueId: input.resolvedEntityId,
      normalizedValue: input.proposal.normalizedLabel,
      resolvedByOxyUserId: input.operatorOxyUserId,
      resolvedAt: new Date(),
    });
    return true;
  });
}
