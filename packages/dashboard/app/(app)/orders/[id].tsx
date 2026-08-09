import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import type { MerchantOrder, OrderItem, Refund, RefundProviderState } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  PriceDisplay,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { OrderStatusBadge } from "@/components/orders/OrderStatusBadge";
import {
  useOrder,
  usePatchOrderStatus,
  useCreateRefund,
  useOrderRefunds,
} from "@/lib/hooks/use-orders";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import type { FulfillmentStatus } from "@/lib/api/orders";

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Head>
        <title>Order | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <OrderDetailBody storeId={storeId} orderId={String(id)} />}
      </RequireStore>
    </>
  );
}

function OrderDetailBody({ storeId, orderId }: { storeId: string; orderId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data, isPending, isError } = useOrder(storeId, orderId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title="Order" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title="Order" action={back}>
        <ScreenMessage title="Couldn't load order" body="Please try again." />
      </Screen>
    );
  }

  return (
    <Screen title={data.orderNumber} subtitle="Order detail" action={back}>
      <OrderContent storeId={storeId} order={data} />
    </Screen>
  );
}

function OrderContent({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  return (
    <View className="gap-5">
      <View className="flex-row items-center justify-between">
        <OrderStatusBadge status={order.status} />
        <Text className="text-xs text-muted-foreground">
          {new Date(order.createdAt).toLocaleString()}
        </Text>
      </View>

      <ItemsCard items={order.items} />
      <TotalsCard order={order} />
      <ShippingAddressCard order={order} />
      <StatusHistoryCard order={order} />
      <RefundsCard storeId={storeId} order={order} />
      <FulfillmentCard storeId={storeId} order={order} />
    </View>
  );
}

function ItemsCard({ items }: { items: OrderItem[] }) {
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Items</Text>
      <View className="gap-3">
        {items.map((item, idx) => (
          <View key={`${item.variantId}-${idx}`} className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {item.variantTitle} · ×{item.quantity}
              </Text>
            </View>
            <PriceDisplay price={item.lineTotal.shop} primaryClassName="text-sm font-semibold" />
          </View>
        ))}
      </View>
    </View>
  );
}

function TotalRow({ label, amount, bold }: { label: string; amount: React.ReactNode; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className={bold ? "text-sm font-semibold text-foreground" : "text-sm text-muted-foreground"}>
        {label}
      </Text>
      {amount}
    </View>
  );
}

function TotalsCard({ order }: { order: MerchantOrder }) {
  const { totals } = order;
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Totals</Text>
      <View className="gap-2">
        <TotalRow label="Subtotal" amount={<PriceDisplay price={totals.subtotal.shop} primaryClassName="text-sm" />} />
        {totals.discountTotal.shop.amount > 0 ? (
          <TotalRow
            label="Discounts"
            amount={<PriceDisplay price={totals.discountTotal.shop} primaryClassName="text-sm text-destructive" />}
          />
        ) : null}
        <TotalRow label="Tax" amount={<PriceDisplay price={totals.tax.shop} primaryClassName="text-sm" />} />
        <TotalRow label="Shipping" amount={<PriceDisplay price={totals.shipping.shop} primaryClassName="text-sm" />} />
        <View className="my-1 h-px bg-border" />
        <TotalRow
          label="Total"
          bold
          amount={<PriceDisplay price={totals.grandTotal.shop} primaryClassName="text-base font-bold" />}
        />
      </View>
    </View>
  );
}

function ShippingAddressCard({ order }: { order: MerchantOrder }) {
  const a = order.shippingAddress;
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">Ship to</Text>
      <Text className="text-sm text-foreground">{a.recipientName}</Text>
      <Text className="text-sm text-muted-foreground">{a.line1}</Text>
      {a.line2 ? <Text className="text-sm text-muted-foreground">{a.line2}</Text> : null}
      <Text className="text-sm text-muted-foreground">
        {a.city}
        {a.region ? `, ${a.region}` : ""} {a.postalCode}
      </Text>
      <Text className="text-sm text-muted-foreground">{a.country}</Text>
    </View>
  );
}

