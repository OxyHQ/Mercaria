import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Order, OrderItem, OrderStatus } from "@mercaria/shared-types";
import {
  Button,
  PriceDisplay,
  SectionHeader,
  Text,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { toast } from "@/components/sonner";
import { useOrder, useCancelOrder } from "@/lib/hooks/use-orders";

/** Order statuses from which a buyer may still cancel (mirrors the backend graph). */
const BUYER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "pending_payment",
  "paid",
  "processing",
]);

/** Friendly label per order status. */
const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "Pending payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

/** Small status chip. */
function StatusPill({ status }: { status: OrderStatus }) {
  return (
    <View className="self-start rounded-full bg-secondary px-3 py-1">
      <Text className="text-xs font-semibold text-foreground">{STATUS_LABEL[status]}</Text>
    </View>
  );
}

function ItemsCard({ items }: { items: OrderItem[] }) {
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Items</Text>
      <View className="gap-3">
        {items.map((item, idx) => (
          <View key={`${item.variantId}-${idx}`} className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {item.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {item.variantTitle} · ×{item.quantity}
              </Text>
            </View>
            <PriceDisplay price={item.lineTotal} primaryClassName="text-sm font-semibold" />
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

function TotalsCard({ order }: { order: Order }) {
  const { totals } = order;
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Totals</Text>
      <View className="gap-2">
        <TotalRow label="Subtotal" amount={<PriceDisplay price={totals.subtotal} primaryClassName="text-sm" />} />
        {totals.discountTotal.amount > 0 ? (
          <TotalRow
            label="Discounts"
            amount={<PriceDisplay price={totals.discountTotal} primaryClassName="text-sm text-destructive" />}
          />
        ) : null}
        <TotalRow label="Tax" amount={<PriceDisplay price={totals.tax} primaryClassName="text-sm" />} />
        <TotalRow label="Shipping" amount={<PriceDisplay price={totals.shipping} primaryClassName="text-sm" />} />
        <View className="my-1 h-px bg-border" />
        <TotalRow
          label="Total"
          bold
          amount={<PriceDisplay price={totals.grandTotal} primaryClassName="text-base font-bold" />}
        />
      </View>
    </View>
  );
}

function PaymentCard({ order }: { order: Order }) {
  const unpaid = order.payment.status === "unpaid";
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-1 text-sm font-semibold text-foreground">Payment</Text>
      <Text className="text-sm text-muted-foreground">
        {unpaid
          ? "Unpaid — payment is pending (Oxy Pay is not yet available)."
          : `Payment ${order.payment.status}.`}
      </Text>
    </View>
  );
}

function ShippingAddressCard({ order }: { order: Order }) {
  const a = order.shippingAddress;
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
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

function OrderDetailBody({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { data: order, isLoading, isError } = useOrder(orderId);
  const cancel = useCancelOrder();

  const onCancel = () => {
    cancel.mutate(orderId, {
      onSuccess: () => toast.success("Order cancelled"),
      onError: () => toast.error("Couldn't cancel the order"),
    });
  };

  if (isLoading && !order) {
    return (
      <View className="px-4 py-16">
        <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
        <View className="h-40 w-full rounded-3xl bg-muted" />
      </View>
    );
  }

  if (isError || !order) {
    return (
      <View className="items-center px-8 py-24">
        <Text className="text-center text-lg font-bold text-foreground">Couldn't load this order</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          Please go back and try again.
        </Text>
        <Button variant="outline" className="mt-4" onPress={() => router.replace("/orders")}>
          <Text className="text-sm font-medium text-foreground">Back to orders</Text>
        </Button>
      </View>
    );
  }

  const sellerName = order.store?.name ?? order.seller?.displayName;

  return (
    <View className="px-4">
      <SectionHeader title={`Order ${order.orderNumber}`} />
      <View className="gap-4">
        <View className="flex-row items-center justify-between">
          <StatusPill status={order.status} />
          <Text className="text-xs text-muted-foreground">
            {new Date(order.createdAt).toLocaleString()}
          </Text>
        </View>
        {sellerName ? (
          <Text className="text-sm text-muted-foreground">Sold by {sellerName}</Text>
        ) : null}

        <ItemsCard items={order.items} />
        <TotalsCard order={order} />
        <PaymentCard order={order} />
        <ShippingAddressCard order={order} />

        {BUYER_CANCELLABLE.has(order.status) ? (
          <Button
            variant="outline"
            className="self-start"
            onPress={onCancel}
            isLoading={cancel.isPending}
          >
            <Text className="text-sm font-medium text-foreground">Cancel order</Text>
          </Button>
        ) : null}
      </View>
      <View className="h-24" />
    </View>
  );
}

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Order — Mercaria</title>
      </Head>
      <OrderDetailBody orderId={String(id)} />
    </ScreenShell>
  );
}
