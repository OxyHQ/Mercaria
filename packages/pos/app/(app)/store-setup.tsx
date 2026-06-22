import React from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import {
  Check,
  ChevronLeft,
  MapPin,
  Store as StoreIcon,
} from "lucide-react-native";
import type { Location, Store } from "@mercaria/shared-types";
import { Text, Button, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useMyStores } from "@/lib/hooks/use-stores";
import { useLocations } from "@/lib/hooks/use-locations";
import { useActiveStore } from "@/lib/stores/active-store";

/**
 * Store + register picker. The operator first picks the store they're working
 * for, then the register location stock commits at. Selecting a location starts
 * the register (`/`). This screen sets the active store/location, so it must NOT
 * be guarded by `RequirePos`/`RequireStore`.
 */
export default function StoreSetupScreen() {
  const { activeStoreId } = useActiveStore();

  return (
    <>
      <Head>
        <title>Store setup | Mercaria POS</title>
      </Head>
      {activeStoreId ? <LocationStep storeId={activeStoreId} /> : <StoreStep />}
    </>
  );
}

/** Step A — pick the store to ring up against. */
function StoreStep() {
  const { colors } = useColorScheme();
  const { data: stores, isPending, isError } = useMyStores();
  const { setActiveStoreId } = useActiveStore();

  const onSelect = (store: Store) => {
    // Setting a (new) store clears any previously-picked register location.
    setActiveStoreId(store.id);
  };

  return (
    <Screen title="Choose a store" subtitle="Pick the store you're selling for">
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load your stores" body="Please try again." />
      ) : stores && stores.length > 0 ? (
        <View className="gap-3">
          {stores.map((store) => (
            <Pressable
              key={store.id}
              onPress={() => onSelect(store)}
              className="min-h-[72px] flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
            >
              <View
                className="h-12 w-12 items-center justify-center rounded-xl"
                style={{ backgroundColor: store.brandColor }}
              >
                <StoreIcon size={22} color="#fff" />
              </View>
              <View className="flex-1">
                <Text className="text-base font-semibold text-foreground">{store.name}</Text>
                <Text className="text-sm text-muted-foreground">
                  @{store.handle} · {store.productCount} products
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View className="items-center justify-center rounded-2xl border border-dashed border-border py-16">
          <StoreIcon size={36} color={colors.mutedForeground} />
          <Text className="mt-4 text-base font-semibold text-foreground">No stores yet</Text>
          <Text className="mt-1 max-w-xs text-center text-sm text-muted-foreground">
            Create a store in the Mercaria Dashboard first, then return here to open
            the register.
          </Text>
        </View>
      )}
    </Screen>
  );
}

/** Step B — pick the register location for the active store. */
function LocationStep({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data: locations, isPending, isError } = useLocations(storeId);
  const {
    activeLocationId,
    setActiveLocationId,
    setActiveStoreId,
  } = useActiveStore();

  const onSelect = (location: Location) => {
    setActiveLocationId(location.id);
    router.replace("/");
  };

  const changeStore = () => {
    // Going back to step A clears the store (and its location).
    setActiveStoreId(null);
  };

  const action = (
    <Button variant="outline" onPress={changeStore}>
      <View className="flex-row items-center gap-1.5">
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="font-semibold text-foreground">Change store</Text>
      </View>
    </Button>
  );

  return (
    <Screen
      title="Choose a register"
      subtitle="Pick the location this register commits stock at"
      action={action}
    >
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load locations" body="Please try again." />
      ) : locations && locations.length > 0 ? (
        <View className="gap-3">
          {locations.map((location) => (
            <Pressable
              key={location.id}
              onPress={() => onSelect(location)}
              className="min-h-[72px] flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
            >
              <View className="h-12 w-12 items-center justify-center rounded-xl bg-secondary">
                <MapPin size={22} color={colors.primary} />
              </View>
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-base font-semibold text-foreground">{location.name}</Text>
                  {location.isDefault ? (
                    <View className="rounded-full bg-secondary px-2 py-0.5">
                      <Text className="text-xs font-medium text-muted-foreground">Default</Text>
                    </View>
                  ) : null}
                </View>
                <Text className="text-sm capitalize text-muted-foreground">
                  {location.type.replace("_", " ")}
                </Text>
              </View>
              {activeLocationId === location.id ? (
                <Check size={20} color={colors.primary} />
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : (
        <ScreenMessage
          title="No locations"
          body="Create a location in the Dashboard first, then return here to open the register."
        />
      )}
    </Screen>
  );
}
