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
 * sentence this module can produce, because the receipt is assembled over the
 * INVENTORY: a class the request cannot erase says `retained_under_obligation`
 * with its reason, and the financial records are exactly that.
 *
 * ## …and never claims a deletion it did not perform (M8-01)
 *
 * The M8 review found this module wrote nothing and answered every erasable
 * class with one affected row — a false receipt that only being unreachable
 * kept from being issued. An erasure now runs D15 in the transaction that
 * records it, and every `affectedRowCount` is a `RETURNING` set from that
 * transaction. It is reached from `POST /guest/orders/:groupId/data-requests`
 * (`routes/guest-orders.ts`), behind a FRESH inbox proof.
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
import { eq } from 'drizzle-orm';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { orders } from '../../db/schema/orders.js';
import {
  findGuestCheckoutByGroup,
  minimizeGuestCheckoutContact,
} from '../../db/guests/guestCheckoutRepository.js';
import { deleteGuestSessionAndCarts } from '../../db/guests/guestSessionRepository.js';
import { revokeGroupGrants } from '../../db/guestPortal/grantRepository.js';
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
  | {
      readonly proof: 'verified_portal_grant';
      readonly grantId: string;
      readonly checkoutGroupId: string;
    }
  | {
      readonly proof: 'completed_oxy_claim';
      readonly oxyUserId: string;
      readonly checkoutGroupId: string;
    };

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
 *
 * ## The erasure and its receipt are ONE transaction (M8-01)
 *
 * The M8 review found this function wrote nothing and reported one affected
 * row per class. Now every count on the receipt is a `RETURNING` set from the
 * transaction that writes the receipt: if the erasure rolls back, so does the
 * claim that it happened, and a class the request cannot reach says so with a
 * bounded reason rather than a number. ADR 0003 D15's post-payment regime, in
 * full: the contact is anonymized (by the writer the retention job uses), every
 * live portal credential for the group is revoked, and the session that placed
 * the checkout is deleted with its cart.
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

  const { requestId, dispositions } = await db.transaction(async (tx) => {
    const composed =
      input.kind === 'export'
        ? composeExportDispositions()
        : await eraseGroup(tx, {
            checkoutGroupId: input.subject.checkoutGroupId,
            guestCheckoutId: checkout.id,
            guestSessionId: checkout.guestSessionId,
            now: input.now,
          });
    const id = await recordDataRequest(tx, {
      checkoutGroupId: input.subject.checkoutGroupId,
      kind: input.kind,
      proof: input.subject.proof,
      ...(input.subject.proof === 'verified_portal_grant'
        ? { sourceGrantId: input.subject.grantId }
        : { requestedByOxyUserId: input.subject.oxyUserId }),
      state: stateFor(composed),
      dispositions: composed,
      now: input.now,
    });
    return { requestId: id, dispositions: composed };
  });

  // An operator ACCESS to a sensitive guest record is counted; a data subject's
  // own request is not the same thing and is not counted as one. What IS worth
  // a number is that erasure requests are being made at all, which the request
  // rows themselves answer. The log carries counts and ids, never a value.
  log.guest.info(
    {
      requestId,
      kind: input.kind,
      proof: input.subject.proof,
      affectedRows: dispositions.reduce((sum, entry) => sum + entry.affectedRowCount, 0),
    },
    '[GuestData] answered a data-subject request',
  );

  return {
    outcome: 'completed',
    receipt: {
      requestId,
      kind: input.kind,
      state: stateFor(dispositions),
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

/** `partially_completed` whenever any class survived — for a guest group, always. */
function stateFor(
  dispositions: readonly ClassDispositionInput[],
): 'completed' | 'partially_completed' {
  return dispositions.some((entry) => entry.disposition === 'retained_under_obligation')
    ? 'partially_completed'
    : 'completed';
}

/** What one erasure actually changed — every figure a `RETURNING` set. */
export interface GroupErasureCounts {
  /** Whether any order references the group: decides pending versus paid. */
  readonly groupHasOrders: boolean;
  /** Whether a live legal hold kept the contact on the row. */
  readonly contactHeld: boolean;
  readonly contactMinimized: number;
  readonly grantsRevoked: number;
  readonly sessionsDeleted: number;
  readonly cartsDeleted: number;
}

/**
 * The classes whose live hold keeps the contact on the row.
 *
 * `lookup_hash` is here beside the two contact classes because the hash leaves
 * in the same statement as the ciphertext (M8-09), so a hold on it is a hold on
 * the row.
 */
const CONTACT_RETENTION_CLASSES = [
  'plaintext_equivalent_contact',
  'unpaid_pending_checkout',
  'lookup_hash',
] as const;

/**
 * Perform D15 for one group inside the caller's transaction, and answer every
 * class from what was done.
 *
 * A legal hold pauses ONLY the class it names (#111 retention rule 7), so a
 * hold on the contact keeps the contact and nothing else: the session, the cart
 * and the credentials are not pausable classes and still go.
 */
async function eraseGroup(
  tx: DatabaseOrTransaction,
  input: { checkoutGroupId: string; guestCheckoutId: string; guestSessionId: string; now: Date },
): Promise<readonly ClassDispositionInput[]> {
  let contactHeld = false;
  for (const retentionClass of CONTACT_RETENTION_CLASSES) {
    if (await isRetentionHeld(tx, { checkoutGroupId: input.checkoutGroupId, retentionClass })) {
      contactHeld = true;
    }
  }
  const [anyOrder] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.checkoutGroupId, input.checkoutGroupId))
    .limit(1);

  const contactMinimized =
    !contactHeld && (await minimizeGuestCheckoutContact(tx, input.guestCheckoutId, input.now))
      ? 1
      : 0;
  // Every live credential for the group, the presenting one included — D15
  // says ALL, and sparing the requester's own would leave standing the one
  // credential most likely to sit in a borrowed or stolen browser.
  const revoked = await revokeGroupGrants(tx, input.checkoutGroupId, input.now);
  const removed = await deleteGuestSessionAndCarts(tx, input.guestSessionId);

  return composeErasureDispositions({
    groupHasOrders: anyOrder !== undefined,
    contactHeld,
    contactMinimized,
    grantsRevoked: revoked.length,
    sessionsDeleted: removed.sessions,
    cartsDeleted: removed.carts,
  });
}

