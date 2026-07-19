import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, History } from "lucide-react-native";
import type {
  Connection,
  ConnectionStatus,
  SyncResourceDirection,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useChannels, useUpdateChannelSettings } from "@/lib/hooks/use-channels";

const PROVIDER_NAME: Record<Connection["provider"], string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  etsy: "Etsy",
  prestashop: "PrestaShop",
  magento: "Magento",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  error: "Needs attention",
  disconnected: "Disconnected",
};

const DIRECTIONS: readonly SyncResourceDirection[] = ["off", "pull", "push", "bidirectional"];

const DIRECTION_LABEL: Record<SyncResourceDirection, string> = {
  off: "Off",
  pull: "Pull",
  push: "Push",
  bidirectional: "Both",
};

function isSyncDirection(value: string): value is SyncResourceDirection {
  return value === "off" || value === "pull" || value === "push" || value === "bidirectional";
}

/** Human-readable timestamp, or a fallback when a channel has never synced. */
function formatSyncedAt(iso: string | undefined): string {
  if (!iso) return "This channel hasn't synced yet.";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "This channel hasn't synced yet.";
  return `Last synced ${when.toLocaleString()}`;
}

export default function ChannelSettingsScreen() {
  const { connectionId } = useLocalSearchParams<{ connectionId: string }>();
  return (
    <>
      <Head>
        <title>Channel settings | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => (
          <ChannelSettingsBody storeId={storeId} connectionId={String(connectionId)} />
        )}
      </RequireStore>
    </>
  );
}

function ChannelSettingsBody({
  storeId,
  connectionId,
}: {
  storeId: string;
  connectionId: string;
}) {
  const router = useRouter();
  const { colors } = useColorScheme();
  // The list endpoint is the only source of a connection DTO (no single-GET
  // route exists), so the detail screen reads from the shared channels query.
  const { data, isPending, isError } = useChannels(storeId);

  const connection = data?.find((c) => c.id === connectionId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title="Channel settings" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !connection) {
    return (
      <Screen title="Channel settings" action={back}>
        <ScreenMessage
          title="Channel not found"
          body="This connection may have been disconnected."
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={`${PROVIDER_NAME[connection.provider]} settings`}
      subtitle={connection.shopDomain}
      action={back}
    >
      <SettingsForm storeId={storeId} connection={connection} />
      <SyncHistory connection={connection} />
    </Screen>
  );
}

function SettingsForm({ storeId, connection }: { storeId: string; connection: Connection }) {
  const update = useUpdateChannelSettings(storeId);
  const [products, setProducts] = useState<SyncResourceDirection>(
    connection.syncSettings.products,
  );
  const [inventory, setInventory] = useState<SyncResourceDirection>(
    connection.syncSettings.inventory,
  );
  const [orders, setOrders] = useState<SyncResourceDirection>(connection.syncSettings.orders);
  const [autoPublish, setAutoPublish] = useState<boolean>(connection.syncSettings.autoPublish);

  const save = () => {
    update.mutate(
      {
        connectionId: connection.id,
        settings: { products, inventory, orders, autoPublish },
      },
      {
        onSuccess: () => toast.success("Channel settings saved"),
        onError: () => toast.error("Couldn't save channel settings"),
      },
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">Sync directions</Text>
        <DirectionField
          label="Products"
          hint="The product catalog (titles, images, prices, variants)."
          value={products}
          onChange={setProducts}
        />
        <DirectionField
          label="Inventory"
          hint="Stock levels at your synced location."
          value={inventory}
          onChange={setInventory}
        />
        <DirectionField
          label="Orders"
          hint="Orders placed on the external channel."
          value={orders}
          onChange={setOrders}
        />
      </View>

      <View className="rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-4 py-1">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Auto-publish</Text>
            <Text className="text-xs text-muted-foreground">
              Publish pulled products immediately. When off, they land as drafts for review.
            </Text>
          </View>
          <Switch value={autoPublish} onValueChange={setAutoPublish} />
        </View>
      </View>

      <Button onPress={save} isLoading={update.isPending} className="self-start">
        <Text className="font-semibold text-primary-foreground">Save settings</Text>
      </Button>
    </View>
  );
}

function DirectionField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: SyncResourceDirection;
  onChange: (direction: SyncResourceDirection) => void;
}) {
  return (
    <View className="gap-2">
      <View>
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{hint}</Text>
      </View>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string" && isSyncDirection(next)) onChange(next);
        }}
      >
        {DIRECTIONS.map((direction) => (
          <ToggleGroupItem key={direction} value={direction}>
            {DIRECTION_LABEL[direction]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </View>
  );
}

function SyncHistory({ connection }: { connection: Connection }) {
  const { colors } = useColorScheme();
  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Sync history</Text>
      <View className="flex-row items-start gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
          <History size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            {STATUS_LABEL[connection.status]}
          </Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            {formatSyncedAt(connection.lastSyncAt)}
          </Text>
          <Text className="mt-2 text-xs text-muted-foreground">
            A per-run sync history (created / updated / skipped / failed tallies) is a follow-up —
            the channels list endpoint returns the connection status and last-synced time only.
          </Text>
        </View>
      </View>
    </View>
  );
}
