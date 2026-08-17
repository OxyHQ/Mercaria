import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import type {
  Order,
  OrderItem,
  OrderPaymentStatus,
  OrderStatus,
  RetailDeliveryStatement,
  RetailOrderExperience,
} from "@mercaria/shared-types";
import {
  Button,
  CommercialDisclosure,
  PickupCollectionPanel,
  PriceDisplay,
  SectionHeader,
  Text,
  commercialSellerLabel,
  retailOrderProgressExplanation,
  retailOrderProgressLabel,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { toast } from "@oxyhq/bloom/toast";
import { useOrder, useCancelOrder } from "@/lib/hooks/use-orders";
import { useOrderCollection } from "@/lib/hooks/use-nearby";
import { useTranslation } from "@/lib/i18n";

/** Order statuses from which a buyer may still cancel (mirrors the backend graph). */
const BUYER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "pending_payment",
  "paid",
  "processing",
]);

/**
 * Friendly label per order status, as translation KEYS.
 *
 * A module-scope `const` is evaluated at import, before the locale store has
 * rehydrated, so a sentence here would freeze whichever language loaded first.
 * The keys are literal so the i18n guard can see each leaf is referenced, and
 * they are resolved at the render site.
 */
const STATUS_LABEL_KEY: Record<OrderStatus, string> = {
  pending_payment: "orders.status.pendingPayment",
  paid: "orders.status.paid",
  processing: "orders.status.processing",
  shipped: "orders.status.shipped",
  delivered: "orders.status.delivered",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
  partially_refunded: "orders.status.partiallyRefunded",
};

/**
 * What the payment line says, per payment state, as translation KEYS.
 *
 * One whole sentence per state rather than a status word interpolated into
 * `Payment %{status}.`: the states are a machine vocabulary
 * (`OrderPaymentStatus`), so interpolating one put an untranslated
 * `authorized` on the screen in every language.
 */
const PAYMENT_STATUS_KEY: Record<OrderPaymentStatus, string> = {
  unpaid: "orders.payment.unpaid",
  authorized: "orders.payment.authorized",
  paid: "orders.payment.paid",
  refunded: "orders.payment.refunded",
  failed: "orders.payment.failed",
};

/**
 * One delivery window, or the honest absence of one.
 *
 * A window with only one end is rendered with only that end. #126 stores the
 * two bounds separately because a source may publish one, and filling the other
 * in — with the same date, with "or later", with anything — would be Mercaria
 * inventing half a promise.
 */
function DeliveryLine({ label, statement }: { label: string; statement: RetailDeliveryStatement }) {
  const { t } = useTranslation();
  const earliest = statement.earliestAt ? new Date(statement.earliestAt).toLocaleDateString() : null;
  const latest = statement.latestAt ? new Date(statement.latestAt).toLocaleDateString() : null;
  const window =
    earliest && latest
      ? `${earliest} – ${latest}`
      : (earliest ?? latest ?? t("orders.delivery.noDates"));
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      <Text className="text-sm text-foreground">{window}</Text>
      <Text className="text-xs text-muted-foreground">
        {statement.basis === "guaranteed"
          ? t("orders.delivery.basisGuaranteed")
          : t("orders.delivery.basisEstimate")}
        {statement.stale ? ` ${t("orders.delivery.staleNote")}` : ""}
      </Text>
    </View>
  );
}

/**
 * Where a Mercaria-retail order has got to, and when it is expected (#129 order
 * rule 4, ADR 0004 D9.1, #126 rule 9).
 *
 * The two delivery statements are rendered SEPARATELY and neither substitutes
 * for the other. An absent `currentDelivery` means nothing has been observed
 * since checkout — it does not mean the accepted window still holds, and
 * showing the accepted one under a "current estimate" heading would be the
 * silent rewrite #126 built an append-only trail to prevent.
 */
function RetailProgressCard({ retail }: { retail: RetailOrderExperience }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text
        className="text-sm font-semibold text-foreground"
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
      >
        {retailOrderProgressLabel(retail.stage)}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {retailOrderProgressExplanation(retail.stage)}
      </Text>
      {retail.acceptedDelivery ? (
        <DeliveryLine
          label={t("orders.delivery.promisedLabel")}
          statement={retail.acceptedDelivery}
        />
      ) : null}
      {retail.currentDelivery ? (
        <DeliveryLine
          label={t("orders.delivery.latestLabel")}
          statement={retail.currentDelivery}
        />
      ) : null}
      {retail.refreshFailing ? (
        // A third fact, beside both windows. Without it a buyer would read the
        // newest observed estimate as current when its refresh has been failing.
        <Text accessibilityRole="alert" className="text-xs text-muted-foreground">
          {t("orders.delivery.refreshFailing")}
        </Text>
      ) : null}
    </View>
  );
}

/** Small status chip. */
function StatusPill({ status }: { status: OrderStatus }) {
  const { t } = useTranslation();
  return (
    <View className="self-start rounded-full bg-secondary px-3 py-1">
      <Text className="text-xs font-semibold text-foreground">{t(STATUS_LABEL_KEY[status])}</Text>
    </View>
  );
}