/**
 * Every class's answer to an erasure, from what {@link eraseGroup} did.
 *
 * An EXHAUSTIVE switch over the class, looped over the inventory: a class added
 * to `GUEST_DATA_CLASSES` without an answer here fails `tsc`, and a class
 * silently omitted from a receipt is impossible because the loop is over the
 * inventory rather than over a list in this file. The version the M8 review
 * read reported the inventory's `disposition` field with one affected row —
 * a field describing what the RETENTION SCHEDULE eventually does, reported as
 * what the REQUEST did, while the request did nothing (M8-01).
 */
export function composeErasureDispositions(
  counts: GroupErasureCounts,
): readonly ClassDispositionInput[] {
  const retained = (
    dataClass: GuestDataClass,
    retainedReason: GuestDataRetentionReason,
    affectedRowCount = 0,
  ): ClassDispositionInput => ({
    dataClass,
    disposition: 'retained_under_obligation',
    retainedReason,
    affectedRowCount,
  });
  const contact = (dataClass: GuestDataClass, applies: boolean): ClassDispositionInput => {
    // A group is EITHER unpaid or paid, never both. The class that does not
    // describe this group stores nothing for it, and answering `minimized`
    // with zero rows would put it in the receipt's erased half.
    if (!applies) return { dataClass, disposition: 'not_stored', affectedRowCount: 0 };
    if (counts.contactHeld) return retained(dataClass, 'legal_hold');
    return { dataClass, disposition: 'minimized', affectedRowCount: counts.contactMinimized };
  };

  return GUEST_DATA_INVENTORY.map((record): ClassDispositionInput => {
    const dataClass = record.dataClass;
    switch (dataClass) {
      case 'guest_session_metadata':
        return { dataClass, disposition: 'deleted', affectedRowCount: counts.sessionsDeleted };
      case 'cart_and_discount_intent':
        return { dataClass, disposition: 'deleted', affectedRowCount: counts.cartsDeleted };
      case 'pending_guest_checkout':
        return contact(dataClass, !counts.groupHasOrders);
      case 'paid_guest_checkout':
        return contact(dataClass, counts.groupHasOrders);
      case 'order_buyer_and_contact_snapshot':
      case 'destination_snapshot':
      case 'claim_operations':
      case 'payment_refund_dispute_ledger_payout':
        // D15: GDPR Art. 17(3)(b). The shipping snapshot is part of the
        // invoice-grade record and stays with it.
        return retained(dataClass, 'financial_record');
      case 'post_purchase_requests':
        return retained(dataClass, 'merchant_fulfilment_copy');
      case 'access_grants_and_portal_sessions':
        // REVOKED, every one, and the rows stay until their own `purge_at` as
        // the audit of who could reach the purchase (ADR 0003 D11). They hold a
        // digest of a dead credential and no contact.
        return retained(dataClass, 'security_audit', counts.grantsRevoked);
      case 'email_verification_and_recovery':
      case 'security_and_audit_events':
        // Keyed digests and counts with no group handle, so the request has
        // nothing to find them BY — the property they were built for.
        // `guest_contact_suppressions` is the M8-08 decision, not an oversight.
        return retained(dataClass, 'security_audit');
      case 'transactional_notification_events':
      case 'product_analytics_and_experimentation':
      case 'merchant_facing_aggregates':
        // No recipient, no contact and no Oxy id in any of them, and each
        // leaves on the published schedule. A queued message for this group can
        // no longer send once the contact is gone (`contact_anonymized`), and
        // the analytics event log is append-only by #77's rule — its only
        // permitted removal is the retention sweep.
        return retained(dataClass, 'expires_on_schedule');
      case 'provider_customer_wallet_reference':
        return { dataClass, disposition: 'not_stored', affectedRowCount: 0 };
      default: {
        const unanswered: never = dataClass;
        throw new Error(`guest data class ${String(unanswered)} has no erasure answer`);
      }
    }
  });
}