function StatusHistoryCard({ order }: { order: MerchantOrder }) {
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">History</Text>
      <View className="gap-2">
        {order.statusHistory.map((event, idx) => (
          <View key={`${event.status}-${idx}`} className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <OrderStatusBadge status={event.status} />
              {event.note ? (
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {event.note}
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-muted-foreground">
              {new Date(event.at).toLocaleDateString()}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Chip presentation per MONEY state: the pill's background and its label's colour.
 *
 * Keyed on `RefundProviderState` and deliberately NOT on `Refund.status`: that
 * one is the commerce lifecycle and already reads `refunded` the instant
 * Mercaria commits the record, before a cent has left the rail. Only
 * `providerState` answers what an operator on this screen is actually asking —
 * has the buyer got the money back yet.
 */
const REFUND_STATE_CHIPS: Record<
  RefundProviderState,
  { label: string; bg: string; text: string }
> = {
  // Approved and moving, but NOT yet in the buyer's hands — muted, not a success tone.
  pending: { label: "On its way", bg: "bg-muted", text: "text-muted-foreground" },
  succeeded: { label: "Completed", bg: "bg-primary/10", text: "text-primary" },
  failed: { label: "Failed", bg: "bg-destructive/10", text: "text-destructive" },
  canceled: { label: "Canceled", bg: "bg-muted", text: "text-muted-foreground" },
};

function RefundsCard({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  // No extra `can("orders:read")` gate: the whole screen already sits behind
  // `RequireStore permission="orders:read"`, which is exactly what the GET
  // endpoint enforces, so a second check here could only ever agree with it.
  const { data } = useOrderRefunds(storeId, order.id);

  // Most orders are never refunded, so an always-mounted empty card would be
  // noise on every order detail — the card appears only once there is history.
  if (!data || data.length === 0) {
    return null;
  }

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Refunds</Text>
      <View className="gap-3">
        {data.map((refund) => (
          <RefundRow key={refund.id} refund={refund} />
        ))}
      </View>
    </View>
  );
}

function RefundRow({ refund }: { refund: Refund }) {
  // A refund with no `provider` had no rail operation at all — cash handed back
  // at a register, or an order captured on Shopify/WooCommerce and refunded
  // there. That absence is a fact about the payment, not a gap in the record,
  // so it gets no chip rather than an "unknown" one.
  const state = refund.provider ? refund.providerState : undefined;
  const chip = state ? REFUND_STATE_CHIPS[state] : undefined;

  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {refund.rmaNumber ?? "Refund"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {new Date(refund.createdAt).toLocaleDateString()}
          </Text>
        </View>
        <PriceDisplay price={refund.totalRefunded.shop} primaryClassName="text-sm font-semibold" />
        {chip ? (
          <View className={`rounded-full px-2 py-1 ${chip.bg}`}>
            <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
          </View>
        ) : null}
      </View>
      {/* The rail's own code, shown verbatim apart from the underscores: it is a
          merchant-safe machine code, and inventing prose around it would put
          words in the provider's mouth about why the money did not move. */}
      {state === "failed" && refund.providerFailureCode ? (
        <Text className="text-xs text-destructive">
          {refund.providerFailureCode.replace(/_/g, " ")}
        </Text>
      ) : null}
    </View>
  );
}

const NEXT_STATUSES: { key: FulfillmentStatus; label: string }[] = [
  { key: "processing", label: "Processing" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancel" },
];

function FulfillmentCard({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  const { can } = useActiveStoreContext();
  const patch = usePatchOrderStatus(storeId, order.id);
  const [tracking, setTracking] = useState(order.shipping.trackingNumber ?? "");
  const [refundOpen, setRefundOpen] = useState(false);

  const canFulfil = can("orders:fulfill");
  const canRefund = can("refunds:write");

  const transition = (status: FulfillmentStatus) => {
    patch.mutate(
      { status, ...(status === "shipped" && tracking.trim() ? { trackingNumber: tracking.trim() } : {}) },
      {
        onSuccess: () => toast.success(`Order marked ${status}`),
        onError: () => toast.error("Couldn't update the order"),
      },
    );
  };

  if (!canFulfil && !canRefund) {
    return null;
  }

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Fulfilment</Text>

      {/* Shipping carrier UI is intentionally hidden (Moovo integration pending);
          only a free-text tracking number is captured on "shipped". */}
      {canFulfil ? (
        <>
          <View className="mb-3 gap-1.5">
            <Label>Tracking number (optional)</Label>
            <Input value={tracking} onChangeText={setTracking} placeholder="1Z…" />
          </View>
          <View className="flex-row flex-wrap gap-2">
            {NEXT_STATUSES.map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant={s.key === "cancelled" ? "outline" : "default"}
                onPress={() => transition(s.key)}
                isLoading={patch.isPending}
              >
                <Text
                  className={`text-sm font-medium ${
                    s.key === "cancelled" ? "text-foreground" : "text-primary-foreground"
                  }`}
                >
                  {s.label}
                </Text>
              </Button>
            ))}
          </View>
        </>
      ) : null}

      {canRefund ? (
        <Button variant="destructive" className="mt-4 self-start" size="sm" onPress={() => setRefundOpen(true)}>
          <Text className="text-sm font-semibold text-destructive-foreground">Refund</Text>
        </Button>
      ) : null}

      <RefundDialog
        storeId={storeId}
        order={order}
        open={refundOpen}
        onOpenChange={setRefundOpen}
      />
    </View>
  );
}

function RefundDialog({
  storeId,
  order,
  open,
  onOpenChange,
}: {
  storeId: string;
  order: MerchantOrder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createRefund = useCreateRefund(storeId, order.id);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");

  const submit = () => {
    const lineItems = order.items
      .map((item) => {
        const qty = Number.parseInt(quantities[item.variantId] ?? "0", 10) || 0;
        return { variantId: item.variantId, quantity: Math.min(qty, item.quantity) };
      })
      .filter((line) => line.quantity > 0);

    if (lineItems.length === 0) {
      toast.error("Enter a quantity to refund");
      return;
    }

    createRefund.mutate(
      { lineItems, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success("Refund processed");
          onOpenChange(false);
          setQuantities({});
          setReason("");
        },
        onError: () => toast.error("Couldn't process the refund"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund order</DialogTitle>
        </DialogHeader>
        <View className="gap-3">
          {order.items.map((item, idx) => (
            <View key={`${item.variantId}-${idx}`} className="flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {item.title}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {item.variantTitle} · max {item.quantity}
                </Text>
              </View>
              <View className="w-20">
                <Input
                  value={quantities[item.variantId] ?? ""}
                  onChangeText={(t) => setQuantities((prev) => ({ ...prev, [item.variantId]: t }))}
                  keyboardType="number-pad"
                  placeholder="0"
                />
              </View>
            </View>
          ))}
          <View className="gap-1.5">
            <Label>Reason (optional)</Label>
            <Input value={reason} onChangeText={setReason} placeholder="Why is this being refunded?" />
          </View>
          <Button variant="destructive" onPress={submit} isLoading={createRefund.isPending} className="mt-1">
            <Text className="font-semibold text-destructive-foreground">Process refund</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
