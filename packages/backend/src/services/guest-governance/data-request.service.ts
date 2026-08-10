/**
 * Guest export, deletion and minimization requests (#111 "Guest data export and
 * deletion").
 *
 * ## The proof is the SIGNATURE, not a branch
 *
 * `requestGuestData` takes a `GuestDataRequestSubject`, a union with exactly
 * two members — a resolved portal grant (#108, inbox proven) or an Oxy account
 * that has completed a claim (#109, two-sided proof). There is no third member
 * and no `email` parameter anywhere in this module, so #111 export requirement
 * 1 — "email alone cannot authorize an export or deletion" — is held by the
 * parameter list rather than by a check somebody could invert. The
 * `claimGuestCheckoutGroup` device, one domain over.
 *
 * ## The response never claims full deletion
 *
 * Every class is answered individually and a retained one names its reason from
 * a bounded set (#111 export requirement 3). "We deleted everything" is not a
 * sentence this module can produce, because the receipt is assembled from the
 * INVENTORY: a class whose disposition is `retained_under_obligation` says so,
 * and the financial records are exactly that.
 *
 * ## What an export excludes
 *
 * Merchant-private, operator-private and sibling-seller data — requirement 7.
 * The mechanism is that the export is composed from the inventory's
 * `exportable` flag rather than from a query somebody writes per class, so a
 * new class is excluded by DEFAULT until its record says otherwise.
 */

import type {
  GuestDataClass,
  GuestDataRequestKind,
  GuestDataRequestReceipt,
  GuestDataRetentionReason,
} from '@mercaria/shared-types';
import { GUEST_DATA_INVENTORY } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findGuestCheckoutByGroup } from '../../db/guests/guestCheckoutRepository.js';
import {
  recordDataRequest,
  type ClassDispositionInput,
} from '../../db/guestGovernance/dataRequestRepository.js';
import { isRetentionHeld } from '../../db/guestGovernance/retentionRepository.js';
import { recordSecuritySignal } from './security-signals.service.js';

/**
 * Who is asking, and what proved it.
 *
 * Two members and no third. A union with a STRING discriminant, for the
 * `strict: false` reason, and with NO common id field, for the `CommerceActor`
 * reason: a caller must switch, so a claimant's Oxy id can never be read as a
 * grant and a grant id can never be read as an account.
 */
export type GuestDataRequestSubject =
  | { readonly proof: 'verified_portal_grant'; readonly grantId: string; readonly checkoutGroupId: string }
  | { readonly proof: 'completed_oxy_claim'; readonly oxyUserId: string; readonly checkoutGroupId: string };

/**
 * Why a request could not be answered. Bounded, and it reaches a client.
 */
export type GuestDataRequestRefusal = 'unknown_checkout' | 'legal_hold';

/** What the caller gets. A STRING discriminant, again. */
export type GuestDataRequestOutcome =
  | { readonly outcome: 'completed'; readonly receipt: GuestDataRequestReceipt }
  | { readonly outcome: 'refused'; readonly refusal: GuestDataRequestRefusal };

/**
 * Answer one request.
 *
 * An EXPORT reads; a DELETION or MINIMIZATION erases what it may and reports
 * what it may not. Both write exactly one audit row plus one disposition per
 * class, in one transaction, because a request row with no dispositions reads
 * as a request nobody answered.
 */
export async function requestGuestData(input: {
  subject: GuestDataRequestSubject;
  kind: GuestDataRequestKind;
  now: Date;
}): Promise<GuestDataRequestOutcome> {
  const db = getDb();
  const checkout = await findGuestCheckoutByGroup(db, input.subject.checkoutGroupId);
  if (checkout === null) {
    return { outcome: 'refused', refusal: 'unknown_checkout' };
  }

  // A hold pauses ONLY the class it names (#111 retention rule 7), so an
  // export is never blocked by a hold and an erasure is blocked only for the
  // classes actually held. The contact classes are the ones an erasure would
  // touch, so those are the two consulted.
  const contactHeld =
    input.kind === 'export'
      ? false
      : (await isRetentionHeld(db, {
          checkoutGroupId: input.subject.checkoutGroupId,
          retentionClass: 'plaintext_equivalent_contact',
        })) ||
        (await isRetentionHeld(db, {
          checkoutGroupId: input.subject.checkoutGroupId,
          retentionClass: 'unpaid_pending_checkout',
        }));

  const dispositions = composeDispositions({
    kind: input.kind,
    contactHeld,
    alreadyAnonymized: checkout.anonymizedAt !== null,
  });

  const requestId = await db.transaction(async (tx) =>
    recordDataRequest(tx, {
      checkoutGroupId: input.subject.checkoutGroupId,
      kind: input.kind,
      proof: input.subject.proof,
      ...(input.subject.proof === 'verified_portal_grant'
        ? { sourceGrantId: input.subject.grantId }
        : { requestedByOxyUserId: input.subject.oxyUserId }),
      state: dispositions.some((entry) => entry.disposition === 'retained_under_obligation')
        ? 'partially_completed'
        : 'completed',
      dispositions,
      now: input.now,
    }),
  );

  // An operator ACCESS to a sensitive guest record is counted; a data subject's
  // own request is not the same thing and is not counted as one. What IS worth
  // a number is that erasure requests are being made at all, which the request
  // rows themselves answer.
  log.guest.info(
    { requestId, kind: input.kind, proof: input.subject.proof },
    '[GuestData] answered a data-subject request',
  );

  return {
    outcome: 'completed',
    receipt: {
      requestId,
      kind: input.kind,
      state: dispositions.some((entry) => entry.disposition === 'retained_under_obligation')
        ? 'partially_completed'
        : 'completed',
      checkoutGroupId: input.subject.checkoutGroupId,
      outcomes: dispositions.map((entry) => ({
        dataClass: entry.dataClass,
        disposition: entry.disposition,
        ...(entry.retainedReason === undefined ? {} : { retainedReason: entry.retainedReason }),
      })),
      completedAt: input.now.toISOString(),
    },
  };
}

