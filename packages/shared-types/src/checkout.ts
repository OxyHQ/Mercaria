/**
 * The checkout CONTACT and DESTINATION contract — #105, ADR 0003 D4/D8/D13,
 * ADR 0006 G6/G12.
 *
 * Before #105, `POST /checkout` took one field for all of this: `addressId`,
 * a row in the Oxy-scoped `addresses` table. That single field conflated three
 * separate concepts, and the conflation is what made guest checkout
 * unrepresentable rather than merely unbuilt:
 *
 *  1. **where the goods go** — a shipping destination, or a pickup location;
 *  2. **how to reach the buyer about this order** — a contact email, optionally
 *     a phone;
 *  3. **whether the buyer wants that destination kept** — saved-address
 *     persistence, which is an Oxy-account feature and nothing to do with
 *     fulfilling this order.
 *
 * They are three fields here, and the split is the point: a guest has (1) and
 * (2) and structurally cannot have (3), while an authenticated buyer may have
 * all three and must not be forced into (3) to use (1).
 *
 * ## What is deliberately NOT in this module
 *
 * No payment field of any kind. No provider, no token, no amount, no billing
 * address — billing details belong to the Stripe element (ADR 0006 G6) and
 * never reach a Mercaria server. No OxyPay, no FairCoin: they are not payment
 * rails in this roadmap and #105 adds no field, flag or copy that anticipates
 * one (`checkout-contact-isolation.test.ts` fails the build over the spelling).
 * No referral field: attribution is #142/#143's own model and can never be
 * derived from an email, a phone or an address.
 */

/** The three destination kinds a checkout may name. */
export const CHECKOUT_DESTINATION_TYPES = [
  'saved_address',
  'inline_shipping_address',
  'pickup',
] as const;

/** One of {@link CHECKOUT_DESTINATION_TYPES}. */
export type CheckoutDestinationType = (typeof CHECKOUT_DESTINATION_TYPES)[number];

/**
 * Field length ceilings for every free-text address and contact field.
 *
 * Exported so the server's zod schema, the client's form and the Postgres
 * columns are all bounded by the SAME numbers rather than three lists that
 * drift. They are generous by international-postal standards on purpose: the
 * bound exists to stop a megabyte arriving in a `line1`, not to encode an
 * opinion about how long a real address can be (see `postal-code` below for
 * the same reasoning applied to format).
 */
export const CHECKOUT_TEXT_LIMITS = {
  recipientName: 200,
  line1: 300,
  line2: 300,
  city: 150,
  region: 150,
  postalCode: 40,
  /** RFC 5321's maximum reverse-path, the one length email genuinely has. */
  email: 320,
  /** E.164 is 15 digits; the slack is for the separators people type. */
  phone: 40,
} as const;

/**
 * A destination the buyer typed, rather than one Mercaria already stored.
 *
 * The same nine fields a saved `Address` carries MINUS `label`: a label is
 * address-book metadata for finding an address again, and an order that will
 * never be looked up by it has no use for one (#105 validation rule 10). When
 * an authenticated buyer asks for this address to be SAVED, the label travels
 * on that request, not on the fulfilment snapshot.
 */
export interface CheckoutAddressInput {
  /** Who to hand the parcel to. */
  recipientName: string;
  /** Primary street line. */
  line1: string;
  /** Secondary street line (apt/suite/unit) — optional everywhere. */
  line2?: string;
  /** City / locality. */
  city: string;
  /** State / province / region — optional, because most countries have none. */
  region?: string;
  /** Postal / ZIP code. */
  postalCode: string;
  /** ISO-3166 alpha-2, upper-case. Validated against the real code list. */
  country: string;
  /** Delivery phone, distinct from the contact phone below. */
  phone?: string;
}

/**
 * How to reach the buyer about THIS order.
 *
 * Separate from the destination because the two answer different questions and
 * have different lifetimes: the destination is fulfilment data a seller sees
 * (ADR 0003 D13), while the contact is Mercaria-only and, for a guest, is the
 * one durable link between a placed order and the person who placed it
 * (ADR 0003 D4).
 *
 * The email is stored, encrypted, ONLY for a guest-origin checkout. An Oxy
 * buyer's transactional channel is Oxy's own notification path keyed on their
 * account id, and copying an Oxy account's email into Mercaria would create
 * exactly the profile mirror ADR 0003 D15 says does not exist.
 */
