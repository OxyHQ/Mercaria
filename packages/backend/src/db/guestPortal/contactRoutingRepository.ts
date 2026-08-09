/**
 * Routing a magic-link request to its checkouts (#108, ADR 0003 D12).
 *
 * ONE function, in its own module, and the placement is the decision. The read
 * lives on `guest_checkouts` — #105's table — but it is not #105's read:
 * `services/__tests__/checkout-contact-isolation.test.ts` fails the build if
 * the checkout contact path acquires a lookup BY CONTACT, and it is right to.
 * #105 takes an address a buyer typed and stores it; it must never be able to
 * ask "who else has this address", because a checkout that could prefill from a
 * previous purchase is a checkout that discloses one.
 *
 * `email_hash` has exactly two permitted uses (D12) and this is the first. The
 * second — abuse velocity counting — lives in
 * `recoveryAttemptRepository.ts` beside it, under its own keyed digest.
 */

import { desc, eq } from 'drizzle-orm';
import { guestCheckouts } from '../schema/guests.js';
import type { DatabaseOrTransaction } from '../postgres.js';
import type { GuestCheckoutRow } from '../guests/guestCheckoutRepository.js';

/**
 * Every checkout an inbox placed, newest first — #108's magic-link ROUTING.
 *
 * This is one of `email_hash`'s exactly two permitted uses (ADR 0003 D12), and
 * the shape is what keeps it inside them. It answers "which checkout groups
 * should be sent an access link", and the caller mints ONE grant per group and
 * sends ONE message per group — so no authorization context, no response and no
 * message ever holds two checkouts at once. That is #108 email-verification
 * rule 8 ("do not correlate separate guest checkouts automatically from a
 * matching verified email") made structural rather than promised: proving an
 * inbox produces N independent single-group credentials, never one credential
 * over N groups.
 *
 * `limit` is MANDATORY and small. An address that placed fifty checkouts is
 * either a very good customer or a mail amplifier, and an unbounded fan-out is
 * the second one whichever it is; the order-number hint is how somebody reaches
 * an older group.
 *
 * Anonymized rows (D15) have a NULL hash and cannot match — the partial index
 * `guest_checkouts_email_hash_idx` states that at the storage layer too.
 */
export async function findGuestCheckoutsByEmailHash(
  db: DatabaseOrTransaction,
  emailHash: string,
  limit: number,
): Promise<GuestCheckoutRow[]> {
  return await db
    .select({
      id: guestCheckouts.id,
      checkoutGroupId: guestCheckouts.checkoutGroupId,
      guestSessionId: guestCheckouts.guestSessionId,
      emailCiphertext: guestCheckouts.emailCiphertext,
      emailHash: guestCheckouts.emailHash,
      emailRedacted: guestCheckouts.emailRedacted,
      phoneCiphertext: guestCheckouts.phoneCiphertext,
      phoneRedacted: guestCheckouts.phoneRedacted,
      contactVerificationStage: guestCheckouts.contactVerificationStage,
      contactVerifiedAt: guestCheckouts.contactVerifiedAt,
      contactPolicyVersion: guestCheckouts.contactPolicyVersion,
      marketingOptIn: guestCheckouts.marketingOptIn,
      locale: guestCheckouts.locale,
      anonymizedAt: guestCheckouts.anonymizedAt,
      createdAt: guestCheckouts.createdAt,
      updatedAt: guestCheckouts.updatedAt,
    })
    .from(guestCheckouts)
    .where(eq(guestCheckouts.emailHash, emailHash))
    .orderBy(desc(guestCheckouts.createdAt))
    .limit(limit);
}
