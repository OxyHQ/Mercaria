import React, { useMemo } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Text, PriceDisplay } from "@mercaria/ui";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequirePos } from "@/components/shell/RequirePos";
import { CatalogPane } from "@/components/register/CatalogPane";
import { CartPanel } from "@/components/register/CartPanel";
import { useRegisterCart, useRegisterCartCount } from "@/lib/stores/register-cart";
import { computeCartSubtotal } from "@/lib/cart-totals";
import { ChargeButton } from "@/components/register/ChargeButton";

/**
 * The Mercaria register — a Shopify-POS two-pane layout. Wide (`md:`+) shows the
 * catalog and the cart side by side; narrow shows the catalog full-width with a
 * sticky bottom Charge bar that opens the full-screen cart review. The register
 * wants the full content width, so it intentionally bypasses `Screen`'s
 * `max-w-5xl` wrapper and renders its own header with the store switcher.
 */
export default function RegisterScreen() {
  return (
    <>
      <Head>
        <title>Register | Mercaria POS</title>
      </Head>
      <RequirePos permission="draft_orders:write">
        {(storeId) => <Register storeId={storeId} />}
      </RequirePos>
    </>
  );
}

function Register({ storeId }: { storeId: string }) {
  return (
    <View className="flex-1 bg-background">
      {/* Full-width header (StoreSwitcher action kept accessible). */}
      <View className="flex-row items-center justify-between gap-4 border-b border-border px-4 py-3 md:px-6">
        <Text className="text-xl font-bold text-foreground">Register</Text>
        <StoreSwitcher />
      </View>

      {/* Two-pane body: catalog (left) + cart (right, md:+ only). */}
      <View className="min-h-0 flex-1 flex-row">
        <View className="min-w-0 flex-1">
          <CatalogPane storeId={storeId} />
        </View>
        <View className="hidden md:flex md:w-[380px] md:border-l md:border-border lg:w-[420px]">
          <CartPanel storeId={storeId} />
        </View>
      </View>

      {/* Narrow only: sticky Charge bar above the floating bottom tab bar. */}
      <NarrowChargeBar />
    </View>
  );
}

/**
 * Compact bottom bar (item count + total + Charge) shown only below `md:` and
 * only when the cart has items. It sits above the area the `(app)` shell
 * reserves for the floating tab bar, so the two never overlap. The count/total
 * region opens the full-screen cart review (`/cart`); the Charge button goes
 * straight to the tender step (`/charge`).
 */
function NarrowChargeBar() {
  const router = useRouter();
  const count = useRegisterCartCount();
  const lines = useRegisterCart((s) => s.lines);
  const subtotal = useMemo(() => computeCartSubtotal(lines), [lines]);

  if (count === 0) return null;

  return (
    <View className="absolute inset-x-0 bottom-[88px] z-50 border-t border-border bg-surface px-4 py-3 md:hidden web:fixed">
      <View className="flex-row items-center justify-between gap-3">
        <Pressable
          onPress={() => router.push("/cart")}
          accessibilityRole="button"
          accessibilityLabel="Review cart"
          className="flex-1 active:opacity-80"
        >
          <Text className="text-xs text-muted-foreground">
            {count} item{count === 1 ? "" : "s"} · Review cart
          </Text>
          <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" />
        </Pressable>
        <ChargeButton total={subtotal} disabled={count === 0} className="h-12 px-6" />
      </View>
    </View>
  );
}
