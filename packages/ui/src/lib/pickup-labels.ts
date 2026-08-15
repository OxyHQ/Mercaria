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
 * `PICKUP_BLOCK_REASON_TEXT` is MERCHANT-facing copy. `docs/pickup.md` §2 is
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
export const LOCATION_AVAILABILITY_TEXT: Readonly<
  Record<LocationAvailabilityState, string>
> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

/** One sentence each, phrased as what the SHOP last confirmed — never a promise. */
export const LOCATION_AVAILABILITY_EXPLANATIONS: Readonly<
  Record<LocationAvailabilityState, string>
> = {
  in_stock: "This shop confirmed it had this in stock.",
  low_stock: "This shop confirmed only a few left.",
  out_of_stock: "This shop confirmed it has none right now.",
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
export const PICKUP_DISTANCE_BAND_TEXT: Readonly<Record<PickupDistanceBand, string>> = {
  under_1km: "Under 1 km away",
  under_5km: "Under 5 km away",
  under_10km: "Under 10 km away",
  under_25km: "Under 25 km away",
  under_50km: "Under 50 km away",
  beyond_50km: "Over 50 km away",
};

/* -------------------------------------------------------------------------- */
/*  What a collection asks of the person collecting                            */
/* -------------------------------------------------------------------------- */

/** What the shop will ask for at the counter. */
export const PICKUP_IDENTITY_REQUIREMENT_TEXT: Readonly<
  Record<PickupIdentityRequirement, string>
> = {
  order_number_only: "Bring your order number.",
  collection_code: "Bring your collection code.",
  collection_code_and_photo_id: "Bring your collection code and photo ID.",
};

/**
 * How a collection is paid for.
 *
 * ONE member, and the sentence says so plainly rather than implying a choice:
 * every Mercaria collection is paid before you go, and "pay in store" is not a
 * rail this roadmap has (`pickup.ts` §`PICKUP_PAYMENT_REQUIREMENTS`).
 */
export const PICKUP_PAYMENT_REQUIREMENT_TEXT: Readonly<
  Record<PickupPaymentRequirement, string>
> = {
  prepaid: "Paid online — nothing to pay when you collect.",
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
export const ORDER_PICKUP_STATE_TEXT: Readonly<Record<OrderPickupState, string>> = {
  awaiting_preparation: "Being prepared",
  ready_for_pickup: "Ready to collect",
  collected: "Collected",
  pickup_cancelled: "Collection cancelled",
};

/** One sentence each, telling the buyer what to do next. */
export const ORDER_PICKUP_STATE_EXPLANATIONS: Readonly<
  Record<OrderPickupState, string>
> = {
  awaiting_preparation:
    "The shop is getting your order ready. Wait until it says ready to collect before you travel.",
  ready_for_pickup: "Your order is waiting at the shop.",
  collected: "This order has been handed over.",
  pickup_cancelled:
    "The shop withdrew this collection. Your order and any refund are handled separately — nothing here has taken your money back.",
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
export const PICKUP_BLOCK_REASON_TEXT: Readonly<Record<PickupBlockReason, string>> = {
  location_not_published: "This location has not been published, so shoppers cannot find it.",
  location_not_active: "This location is switched off and routes no inventory.",
  pickup_paused: "You have paused collection at this location.",
  pickup_not_offered: "This location does not offer collection.",
  location_not_geocoded:
    "This location has no map pin, so it cannot be found by distance. Add one to be discoverable.",
  location_restricted: "Mercaria has restricted this location. Contact support.",
  store_unavailable: "The store itself is inactive or restricted.",
  listing_unavailable: "The listing is not active, so nothing here is collectable.",
  no_collectable_stock: "There are no collectable units at this location right now.",
  inventory_stale:
    "Stock here was last confirmed longer ago than the confirmation interval you set for this location.",
  location_closed: "This location is closed for the period being asked about.",
  seller_not_payment_ready: "This seller cannot be paid yet, so nothing can be bought for collection.",
  guest_pickup_disabled: "Guest collection is switched off for this deployment.",
  guest_seller_not_activated: "This seller has not been activated for guest checkout.",
  guest_notifications_unavailable:
    "Guest collection needs a transactional message transport, and this deployment has none.",
  store_pickup_disabled: "Store collection is switched off for this deployment.",
  p2p_pickup_not_available: "Collection is not available for person-to-person listings.",
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
  reasons: readonly PickupBlockReason[],
): BuyerPickupBlockCopy {
  const guestOnly =
    reasons.length > 0 && reasons.every((reason) => GUEST_ONLY_BLOCK_REASONS.includes(reason));
  if (guestOnly) {
    return {
      sentence:
        "You can collect from this shop with a Mercaria account. Signing in is optional everywhere else — here it is what makes collection available.",
      offerSignIn: true,
    };
  }
  return {
    sentence: "Collection is not available here for you right now. You can still have it delivered.",
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
export function describeOpenState(state: LocationOpenState): string {
  if (!state.known) return "Opening hours not published";
  if (state.open) {
    return state.changesAt === undefined ? "Open now" : `Open now — until ${state.changesAt}`;
  }
  if (state.closureNote !== undefined) return `Closed — ${state.closureNote}`;
  return state.changesAt === undefined ? "Closed now" : `Closed — opens ${state.changesAt}`;
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
export function describeStockConfirmed(isoInstant: string, now: number): string {
  const at = Date.parse(isoInstant);
  if (Number.isNaN(at)) return "Last confirmed at an unknown time";
  const elapsed = now - at;
  // A future instant is clock skew, not a fact about the shop. Saying "just
  // now" is the honest floor; "in 3 minutes" would read as a prediction.
  if (elapsed < MINUTE_MS) return "Stock confirmed just now";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `Stock confirmed ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `Stock confirmed ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `Stock confirmed ${days} ${days === 1 ? "day" : "days"} ago`;
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

/** Weekday names indexed to match `LocationOpeningHour.weekday` (`Date#getDay`). */
const WEEKDAY_NAMES: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Minutes in an hour, for rendering a minute-of-day as a clock time. */
const MINUTES_PER_HOUR = 60;

/** A minute-of-day as local `HH:MM`. 1440 is a shift ending at midnight. */
export function formatOpeningMinute(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / MINUTES_PER_HOUR) % 24;
  const minute = minuteOfDay % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A weekday index as its name, or an empty string for an out-of-range one. */
export function formatWeekday(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? "";
}
