import {
  type LocationAvailabilityState,
  type LocationOpenState,
  type LocationPublicAddress,
  type OrderPickupState,
  type PickupBlockReason,
  type PickupDistanceBand,
  type PickupIdentityRequirement,
  type PickupPaymentRequirement,
} from "@mercaria/shared-types";
import type { Translate } from "../i18n/create-app-i18n";

/**
 * Reader-facing copy for location publication, nearby discovery and collection
 * (#93).
 *
 * The KEYS live in `@mercaria/shared-types` and are what a column, a CHECK and
 * a wire contract carry; the SENTENCES live here so a wording change touches no
 * stored value — `lib/condition.ts`'s split, applied to a second taxonomy.
 * Every map is exhaustive over its union, so a member added to `pickup.ts` is a
 * `tsc` failure in this package rather than a blank chip on a shopper's screen.
 *
 * ## The buyer never reads a block REASON, and that is enforced here
 *
 * `PICKUP_BLOCK_REASON_KEYS` is MERCHANT-facing copy. `docs/pickup.md` §2 is
 * explicit: given three published shop fronts and a per-reason answer, a client
 * varying one input at a time reads out a merchant's stock position, their
 * pause levers and their moderation state. The public nearby read already
 * OMITS a location it will not serve — but `checkoutEligibility` is the one
 * place reasons do reach a client (#93 nearby rule 12), and
 * {@link describeBuyerPickupBlock} is what collapses them back into one
 * sentence before anybody renders them.
 *
 * ## Nothing here encodes a state in colour
 *
 * `ConditionBadge`'s rule: colour alone is not a label, and "in stock" green
 * beside "low stock" amber reads as a recommendation when both are simply facts
 * a merchant published. The words carry the meaning.
 */

/* -------------------------------------------------------------------------- */
/*  Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The bounded availability state, as a shopper reads it.
 *
 * A STATE and not a number: `docs/pickup.md` §5 — the exact count is present
 * only where a merchant opted into disclosing it, so a consumer wanting to say
 * "3 left" reads a property that is usually absent. These three sentences are
 * what every other case renders.
 */
export const LOCATION_AVAILABILITY_KEYS: Readonly<
  Record<LocationAvailabilityState, string>
> = {
  in_stock: "ui.pickup.availability.text.in_stock",
  low_stock: "ui.pickup.availability.text.low_stock",
  out_of_stock: "ui.pickup.availability.text.out_of_stock",
};

/** One sentence each, phrased as what the SHOP last confirmed — never a promise. */
export const LOCATION_AVAILABILITY_EXPLANATION_KEYS: Readonly<
  Record<LocationAvailabilityState, string>
> = {
  in_stock: "ui.pickup.availability.explanation.in_stock",
  low_stock: "ui.pickup.availability.explanation.low_stock",
  out_of_stock: "ui.pickup.availability.explanation.out_of_stock",
};

/* -------------------------------------------------------------------------- */
/*  Distance                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The coarse band, as a shopper reads it.
 *
 * Both the band AND the rounded metre figure are published, and both are
 * deliberately imprecise (#93 nearby rule 5). The band is what a filter and a
 * screen reader use; `formatDistance` renders the figure beside it.
 */
export const PICKUP_DISTANCE_BAND_KEYS: Readonly<Record<PickupDistanceBand, string>> = {
  under_1km: "ui.pickup.distanceBand.under_1km",
  under_5km: "ui.pickup.distanceBand.under_5km",
  under_10km: "ui.pickup.distanceBand.under_10km",
  under_25km: "ui.pickup.distanceBand.under_25km",
  under_50km: "ui.pickup.distanceBand.under_50km",
  beyond_50km: "ui.pickup.distanceBand.beyond_50km",
};

/* -------------------------------------------------------------------------- */
/*  What a collection asks of the person collecting                            */
/* -------------------------------------------------------------------------- */

/** What the shop will ask for at the counter. */
export const PICKUP_IDENTITY_REQUIREMENT_KEYS: Readonly<
  Record<PickupIdentityRequirement, string>
> = {
  order_number_only: "ui.pickup.identityRequirement.order_number_only",
  collection_code: "ui.pickup.identityRequirement.collection_code",
  collection_code_and_photo_id: "ui.pickup.identityRequirement.collection_code_and_photo_id",
};

/**
 * How a collection is paid for.
 *
 * ONE member, and the sentence says so plainly rather than implying a choice:
 * every Mercaria collection is paid before you go, and "pay in store" is not a
 * rail this roadmap has (`pickup.ts` §`PICKUP_PAYMENT_REQUIREMENTS`).
 */
export const PICKUP_PAYMENT_REQUIREMENT_KEYS: Readonly<
  Record<PickupPaymentRequirement, string>
