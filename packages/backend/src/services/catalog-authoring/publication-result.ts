/**
 * What a publication actually produced (#367 step 5's "return a complete
 * publication result with created IDs and any pending review/matching state").
 *
 * ## Derived from the LISTING, never accumulated as the transaction goes
 *
 * The obvious implementation collects ids while `publishDraft` writes them. It
 * is wrong for the case the endpoint exists to serve: a CONVERGENCE created
 * nothing this time — the listing was published by an earlier attempt whose
 * response the client lost — so an accumulating result answers a retry with an
 * empty body. That makes retrying, which is the safe client behaviour, the one
 * that loses information.
 *
 * So every field here is read back from the published listing and its draft, and
 * `published` and `converged` answer identically because they run the same
 * function over the same rows. `publishDraft` has exactly ONE call site for it,
 * which is what stops a fourth branch answering with less.
 *
 * ## It reports no matching VERDICT, and cannot
 *
 * `finishStoreProductCreation` → `syncListingFacets` requests a match for every
 * variant AFTER the commit. At the moment this composes, the matcher has not
 * run. `AuthoringVariantResolution` therefore has no `matched` member: the only
 * statements available are that a person resolved a variant (an active
 * `merchant_declared` link) or that nobody has and #58 owns it.
 *
 * **`queued_for_matching` is derived from the ABSENCE of that link, deliberately
 * — never from a queue row.** A queue row exists only after
 * `syncListingFacets` runs and is gone once the matcher drains it, so reading
 * one would make this answer depend on when it was asked, and a convergence
 * hours later would report a variant as unqueued that was never resolved by
 * anybody. The absence of a declared link is the durable fact.
 *
 * ## Why counts sit beside ids
 *
 * A caller can act on a `product_variants` id and on a canonical variant id. It
 * cannot act on an axis-assignment id or a claim id — no surface addresses those
 * rows — and what it needs from them is that the variant did not land
 * half-written. So those are counts, and the ids that matter are ids.
 *
 * ## Reads, and what is NOT one
 *
 * Six scoped reads, all of them existing repository functions and none of them
 * new: this issue required no DDL and no new query. `countQueuedClaims` already
 * took a `{ listingIds }` scope, which is what makes the queued-claim figure a
 * fact about THIS listing rather than the deployment's backlog.
 */

import type {
  AuthoringPublicationResult,
  AuthoringPublishedVariant,
  AuthoringVariantResolution,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import type { CatalogAuthoringDraftRow } from '../../db/catalogAuthoring/draftRepository.js';
import { listDraftVariants } from '../../db/catalogAuthoring/draftRepository.js';
import { findVariantsByListing } from '../../db/catalog/variantRepository.js';
import { findActiveLinksForListing } from '../../db/offers/nativeListingLinkRepository.js';
import {
  listVariantAxesForListing,
  listVariantAxisAssignments,
  listVariantSignaturesForListing,
} from '../../db/variantAxes/variantAxisRepository.js';
import {
  countQueuedClaims,
  listListingAttributeClaims,
  listVariantAttributeClaims,
} from '../../db/variantAxes/attributeClaimRepository.js';
import { listOpenProposalsBlockingDraft } from '../../db/catalogProposals/proposalRepository.js';

export interface PublicationResultInput {
  readonly draft: CatalogAuthoringDraftRow;
  readonly listingId: string;
  readonly outcome: 'published' | 'converged';
}

/**
 * The provenance the authoring path stamps on every claim it writes.
 *
 * Claims are counted by it rather than counted whole, so a listing that later
 * accumulates a connector's or the backfill's assertions does not make a
 * converging publication report a larger number than the publishing one did.
 */
const AUTHORED_CLAIM_PROVENANCE = 'merchant_declared';

export async function composePublicationResult(
  db: DatabaseOrTransaction,
  input: PublicationResultInput,
): Promise<AuthoringPublicationResult> {
  const { draft, listingId } = input;

  const [listingVariants, draftVariants, links, axes, listingClaims, queued, openProposals] =
    await Promise.all([
      findVariantsByListing(listingId, db),
      listDraftVariants(db, draft.id),
      findActiveLinksForListing(db, listingId),
      listVariantAxesForListing(db, listingId),
      listListingAttributeClaims(db, listingId),
      countQueuedClaims(db, { listingIds: [listingId] }),
      listOpenProposalsBlockingDraft(db, draft.id),
    ]);

  const variantIds = listingVariants.map((variant) => variant.id);
  const [assignments, signatures, variantClaims] = await Promise.all([
    listVariantAxisAssignments(db, variantIds),
    listVariantSignaturesForListing(db, listingId),
    listVariantAttributeClaims(db, variantIds),
  ]);

  // The pairing, by POSITION. `insertVariants` returns rows in input order and
  // `createStoreProductWithin` preserves it, so draft position N is listing
  // position N — the same fact `publishDraft` writes the canonical links from.
  const draftVariantIdByPosition = new Map(
    draftVariants.map((variant) => [variant.position, variant.id]),
  );
  const canonicalByVariantId = new Map(
    links.map((link) => [link.productVariantId, link.canonicalVariantId]),
  );
  const declaredByVariantId = new Set(
    links.filter((link) => link.method === 'merchant_declared').map((link) => link.productVariantId),
  );
  const signatureByVariantId = new Map(
    signatures.map((signature) => [signature.variantId, signature.signature]),
  );

  const countBy = <T extends { variantId: string }>(rows: readonly T[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.variantId, (counts.get(row.variantId) ?? 0) + 1);
    return counts;
  };
  const assignmentCounts = countBy(assignments);
  const claimCounts = countBy(
    variantClaims.filter((claim) => claim.provenance === AUTHORED_CLAIM_PROVENANCE),
  );

  const variants: AuthoringPublishedVariant[] = listingVariants.map((variant) => {
    const resolution: AuthoringVariantResolution = declaredByVariantId.has(variant.id)
      ? 'merchant_declared'
      : 'queued_for_matching';
    return {
      // A published listing whose draft lost a variant row is not a state this
      // path can produce — the draft is frozen at publish and the variants are
      // written from it — but the map lookup is total either way, and a NULL
      // here would be a pairing claim nobody could check.
      draftVariantId: draftVariantIdByPosition.get(variant.position) ?? '',
      position: variant.position,
      productVariantId: variant.id,
      resolution,
      canonicalVariantId:
        resolution === 'merchant_declared' ? canonicalByVariantId.get(variant.id) ?? null : null,
      axisSignature: signatureByVariantId.get(variant.id) ?? null,
      axisAssignmentCount: assignmentCounts.get(variant.id) ?? 0,
      merchantDeclaredClaimCount: claimCounts.get(variant.id) ?? 0,
    };
  });

  return {
    outcome: input.outcome,
    listingId,
    declaredAxisCount: axes.length,
    listingClaimCount: listingClaims.filter(
      (claim) => claim.provenance === AUTHORED_CLAIM_PROVENANCE,
    ).length,
    variants,
    review: {
      merchantDeclaredCount: variants.filter(
        (variant) => variant.resolution === 'merchant_declared',
      ).length,
      queuedForMatchingCount: variants.filter(
        (variant) => variant.resolution === 'queued_for_matching',
      ).length,
      queuedAttributeClaimCount: queued.queued,
      openProposalIds: openProposals.map((entry) => entry.proposalId),
    },
  };
}