/**
 * The export receipt: which classes an export covers.
 *
 * NOT ROUTED, and it must not be until it is fixed: it answers an exportable
 * class with `deleted` because `GUEST_DATA_DISPOSITIONS` has no `exported`
 * value, so a routed export would write an erasure record for data it only
 * read. Unchanged by M8-01 apart from moving here (`HANDOFF.md` carries it).
 * An export removes nothing, so no class is counted as affected.
 */
function composeExportDispositions(): readonly ClassDispositionInput[] {
  return GUEST_DATA_INVENTORY.map(
    (record): ClassDispositionInput => ({
      dataClass: record.dataClass,
      disposition: record.exportable ? 'deleted' : 'retained_under_obligation',
      ...(record.exportable ? {} : { retainedReason: exportExclusionReason(record.dataClass) }),
      affectedRowCount: 0,
    }),
  );
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
}): Promise<
  readonly { dataClass: GuestDataClass; exportable: boolean; tables: readonly string[] }[]
> {
  recordSecuritySignal('operator_sensitive_access', 0);
  const checkout = await findGuestCheckoutByGroup(getDb(), input.checkoutGroupId);
  if (checkout === null) return [];
  return GUEST_DATA_INVENTORY.map((record) => ({
    dataClass: record.dataClass,
    exportable: record.exportable,
    tables: record.tables,
  }));
}
