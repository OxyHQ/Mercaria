import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import * as Clipboard from "expo-clipboard";
import {
  ChevronLeft,
  History,
  KeyRound,
  Copy,
  Check,
  Trash2,
  Plus,
  TriangleAlert,
} from "lucide-react-native";
import type {
  ChannelApiKey,
  Connection,
  ConnectionStatus,
  GenerateChannelApiKeyResult,
  SyncResourceDirection,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useChannels,
  useUpdateChannelSettings,
  useChannelKeys,
  useGenerateChannelKey,
  useRevokeChannelKey,
} from "@/lib/hooks/use-channels";

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
      {connection.mode === "push_in" ? (
        <ChannelApiKeys storeId={storeId} connection={connection} />
      ) : null}
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

/** Human-readable "last used" line for a key, or a never-used fallback. */
function formatLastUsed(iso: string | undefined): string {
  if (!iso) return "Never used";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "Never used";
  return `Last used ${when.toLocaleString()}`;
}

/**
 * API keys area for a push-in channel. The merchant mints a long-lived key here,
 * copies it (and the connection id) into their WordPress/WooCommerce plugin, and
 * revokes it if it leaks. The plaintext key is shown EXACTLY once, at creation.
 */
function ChannelApiKeys({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const { data: keys, isPending, isError } = useChannelKeys(storeId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [minted, setMinted] = useState<GenerateChannelApiKeyResult | null>(null);

  return (
    <View className="mt-8 gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-muted-foreground">API keys</Text>
        <Button variant="outline" size="sm" onPress={() => setDialogOpen(true)}>
          <View className="flex-row items-center gap-1.5">
            <Plus size={14} color={colors.foreground} />
            <Text className="text-xs font-semibold text-foreground">Generate key</Text>
          </View>
        </Button>
      </View>

      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-start gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
            <KeyRound size={18} color={colors.mutedForeground} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              Long-lived plugin credentials
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              Paste a key (and this channel&apos;s connection id) into the Mercaria plugin on your
              WordPress site. Keys don&apos;t expire — revoke one anytime to cut off access.
            </Text>
            <View className="mt-2 flex-row items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5">
              <Text className="text-[11px] font-medium text-muted-foreground">Connection id</Text>
              <Text selectable className="flex-1 text-[11px] font-semibold text-foreground">
                {connection.id}
              </Text>
              <CopyButton value={connection.id} label="connection id" />
            </View>
          </View>
        </View>

        {minted ? (
          <MintedKeyCard result={minted} onDone={() => setMinted(null)} />
        ) : null}

        {isPending ? (
          <Text className="text-xs text-muted-foreground">Loading keys…</Text>
        ) : isError ? (
          <Text className="text-xs text-destructive">Couldn&apos;t load API keys.</Text>
        ) : (keys?.length ?? 0) === 0 ? (
          <Text className="text-xs text-muted-foreground">
            No keys yet. Generate one to connect the plugin.
          </Text>
        ) : (
          <View className="gap-2">
            {keys?.map((key) => (
              <KeyRow key={key.id} storeId={storeId} apiKey={key} />
            ))}
          </View>
        )}
      </View>

      <GenerateKeyDialog
        storeId={storeId}
        connection={connection}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onMinted={(result) => {
          setMinted(result);
          setDialogOpen(false);
        }}
      />
    </View>
  );
}

/**
 * The one-time reveal of a freshly minted key. Prominent, with a copy button and
 * an unmissable "you won't see it again" warning; dismissed by "Done".
 */
function MintedKeyCard({
  result,
  onDone,
}: {
  result: GenerateChannelApiKeyResult;
  onDone: () => void;
}) {
  const { colors } = useColorScheme();
  return (
    <View className="gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
      <View className="flex-row items-center gap-2">
        <TriangleAlert size={15} color={colors.primary} />
        <Text className="flex-1 text-xs font-semibold text-foreground">
          Copy this key now — you won&apos;t be able to see it again.
        </Text>
      </View>
      <View className="flex-row items-center gap-2 rounded-lg bg-surface px-2.5 py-2">
        <Text selectable className="flex-1 text-[11px] font-semibold text-foreground">
          {result.key}
        </Text>
        <CopyButton value={result.key} label="API key" />
      </View>
      <Button size="sm" onPress={onDone} className="self-start">
        <Text className="text-xs font-semibold text-primary-foreground">Done</Text>
      </Button>
    </View>
  );
}

/** A single existing key row: label, prefix, last-used, and a revoke action. */
function KeyRow({ storeId, apiKey }: { storeId: string; apiKey: ChannelApiKey }) {
  const { colors } = useColorScheme();
  const revoke = useRevokeChannelKey(storeId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onRevoke = () => {
    revoke.mutate(apiKey.id, {
      onSuccess: () => {
        toast.success("API key revoked");
        setConfirmOpen(false);
      },
      onError: () => toast.error("Couldn't revoke the key"),
    });
  };

  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border bg-background p-3">
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{apiKey.label}</Text>
        <Text className="mt-0.5 text-[11px] text-muted-foreground">
          <Text className="font-mono text-[11px] text-muted-foreground">{apiKey.prefix}…</Text>
          {"  ·  "}
          {formatLastUsed(apiKey.lastUsedAt)}
        </Text>
      </View>
      <Pressable
        onPress={() => setConfirmOpen(true)}
        className="h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 active:opacity-70"
      >
        <Trash2 size={14} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-muted-foreground">Revoke</Text>
      </Pressable>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              Any plugin using “{apiKey.label}” will stop syncing immediately. This cannot be
              undone — you&apos;d need to generate a new key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirmOpen(false)}>
              <Text className="font-semibold text-foreground">Cancel</Text>
            </Button>
            <Button variant="destructive" onPress={onRevoke} isLoading={revoke.isPending}>
              <Text className="font-semibold text-destructive-foreground">Revoke</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}

/** Dialog to mint a new key: a label, then generate (bound to this connection). */
function GenerateKeyDialog({
  storeId,
  connection,
  open,
  onOpenChange,
  onMinted,
}: {
  storeId: string;
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMinted: (result: GenerateChannelApiKeyResult) => void;
}) {
  const generate = useGenerateChannelKey(storeId);
  const [label, setLabel] = useState("");

  const submit = () => {
    const trimmed = label.trim();
    if (trimmed === "") {
      toast.error("Give the key a label");
      return;
    }
    generate.mutate(
      { label: trimmed, connectionId: connection.id },
      {
        onSuccess: (result) => {
          setLabel("");
          onMinted(result);
          toast.success("API key generated");
        },
        onError: () => toast.error("Couldn't generate the key"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate API key</DialogTitle>
          <DialogDescription>
            Create a long-lived key for this channel. Give it a name so you can recognize it later
            (e.g. the site it&apos;s used on).
          </DialogDescription>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Label</Label>
            <Input
              value={label}
              onChangeText={setLabel}
              placeholder="WordPress plugin"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <Button onPress={submit} isLoading={generate.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Generate key</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}

/** A small copy-to-clipboard button that briefly confirms with a check. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const { colors } = useColorScheme();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    toast.success(`Copied ${label}`);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Pressable
      onPress={copy}
      accessibilityLabel={`Copy ${label}`}
      className="h-7 w-7 items-center justify-center rounded-md active:opacity-70"
    >
      {copied ? (
        <Check size={14} color={colors.primary} />
      ) : (
        <Copy size={14} color={colors.mutedForeground} />
      )}
    </Pressable>
  );
}
