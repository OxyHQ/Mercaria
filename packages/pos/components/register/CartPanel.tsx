import React, { useMemo } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Minus, Plus, Tag, Trash2, User as UserIcon, X } from "lucide-react-native";
import { Text, Input, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { useCustomers } from "@/lib/hooks/use-customers";
import {
  useRegisterCart,
  useRegisterCartCount,
  type RegisterCartLine,
} from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
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
    return match?.displayName ?? "Customer";
  }, [customerId, customerPage]);

  return (
    <View className="flex-1 bg-surface">
      {/* Header. */}
      <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 py-3">
        <View>
          <Text className="text-lg font-bold text-foreground">Cart</Text>
          <Text className="text-xs text-muted-foreground">
            {count} item{count === 1 ? "" : "s"}
          </Text>
        </View>
        {isEmpty ? null : (
          <Pressable
            onPress={clear}
            accessibilityRole="button"
            accessibilityLabel="Clear cart"
            className="h-9 flex-row items-center gap-1.5 rounded-lg px-2 active:bg-secondary"
          >
            <Trash2 size={16} color="#ef4444" />
            <Text className="text-sm font-medium text-destructive">Clear</Text>
          </Pressable>
        )}
      </View>

      {/* Customer row. */}
      <Pressable
        onPress={() => router.push("/customer")}
        accessibilityRole="button"
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
      >
        <View className="h-9 w-9 items-center justify-center rounded-full bg-secondary">
          <UserIcon size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {customerName ?? "Add customer"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {customerName ? "Attached to this sale" : "Optional"}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.mutedForeground} />
      </Pressable>

      {/* Line items. */}
      {isEmpty ? (
        <View className="flex-1 items-center justify-center gap-1 px-6 py-12">
          <Text className="text-base font-semibold text-foreground">Cart is empty</Text>
          <Text className="text-center text-sm text-muted-foreground">
            Tap products to add them to the sale.
          </Text>
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
        <View className="flex-row items-center gap-2 rounded-xl border border-border bg-background px-3">
          <Tag size={16} color={colors.mutedForeground} />
          <Input
            value={discountCode ?? ""}
            onChangeText={(text) => setDiscountCode(text.trim() === "" ? null : text)}
            placeholder="Discount code"
            autoCapitalize="characters"
            className="h-11 flex-1 border-0 bg-transparent px-0"
          />
        </View>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">Subtotal</Text>
          <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
        </View>
        <ChargeButton total={subtotal} disabled={isEmpty} className="h-14" />
      </View>
    </View>
  );
}

/** A single cart line: thumbnail-less name + variant, qty stepper, line total. */
function CartLineRow({ line }: { line: RegisterCartLine }) {
  const { colors } = useColorScheme();
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
          accessibilityLabel="Remove item"
          className="h-9 w-9 items-center justify-center rounded-lg active:bg-secondary"
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <View className="mt-2 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => setQuantity(line.variantId, line.quantity - 1)}
            accessibilityRole="button"
            accessibilityLabel="Decrease quantity"
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-secondary"
          >
            <Minus size={16} color={colors.foreground} />
          </Pressable>
          <Text className="min-w-[28px] text-center text-base font-semibold text-foreground">
            {line.quantity}
          </Text>
          <Pressable
            onPress={() => setQuantity(line.variantId, line.quantity + 1)}
            disabled={line.quantity >= line.available}
            accessibilityRole="button"
            accessibilityLabel="Increase quantity"
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-secondary disabled:opacity-40"
          >
            <Plus size={16} color={colors.foreground} />
          </Pressable>
        </View>
        <PriceDisplay price={lineTotal} primaryClassName="text-sm font-bold" />
      </View>
    </View>
  );
}
