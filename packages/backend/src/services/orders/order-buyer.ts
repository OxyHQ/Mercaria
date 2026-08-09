/**
 * The ONE translation from an `orders` row's buyer columns to the
 * {@link OrderBuyer} union — #106 buyer-model rule 8, ADR 0003 D6.
 *
 * Five columns encode the buyer (`buyer_origin`, `buyer_oxy_user_id`,
 * `buyer_guest_checkout_id`, `claimed_by_oxy_user_id`, `claimed_at`) and
 * `orders_buyer_identity_check` decides which combinations are legal. Reading
 * them at each call site would mean re-deriving that constraint by hand in
 * every serializer, every authorization check and every report — and the first
 * one that got it slightly wrong would attribute a claimed guest order to the
 * wrong person, silently. So the derivation lives here, once, and everything
 * downstream consumes the union.
 *
 * ## The compiler cannot see the CHECK, so this function is where it lands
 *
 * drizzle types the five columns independently: `buyer_origin` narrows to the
 * literal union, but `buyer_oxy_user_id` stays `string | null` in every branch.
 * The database guarantees the correlation and TypeScript does not, which is
 * exactly the seam where a `!` or an `as` gets written. Neither appears below:
 * each branch checks the column the CHECK promises and RAISES when it is
 * absent, because a row that violated the constraint is a corrupted commercial
 * record and serving a fabricated buyer for it is worse than failing the read.
 * The `orderRepository`'s own "conflicted on a group that does not exist" throw
 * is the precedent.
 */

import type { OrderBuyer, OrderBuyerOrigin, ConnectorProviderId } from '@mercaria/shared-types';

/**
 * The buyer columns of an `orders` row, and nothing else.
 *
 * Declared structurally rather than as `OrderRow` so the derivation can also
 * run over a narrow projection — the payment seam's, the operator trace's, a
 * consistency sweep's — without any of them having to select thirty columns
 * they do not read.
 */
export interface OrderBuyerColumns {
  readonly buyerOrigin: OrderBuyerOrigin;
  readonly buyerOxyUserId: string | null;
  readonly buyerGuestCheckoutId: string | null;
  readonly claimedByOxyUserId: string | null;
  readonly claimedAt: Date | null;
  readonly sourceProvider: ConnectorProviderId | null;
  readonly sourceExternalId: string | null;
}

/** Raised when a row's buyer columns contradict `orders_buyer_identity_check`. */
function inconsistent(origin: OrderBuyerOrigin, missing: string): Error {
  return new Error(
    `orders row has buyer_origin='${origin}' with no ${missing}; ` +
      'orders_buyer_identity_check makes this unrepresentable, so the row is corrupt.',
  );
}

/**
 * Read an order's buyer identity.
 *
 * Total over every legal row shape and never fabricates: an unclaimed guest
 * order simply has no claim properties, rather than carrying empty strings that
 * a consumer would have to test for.
 */
export function orderBuyerOf(row: OrderBuyerColumns): OrderBuyer {
  switch (row.buyerOrigin) {
    case 'oxy': {
      if (row.buyerOxyUserId === null) throw inconsistent('oxy', 'buyer_oxy_user_id');
      return { origin: 'oxy', oxyUserId: row.buyerOxyUserId };
    }
    case 'guest': {
      if (row.buyerGuestCheckoutId === null) {
        throw inconsistent('guest', 'buyer_guest_checkout_id');
      }
      // The claim pair travels together — `num_nonnulls(…) in (0, 2)` — so ONE
      // test narrows both. Both are still read, because the CHECK constrains
      // the database and this is the only thing that constrains the types.
      return {
        origin: 'guest',
        guestCheckoutId: row.buyerGuestCheckoutId,
        ...(row.claimedByOxyUserId !== null && row.claimedAt !== null
          ? {
              claimedByOxyUserId: row.claimedByOxyUserId,
              claimedAt: row.claimedAt.toISOString(),
            }
          : {}),
      };
    }
    case 'external': {
      // Both provenance fields are genuinely optional here rather than
      // CHECK-guaranteed: `'external'` is also the value a hand-created or
      // seeded import can carry, and `orders_store_id_source_key` only
      // constrains rows that HAVE an external id. Absence is reported as
      // absence.
      return {
        origin: 'external',
        ...(row.sourceProvider !== null ? { connectorProvider: row.sourceProvider } : {}),
        ...(row.sourceExternalId !== null ? { externalReference: row.sourceExternalId } : {}),
      };
    }
  }
}

/**
 * The Oxy account that may read this order as its BUYER, if any.
 *
 * The original owner for an `oxy` order, the claimant for a claimed guest
 * order, and nobody for an unclaimed guest or an external import. Kept as a
 * function of the union rather than of the row so it cannot disagree with
 * {@link orderBuyerOf} — and deliberately NOT called `buyerOxyUserId`, because
 * for a claimed guest order the value it returns is not the buyer.
 */
export function accountWithBuyerAccess(buyer: OrderBuyer): string | undefined {
  switch (buyer.origin) {
    case 'oxy':
      return buyer.oxyUserId;
    case 'guest':
      return buyer.claimedByOxyUserId;
    case 'external':
      return undefined;
  }
}
