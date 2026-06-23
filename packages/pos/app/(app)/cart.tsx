import React from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { RequirePos } from "@/components/shell/RequirePos";
import { CartPanel } from "@/components/register/CartPanel";

/**
 * Narrow / native cart-review screen. On wide screens the cart lives inline in
 * the register's right pane; below `md:` the register hides it and the bottom
 * bar routes here so the operator can review line items, customer and discount
 * full-screen before charging. Renders the SAME `CartPanel` component, whose
 * charge button leads to the tender step (`/charge`).
 */
export default function CartScreen() {
  return (
    <>
      <Head>
        <title>Cart | Mercaria POS</title>
      </Head>
      <RequirePos permission="draft_orders:write">
        {(storeId) => (
          <View className="flex-1 bg-background">
            <CartPanel storeId={storeId} />
          </View>
        )}
      </RequirePos>
    </>
  );
}