> = {
  prepaid: "ui.pickup.paymentRequirement.prepaid",
};

/* -------------------------------------------------------------------------- */
/*  The order's collection state                                               */
/* -------------------------------------------------------------------------- */

/**
 * The operational state of one collection.
 *
 * Kept entirely apart from the order's own status and from the payment's
 * (#93 pickup rule 12), so none of these words may be a payment word: "paid"
 * and "ready to collect" are different facts about one order and a shopper acts
 * on each differently.
 */
export const ORDER_PICKUP_STATE_KEYS: Readonly<Record<OrderPickupState, string>> = {
  awaiting_preparation: "ui.pickup.orderState.text.awaiting_preparation",
  ready_for_pickup: "ui.pickup.orderState.text.ready_for_pickup",
  collected: "ui.pickup.orderState.text.collected",
  pickup_cancelled: "ui.pickup.orderState.text.pickup_cancelled",
};

/** One sentence each, telling the buyer what to do next. */
export const ORDER_PICKUP_STATE_EXPLANATION_KEYS: Readonly<
  Record<OrderPickupState, string>
> = {
  awaiting_preparation: "ui.pickup.orderState.explanation.awaiting_preparation",
  ready_for_pickup: "ui.pickup.orderState.explanation.ready_for_pickup",
  collected: "ui.pickup.orderState.explanation.collected",
  pickup_cancelled: "ui.pickup.orderState.explanation.pickup_cancelled",
};

/* -------------------------------------------------------------------------- */
/*  Block reasons — MERCHANT-facing only                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why a location is not discoverable, or not collectable from.
 *
 * **Never render one of these to a buyer.** `docs/pickup.md` §2 states the
 * attack: a per-reason answer lets a shopper vary one input at a time and read
 * out a merchant's stock position, pause levers and moderation state. These
 * sentences exist for the merchant's OWN dashboard, where the subject is the
 * reader's own shop, and for an operator trace.
 *
 * Buyer-facing rendering goes through {@link describeBuyerPickupBlock}, which
 * takes the same list and answers with one sentence.
 */
export const PICKUP_BLOCK_REASON_KEYS: Readonly<Record<PickupBlockReason, string>> = {
  location_not_published: "ui.pickup.blockReason.location_not_published",
  location_not_active: "ui.pickup.blockReason.location_not_active",
  pickup_paused: "ui.pickup.blockReason.pickup_paused",
  pickup_not_offered: "ui.pickup.blockReason.pickup_not_offered",
  location_not_geocoded: "ui.pickup.blockReason.location_not_geocoded",
  location_restricted: "ui.pickup.blockReason.location_restricted",
  store_unavailable: "ui.pickup.blockReason.store_unavailable",
  listing_unavailable: "ui.pickup.blockReason.listing_unavailable",
  no_collectable_stock: "ui.pickup.blockReason.no_collectable_stock",
  inventory_stale: "ui.pickup.blockReason.inventory_stale",
  location_closed: "ui.pickup.blockReason.location_closed",
  seller_not_payment_ready: "ui.pickup.blockReason.seller_not_payment_ready",
  guest_pickup_disabled: "ui.pickup.blockReason.guest_pickup_disabled",
  guest_seller_not_activated: "ui.pickup.blockReason.guest_seller_not_activated",
  guest_notifications_unavailable: "ui.pickup.blockReason.guest_notifications_unavailable",
  store_pickup_disabled: "ui.pickup.blockReason.store_pickup_disabled",
  p2p_pickup_not_available: "ui.pickup.blockReason.p2p_pickup_not_available",
};

/**
 * The reasons a SIGNED-OUT shopper could fix by signing in.
 *
 * The whole of #93 client rule 10: sign-in is offered as an OPTIONAL BENEFIT
 * where it genuinely is one, and never as a condition. Every member here is a
 * refusal that applies to a guest and not to an account holder, so the offer is
 * true rather than a growth prompt wearing a helpful sentence.
 */
const GUEST_ONLY_BLOCK_REASONS: readonly PickupBlockReason[] = [
  "guest_pickup_disabled",
  "guest_seller_not_activated",
  "guest_notifications_unavailable",
];

/** What a buyer is told when collection is refused, and whether to offer sign-in. */
export interface BuyerPickupBlockCopy {
  /** ONE sentence. Never a list, and never a named reason. */
  readonly sentence: string;
  /**
   * Whether signing in would actually change the answer.
   *
   * `true` ONLY when every reason is guest-specific — a mixed list means
   * something else is also refusing, so signing in would send somebody through
   * an account flow and refuse them again at the end of it.
   */
  readonly offerSignIn: boolean;
}

