import React, { useMemo, useState } from "react";
import { View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { useQueryClient } from "@tanstack/react-query";
import { Banknote, CreditCard, type LucideIcon } from "lucide-react-native";
import { Text, PriceDisplay, toBloomIcon } from "@mercaria/ui";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { Screen } from "@/components/shell/Screen";
import { RequirePos } from "@/components/shell/RequirePos";
import { useChargeSale } from "@/lib/hooks/use-sale";
import { useCustomers } from "@/lib/hooks/use-customers";
import { useRegisterCart } from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/lib/i18n";

/** Tender method the operator records for the sale (UI-only; no real payment). */
type TenderMethod = "cash" | "card";

/** Review + charge the current register sale. */
export default function ChargeScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("charge.documentTitle")}</title>
      </Head>
      <RequirePos permission="draft_orders:write">
        {(storeId, locationId) => <Charge storeId={storeId} locationId={locationId} />}
      </RequirePos>
    </>
  );
}

function Charge({ storeId, locationId }: { storeId: string; locationId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const lines = useRegisterCart((s) => s.lines);
  const discountCode = useRegisterCart((s) => s.discountCode);
  const customerId = useRegisterCart((s) => s.customerId);
  const clear = useRegisterCart((s) => s.clear);

  const [tender, setTender] = useState<TenderMethod>("cash");

  const charge = useChargeSale(storeId);

  // Resolve the attached customer's display name (best-effort, from the list cache).
  const { data: customerPage } = useCustomers(storeId, "");
  const customerName = useMemo(() => {
    if (!customerId) return null;
    const match = customerPage?.data.find((c) => c.id === customerId);
    return match?.displayName ?? t("customer.fallbackName");
  }, [customerId, customerPage, t]);

  const subtotal = useMemo(() => computeCartSubtotal(lines), [lines]);

  // Empty-cart guard: nothing to charge → back to the register.
  if (lines.length === 0) {
    router.replace("/");
    return null;
  }

  const onCharge = () => {
    charge.mutate(
      { locationId, customerId, discountCode, lines },
      {
        onSuccess: (order) => {
          // Prime the receipt cache so it renders instantly.
          queryClient.setQueryData(queryKeys.orders.detail(storeId, order.id), order);
          clear();
          router.replace({ pathname: "/receipt/[id]", params: { id: order.id } });
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : t("charge.failed"));
        },
      },
    );
  };

  return (
    <Screen title={t("charge.title")} subtitle={t("charge.subtitle")}>
      <View className="gap-5">
        {/* Line summary. */}
        <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
          {lines.map((line) => (
            <View key={line.variantId} className="flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                  {line.title}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {line.variantTitle} · ×{line.quantity}
                </Text>
              </View>
              <PriceDisplay price={{ amount: line.unitPrice.amount * line.quantity, currency: line.unitPrice.currency }} />
            </View>
          ))}
          <View className="mt-2 flex-row items-center justify-between border-t border-border pt-3">
            <Text className="text-sm font-semibold text-foreground">
              {t("charge.expectedTotal")}
            </Text>
            <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
          </View>
          <Text className="text-xs text-muted-foreground">{t("charge.finalTotalNote")}</Text>
        </View>

        {/* Customer. */}
        <View className="flex-row items-center justify-between rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm text-muted-foreground">{t("charge.customer")}</Text>
          <Text className="text-sm font-semibold text-foreground">
            {customerName ?? t("customer.walkIn")}
          </Text>
        </View>

        {/* Tender method (UI-only). */}
        <View className="gap-2">
          <Text className="text-sm font-semibold text-foreground">{t("charge.tender")}</Text>
          <View className="flex-row gap-3">
            <TenderButton
              label={t("charge.tenderCash")}
              icon={Banknote}
              active={tender === "cash"}
              onPress={() => setTender("cash")}
            />
            <TenderButton
              label={t("charge.tenderCard")}
              icon={CreditCard}
              active={tender === "card"}
              onPress={() => setTender("card")}
            />
          </View>
        </View>

        <Button
          tone="accent"
          size="lg"
          onPress={onCharge}
          loading={charge.isPending}
          style={{ height: 64 }}
        >
          {t("charge.action")}
        </Button>
      </View>
    </Screen>
  );
}

function TenderButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      appearance={active ? "solid" : "outline"}
      tone={active ? "accent" : "neutral"}
      size="lg"
      pressed={active}
      leadingIcon={toBloomIcon(icon)}
      onPress={onPress}
      className="flex-1"
      style={{ height: 64 }}
    >
      {label}
    </Button>
  );
}
