import React, { useMemo, useState } from "react";
import { View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { useQueryClient } from "@tanstack/react-query";
import { Banknote, CreditCard } from "lucide-react-native";
import { Text, Button, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen } from "@/components/shell/Screen";
import { RequirePos } from "@/components/shell/RequirePos";
import { useChargeSale } from "@/lib/hooks/use-sale";
import { useCustomers } from "@/lib/hooks/use-customers";
import { useRegisterCart } from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
import { queryKeys } from "@/lib/queryKeys";

/** Tender method the operator records for the sale (UI-only; no real payment). */
type TenderMethod = "cash" | "card";

/** Review + charge the current register sale. */
export default function ChargeScreen() {
  return (
    <>
      <Head>
        <title>Charge | Mercaria POS</title>
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
  const { colors } = useColorScheme();

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
    return match?.displayName ?? "Customer";
  }, [customerId, customerPage]);

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
          toast.error(error instanceof Error ? error.message : "Charge failed");
        },
      },
    );
  };

  return (
    <Screen title="Charge" subtitle="Review and take the sale">
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
            <Text className="text-sm font-semibold text-foreground">Expected total</Text>
            <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
          </View>
          <Text className="text-xs text-muted-foreground">
            Final total (discounts &amp; tax) is computed when the sale is taken.
          </Text>
        </View>

        {/* Customer. */}
        <View className="flex-row items-center justify-between rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm text-muted-foreground">Customer</Text>
          <Text className="text-sm font-semibold text-foreground">
            {customerName ?? "Walk-in"}
          </Text>
        </View>

        {/* Tender method (UI-only). */}
        <View className="gap-2">
          <Text className="text-sm font-semibold text-foreground">Tender</Text>
          <View className="flex-row gap-3">
            <TenderButton
              label="Cash"
              icon={<Banknote size={20} color={tender === "cash" ? colors.primaryForeground : colors.foreground} />}
              active={tender === "cash"}
              onPress={() => setTender("cash")}
            />
            <TenderButton
              label="Card"
              icon={<CreditCard size={20} color={tender === "card" ? colors.primaryForeground : colors.foreground} />}
              active={tender === "card"}
              onPress={() => setTender("card")}
            />
          </View>
        </View>

        <Button onPress={onCharge} isLoading={charge.isPending} className="h-16">
          <Text className="text-lg font-semibold text-primary-foreground">Charge</Text>
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
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      onPress={onPress}
      className="h-16 flex-1"
      accessibilityState={{ selected: active }}
    >
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className={active ? "text-base font-semibold text-primary-foreground" : "text-base font-semibold text-foreground"}>
          {label}
        </Text>
      </View>
    </Button>
  );
}