export interface CheckoutContactInput {
  /** The address transactional mail about this order goes to. */
  email: string;
  /** Optional contact number. Never an authorization factor (ADR 0003 I2). */
  phone?: string;
}

/** Ship to an address the authenticated buyer has already saved. */
export interface SavedAddressDestination {
  type: 'saved_address';
  /** An `addresses` row id, resolved against the CALLER's own rows. */
  addressId: string;
}

/** Ship to an address supplied inline, by either actor kind. */
export interface InlineShippingAddressDestination {
  type: 'inline_shipping_address';
  address: CheckoutAddressInput;
  /**
   * Keep this address in the buyer's address book.
   *
   * Opt-IN, and honoured only for an authenticated buyer — a guest has no
   * address book and asking for one cannot conjure an Oxy account (#105 actor
   * rule 4, privacy rule 6). Absent means "use it once and forget it", which is
   * what an unticked box must mean: a checkout that quietly grew the address
   * book would be storing data the buyer never asked to keep.
   */
  saveToAddressBook?: boolean;
  /** Address-book label, meaningful only alongside `saveToAddressBook`. */
  saveLabel?: string;
}

/**
 * Collect in person at a seller location.
 *
 * Carries its own contact because the person collecting is not necessarily the
 * person who paid, and because pickup needs NO invented shipping address
 * (#105 actor rule 5) — inventing one would put a fictional street on an
 * invoice-grade record.
 */
export interface PickupDestination {
  type: 'pickup';
  /** A `locations` row id belonging to the seller being checked out. */
  locationId: string;
  /** Who will collect, and how to reach them. */
  pickupContact: CheckoutContactInput;
}

/**
 * Where this checkout's goods go — a discriminated union, so the compiler
 * forces every consumer to say which case it is handling.
 */
export type CheckoutDestination =
  | SavedAddressDestination
  | InlineShippingAddressDestination
  | PickupDestination;

/**
 * Whether the contact inbox was proven BEFORE the payment or is still
 * unproven when it completes (#105 GuestCheckout rule 8).
 *
 * Recorded rather than enforced: ADR 0003 D17 puts payment deliberately on the
 * pre-verification side of the line, because an email typo is answered by the
 * confirmation mail not arriving, not by refusing a card the buyer already
 * authorised. What the record buys is the ability to tell the two apart later —
 * a support agent looking at an undeliverable confirmation needs to know
 * whether anybody ever proved that inbox.
 *
 * `pending` is the launch value for every guest checkout: #108 owns the
 * magic-link exchange that can move it to `verified_before_payment`, and #106
 * owns stamping `verified_after_payment` once an order is paid and a link is
 * consumed.
 */
export const GUEST_CONTACT_VERIFICATION_STAGES = [
  'pending',
  'verified_before_payment',
  'verified_after_payment',
] as const;

/** One of {@link GUEST_CONTACT_VERIFICATION_STAGES}. */
export type GuestContactVerificationStage =
  (typeof GUEST_CONTACT_VERIFICATION_STAGES)[number];

/**
 * The contact POLICY version a stored guest contact was captured under (#106
 * GuestCheckout rule 7).
 *
 * Stamped on every `guest_checkouts` row and surfaced on the buyer's contact
 * projection. It names the version of ADR 0003 D12's normalization (trim, NFC,
 * lowercase the whole address, no plus-tag stripping, no dot folding), of the
 * redaction forms and of the D15 erasure rules that produced the stored values.
 *
 * Bumping it is a DECISION with consequences, not a version-number ritual: a
 * row stamped `v1` was normalized by the v1 rules, so changing the rules means
 * either re-deriving those rows or accepting that two rows spell the same inbox
 * differently. The stamp is what makes that choice visible instead of silent.
 */
export const GUEST_CONTACT_POLICY_VERSION = 'v1';

/**
 * Where an order's buyer identity came from — ADR 0003 D6.
 *
 * IMMUTABLE after insert: a claim (#109) records a later Oxy owner in its own
 * column and never rewrites this one, so "who placed it" and "who owns it now"
 * stay two facts (I7).
 */
export const ORDER_BUYER_ORIGINS = ['oxy', 'guest', 'external'] as const;

/** One of {@link ORDER_BUYER_ORIGINS}. */
export type OrderBuyerOrigin = (typeof ORDER_BUYER_ORIGINS)[number];
