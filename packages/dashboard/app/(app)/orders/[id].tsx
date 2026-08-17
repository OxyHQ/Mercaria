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
  formatDate,
  formatDateTime,
  formatRegionName,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { OrderStatusBadge, ORDER_STATUS_LABEL_KEYS } from "@/components/orders/OrderStatusBadge";
import { PickupDeskCard } from "@/components/orders/PickupDeskCard";
import {
  useOrder,
  usePatchOrderStatus,
  useCreateRefund,
  useOrderRefunds,
} from "@/lib/hooks/use-orders";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { useTranslation } from "@/lib/i18n";
import type { FulfillmentStatus } from "@/lib/api/orders";

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("orders.detail.documentTitle")}</title>
      </Head>
      <RequireStore permission="orders:read">
        {(storeId) => <OrderDetailBody storeId={storeId} orderId={String(id)} />}
      </RequireStore>
    </>
  );
}

function OrderDetailBody({ storeId, orderId }: { storeId: string; orderId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { data, isPending, isError } = useOrder(storeId, orderId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title={t("orders.detail.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("orders.detail.title")} action={back}>
        <ScreenMessage title={t("orders.detail.loadFailed")} body={t("common.pleaseTryAgain")} />
      </Screen>
    );
  }

  return (
    <Screen title={data.orderNumber} subtitle={t("orders.detail.subtitle")} action={back}>
      <OrderContent storeId={storeId} order={data} />
    </Screen>
  );
}

function OrderContent({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  const { locale } = useTranslation();
  return (
    <View className="gap-5">
      <View className="flex-row items-center justify-between">
        <OrderStatusBadge status={order.status} />
        {/* The instant sits alone beside the status badge, so an unformattable
            one renders nothing rather than "Invalid Date" (#529). */}
        <Text className="text-xs text-muted-foreground">
          {formatDateTime(order.createdAt, locale)}
        </Text>
      </View>

      <ItemsCard items={order.items} />
      <TotalsCard order={order} />
      <ShippingAddressCard order={order} />
      <StatusHistoryCard order={order} />
      {/*
        The collection desk (#93). Renders only for a collection order — the
        card returns null on the 404 a delivery order answers with — and it is
        seated ABOVE fulfilment because a parcel handed across a counter was
        never shipped: the two are different fulfilment paths and the desk is
        the one that applies here.
      */}
      <PickupDeskCard storeId={storeId} orderId={order.id} />
      <RefundsCard storeId={storeId} order={order} />
      <FulfillmentCard storeId={storeId} order={order} />
    </View>
  );
}

function ItemsCard({ items }: { items: OrderItem[] }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.detail.items")}</Text>
      <View className="gap-3">
        {items.map((item, idx) => (
          <View key={`${item.variantId}-${idx}`} className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("orders.detail.itemVariantQuantity", {
                  variant: item.variantTitle,
                  quantity: item.quantity,
                })}
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
  const { t } = useTranslation();
  const { totals } = order;
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.totals.heading")}</Text>
      <View className="gap-2">
        <TotalRow
          label={t("orders.totals.subtotal")}
          amount={<PriceDisplay price={totals.subtotal.shop} primaryClassName="text-sm" />}
        />
        {totals.discountTotal.shop.amount > 0 ? (
          <TotalRow
            label={t("orders.totals.discounts")}
            amount={<PriceDisplay price={totals.discountTotal.shop} primaryClassName="text-sm text-destructive" />}
          />
        ) : null}
        <TotalRow
          label={t("orders.totals.tax")}
          amount={<PriceDisplay price={totals.tax.shop} primaryClassName="text-sm" />}
        />
        <TotalRow
          label={t("orders.totals.shipping")}
          amount={<PriceDisplay price={totals.shipping.shop} primaryClassName="text-sm" />}
        />
        <View className="my-1 h-px bg-border" />
        <TotalRow
          label={t("orders.totals.total")}
          bold
          amount={<PriceDisplay price={totals.grandTotal.shop} primaryClassName="text-base font-bold" />}
        />
      </View>
    </View>
  );
}

function ShippingAddressCard({ order }: { order: MerchantOrder }) {
  const { t, locale } = useTranslation();
  const a = order.shippingAddress;
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">{t("orders.detail.shipTo")}</Text>
      <Text className="text-sm text-foreground">{a.recipientName}</Text>
      <Text className="text-sm text-muted-foreground">{a.line1}</Text>
      {a.line2 ? <Text className="text-sm text-muted-foreground">{a.line2}</Text> : null}
      <Text className="text-sm text-muted-foreground">
        {a.city}
        {a.region ? `, ${a.region}` : ""} {a.postalCode}
      </Text>
      {/* The country is an ISO alpha-2 CODE on the wire (#560). #513 fixed
          this exact shape on the storefront; the remedy is the same import. */}
      <Text className="text-sm text-muted-foreground">{formatRegionName(a.country, locale)}</Text>
    </View>
  );
}

function StatusHistoryCard({ order }: { order: MerchantOrder }) {
  const { t, locale } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.detail.history")}</Text>
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
              {formatDate(event.at, locale)}
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
 *
 * `labelKey` is a translation KEY rather than a sentence (#398): this map is
 * evaluated at import, before the locale store has rehydrated, so a resolved
 * label would freeze whatever language loaded first.
 */
const REFUND_STATE_CHIPS: Record<
  RefundProviderState,
  { labelKey: string; bg: string; text: string }
> = {
  // Approved and moving, but NOT yet in the buyer's hands — muted, not a success tone.
  pending: { labelKey: "orders.refundState.pending", bg: "bg-muted", text: "text-muted-foreground" },
  succeeded: { labelKey: "orders.refundState.succeeded", bg: "bg-primary/10", text: "text-primary" },
  failed: { labelKey: "orders.refundState.failed", bg: "bg-destructive/10", text: "text-destructive" },
  canceled: { labelKey: "orders.refundState.canceled", bg: "bg-muted", text: "text-muted-foreground" },
};

function RefundsCard({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  const { t } = useTranslation();
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
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.detail.refunds")}</Text>
      <View className="gap-3">
        {data.map((refund) => (
          <RefundRow key={refund.id} refund={refund} />
        ))}
      </View>
    </View>
  );
}

function RefundRow({ refund }: { refund: Refund }) {
  const { t, locale } = useTranslation();
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
            {refund.rmaNumber ?? t("orders.detail.refundFallbackLabel")}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {formatDate(refund.createdAt, locale)}
          </Text>
        </View>
        <PriceDisplay price={refund.totalRefunded.shop} primaryClassName="text-sm font-semibold" />
        {chip ? (
          <View className={`rounded-full px-2 py-1 ${chip.bg}`}>
            <Text className={`text-[10px] font-semibold ${chip.text}`}>{t(chip.labelKey)}</Text>
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

/**
 * The fulfilment buttons. `labelKey` is a translation KEY, not a sentence
 * (#398) — module scope is evaluated before the locale store has rehydrated.
 *
 * The first three reuse the status badge's keys so a status reads the same word
 * everywhere; `cancelled` carries `common.cancel` because the button is the
 * ACTION "Cancel", not the status "Cancelled".
 */
const NEXT_STATUSES: { key: FulfillmentStatus; labelKey: string }[] = [
  { key: "processing", labelKey: ORDER_STATUS_LABEL_KEYS.processing },
  { key: "shipped", labelKey: ORDER_STATUS_LABEL_KEYS.shipped },
  { key: "delivered", labelKey: ORDER_STATUS_LABEL_KEYS.delivered },
  { key: "cancelled", labelKey: "common.cancel" },
];

/**
 * One whole confirmation sentence per transition, rather than interpolating the
 * status word into a shared frame: a status name declines and agrees differently
 * in most of the languages this app ships, and a frame plus a noun is exactly the
 * split rule 5 of the extraction contract forbids.
 */
const TRANSITION_TOAST_KEYS: Record<FulfillmentStatus, string> = {
  processing: "orders.detail.markedProcessing",
  shipped: "orders.detail.markedShipped",
  delivered: "orders.detail.markedDelivered",
  cancelled: "orders.detail.markedCancelled",
};

function FulfillmentCard({ storeId, order }: { storeId: string; order: MerchantOrder }) {
  const { t } = useTranslation();
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
        onSuccess: () => toast.success(t(TRANSITION_TOAST_KEYS[status])),
        onError: () => toast.error(t("orders.detail.updateFailed")),
      },
    );
  };

  if (!canFulfil && !canRefund) {
    return null;
  }

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t("orders.detail.fulfilment")}
      </Text>

      {/* Shipping carrier UI is intentionally hidden (Moovo integration pending);
          only a free-text tracking number is captured on "shipped". */}
      {canFulfil ? (
        <>
          <View className="mb-3 gap-1.5">
            <Label>{t("orders.detail.trackingLabel")}</Label>
            <Input
              value={tracking}
              onChangeText={setTracking}
              placeholder={t("orders.detail.trackingPlaceholder")}
            />
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
                  {t(s.labelKey)}
                </Text>
              </Button>
            ))}
          </View>
        </>
      ) : null}

      {canRefund ? (
        <Button variant="destructive" className="mt-4 self-start" size="sm" onPress={() => setRefundOpen(true)}>
          <Text className="text-sm font-semibold text-destructive-foreground">
            {t("orders.detail.refund")}
          </Text>
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
  const { t } = useTranslation();
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
      toast.error(t("orders.refund.quantityRequired"));
      return;
    }

    createRefund.mutate(
      { lineItems, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success(t("orders.refund.processed"));
          onOpenChange(false);
          setQuantities({});
          setReason("");
        },
        onError: () => toast.error(t("orders.refund.failed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("orders.refund.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <View className="gap-3">
          {order.items.map((item, idx) => (
            <View key={`${item.variantId}-${idx}`} className="flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {item.title}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {t("orders.refund.itemMax", {
                    variant: item.variantTitle,
                    quantity: item.quantity,
                  })}
                </Text>
              </View>
              <View className="w-20">
                <Input
                  value={quantities[item.variantId] ?? ""}
                  onChangeText={(value) =>
                    setQuantities((prev) => ({ ...prev, [item.variantId]: value }))
                  }
                  keyboardType="number-pad"
                  placeholder="0"
                />
              </View>
            </View>
          ))}
          <View className="gap-1.5">
            <Label>{t("orders.refund.reasonLabel")}</Label>
            <Input
              value={reason}
              onChangeText={setReason}
              placeholder={t("orders.refund.reasonPlaceholder")}
            />
          </View>
          <Button variant="destructive" onPress={submit} isLoading={createRefund.isPending} className="mt-1">
            <Text className="font-semibold text-destructive-foreground">
              {t("orders.refund.submit")}
            </Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
