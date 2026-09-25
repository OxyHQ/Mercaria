import React, { useMemo } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { RiShoppingCartLine } from "@oxy.so/bloom/icons/RiShoppingCartLine";
import { ChevronRight, Tag, Trash2, User as UserIcon, X } from "lucide-react-native";
import { Stepper } from "@oxy.so/bloom/stepper";
import { Text, PriceDisplay, toBloomFieldIcon, useColorScheme } from "@mercaria/ui";
import { TextField, TextFieldIcon, TextFieldInput } from "@oxy.so/bloom/text-field";
import { useCustomers } from "@/lib/hooks/use-customers";
import {
  useRegisterCart,
  useRegisterCartCount,
  type RegisterCartLine,
} from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
import { useTranslation } from "@/lib/i18n";
import { ChargeButton } from "./ChargeButton";

/**
 * The register cart: a header with the item count and a Clear action, an
 * attach-customer row, the scrollable line items (each with a quantity stepper
 * and line total), a discount-code row, a friendly empty state, and a sticky
 * footer carrying the subtotal and the shared charge button. Used full-height in
 * the wide right pane and full-screen in the narrow cart-review route.
 */
export function CartPanel({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const lines = useRegisterCart((s) => s.lines);
  const discountCode = useRegisterCart((s) => s.discountCode);
  const customerId = useRegisterCart((s) => s.customerId);
  const setDiscountCode = useRegisterCart((s) => s.setDiscountCode);
  const clear = useRegisterCart((s) => s.clear);
  const count = useRegisterCartCount();

  const subtotal = useMemo(() => computeCartSubtotal(lines), [lines]);
  const isEmpty = lines.length === 0;

  // Resolve the attached customer's display name (best-effort, from the list cache).
  const { data: customerPage } = useCustomers(storeId, "");
  const customerName = useMemo(() => {
    if (!customerId) return null;
    const match = customerPage?.data.find((c) => c.id === customerId);
    return match?.displayName ?? t("customer.fallbackName");
  }, [customerId, customerPage, t]);

  return (
    <View className="flex-1 bg-surface">
      {/* Header. */}
      <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 py-3">
        <View>
          <Text className="text-lg font-bold text-foreground">{t("cart.title")}</Text>
          <Text className="text-xs text-muted-foreground">
            {t("cart.itemCount", { count })}
          </Text>
        </View>
        {isEmpty ? null : (
          <Pressable
            onPress={clear}
            accessibilityRole="button"
            accessibilityLabel={t("cart.clearCart")}
            className="h-9 flex-row items-center gap-1.5 rounded-lg px-2 active:bg-accent"
          >
            <Trash2 size={16} color="#ef4444" />
            <Text className="text-sm font-medium text-destructive">{t("cart.clear")}</Text>
          </Pressable>
        )}
      </View>

      {/* Customer row. */}
      <Pressable
        onPress={() => router.push("/customer")}
        accessibilityRole="button"
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-accent"
      >
        <View className="h-9 w-9 items-center justify-center rounded-full bg-muted">
          <UserIcon size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {customerName ?? t("cart.addCustomer")}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {customerName ? t("cart.customerAttached") : t("common.optional")}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.mutedForeground} />
      </Pressable>

      {/* Line items. */}
      {isEmpty ? (
        <View className="flex-1 justify-center">
          <EmptyState
            icon={RiShoppingCartLine}
            variant="compact"
            title={t("cart.emptyTitle")}
            description={t("cart.emptyBody")}
          />
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="gap-2 p-3">
          {lines.map((line) => (
            <CartLineRow key={line.variantId} line={line} />
          ))}
        </ScrollView>
      )}

      {/* Discount + subtotal + charge footer. */}
      <View className="gap-3 border-t border-border bg-surface p-4">
        <TextField style={{ height: 44 }}>
          <TextFieldIcon icon={toBloomFieldIcon(Tag)} />
          <TextFieldInput
            label={t("cart.discountCodePlaceholder")}
            value={discountCode ?? ""}
            onValueChange={(text) => setDiscountCode(text.trim() === "" ? null : text)}
            autoCapitalize="characters"
          />
        </TextField>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">{t("cart.subtotal")}</Text>
          <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
        </View>
        <ChargeButton total={subtotal} disabled={isEmpty} style={{ height: 56 }} />
      </View>
    </View>
  );
}

/**
 * A single cart line: thumbnail-less name + variant, qty stepper, line total.
 *
 * The stepper is Bloom's, floored at 1 with `onRemove`: at quantity 1 its `−`
 * becomes a trash button that removes the line, which is the till's long-standing
 * "− at 1 removes the line". The separate ✕ stays, because an operator voiding a
 * line of six should not have to press `−` six times — which is also why this is
 * not Bloom's `CartLine`, whose `removeInStepper` drops that control.
 */
function CartLineRow({ line }: { line: RegisterCartLine }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const setQuantity = useRegisterCart((s) => s.setQuantity);
  const removeLine = useRegisterCart((s) => s.removeLine);

  const lineTotal = useMemo(
    () => ({
      amount: line.unitPrice.amount * line.quantity,
      currency: line.unitPrice.currency,
    }),
    [line.unitPrice, line.quantity],
  );

  return (
    <View className="rounded-xl border border-border bg-background p-3">
      <View className="flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text numberOfLines={2} className="text-sm font-semibold text-foreground">
            {line.title}
          </Text>
          <Text className="text-xs text-muted-foreground">{line.variantTitle}</Text>
        </View>
        <Pressable
          onPress={() => removeLine(line.variantId)}
          accessibilityRole="button"
          accessibilityLabel={t("cart.removeItem")}
          className="h-9 w-9 items-center justify-center rounded-lg active:bg-accent"
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <View className="mt-2 flex-row items-center justify-between">
        <Stepper
          value={line.quantity}
          min={1}
          max={Math.max(1, line.available)}
          onValueChange={(quantity) => setQuantity(line.variantId, quantity)}
          onRemove={() => removeLine(line.variantId)}
          removeLabel={t("cart.removeItem")}
          decrementLabel={t("cart.decreaseQuantity")}
          incrementLabel={t("cart.increaseQuantity")}
          accessibilityLabel={line.title}
          size="small"
        />
        <PriceDisplay price={lineTotal} primaryClassName="text-sm font-bold" />
      </View>
    </View>
  );
}
