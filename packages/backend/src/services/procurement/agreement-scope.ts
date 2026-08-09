/**
 * Agreement scope: the pure, fail-closed answers to "does this agreement
 * permit that", read by eligibility derivation and by purchase-order creation.
 *
 * Everything here is a pure function over a NARROW structural shape — the
 * fields the questions actually read — so the same code answers for a real
 * `supplier_agreements` row and for a table-test fixture, and a caller cannot
 * be forced to fetch columns it does not need.
 *
 * ## Fail closed, everywhere
 *
 * An agreement that is not `approved` permits nothing. A window that has not
 * started or has ended permits nothing. An EMPTY destination or channel list
 * permits NONE — deliberately the opposite of `commerce_relationships`'
 * `'{}' = worldwide`, because a relationship is a scoped-down positive fact
 * while an agreement is a GRANT, and a grant that names no destination grants
 * none. `CONVENTIONS.md` documents the two semantics against each other.
 */

import type { AgreementApprovalState, AgreementChannel } from '@mercaria/shared-types';

/** The agreement facts scope questions read — a structural subset of the row. */
export interface AgreementScopeFacts {
  approvalState: AgreementApprovalState;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  permittedDestinationCountries: string[];
  permittedChannels: string[];
  resaleRightsGranted: boolean;
  dropshipRightsGranted: boolean;
  blindDropshipVerified: boolean;
  dataProcessingTermsAccepted: boolean;
}

/** Approved, started, not ended — the "active scope" conjunction. */
export function isAgreementActive(agreement: AgreementScopeFacts, at: Date): boolean {
  if (agreement.approvalState !== 'approved') return false;
  if (!agreement.effectiveAt || agreement.effectiveAt.getTime() > at.getTime()) return false;
  if (agreement.expiresAt && agreement.expiresAt.getTime() <= at.getTime()) return false;
  return true;
}

/** May goods ship to this destination under this agreement? Empty list = no. */
export function agreementPermitsDestination(
  agreement: AgreementScopeFacts,
  destinationCountry: string,
): boolean {
  return agreement.permittedDestinationCountries.includes(destinationCountry.toUpperCase());
}

/** May offers surface on this channel under this agreement? Empty list = no. */
export function agreementPermitsChannel(
  agreement: AgreementScopeFacts,
  channel: AgreementChannel,
): boolean {
  return agreement.permittedChannels.includes(channel);
}

/**
 * The rights conjunction `mercaria_retail` requires (ADR 0004 D2.10, D2.3,
 * D2.7): resale, direct-to-customer dropship, VERIFIED blind fulfilment, and
 * accepted data-processing terms. An affiliate agreement, a public API's terms
 * or a consumer account can never satisfy this — which is #118 acceptance
 * criterion 3, answered structurally.
 */
export function agreementGrantsRetailDropship(agreement: AgreementScopeFacts): boolean {
  return (
    agreement.resaleRightsGranted &&
    agreement.dropshipRightsGranted &&
    agreement.blindDropshipVerified &&
    agreement.dataProcessingTermsAccepted
  );
}
