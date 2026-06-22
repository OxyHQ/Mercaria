import React from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { ChevronsUpDown, Store as StoreIcon } from "lucide-react-native";
import { Text, useColorScheme } from "@mercaria/ui";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";

/**
 * Compact active-store indicator + switcher. Tapping it returns to the
 * store-setup picker (`/store-setup`) to choose a different store/register.
 * Rendered in screen headers so the operator always sees which store they're
 * ringing up against.
 */
export function StoreSwitcher() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { store } = useActiveStoreContext();

  return (
    <Pressable
      onPress={() => router.push("/store-setup")}
      accessibilityRole="button"
      accessibilityLabel="Switch store"
      className="flex-row items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 active:opacity-80 web:hover:border-primary"
    >
      <View
        className="h-6 w-6 items-center justify-center rounded-md"
        style={{ backgroundColor: store?.brandColor ?? colors.muted }}
      >
        <StoreIcon size={14} color="#fff" />
      </View>
      <Text className="max-w-[140px] text-sm font-semibold text-foreground" numberOfLines={1}>
        {store?.name ?? "Select store"}
      </Text>
      <ChevronsUpDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
