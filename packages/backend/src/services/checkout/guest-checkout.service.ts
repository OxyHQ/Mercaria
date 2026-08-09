/**
 * Preparing a guest checkout's contact record (#105 "GuestCheckout contact
 * preparation", ADR 0003 D4).
 *
 * One function of substance, and everything interesting about it is what it
 * REFUSES to do:
 *
 *  - **It does not look the buyer up.** No prior-order search by email, no
 *    prefill, no "we recognise this address" (#105 rule 4). The lookup hash is
 *    written and never read here — its two permitted uses are #108's magic-link
 *    routing and abuse velocity counting (ADR 0003 D12), and neither is a read
 *    this issue performs.
 *  - **It creates no cross-checkout profile** (#105 rule 5). There is no
 *    `guest_customers` table and no `customers` row: a guest's contact belongs
 *    to ONE checkout group and correlating two of them is exactly the merge
 *    ADR 0003 I6 forbids. A second purchase by the same person creates a second
 *    row, on purpose.
 *  - **It never writes to `addresses`** (#105 privacy rule 6). A guest has no
 *    address book; the destination lives on the ORDER's own immutable snapshot
 *    and nowhere else.
 *  - **It stores no referral, partner or campaign field** (#105 rule 9). There
 *    is no column for one, which is the version of that promise a reviewer can
 *    check.
 *
 * ## One contact identity per `checkoutGroupId`
 *
 * #105 rule 6, and it is the unique index rather than this code that holds it.
 * Sibling orders from a multi-seller cart share the row; each ORDER keeps its
 * own immutable fulfilment snapshot, because destinations can legitimately
 * differ per seller and a contact cannot.
 *
 * ## Convergence under the idempotency contract
 *
 * #105 rule 7. The row is created in the SAME transaction as the group's orders
 * and keyed on the group, so every layer that already converges — the Redis
 * claim, `orders_idempotency_key_key`, `payments.checkout_group_id`, the rail's
 * own key — carries this row along with it. A retry reads the contact it
 * created the first time; see `ensureGuestCheckout` for why it must not
 * overwrite.
 */

import type { GuestContactVerificationStage } from '@mercaria/shared-types';
import {
  ensureGuestCheckout,
  type GuestCheckoutRow,
} from '../../db/guests/guestCheckoutRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { encryptGuestPii, guestEmailHash, redactEmail, redactPhone } from '../../lib/guest-pii.js';
import { log } from '../../lib/logger.js';
import type { NormalizedCheckoutContact } from './contact.js';

/** What the checkout transaction hands this service. */
export interface PrepareGuestContactInput {
  checkoutGroupId: string;
  /** The `guest_sessions` row id — never a token (ADR 0003 D3). */
  guestSessionId: string;
  contact: NormalizedCheckoutContact;
  /** Separate from the purchase's own transactional permission. */
  marketingOptIn: boolean;
  /** BCP-47, when the client declared one. */
  locale?: string;
}

/**
 * The projection anything outside this module may see of a guest contact.
 *
 * Names every field explicitly — the payment status-projection rule — and the
 * point is what is NOT here: no ciphertext, no `email_hash`, no plaintext, no
 * session id. #105 privacy rule 7 says the normalized email hash is never
 * exposed to a client, a merchant or a partner, and the way to make that true
 * of a projection is to give it no field to travel in.
 */
export interface GuestContactSummary {
  /** The `guest_checkouts` row id — an internal handle, never a credential. */
  id: string;
  /** `j***@example.com`, or `deleted` after anonymization (T15). */
  emailRedacted: string;
  /** `***42`, when a phone was given. */
  phoneRedacted?: string;
  verificationStage: GuestContactVerificationStage;
  marketingOptIn: boolean;
}

/**
 * Create (or converge on) the contact record for a guest checkout group.
 *
 * MUST run inside the orders' transaction: the contact and the orders that
 * reference it commit together or not at all, so there is never an order
 * pointing at a contact that rolled back, nor a contact for a checkout that
 * never happened. `orders.buyer_guest_checkout_id`'s `restrict` foreign key is
 * the structural half of the first; sharing the transaction is the second.
 */
export async function prepareGuestCheckoutContact(
  tx: DatabaseOrTransaction,
  input: PrepareGuestContactInput,
): Promise<GuestCheckoutRow> {
  const row = await ensureGuestCheckout(tx, {
    checkoutGroupId: input.checkoutGroupId,
    guestSessionId: input.guestSessionId,
    // The DISPLAY email is what gets encrypted — a receipt is addressed to what
    // the buyer typed, and the lower-cased form exists only to be hashed
    // (ADR 0003 D12).
    emailCiphertext: encryptGuestPii(input.contact.displayEmail),
    emailHash: guestEmailHash(input.contact.normalizedEmail),
    emailRedacted: redactEmail(input.contact.displayEmail),
    ...(input.contact.displayPhone !== undefined
      ? {
          phoneCiphertext: encryptGuestPii(input.contact.displayPhone),
          phoneRedacted: redactPhone(input.contact.displayPhone),
        }
      : {}),
    marketingOptIn: input.marketingOptIn,
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  });

  // The security event carries ROW IDS and the redacted display form only —
  // never the address, never the hash (#105 privacy rule 8). It is what makes a
  // guest checkout traceable by an operator without making the log a place a
  // buyer's inbox can be read out of.
  log.guest.info(
    {
      guestCheckoutId: row.id,
      checkoutGroupId: row.checkoutGroupId,
      emailRedacted: row.emailRedacted,
      marketingOptIn: row.marketingOptIn,
      verificationStage: row.contactVerificationStage,
    },
    '[Guest] checkout contact prepared',
  );

  return row;
}

/** The safe projection of a stored contact row. */
export function toGuestContactSummary(row: GuestCheckoutRow): GuestContactSummary {
  return {
    id: row.id,
    emailRedacted: row.emailRedacted,
    ...(row.phoneRedacted !== null ? { phoneRedacted: row.phoneRedacted } : {}),
    verificationStage: row.contactVerificationStage,
    marketingOptIn: row.marketingOptIn,
  };
}
