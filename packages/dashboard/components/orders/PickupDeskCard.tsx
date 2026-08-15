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

/** What each trail entry says, in the vocabulary of a counter. */
const EVENT_TEXT: Record<PickupCollectionEventKind, string> = {
  code_validated: "Code accepted",
  code_rejected: "Code rejected",
  collected: "Handed over",
  collection_refused: "Handover refused",
  code_rotated: "Code rotated",
  code_revoked: "Code revoked",
  marked_ready: "Marked ready",
  pickup_cancelled: "Collection cancelled",
  fallback_override: "Handed over with an override",
};

export function PickupDeskCard({ storeId, orderId }: { storeId: string; orderId: string }) {
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
      <Text className="text-base font-semibold text-foreground">Collection</Text>

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
              onPress={() => run({ kind: "ready" }, "Marked ready to collect")}
            >
              <Text className="text-sm font-semibold text-primary-foreground">
                Mark ready to collect
              </Text>
            </Button>
          ) : null}

          <View className="gap-1.5">
            <Label nativeID="pickup-code">Code the customer presented</Label>
            <Input
              aria-labelledby="pickup-code"
              accessibilityLabel="Collection code the customer presented"
              value={code}
              onChangeText={setCode}
              placeholder="ABCD234567"
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Button
              variant="outline"
              disabled={act.isPending || code.trim().length === 0}
              onPress={() =>
                run({ kind: "collect", code: code.trim() }, "Collection recorded")
              }
            >
              <Text className="text-sm font-medium text-foreground">Check code and hand over</Text>
            </Button>
          </View>

          {/*
            The audited fallback (#93 verification rule 7). A reason is
            MANDATORY and the control refuses without one — the record of who
            waved a handover through is the whole of what makes this safe rather
            than a way around verification.
          */}
          <View className="gap-1.5">
            <Label nativeID="pickup-override">Hand over without a working code — reason</Label>
            <Input
              aria-labelledby="pickup-override"
              accessibilityLabel="Reason for handing over without a working code"
              value={overrideReason}
              onChangeText={setOverrideReason}
              placeholder="Code would not scan; ID checked in person"
            />
            <Button
              variant="outline"
              disabled={act.isPending || overrideReason.trim().length === 0}
              onPress={() =>
                run(
                  { kind: "collect", overrideReason: overrideReason.trim() },
                  "Collection recorded with an override",
                )
              }
            >
              <Text className="text-sm font-medium text-foreground">Hand over with override</Text>
            </Button>
            <Text className="text-xs text-muted-foreground">
              Recorded against your account, with the reason, in the trail below.
            </Text>
          </View>

          <View className="gap-1.5">
            <Label nativeID="pickup-rotate">Issue a new code — reason</Label>
            <Input
              aria-labelledby="pickup-rotate"
              accessibilityLabel="Reason for issuing a new collection code"
              value={rotateReason}
              onChangeText={setRotateReason}
              placeholder="Customer says the code leaked"
            />
            <Button
              variant="outline"
              disabled={rotate.isPending || rotateReason.trim().length === 0}
              onPress={() =>
                rotate.mutate(rotateReason.trim(), {
                  onSuccess: (issued) => {
                    setRotatedCode(issued.code);
                    toast.success("New code issued");
                  },
                  onError: (error: Error) => toast.error(error.message),
                })
              }
            >
              <Text className="text-sm font-medium text-foreground">Issue a new code</Text>
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
                  Read this to the customer. The previous code no longer works.
                </Text>
                <Text className="text-lg font-semibold text-foreground web:select-text">
                  {rotatedCode}
                </Text>
              </View>
            )}
          </View>

          <View className="gap-1.5">
            <Label nativeID="pickup-cancel">Cancel this collection — reason</Label>
            <Input
              aria-labelledby="pickup-cancel"
              accessibilityLabel="Reason for cancelling this collection"
              value={cancelReason}
              onChangeText={setCancelReason}
              placeholder="Stock damaged in the stockroom"
            />
            <Button
              variant="outline"
              disabled={act.isPending || cancelReason.trim().length === 0}
              onPress={() =>
                run({ kind: "cancel", reason: cancelReason.trim() }, "Collection cancelled")
              }
            >
              <Text className="text-sm font-medium text-foreground">Cancel collection</Text>
            </Button>
            <Text className="text-xs text-muted-foreground">
              This withdraws the handover and revokes the code. It does not cancel the order and it
              refunds nothing — do that on the order itself if the customer is owed money.
            </Text>
          </View>
        </View>
      )}

      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">Collection trail</Text>
        {events.length === 0 ? (
          <Text className="text-xs text-muted-foreground">Nothing has happened at the counter yet.</Text>
        ) : (
          events.map((event) => (
            <Text key={event.id} className="text-xs text-muted-foreground">
              {new Date(event.occurredAt).toLocaleString()} · {EVENT_TEXT[event.kind]}
              {event.reason === undefined ? "" : ` · ${event.reason}`}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}