/**
 * Collapse an actor-specific refusal into one buyer-safe sentence.
 *
 * This is the function that keeps #93 client rule 5 ("explain actor-ineligible
 * states") and `docs/pickup.md` §2 ("the buyer never sees a reason") from
 * contradicting each other. The shopper is told that collection is not
 * available to them here, which is the fact that concerns them, and is told
 * nothing that varies with the merchant's stock, pauses or moderation state.
 *
 * An EMPTY reason list is treated as a refusal too. A `blocked` verdict with no
 * reasons is not something the server produces, and answering "you can collect
 * here" on one would be the permissive direction of a bug in somebody else's
 * code.
 */
export function describeBuyerPickupBlock(
  t: Translate,
  reasons: readonly PickupBlockReason[],
): BuyerPickupBlockCopy {
  const guestOnly =
    reasons.length > 0 && reasons.every((reason) => GUEST_ONLY_BLOCK_REASONS.includes(reason));
  if (guestOnly) {
    return {
      sentence: t("ui.pickup.buyerBlock.guestSignIn"),
      offerSignIn: true,
    };
  }
  return {
    sentence: t("ui.pickup.buyerBlock.unavailable"),
    offerSignIn: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Open state, hours and address                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether a shop is open, said in one sentence.
 *
 * The `known: false` branch has no `open` property to read, so "we do not know
 * this shop's hours" cannot be rendered as "closed" — the unknown-is-never-zero
 * rule applied to a schedule. It is a real and common state: a merchant may
 * publish a location and never fill its opening hours in.
 */
export function describeOpenState(t: Translate, state: LocationOpenState): string {
  if (!state.known) return t("ui.pickup.openState.hoursNotPublished");
  if (state.open) {
    return state.changesAt === undefined
      ? t("ui.pickup.openState.openNow")
      : t("ui.pickup.openState.openUntil", { time: state.changesAt });
  }
  if (state.closureNote !== undefined) {
    return t("ui.pickup.openState.closedNote", { note: state.closureNote });
  }
  return state.changesAt === undefined
    ? t("ui.pickup.openState.closedNow")
    : t("ui.pickup.openState.closedOpensAt", { time: state.changesAt });
}

/** Seconds, minutes and hours, for the relative-time helper below. */
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * When this shop last confirmed the stock figure (#93 client rule 3).
 *
 * Relative, because "confirmed 4 minutes ago" is what tells a shopper whether
 * to trust the number and an absolute timestamp is not. An UNPARSEABLE instant
 * answers that it is unknown rather than falling back to the current time,
 * which would render the stalest possible data as the freshest.
 *
 * `now` is a parameter rather than a `Date.now()` read, so this stays pure and
 * a caller in a memoized position cannot pick up a clock that React Compiler
 * will not re-run.
 */
export function describeStockConfirmed(t: Translate, isoInstant: string, now: number): string {
  const at = Date.parse(isoInstant);
  if (Number.isNaN(at)) return t("ui.pickup.stockConfirmed.unknown");
  const elapsed = now - at;
  // A future instant is clock skew, not a fact about the shop. Saying "just
  // now" is the honest floor; "in 3 minutes" would read as a prediction.
  if (elapsed < MINUTE_MS) return t("ui.pickup.stockConfirmed.justNow");
  // `count` drives i18n-js's pluralisation, so the singular/plural split comes
  // from the BUNDLE rather than from an English ternary no other language shares.
  if (elapsed < HOUR_MS) {
    return t("ui.pickup.stockConfirmed.minutes", { count: Math.floor(elapsed / MINUTE_MS) });
  }
  if (elapsed < DAY_MS) {
    return t("ui.pickup.stockConfirmed.hours", { count: Math.floor(elapsed / HOUR_MS) });
  }
  return t("ui.pickup.stockConfirmed.days", { count: Math.floor(elapsed / DAY_MS) });
}

/**
 * A published address as one line.
 *
 * EVERY field is optional except the country (`LocationPublicAddress`), because
 * "the city and nothing else" is a complete answer a merchant may choose — so
 * this joins whatever is present and never renders a separator for a field that
 * is not there. It can legitimately return just a country code.
 */
export function formatPublicAddress(address: LocationPublicAddress): string {
  return [address.line1, address.line2, address.postalCode, address.city, address.region, address.country]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join(", ");
}


/** Minutes in an hour, for rendering a minute-of-day as a clock time. */
const MINUTES_PER_HOUR = 60;

/** A minute-of-day as local `HH:MM`. 1440 is a shift ending at midnight. */
export function formatOpeningMinute(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / MINUTES_PER_HOUR) % 24;
  const minute = minuteOfDay % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
