import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  PICKUP_PANEL_CODE_A11Y_KEY,
  PICKUP_PANEL_CODE_HEADING_KEY,
  PICKUP_PANEL_CODE_NOTE_KEY,
  PICKUP_PANEL_HEADING_KEY,
} from "../../lib/marketplace-labels";
import { Pressable, View } from "react-native";
import type { OrderPickup, PickupCollectionCode } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import {
  GOWAY_PLACE_LINK_A11Y_KEY,
  GOWAY_PLACE_LINK_KEY,
  ORDER_PICKUP_STATE_EXPLANATION_KEYS,
  ORDER_PICKUP_STATE_KEYS,
  PICKUP_IDENTITY_REQUIREMENT_KEYS,
  PICKUP_PAYMENT_REQUIREMENT_KEYS,
  formatPublicAddress,
} from "../../lib/pickup-labels";

/**
 * The collection an order carries, and the code that opens the shutter
 * (#93 client rule 13).
 *
 * ## This component is the "authorized order surface"
 *
 * The code is rendered HERE and nowhere else. It is fetched by a separate call
 * against a separately authorized route — never a field of the order DTO —
 * because an order DTO is logged, cached and forwarded into support tooling,
 * and a code carried inside one would follow it into all three. Both callers
 * (the buyer's own order detail, and #108's guest portal) reach the SAME server
 * handler, which is #93 verification rule 9: guest and authenticated buyers use
 * one collection mechanism.
 *
 * ## An absent code is three different facts and none of them is an error
 *
 * A location asking for `order_number_only` issues none; a cancelled collection
 * has none; a deployment with no signing key configured can derive none. The
 * panel renders the instruction line in every case and simply has no code block
 * — a present-but-empty code field is the shape that renders as a blank box a
 * shopper stands at a counter holding.
 *
 * ## Nothing here is a payment or a status word
 *
 * `OrderPickupState` is kept entirely apart from the order's status and the
 * payment's (#93 pickup rule 12). A cancelled COLLECTION has not refunded
 * anything and does not say it has — `docs/pickup.md` §10 — so the explanation
 * for that state says outright that money is handled separately, rather than
 * leaving a shopper to infer a refund that nobody made.
 */

export interface PickupCollectionPanelProps {
  pickup: OrderPickup;
  /** Absent for the three legitimate reasons in the doc block above. */
  code?: PickupCollectionCode;
  /**
   * Open the collection point's GoWay place. No link renders without it, nor
   * for a collection placed before the snapshot recorded its place.
   */
  onPressPlace?: (goWayPlaceId: string) => void;
}

export function PickupCollectionPanel({ pickup, code, onPressPlace }: PickupCollectionPanelProps) {
  const t = useSharedUiTranslation();
  const address = formatPublicAddress(pickup.address);

  return (
    <View className="gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-16">
      <Text className="text-shop-sectionTitle text-text" accessibilityRole="header">
        {t(PICKUP_PANEL_HEADING_KEY)}
      </Text>

      <View className="gap-space-4">
        <View
          className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
          accessibilityRole="text"
        >
          <Text className="text-shop-captionBold text-text">{t(ORDER_PICKUP_STATE_KEYS[pickup.state])}</Text>
        </View>
        <Text className="text-shop-caption text-text-secondary">
          {t(ORDER_PICKUP_STATE_EXPLANATION_KEYS[pickup.state])}
        </Text>
      </View>

      <View className="gap-space-4">
        <Text className="text-shop-bodyTitleSmall text-text">{pickup.displayName}</Text>
        {address.length > 0 ? (
          <Text className="text-shop-caption text-text-secondary">{address}</Text>
        ) : null}
        {pickup.goWayPlaceId === undefined || onPressPlace === undefined ? null : (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t(GOWAY_PLACE_LINK_A11Y_KEY, { place: pickup.displayName })}
            onPress={() => {
              if (pickup.goWayPlaceId !== undefined) onPressPlace(pickup.goWayPlaceId);
            }}
            className="self-start"
          >
            <Text className="text-shop-captionBold text-text">{t(GOWAY_PLACE_LINK_KEY)}</Text>
          </Pressable>
        )}
      </View>

      {pickup.pickupInstructions === undefined ? null : (
        <Text className="text-shop-caption text-text-secondary">{pickup.pickupInstructions}</Text>
      )}

      <Text className="text-shop-caption text-text-tertiary">
        {t(PICKUP_PAYMENT_REQUIREMENT_KEYS[pickup.paymentRequirement])}{" "}
        {t(PICKUP_IDENTITY_REQUIREMENT_KEYS[pickup.identityRequirement])}
      </Text>

      {/*
        The code itself. Rendered as TEXT and selectable, deliberately not as an
        image: a QR needs a generator dependency in every app that shows one,
        and the alphabet was already chosen to be read off a phone screen and
        spoken aloud (`I`, `L`, `O` and `U` are removed). A shopper with a
        cracked screen or a screen reader can still complete a handover.
      */}
      {code === undefined ? null : (
        <View className="gap-space-4 rounded-radius-12 bg-bg-fill-secondary p-space-12">
          <Text className="text-shop-caption text-text-secondary">
            {t(PICKUP_PANEL_CODE_HEADING_KEY)}
          </Text>
          <Text
            className="text-shop-header text-text web:select-text"
            accessibilityLabel={t(PICKUP_PANEL_CODE_A11Y_KEY, {
              code: code.code.split("").join(" "),
            })}
          >
            {code.code}
          </Text>
          <Text className="text-shop-caption text-text-tertiary">
            {t(PICKUP_PANEL_CODE_NOTE_KEY)}
          </Text>
        </View>
      )}
    </View>
  );
}