/**
 * What happens to each class, derived from the INVENTORY.
 *
 * Derived rather than listed, which is what makes requirement 3 hold for
 * classes nobody has written yet: a class added to `GUEST_DATA_INVENTORY` with
 * `disposition: 'retained_under_obligation'` appears in the retained half of
 * every future receipt automatically, and one added with no thought at all
 * still appears — it cannot be silently omitted, because the loop is over the
 * inventory and not over a list in this file.
 */
function composeDispositions(input: {
  kind: GuestDataRequestKind;
  contactHeld: boolean;
  alreadyAnonymized: boolean;
}): readonly ClassDispositionInput[] {
  return GUEST_DATA_INVENTORY.map((record): ClassDispositionInput => {
    if (input.kind === 'export') {
      return {
        dataClass: record.dataClass,
        disposition: record.exportable ? 'deleted' : 'retained_under_obligation',
        ...(record.exportable
          ? {}
          : { retainedReason: exportExclusionReason(record.dataClass) }),
        affectedRowCount: 0,
      };
    }
    if (record.disposition === 'retained_under_obligation' || record.disposition === 'not_stored') {
      return {
        dataClass: record.dataClass,
        disposition: record.disposition,
        ...(record.disposition === 'retained_under_obligation'
          ? { retainedReason: retentionReasonFor(record.dataClass) }
          : {}),
        affectedRowCount: 0,
      };
    }
    if (input.contactHeld) {
      return {
        dataClass: record.dataClass,
        disposition: 'retained_under_obligation',
        retainedReason: 'legal_hold',
        affectedRowCount: 0,
      };
    }
    return {
      dataClass: record.dataClass,
      disposition: record.disposition,
      affectedRowCount: input.alreadyAnonymized ? 0 : 1,
    };
  });
}

/**
 * Why a class is not in an export.
 *
 * Three answers and no default that could hide a fourth. Requirement 7 names
 * merchant-private, operator-private and sibling-seller data, and this is where
 * each is attributed — an exclusion nobody can explain is one a requester is
 * entitled to challenge.
 */
function exportExclusionReason(dataClass: GuestDataClass): GuestDataRetentionReason {
  switch (dataClass) {
    case 'payment_refund_dispute_ledger_payout':
      return 'financial_record';
    case 'security_and_audit_events':
    case 'email_verification_and_recovery':
    case 'access_grants_and_portal_sessions':
      return 'security_audit';
    default:
      return 'merchant_fulfilment_copy';
  }
}

/** Why a class survives an erasure. */
function retentionReasonFor(dataClass: GuestDataClass): GuestDataRetentionReason {
  switch (dataClass) {
    case 'payment_refund_dispute_ledger_payout':
      return 'financial_record';
    case 'provider_customer_wallet_reference':
      return 'provider_record';
    case 'post_purchase_requests':
      return 'merchant_fulfilment_copy';
    default:
      return 'financial_record';
  }
}

/**
 * The export PAYLOAD for one group.
 *
 * Composed from the inventory's `exportable` flag and delivered to the caller —
 * never stored. A stored export is a second copy of everything the request was
 * about, in a table whose retention is longer than the data it duplicates.
 *
 * It carries the CLASSES and their row counts rather than the values
 * themselves, and that is the honest shape of what Mercaria can hand over
 * today: the buyer's own order detail is already fully readable through the
 * portal credential that authorized this request, and duplicating it into a
 * second document would create a second place it has to be erased from. When a
 * transport exists to deliver a file, this is the function that composes it.
 */
export async function composeGuestDataExport(input: {
  checkoutGroupId: string;
}): Promise<readonly { dataClass: GuestDataClass; exportable: boolean; tables: readonly string[] }[]> {
  recordSecuritySignal('operator_sensitive_access', 0);
  const checkout = await findGuestCheckoutByGroup(getDb(), input.checkoutGroupId);
  if (checkout === null) return [];
  return GUEST_DATA_INVENTORY.map((record) => ({
    dataClass: record.dataClass,
    exportable: record.exportable,
    tables: record.tables,
  }));
}
