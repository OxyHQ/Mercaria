/**
 * Who an order BELONGS to, who ACTED on it, and what a given reader may learn
 * about either — #106, ADR 0003 D6/D13/D16.
 *
 * `#105` made a guest order storable: `orders.buyer_origin` and
 * `orders.buyer_guest_checkout_id` exist, and `orders_buyer_identity_check`
 * refuses every illegal combination of them. What it did NOT give anyone was a
 * way to READ a buyer without picking columns off the row and guessing which
 * ones apply. This module is that reading, as a discriminated union, so the
 * guessing is a `switch` the compiler checks.
 *
 * ## There is deliberately NO common `oxyUserId` field
 *
 * Exactly `CommerceActor`'s rule (ADR 0003 D1/I1), one layer down: a shared
 * `buyer.oxyUserId` would let code that forgot which origin it holds pass a
 * guest's Oxy CLAIMANT where the original purchaser was expected — which is a
 * silent attribution error rather than a crash. With no common field, every
 * consumer narrows on `origin` first.
 *
 * ## A claim is a SECOND owner, never a rewritten first one
 *
 * `origin: 'guest'` stays `'guest'` after a claim, forever (ADR 0003 I7). The
 * claim appears as `claimedByOxyUserId` INSIDE the guest member — so "who
 * placed this" and "whose account owns it now" cannot be read from the same
 * field, and no projection can accidentally answer the second question when it
 * was asked the first. The database holds the same shape: `buyer_origin` is
 * immutable by trigger, and the claim pair may only move NULL→value (a claim)
 * and value→NULL (an audited operator unclaim), never value→value.
 *
 * ## What a SELLER may see is a different type, not a filtered one
 *
 * ADR 0003 D13 lists what a seller receives per order they fulfil, and the list
 * contains no buyer identifier of any kind beyond a display label. The way to
 * make that true of a projection is to give it no field to travel in — the
 * payment status-projection rule — so {@link MerchantBuyerLabel} is its own
 * type with two properties, rather than {@link OrderBuyer} with some fields
 * omitted at runtime. A seller API therefore cannot enumerate or correlate a
 * guest's purchases because there is nothing in the response to correlate BY
 * (invariant I11).
 */

import type { ConnectorProviderId } from './integration';
import type { GuestContactVerificationStage } from './checkout';

/**
 * Which kind of actor performed a lifecycle transition (ADR 0003 D16).
 *
 * Recorded on every `order_status_history` row. `system` is the sweep, the
 * outbox handler and the connector; `operator` is a Mercaria staff action.
 * The kind is what decides which id column may be written: `by_oxy_user_id`
 * only for `oxy`/`operator`, `actor_guest_session_id` only for `guest` — a
 * CHECK ties them, so a guest id can never reach an Oxy column even in an
 * audit row (I1 applies to audit rows too).
 */
export const ORDER_ACTOR_KINDS = ['oxy', 'guest', 'system', 'operator'] as const;

/** One of {@link ORDER_ACTOR_KINDS}. */
export type OrderActorKind = (typeof ORDER_ACTOR_KINDS)[number];

/** The order was placed by a verified Oxy account, which still owns it. */
export interface OxyOrderBuyer {
  origin: 'oxy';
  /** The Oxy account that placed it — the ORIGIN owner, never rewritten. */
  oxyUserId: string;
}

/**
 * The order was placed by a guest, whose durable identity is the checkout
 * group's contact record (ADR 0003 D4).
 *
 * `guestCheckoutId` is a Mercaria row id and NOT a credential: possession of it
 * authorizes nothing, which is why it may appear in a buyer-facing projection
 * at all. The guest SESSION id never appears here in any form — it is the
 * credential's audit handle and belongs to the operator surface.
 */
export interface GuestOrderBuyer {
  origin: 'guest';
  /** The `guest_checkouts` row this order's contact lives on. */
  guestCheckoutId: string;
  /**
   * The Oxy account that later CLAIMED this order (#109), when one has.
   *
   * Secondary ownership: it grants account access and changes nothing about
   * who placed the purchase. Absent on every unclaimed guest order, which is
   * the normal state.
   */
  claimedByOxyUserId?: string;
  /** ISO-8601 instant of the claim. Present exactly with the claimant. */
  claimedAt?: string;
}

/**
 * The order was imported from an external commerce platform.
 *
 * Its buyer identity is the source platform's, and Mercaria holds only the
 * provenance. Historically this identity was smuggled into
 * `orders.buyer_oxy_user_id` as `ext:<provider>:<externalId>` — a convention
 * nothing enforced. `'external'` names those rows honestly; ADR 0003 M9 stops
 * NEW imports writing the legacy value, and the existing rows keep theirs as
 * provenance.
 */
export interface ExternalOrderBuyer {
  origin: 'external';
  /** Which platform the order came from, when the row records one. */
  connectorProvider?: ConnectorProviderId;
  /** The platform's own order id — a foreign key space Mercaria never mints. */
  externalReference?: string;
}

/**
 * Who an order belongs to, historically and currently.
 *
 * Exactly one member per order, decided at insert and immutable thereafter
 * apart from the claim pair inside the guest member.
 */
export type OrderBuyer = OxyOrderBuyer | GuestOrderBuyer | ExternalOrderBuyer;

