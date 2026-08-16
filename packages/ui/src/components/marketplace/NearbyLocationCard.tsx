import { Pressable, View } from "react-native";
import { type NearbyLocationResult } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { formatDistance, formatMoney } from "../../lib/format";
import { conditionLabel } from "../../lib/condition";
import {
  LOCATION_AVAILABILITY_EXPLANATIONS,
  LOCATION_AVAILABILITY_TEXT,
  PICKUP_DISTANCE_BAND_TEXT,
  PICKUP_IDENTITY_REQUIREMENT_TEXT,
  PICKUP_PAYMENT_REQUIREMENT_TEXT,
  describeBuyerPickupBlock,
  describeOpenState,
  describeStockConfirmed,
  formatPublicAddress,
} from "../../lib/pickup-labels";

/**
 * One place a shopper could collect this exact thing from (#93 client rules 3,
 * 4 and 5).
 *
 * ## Three names, kept apart
 *
 * #93 client rule 4 asks that a link to the merchant, the storefront and the
 * location not confuse the location with the brand — so the LOCATION's display
 * name is the heading (it is the place you walk into), the MERCHANT is a
 * separate, pressable identity below it, and the STOREFRONT is named as a third
 * thing when there is one. A single "Nike, Gran Via" heading would merge a
 * brand, a business and a building into one string, which is exactly the
 * confusion the rule names — and the merchant is the only one of the three with
 * a page to visit.
 *
 * ## Every unknown renders as its own sentence
 *
 * A location whose hours are unpublished says so; a stock figure carries when
 * it was confirmed; a refused collection says that it is refused and not WHY
 * (see below). None of the three is rendered as an absence, because an absent
 * line is read as "fine" by whoever is scanning the list.
 *
 * ## A refusal never names a reason
 *
 * `checkoutEligibility` is the one place `PickupBlockReason`s reach a client
 * (#93 nearby rule 12), and rendering the list would let a shopper read out a
 * merchant's stock position, pause levers and moderation state one request at a
 * time (`docs/pickup.md` §2). {@link describeBuyerPickupBlock} collapses them
 * to one sentence here, and the sign-in offer beside it appears only when
 * signing in would genuinely change the answer — #93 client rule 10's
 * "optional benefit, not a condition".
 *
 * ## No map, ever
 *
 * #93 client rule 8: accessibility does not depend on a map, and every result
 * is available in a list. This component renders no map, holds no map provider
 * and has no coordinate to give one — `NearbyLocationResult` carries a rounded
 * metre count and a band, and nothing else about where anything is.
 */

export interface NearbyLocationCardProps {
  result: NearbyLocationResult;
  /**
   * The instant relative times are measured against.
   *
   * Passed IN rather than read from a clock here: this package's components are
   * pure renderers, and React Compiler will not re-run a memoized position that
   * reads a module-level clock — so a "confirmed 4 minutes ago" derived inside
   * would freeze at whatever it first rendered.
   */
  now: number;
  /** Visit the merchant behind this place. Absent when the caller cannot route. */
  onPressMerchant?: (merchantSlug: string) => void;
  /**
   * Choose this place and go and buy it.
   *
   * Offered ONLY when the caller asked for actor eligibility AND it came back
   * eligible — a control that refuses on press is worse than one that is not
   * there, because the shopper has already decided by the time it refuses.
   */
  onSelect?: (result: NearbyLocationResult) => void;
  /** Copy for the select control, so a page and a checkout can differ. */
  selectLabel?: string;
  /** Offer a sign-in path when a guest-specific refusal is the only thing blocking. */
  onSignIn?: () => void;
}

/** Icon-free chip, the house shape shared with every other badge in this package. */
function Chip({ children }: { children: string }) {
  return (
    <View
      className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
      accessibilityRole="text"
    >
      <Text className="text-captionBold text-text">{children}</Text>
    </View>
  );
}

