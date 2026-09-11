/**
 * The ONE translation from a `CommerceActor` to an `asset_rights.buyer_key`.
 *
 * `oxy:<id>` or `guest:<sessionId>` — the spelling `cartOwnerForActor` already
 * uses, deliberately, so a reader who knows one knows the other.
 *
 * ## Why a key rather than two nullable columns
 *
 * Two columns would make "which buyer" a question with two answers and one of
 * them always NULL, and every read would carry an `or`. One column with a CHECKed
 * prefix makes the buyer addressable by a single equality — which is what the
 * buyer library's index is — and makes passing a guest session id where an Oxy id
 * belongs impossible to do silently: the prefix would be wrong and the lookup
 * would find nothing rather than find somebody else's rights.
 *
 * ## An anonymous actor has no key, and that is a refusal rather than a fallback
 *
 * It returns `null`, and the one caller turns that into a 403. A right belongs to
 * somebody; an anonymous caller is not somebody, and inventing a key for one —
 * from a cookie, a fingerprint, an IP — is the shape that would make rights
 * unrecoverable AND trackable at once.
 */

import { eq } from 'drizzle-orm';
import type { CommerceActor } from '../commerce-actor.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { guestCheckouts } from '../../db/schema/guests.js';

/** `oxy:<oxyUserId>` or `guest:<guestSessionId>`; `null` for anonymous. */
export function buyerKeyForActor(actor: CommerceActor): string | null {
  switch (actor.kind) {
    case 'oxy':
      return `oxy:${actor.oxyUserId}`;
    case 'guest':
      return `guest:${actor.guestSessionId}`;
    case 'anonymous':
      return null;
  }
}

/** The key an Oxy user id maps to, for paths that already hold one. */
export function buyerKeyForOxyUser(oxyUserId: string): string {
  return `oxy:${oxyUserId}`;
}

/**
 * The buyer key for an ORDER, which is a different question from the actor's.
 *
 * An order does not carry a guest SESSION id — it carries a `guest_checkouts` row
 * id — so the guest branch reads through that row to reach the session the key is
 * built from. It has to be the session and not the checkout: a download is
 * authorized for whoever is holding the credential NOW, and
 * `buyerKeyForActor` is what that resolves to. Two spellings of "the guest who
 * bought this" would make a right unreachable from the only surface that asks.
 *
 * Returns `null` when the key cannot be established — an `external` order, or a
 * guest checkout row that has been anonymized away. The caller treats that as "no
 * rights to grant" rather than inventing a key, because a right nobody can reach
 * is worse than no right: it would report as delivered and open nothing.
 */
export async function resolveBuyerKeyForOrder(
  order: {
    readonly buyerOrigin: string;
    readonly buyerOxyUserId: string | null;
    readonly buyerGuestCheckoutId: string | null;
  },
  tx?: DatabaseOrTransaction,
): Promise<string | null> {
  if (order.buyerOrigin === 'oxy' && order.buyerOxyUserId) {
    return buyerKeyForOxyUser(order.buyerOxyUserId);
  }
  if (order.buyerOrigin === 'guest' && order.buyerGuestCheckoutId) {
    const db = tx ?? getDb();
    const [row] = await db
      .select({ guestSessionId: guestCheckouts.guestSessionId })
      .from(guestCheckouts)
      .where(eq(guestCheckouts.id, order.buyerGuestCheckoutId))
      .limit(1);
    return row ? `guest:${row.guestSessionId}` : null;
  }
  return null;
}
