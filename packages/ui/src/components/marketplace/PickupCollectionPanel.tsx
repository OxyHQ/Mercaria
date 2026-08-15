import { View } from "react-native";
import type { OrderPickup, PickupCollectionCode } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import {
  ORDER_PICKUP_STATE_EXPLANATIONS,
  ORDER_PICKUP_STATE_TEXT,
  PICKUP_IDENTITY_REQUIREMENT_TEXT,
  PICKUP_PAYMENT_REQUIREMENT_TEXT,
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
}

export function PickupCollectionPanel({ pickup, code }: PickupCollectionPanelProps) {
  const address = formatPublicAddress(pickup.address);

  return (
    <View className="gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-16">
      <Text className="text-sectionTitle text-text" accessibilityRole="header">
        Collection
      </Text>

      <View className="gap-space-4">
        <View
          className="self-start rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
          accessibilityRole="text"
        >
          <Text className="text-captionBold text-text">{ORDER_PICKUP_STATE_TEXT[pickup.state]}</Text>
        </View>
        <Text className="text-caption text-text-secondary">
          {ORDER_PICKUP_STATE_EXPLANATIONS[pickup.state]}
        </Text>
      </View>

      <View className="gap-space-4">
        <Text className="text-bodyTitleSmall text-text">{pickup.displayName}</Text>
        {address.length > 0 ? (
          <Text className="text-caption text-text-secondary">{address}</Text>
        ) : null}
      </View>

      {pickup.pickupInstructions === undefined ? null : (
        <Text className="text-caption text-text-secondary">{pickup.pickupInstructions}</Text>
      )}

      <Text className="text-caption text-text-tertiary">
        {PICKUP_PAYMENT_REQUIREMENT_TEXT[pickup.paymentRequirement]}{" "}
        {PICKUP_IDENTITY_REQUIREMENT_TEXT[pickup.identityRequirement]}
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
          <Text className="text-caption text-text-secondary">Your collection code</Text>
          <Text
            className="text-header text-text web:select-text"
            accessibilityLabel={`Collection code ${code.code.split("").join(" ")}`}
          >
            {code.code}
          </Text>
          <Text className="text-caption text-text-tertiary">
            Show this at the counter. If it stops working the shop can issue a new one — an older
            code never keeps working alongside it.
          </Text>
        </View>
      )}
    </View>
  );
}