/**
 * What a SELLER learns about the buyer of an order they fulfil (ADR 0003 D13).
 *
 * Two properties, and the second is present only for an `oxy` order. There is
 * deliberately no contact field, no guest checkout id, no claim status and no
 * buyer-origin discriminant: a merchant fulfilling a parcel needs a name to put
 * on a packing slip and the shipping snapshot the order already carries, and
 * everything past that is correlation material.
 *
 * `displayLabel` for a guest order is the literal `Guest` — not "Guest #4821",
 * not a truncated email, not an initial. A per-guest label would be a
 * correlation key wearing a display name, which is precisely what I11 forbids.
 * It is also why nothing here says WHICH kind of buyer this is: #106 DTO rule 5
 * ("do not stigmatize guest buyers in merchant UX") and I11 point the same way,
 * so a merchant reading two orders cannot tell a signed-out buyer from a
 * signed-in one at all.
 */
export interface MerchantBuyerLabel {
  /** The Oxy display handle, or the literal `Guest`. */
  displayLabel: string;
  /**
   * The buyer's Oxy account id — present ONLY for an `oxy`-origin order, where
   * the seller could already read it before #106 and where it is the merchant's
   * existing CRM key. Absent for guest and external orders, in which case there
   * is no id to give and none is invented.
   */
  oxyUserId?: string;
}

/**
 * Where the historical buyer contact came from, and the redacted form of it.
 *
 * ## This is a projection of ONE stored snapshot, and never a live read
 *
 * #106 contact rule 5 says the historical contact accepted at purchase must
 * never be rendered by re-reading a live source. The snapshot it is rendered
 * from is the order's own `guest_checkouts` row, which is immutable by trigger
 * and referenced by a `RESTRICT` foreign key — so it cannot drift and cannot be
 * orphaned. An Oxy profile is never read for this, in any code path.
 *
 * ## Why the guest contact is not COPIED onto each order
 *
 * Copying it would satisfy a literal reading of rule 5 and break rule 10, which
 * is the stronger requirement: contact retention must be separable from order
 * financial retention. ADR 0003 D15 erases a guest's contact on a verified
 * request while the orders, totals, refunds and ledger entries are retained
 * under a statutory obligation — and a copy on the immutable order record would
 * be exactly the copy that erasure could not reach. One snapshot, separately
 * erasable, is what makes both rules satisfiable at once; an anonymized contact
 * renders as `deleted`, which is the honest answer rather than a stale one.
 */
export interface BuyerContactProjection {
  /**
   * `guest_checkout` — the durable contact record this order was placed with.
   * `oxy_account` — none is stored, because an Oxy buyer's transactional
   * channel is Oxy's own notification path keyed on their account id. Copying
   * an Oxy account's email into Mercaria would create the profile mirror
   * ADR 0003 D15 says does not exist, so the projection says where the channel
   * IS rather than inventing a value to put here.
   */
  source: 'guest_checkout' | 'oxy_account';
  /** `j***@example.com`, or the literal `deleted` after erasure (D15). */
  emailRedacted?: string;
  /** `***42`, when the buyer gave a contact phone. */
  phoneRedacted?: string;
  /** Whether the contact inbox was proven, and when relative to payment. */
  verificationStage?: GuestContactVerificationStage;
  /** Consent to MARKETING, which the purchase itself never implies. */
  marketingOptIn?: boolean;
  /**
   * Which contact policy version the value was captured under.
   *
   * Recorded because email normalization, redaction and retention are a POLICY
   * (ADR 0003 D12/D15) and a stored contact must say which one it was read
   * under — the versioned-attribute-definition reasoning, applied to a person's
   * details rather than to a product's.
   */
  policyVersion?: string;
}

/**
 * The lifecycle of a guest checkout GROUP, derived and never stored.
 *
 * #106's GuestCheckout model asks for a status "covering pending payment, paid,
 * cancelled, expired or another explicit lifecycle". It is derived from the
 * group's ORDERS rather than held in a column of its own, for the reason
 * `guest_sessions` has no status column and `provider_accounts` has no `ready`
 * boolean beside `onboarding_state`: two representations of one fact can
 * disagree, and the place that must not happen is a portal telling a buyer
 * their order is unpaid while the ledger says otherwise.
 *
 * `mixed` is a real member and not a fallback: a multi-seller group whose
 * sellers are at different stages is the ordinary case once one order ships,
 * and collapsing it to the "worst" or "latest" status would be an invented
 * fact.
 */
export const GUEST_CHECKOUT_LIFECYCLES = [
  'pending_payment',
  'paid',
  'cancelled',
  'refunded',
  'mixed',
] as const;

/** One of {@link GUEST_CHECKOUT_LIFECYCLES}. */
export type GuestCheckoutLifecycle = (typeof GUEST_CHECKOUT_LIFECYCLES)[number];

/**
 * Whether a guest checkout group has been claimed into an Oxy account.
 *
 * Derived from the group's orders, which is where ADR 0003 D6 puts the claim
 * columns. A claim is group-ATOMIC by construction (D14: "a group can never be
 * split"), so every order of a claimed group carries the same claimant and this
 * derivation has one answer rather than a reduction over disagreeing rows —
 * `partial` exists so a disagreement is VISIBLE rather than smoothed over, and
 * is what the operator consistency check counts.
 */
export interface GuestCheckoutClaimState {
  status: 'unclaimed' | 'claimed' | 'partial';
  /** The claiming Oxy account, when the whole group agrees on one. */
  claimedByOxyUserId?: string;
  /** ISO-8601 instant of the claim. */
  claimedAt?: string;
}