function ItemsCard({ items }: { items: OrderItem[] }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.items.title")}</Text>
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
            <PriceDisplay price={item.lineTotal.presentment} primaryClassName="text-sm font-semibold" />
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
  const { t } = useTranslation();
  const { totals } = order;
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{t("orders.totals.title")}</Text>
      <View className="gap-2">
        <TotalRow label={t("orders.totals.subtotal")} amount={<PriceDisplay price={totals.subtotal.presentment} primaryClassName="text-sm" />} />
        {totals.discountTotal.presentment.amount > 0 ? (
          <TotalRow
            label={t("orders.totals.discounts")}
            amount={<PriceDisplay price={totals.discountTotal.presentment} primaryClassName="text-sm text-destructive" />}
          />
        ) : null}
        <TotalRow label={t("orders.totals.tax")} amount={<PriceDisplay price={totals.tax.presentment} primaryClassName="text-sm" />} />
        <TotalRow label={t("orders.totals.shipping")} amount={<PriceDisplay price={totals.shipping.presentment} primaryClassName="text-sm" />} />
        <View className="my-1 h-px bg-border" />
        <TotalRow
          label={t("orders.totals.total")}
          bold
          amount={<PriceDisplay price={totals.grandTotal.presentment} primaryClassName="text-base font-bold" />}
        />
      </View>
    </View>
  );
}

function PaymentCard({ order }: { order: Order }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-1 text-sm font-semibold text-foreground">{t("orders.payment.title")}</Text>
      <Text className="text-sm text-muted-foreground">
        {t(PAYMENT_STATUS_KEY[order.payment.status])}
      </Text>
    </View>
  );
}

function ShippingAddressCard({ order }: { order: Order }) {
  const { t } = useTranslation();
  const a = order.shippingAddress;
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">{t("orders.shipTo.title")}</Text>
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
  const { t } = useTranslation();
  const router = useRouter();
  const { data: order, isLoading, isError } = useOrder(orderId);
  const cancel = useCancelOrder();
  /**
   * The collection, when this order has one.
   *
   * A separate query on purpose — see `useOrderCollection`. A 404 here is the
   * ordinary answer for a delivered order rather than an error worth showing,
   * so the panel simply does not render and nothing apologises for the absence
   * of a thing the buyer never asked for.
   */
  const collection = useOrderCollection(orderId);

  const onCancel = () => {
    cancel.mutate(orderId, {
      onSuccess: () => toast.success(t("orders.cancel.success")),
      onError: () => toast.error(t("orders.cancel.error")),
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
        <Text className="text-center text-lg font-bold text-foreground">
          {t("orders.detail.errorTitle")}
        </Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          {t("orders.detail.errorSubtitle")}
        </Text>
        <Button variant="outline" className="mt-4" onPress={() => router.replace("/orders")}>
          <Text className="text-sm font-medium text-foreground">
            {t("orders.detail.backToOrders")}
          </Text>
        </Button>
      </View>
    );
  }

  // #129 order rules 1 and 2: the seller comes from the order's own commercial
  // presentation, which #123 stored with the order. A `platform` order has
  // neither `store` nor `seller` by construction, so the old coalesce rendered
  // nothing at all for exactly the sales Mercaria makes itself.
  const sellerName = commercialSellerLabel(order.commercial);

  return (
    <View className="px-4">
      <SectionHeader title={t("orders.detail.title", { number: order.orderNumber })} />
      <View className="gap-4">
        <View className="flex-row items-center justify-between">
          <StatusPill status={order.status} />
          <Text className="text-xs text-muted-foreground">
            {new Date(order.createdAt).toLocaleString()}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground">
          {t("orders.detail.soldBy", { seller: sellerName })}
        </Text>
        <CommercialDisclosure presentation={order.commercial} showExplanations />

        {/*
          The Mercaria-retail progress and delivery statements (#129 order rule
          4, ADR 0004 D9.1). Present only on a retail order; a marketplace order
          has no supply-confirmation window and no accepted-versus-current
          distinction to report.
        */}
        {order.retail ? <RetailProgressCard retail={order.retail} /> : null}

        {/*
          Collection (#93 client rule 13). This screen is an AUTHORIZED order
          surface, which is the only place a code may be rendered — and the code
          is fetched by its own call against its own route rather than read off
          the order DTO, so it is never in the cache, the log or the support
          export that DTO ends up in. `collection.data` is absent for a
          delivered order, which renders nothing at all.
        */}
        {collection.data === undefined ? null : (
          <PickupCollectionPanel
            pickup={collection.data.pickup}
            {...(collection.data.code === undefined ? {} : { code: collection.data.code })}
          />
        )}

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
            <Text className="text-sm font-medium text-foreground">
              {t("orders.cancel.action")}
            </Text>
          </Button>
        ) : null}
      </View>
      <View className="h-24" />
    </View>
  );
}

export default function OrderDetailScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t("orders.detail.pageTitle")}</title>
      </Head>
      <OrderDetailBody orderId={String(id)} />
    </ScreenShell>
  );
}