export function NearbyLocationCard({
  result,
  now,
  onPressMerchant,
  onSelect,
  selectLabel = "Collect here",
  onSignIn,
}: NearbyLocationCardProps) {
  const { location } = result;
  const address = formatPublicAddress(location.address);
  const eligibility = result.checkoutEligibility;
  const blocked = eligibility !== undefined && eligibility.verdict === "blocked";
  const blockCopy = blocked ? describeBuyerPickupBlock(eligibility.reasons) : undefined;

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-16">
      {/*
        The PLACE is the heading. A shopper scanning this list is choosing
        between buildings, and the merchant behind them is often the same one.
      */}
      <Text className="text-bodyTitleSmall text-text" accessibilityRole="header">
        {location.displayName}
      </Text>

      {address.length > 0 ? (
        <Text className="text-caption text-text-secondary">{address}</Text>
      ) : null}

      <View className="flex-row flex-wrap gap-space-6">
        <Chip>{`${PICKUP_DISTANCE_BAND_TEXT[result.distanceBand]} · ${formatDistance(result.approximateMetres)}`}</Chip>
        <Chip>{LOCATION_AVAILABILITY_TEXT[result.availability]}</Chip>
        {result.condition === undefined ? null : <Chip>{conditionLabel(result.condition)}</Chip>}
      </View>

      {/*
        The exact count appears ONLY where the merchant opted in, so this reads
        an optional property rather than a number with a sentinel — which is the
        shape that makes the private default safe (`docs/pickup.md` §5).
      */}
      <Text className="text-caption text-text-secondary">
        {result.exactQuantity === undefined
          ? LOCATION_AVAILABILITY_EXPLANATIONS[result.availability]
          : `${result.exactQuantity} in stock at this shop.`}
      </Text>

      {/* Hours and freshness: two facts a shopper acts on before travelling. */}
      <Text className="text-caption text-text-secondary">{describeOpenState(location.openState)}</Text>
      <Text className="text-caption text-text-tertiary">
        {describeStockConfirmed(result.stockConfirmedAt, now)}
      </Text>

      {/*
        `NearbyLocationResult.price` is a `Money`, so its currency is already
        Mercaria's presentment union and `formatMoney` takes it directly — no
        membership test, no cast, no fallback. The membership dance that used to
        stand here belonged to `OfferMoney` (whose currency is a bare string) and
        was copied onto a type that cannot carry one: its "unpresentable" branch
        was unreachable, and it printed `result.price.amount` RAW — integer MINOR
        units beside a code, which is off by a factor of 100 on a fiat price and
        of 100_000_000 on a FAIR one (#441).

        Deleting it rather than making it refuse is the safer shape: if the field
        is ever widened to `OfferMoney`, this call stops compiling and whoever
        widens it decides what to render, where a surviving fallback would just
        start printing minor units again in silence.

        `formatMoney` and not `PriceDisplay`: this is the price the till charges
        at a shop the shopper walks into, so it is quoted in the seller's own
        currency. `PriceDisplay` would convert it to the viewer's display
        currency and show a figure nobody at that counter will ask for.
      */}
      <Text className="text-body text-text">{formatMoney(result.price)}</Text>

      {/*
        Merchant and storefront, named as the separate things they are. The
        merchant is pressable because it has a page; a storefront does not, so
        it is text — a link to nowhere is #71's own bug, and typedRoutes would
        not catch it.
      */}
      {location.merchant === undefined ? null : (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Visit ${location.merchant.name}`}
          disabled={onPressMerchant === undefined}
          onPress={() => {
            if (location.merchant !== undefined) onPressMerchant?.(location.merchant.slug);
          }}
        >
          <Text className="text-caption text-text">Sold by {location.merchant.name}</Text>
        </Pressable>
      )}
      {location.storefront === undefined ? null : (
        <Text className="text-caption text-text-tertiary">
          Channel: {location.storefront.name}
        </Text>
      )}

      <Text className="text-caption text-text-tertiary">
        {PICKUP_PAYMENT_REQUIREMENT_TEXT[location.paymentRequirement]}{" "}
        {PICKUP_IDENTITY_REQUIREMENT_TEXT[location.identityRequirement]}
      </Text>

      {location.pickupInstructions === undefined ? null : (
        <Text className="text-caption text-text-secondary">{location.pickupInstructions}</Text>
      )}

      {/*
        The action, and the three states it has. `undefined` eligibility is a
        BROWSE — the caller did not ask whether this actor may check out — and
        renders no control at all rather than an optimistic one.
      */}
      {blockCopy === undefined ? null : (
        <View className="gap-space-8">
          <Text className="text-caption text-text-secondary" accessibilityRole="alert">
            {blockCopy.sentence}
          </Text>
          {blockCopy.offerSignIn && onSignIn !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in to collect from this shop"
              onPress={onSignIn}
              className="self-start rounded-radius-max border border-border-secondary px-space-16 py-space-8"
            >
              <Text className="text-buttonSmall text-text">Sign in</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {eligibility !== undefined && eligibility.verdict === "eligible" && onSelect !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${selectLabel} at ${location.displayName}`}
          onPress={() => onSelect(result)}
          className="self-start rounded-radius-max bg-bg-fill-inverse px-space-16 py-space-8"
        >
          <Text className="text-buttonSmall text-text-inverse">{selectLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
