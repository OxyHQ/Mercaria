/**
 * Row → DTO (#367 step 6, ADR 0007 D9).
 *
 * Every projection NAMES its fields (the `provider_accounts` device) rather than
 * spreading a row, so a column added to the schema is ABSENT from the wire until
 * somebody decides it belongs there. That matters more here than in most
 * domains, because `catalog_proposals` grows a column every time the review
 * vocabulary does, and half of them are decisions rather than facts.
 *
 * There is deliberately no operator-only projection with more in it. An operator
 * trace adds the CANDIDATES, the REFERENCES and the EVENTS — three separate
 * lists — and never a richer proposal: everything about the request itself is
 * already visible to the merchant who made it, and a second shape would be a
 * second answer to what a proposal is.
 */

import type {
  CatalogProposal,
  CatalogProposalDuplicateCandidate,
  CatalogProposalReference,
  CatalogReviewEvent,
} from '@mercaria/shared-types';
import type {
  CatalogProposalDuplicateCandidateRow,
  CatalogProposalReferenceRow,
  CatalogProposalRow,
  CatalogReviewEventRow,
} from '../../db/catalogProposals/proposalRepository.js';

/** ISO 8601, or `null`. One spelling, so no surface invents a second. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function projectProposal(row: CatalogProposalRow): CatalogProposal {
  return {
    id: row.id,
    type: row.type,
    origin: row.origin,
    state: row.state,
    storeId: row.storeId,
    submittedByOxyUserId: row.submittedByOxyUserId,
    proposedLabel: row.proposedLabel,
    sourceLocale: row.sourceLocale,
    normalizedLabel: row.normalizedLabel,
    proposedDescription: row.proposedDescription,
    submitterNote: row.submitterNote,
    categoryId: row.categoryId,
    productTypeDefinitionId: row.productTypeDefinitionId,
    attributeDefinitionId: row.attributeDefinitionId,
    attributeDefinitionVersion: row.attributeDefinitionVersion,
    resolvedEntityId: row.resolvedEntityId,
    redirectedToProposalId: row.redirectedToProposalId,
    rejectionReason: row.rejectionReason,
    decisionReason: row.decisionReason,
    decidedByOxyUserId: row.decidedByOxyUserId,
    decidedAt: iso(row.decidedAt),
    deferredUntil: iso(row.deferredUntil),
    duplicateScanPopulation: row.duplicateScanPopulation,
    duplicateScanCandidates: row.duplicateScanCandidates,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The SEARCH form is not projected, and that is deliberate.
 *
 * `normalized_label` is projected because it is what convergence is decided on
 * and a submitter shown "your request was merged with this one" deserves to see
 * why. `search_label` is a retrieval artefact of this domain's own index and
 * says nothing a reader can act on.
 */
export function projectDuplicateCandidate(
  row: CatalogProposalDuplicateCandidateRow,
): CatalogProposalDuplicateCandidate {
  return {
    id: row.id,
    kind: row.kind,
    detector: row.detector,
    ref: row.candidateRef,
    label: row.candidateLabel,
    similarity: row.similarity,
  };
}

export function projectProposalReference(
  row: CatalogProposalReferenceRow,
): CatalogProposalReference {
  return {
    id: row.id,
    proposalId: row.proposalId,
    kind: row.kind,
    draftId: row.draftId,
    draftValueId: row.draftValueId,
    listingClaimId: row.listingClaimId,
    backfilledAt: iso(row.backfilledAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function projectReviewEvent(row: CatalogReviewEventRow): CatalogReviewEvent {
  return {
    id: row.id,
    proposalId: row.proposalId,
    action: row.action,
    actorKind: row.actorKind,
    actorOxyUserId: row.actorOxyUserId,
    fromState: row.fromState,
    toState: row.toState,
    reason: row.reason,
    at: row.at.toISOString(),
  };
}
