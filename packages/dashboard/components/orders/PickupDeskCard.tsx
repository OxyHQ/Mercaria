import React, { useState } from "react";
import { View } from "react-native";
import type { PickupCollectionEventKind } from "@mercaria/shared-types";
import {
  Button,
  Input,
  Label,
  ORDER_PICKUP_STATE_EXPLANATIONS,
  ORDER_PICKUP_STATE_TEXT,
  PICKUP_IDENTITY_REQUIREMENT_TEXT,
  Text,
  formatPublicAddress,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import {
  useOrderPickup,
  usePickupDeskAction,
  useRotateCollectionCode,
} from "@/lib/hooks/use-orders";
import { useTranslation } from "@/lib/i18n";

/**
 * The collection desk — one order, at one counter (#93 merchant rules 1-4 and
 * 10, acceptance 11).
 *
 * ## The desk moves no money and no stock, and neither does this screen
 *
 * The units were committed when the order was PAID (`docs/pickup.md` §10), so
 * marking a collection collected is a HANDOVER record and nothing else.
 * Cancelling a collection withdraws the handover and revokes the code; it does
 * not cancel the order and it refunds nothing — the copy says so outright,
 * because a member of staff pressing "cancel collection" and assuming a refund
 * happened is how a customer is told their money is coming back when nobody
 * sent it.
 *
 * ## Staff never see the buyer's code
 *
 * There is no route that returns one, and so there is no field here to render.
 * A desk verifies a code by having it PRESENTED and typed into the box below;
 * the server re-derives and compares. Rotation is the one action that yields a
 * code, and it yields the NEW one, because the shop is the party that has to
 * tell the customer it changed.
 *
 * ## Nothing here identifies the buyer beyond the order
 *
 * #93 merchant rule 2 and acceptance 11: no guest session id, no portal
 * credential, no email, no buyer-origin word. `OrderPickup` carries none of
 * them — the snapshot is the PLACE, not the person — so this is a property of
 * the type rather than a filter somebody applied. A guest's order and an
 * account holder's render identically, which is #93 merchant rule 8.
 */

/**
 * What each trail entry says, in the vocabulary of a counter — as translation
 * KEYS, not sentences (#398). Module scope is evaluated at import, before the
 * locale store has rehydrated, so a resolved sentence here would freeze whatever
 * language loaded first; the trail calls `t(EVENT_TEXT_KEYS[kind])`.
 */
const EVENT_TEXT_KEYS: Record<PickupCollectionEventKind, string> = {
  code_validated: "orders.pickup.event.codeValidated",
  code_rejected: "orders.pickup.event.codeRejected",
  collected: "orders.pickup.event.collected",
  collection_refused: "orders.pickup.event.collectionRefused",
  code_rotated: "orders.pickup.event.codeRotated",
  code_revoked: "orders.pickup.event.codeRevoked",
  marked_ready: "orders.pickup.event.markedReady",
  pickup_cancelled: "orders.pickup.event.pickupCancelled",
  fallback_override: "orders.pickup.event.fallbackOverride",
};

export function PickupDeskCard({ storeId, orderId }: { storeId: string; orderId: string }) {
  const { t } = useTranslation();
  const desk = useOrderPickup(storeId, orderId);
  const act = usePickupDeskAction(storeId, orderId);
  const rotate = useRotateCollectionCode(storeId, orderId);

  const [code, setCode] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [rotateReason, setRotateReason] = useState("");
  /** The NEW code, shown once after a rotation so staff can read it out. */
  const [rotatedCode, setRotatedCode] = useState<string | null>(null);

  // A 404 is the ordinary answer for a delivery order. Rendering nothing is
  // right; an error box would tell every merchant that something is broken
  // about the majority of their orders.
  if (desk.data === undefined) return null;

  const { pickup, events } = desk.data;
  const settled = pickup.state === "collected" || pickup.state === "pickup_cancelled";
  const address = formatPublicAddress(pickup.address);

  const run = (action: Parameters<typeof act.mutate>[0], success: string) =>
    act.mutate(action, {
      onSuccess: () => toast.success(success),
      onError: (error: Error) => toast.error(error.message),
    });

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="text-base font-semibold text-foreground">{t("orders.pickup.title")}</Text>

      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">
          {ORDER_PICKUP_STATE_TEXT[pickup.state]}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {ORDER_PICKUP_STATE_EXPLANATIONS[pickup.state]}
        </Text>
      </View>

      <View className="gap-0.5">
        <Text className="text-sm text-foreground">{pickup.displayName}</Text>
        {address.length > 0 ? (
          <Text className="text-xs text-muted-foreground">{address}</Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">
          {PICKUP_IDENTITY_REQUIREMENT_TEXT[pickup.identityRequirement]}
        </Text>
      </View>

      {settled ? null : (
        <View className="gap-3">
          {pickup.state === "awaiting_preparation" ? (
            <Button
              disabled={act.isPending}
              onPress={() => run({ kind: "ready" }, t("orders.pickup.toast.markedReady"))}
            >
              <Text className="text-sm font-semibold text-primary-foreground">
                {t("orders.pickup.markReady")}
              </Text>
            </Button>
          ) : null}

          <View className="gap-1.5">
            <Label nativeID="pickup-code">{t("orders.pickup.codeLabel")}</Label>
            <Input
              aria-labelledby="pickup-code"
              accessibilityLabel={t("orders.pickup.codeAccessibilityLabel")}
              value={code}
              onChangeText={setCode}
              placeholder={t("orders.pickup.codePlaceholder")}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Button
              variant="outline"
              disabled={act.isPending || code.trim().length === 0}
              onPress={() =>
                run({ kind: "collect", code: code.trim() }, t("orders.pickup.toast.collected"))
              }
            >
              <Text className="text-sm font-medium text-foreground">
                {t("orders.pickup.checkCodeAndHandOver")}
              </Text>
            </Button>
          </View>

          {/*
            The audited fallback (#93 verification rule 7). A reason is
            MANDATORY and the control refuses without one — the record of who
            waved a handover through is the whole of what makes this safe rather
            than a way around verification.
          */}
          <View className="gap-1.5">
            <Label nativeID="pickup-override">{t("orders.pickup.overrideLabel")}</Label>
            <Input
              aria-labelledby="pickup-override"
              accessibilityLabel={t("orders.pickup.overrideAccessibilityLabel")}
              value={overrideReason}
              onChangeText={setOverrideReason}
              placeholder={t("orders.pickup.overridePlaceholder")}
            />
            <Button
              variant="outline"
              disabled={act.isPending || overrideReason.trim().length === 0}
              onPress={() =>
                run(
                  { kind: "collect", overrideReason: overrideReason.trim() },
                  t("orders.pickup.toast.collectedWithOverride"),
                )
              }
            >
              <Text className="text-sm font-medium text-foreground">
                {t("orders.pickup.handOverWithOverride")}
              </Text>
            </Button>
            <Text className="text-xs text-muted-foreground">
              {t("orders.pickup.overrideNote")}
            </Text>
          </View>

          <View className="gap-1.5">
            <Label nativeID="pickup-rotate">{t("orders.pickup.rotateLabel")}</Label>
            <Input
              aria-labelledby="pickup-rotate"
              accessibilityLabel={t("orders.pickup.rotateAccessibilityLabel")}
              value={rotateReason}
              onChangeText={setRotateReason}
              placeholder={t("orders.pickup.rotatePlaceholder")}
            />
            <Button
              variant="outline"
              disabled={rotate.isPending || rotateReason.trim().length === 0}
              onPress={() =>
                rotate.mutate(rotateReason.trim(), {
                  onSuccess: (issued) => {
                    setRotatedCode(issued.code);
                    toast.success(t("orders.pickup.toast.codeIssued"));
                  },
                  onError: (error: Error) => toast.error(error.message),
                })
              }
            >
              <Text className="text-sm font-medium text-foreground">
                {t("orders.pickup.rotate")}
              </Text>
            </Button>
            {/*
              Shown ONCE, right here, because the shop has to read it to the
              customer. Every previous copy stopped working the moment it was
              issued — there is no grace window — so leaving the old one in
              circulation is not a risk this creates.
            */}
            {rotatedCode === null ? null : (
              <View className="gap-0.5 rounded-xl bg-muted p-3">
                <Text className="text-xs text-muted-foreground">
                  {t("orders.pickup.rotatedCodeNote")}
                </Text>
                <Text className="text-lg font-semibold text-foreground web:select-text">
                  {rotatedCode}
                </Text>
              </View>
            )}
          </View>

          <View className="gap-1.5">
            <Label nativeID="pickup-cancel">{t("orders.pickup.cancelLabel")}</Label>
            <Input
              aria-labelledby="pickup-cancel"
              accessibilityLabel={t("orders.pickup.cancelAccessibilityLabel")}
              value={cancelReason}
              onChangeText={setCancelReason}
              placeholder={t("orders.pickup.cancelPlaceholder")}
            />
            <Button
              variant="outline"
              disabled={act.isPending || cancelReason.trim().length === 0}
              onPress={() =>
                run(
                  { kind: "cancel", reason: cancelReason.trim() },
                  t("orders.pickup.toast.cancelled"),
                )
              }
            >
              <Text className="text-sm font-medium text-foreground">
                {t("orders.pickup.cancelCollection")}
              </Text>
            </Button>
            <Text className="text-xs text-muted-foreground">
              {t("orders.pickup.cancelNote")}
            </Text>
          </View>
        </View>
      )}

      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">{t("orders.pickup.trail")}</Text>
        {events.length === 0 ? (
          <Text className="text-xs text-muted-foreground">{t("orders.pickup.trailEmpty")}</Text>
        ) : (
          events.map((event) => (
            <Text key={event.id} className="text-xs text-muted-foreground">
              {new Date(event.occurredAt).toLocaleString()} · {t(EVENT_TEXT_KEYS[event.kind])}
              {event.reason === undefined ? "" : ` · ${event.reason}`}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}
