import React, { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import * as WebBrowser from "expo-web-browser";
import {
  Plug,
  Store as StoreIcon,
  RefreshCw,
  Settings2,
  Trash2,
  Plus,
  ExternalLink,
} from "lucide-react-native";
import type {
  Connection,
  ConnectionStatus,
  ConnectorProviderId,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
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
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useChannels,
  useConnectChannel,
  useConnectKeyChannel,
  useSyncChannel,
  useDisconnectChannel,
} from "@/lib/hooks/use-channels";

/**
 * Presentational metadata for each connector. `available` gates whether the
 * "Connect" affordance is live: Shopify + WooCommerce ship first (both `pull`
 * connectors), the rest are placeholders until their `ConnectorProvider` lands
 * server-side. `credentialStrategy` chooses the connect flow — an OAuth redirect
 * (Shopify) or an in-app API-key form (WooCommerce).
 */
interface ProviderMeta {
  id: ConnectorProviderId;
  name: string;
  blurb: string;
  available: boolean;
  credentialStrategy: "oauth" | "api_key";
}

const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "shopify",
    name: "Shopify",
    blurb: "Sync products, inventory and orders from your Shopify store.",
    available: true,
    credentialStrategy: "oauth",
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    blurb: "Sync your WooCommerce catalog with a REST API key.",
    available: true,
    credentialStrategy: "api_key",
  },
  {
    id: "etsy",
    name: "Etsy",
    blurb: "Import your Etsy listings.",
    available: false,
    credentialStrategy: "oauth",
  },
  {
    id: "prestashop",
    name: "PrestaShop",
    blurb: "PrestaShop catalog sync.",
    available: false,
    credentialStrategy: "oauth",
  },
  {
    id: "magento",
    name: "Magento",
    blurb: "Adobe Commerce / Magento sync.",
    available: false,
    credentialStrategy: "oauth",
  },
] as const;

const PROVIDER_NAME: Record<ConnectorProviderId, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  etsy: "Etsy",
  prestashop: "PrestaShop",
  magento: "Magento",
};

const STATUS_STYLES: Record<ConnectionStatus, string> = {
  connected: "bg-primary/10 text-primary",
  error: "bg-destructive/10 text-destructive",
  disconnected: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  error: "Needs attention",
  disconnected: "Disconnected",
};

/** Human-readable timestamp, or a fallback when a channel has never synced. */
function formatSyncedAt(iso: string | undefined): string {
  if (!iso) return "Never synced";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "Never synced";
  return `Last synced ${when.toLocaleString()}`;
}

export default function ChannelsScreen() {
  return (
    <>
      <Head>
        <title>Sales channels | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <ChannelsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function ChannelsBody({ storeId }: { storeId: string }) {
  const { data, isPending, isError, refetch } = useChannels(storeId);
  const [connectProvider, setConnectProvider] = useState<ProviderMeta | null>(null);

  const connectedProviderIds = useMemo(
    () => new Set((data ?? []).map((c) => c.provider)),
    [data],
  );

  const action = <StoreSwitcher />;

  return (
    <Screen
      title="Sales channels"
      subtitle="Connect external stores to sync products, inventory and orders into Mercaria"
      action={action}
    >
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load channels" body="Please try again." />
      ) : (
        <View className="gap-8">
          <ConnectedChannels storeId={storeId} connections={data ?? []} />
          <AvailableChannels
            connectedProviderIds={connectedProviderIds}
            onConnect={(provider) => setConnectProvider(provider)}
          />
        </View>
      )}

      {connectProvider?.credentialStrategy === "api_key" ? (
        <ConnectKeyDialog
          storeId={storeId}
          provider={connectProvider}
          open
          onOpenChange={(open) => {
            if (!open) setConnectProvider(null);
          }}
          onConnected={() => {
            void refetch();
          }}
        />
      ) : (
        <ConnectChannelDialog
          storeId={storeId}
          provider={connectProvider}
          open={connectProvider !== null}
          onOpenChange={(open) => {
            if (!open) setConnectProvider(null);
          }}
          onConnected={() => {
            void refetch();
          }}
        />
      )}
    </Screen>
  );
}

function ConnectedChannels({
  storeId,
  connections,
}: {
  storeId: string;
  connections: Connection[];
}) {
  if (connections.length === 0) {
    return (
      <View className="items-center justify-center rounded-2xl border border-dashed border-border py-12">
        <Plug size={32} className="text-muted-foreground" />
        <Text className="mt-4 text-base font-semibold text-foreground">
          No channels connected
        </Text>
        <Text className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
          Connect a store below to start syncing its catalog into Mercaria.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Connected</Text>
      <View className="gap-2">
        {connections.map((connection) => (
          <ChannelRow key={connection.id} storeId={storeId} connection={connection} />
        ))}
      </View>
    </View>
  );
}

function ChannelRow({ storeId, connection }: { storeId: string; connection: Connection }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const sync = useSyncChannel(storeId);
  const disconnect = useDisconnectChannel(storeId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onSync = () => {
    sync.mutate(connection.id, {
      onSuccess: (run) =>
        toast.success(
          run.status === "failed"
            ? "Sync finished with errors — check the channel"
            : "Sync started",
        ),
      onError: () => toast.error("Couldn't start the sync"),
    });
  };

  const onDisconnect = () => {
    disconnect.mutate(connection.id, {
      onSuccess: () => {
        toast.success("Channel disconnected");
        setConfirmOpen(false);
      },
      onError: () => toast.error("Couldn't disconnect the channel"),
    });
  };

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-start gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
          <StoreIcon size={20} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">
              {PROVIDER_NAME[connection.provider]}
            </Text>
            <View className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[connection.status]}`}>
              <Text
                className={`text-[10px] font-semibold ${STATUS_STYLES[connection.status].split(" ")[1]}`}
              >
                {STATUS_LABEL[connection.status]}
              </Text>
            </View>
          </View>
          {connection.shopDomain ? (
            <Text className="mt-0.5 text-xs text-muted-foreground">{connection.shopDomain}</Text>
          ) : null}
          <Text className="mt-0.5 text-xs text-muted-foreground">
            {formatSyncedAt(connection.lastSyncAt)}
          </Text>
        </View>
      </View>

      <View className="mt-4 flex-row flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onPress={onSync} isLoading={sync.isPending}>
          <View className="flex-row items-center gap-1.5">
            <RefreshCw size={14} color={colors.foreground} />
            <Text className="text-xs font-semibold text-foreground">Sync now</Text>
          </View>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={() => router.push(`/channels/${connection.id}`)}
        >
          <View className="flex-row items-center gap-1.5">
            <Settings2 size={14} color={colors.foreground} />
            <Text className="text-xs font-semibold text-foreground">Settings</Text>
          </View>
        </Button>
        <Pressable
          onPress={() => setConfirmOpen(true)}
          className="ml-auto h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 active:opacity-70"
        >
          <Trash2 size={14} color={colors.mutedForeground} />
          <Text className="text-xs font-medium text-muted-foreground">Disconnect</Text>
        </Pressable>
      </View>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {PROVIDER_NAME[connection.provider]}?</DialogTitle>
            <DialogDescription>
              Mercaria will stop syncing with{" "}
              {connection.shopDomain ?? "this store"}. Products already imported stay in your
              catalog.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirmOpen(false)}>
              <Text className="font-semibold text-foreground">Cancel</Text>
            </Button>
            <Button variant="destructive" onPress={onDisconnect} isLoading={disconnect.isPending}>
              <Text className="font-semibold text-destructive-foreground">Disconnect</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}

function AvailableChannels({
  connectedProviderIds,
  onConnect,
}: {
  connectedProviderIds: Set<ConnectorProviderId>;
  onConnect: (provider: ProviderMeta) => void;
}) {
  const { colors } = useColorScheme();

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Add channel</Text>
      <View className="gap-2">
        {PROVIDERS.map((provider) => {
          const alreadyConnected = connectedProviderIds.has(provider.id);
          return (
            <View
              key={provider.id}
              className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4"
            >
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
                <StoreIcon size={20} color={colors.mutedForeground} />
              </View>
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-semibold text-foreground">{provider.name}</Text>
                  {!provider.available ? (
                    <View className="rounded-full bg-muted px-2 py-0.5">
                      <Text className="text-[10px] font-semibold text-muted-foreground">
                        Coming soon
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text className="mt-0.5 text-xs text-muted-foreground">{provider.blurb}</Text>
              </View>
              {provider.available ? (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => onConnect(provider)}
                  disabled={alreadyConnected}
                >
                  <View className="flex-row items-center gap-1.5">
                    <Plus size={14} color={colors.foreground} />
                    <Text className="text-xs font-semibold text-foreground">
                      {alreadyConnected ? "Connected" : "Connect"}
                    </Text>
                  </View>
                </Button>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ConnectChannelDialog({
  storeId,
  provider,
  open,
  onOpenChange,
  onConnected,
}: {
  storeId: string;
  provider: ProviderMeta | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { colors } = useColorScheme();
  const connect = useConnectChannel(storeId);
  const [shopDomain, setShopDomain] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const submit = async () => {
    if (!provider) return;
    const domain = shopDomain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      toast.error("Enter a valid *.myshopify.com domain");
      return;
    }
    try {
      setRedirecting(true);
      const { authorizeUrl } = await connect.mutateAsync({
        provider: provider.id,
        shopDomain: domain,
      });
      // Real OAuth requires the deploy-time Shopify Partner app + callback URL;
      // this opens the server-issued authorize URL (web: new tab, native: in-app
      // browser). The connection is created by the out-of-band OAuth callback, so
      // we refetch when the browser closes to surface it.
      await WebBrowser.openBrowserAsync(authorizeUrl);
      onConnected();
      setShopDomain("");
      onOpenChange(false);
      toast.success("Finish authorizing in the browser to complete the connection");
    } catch {
      toast.error("Couldn't start the Shopify connection");
    } finally {
      setRedirecting(false);
    }
  };

  const busy = connect.isPending || redirecting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider?.name ?? "channel"}</DialogTitle>
          <DialogDescription>
            Enter your Shopify store domain. You&apos;ll be redirected to Shopify to authorize
            Mercaria, then brought back here.
          </DialogDescription>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Shop domain</Label>
            <Input
              value={shopDomain}
              onChangeText={setShopDomain}
              placeholder="your-store.myshopify.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          <View className="flex-row items-start gap-2 rounded-xl bg-muted p-3">
            <ExternalLink size={14} color={colors.mutedForeground} />
            <Text className="flex-1 text-xs text-muted-foreground">
              Authorization opens on Shopify. Grant the requested scopes to finish connecting.
            </Text>
          </View>
          <Button onPress={submit} isLoading={busy} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Continue to Shopify</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}

/**
 * API-key connect dialog (WooCommerce). Unlike the OAuth flow there is no browser
 * redirect: the merchant pastes their WooCommerce REST API consumer key/secret and
 * the server verifies them against the site, creating the connection synchronously.
 */
function ConnectKeyDialog({
  storeId,
  provider,
  open,
  onOpenChange,
  onConnected,
}: {
  storeId: string;
  provider: ProviderMeta | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const { colors } = useColorScheme();
  const connect = useConnectKeyChannel(storeId);
  const [siteUrl, setSiteUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");

  const reset = () => {
    setSiteUrl("");
    setConsumerKey("");
    setConsumerSecret("");
  };

  const submit = async () => {
    if (!provider) return;
    const shopDomain = siteUrl.trim();
    let isHttps = false;
    try {
      isHttps = new URL(shopDomain).protocol === "https:";
    } catch {
      isHttps = false;
    }
    if (!isHttps) {
      toast.error("Enter your site URL starting with https://");
      return;
    }
    if (consumerKey.trim() === "" || consumerSecret.trim() === "") {
      toast.error("Enter both the consumer key and secret");
      return;
    }
    try {
      await connect.mutateAsync({
        provider: provider.id,
        shopDomain,
        consumerKey: consumerKey.trim(),
        consumerSecret: consumerSecret.trim(),
      });
      onConnected();
      reset();
      onOpenChange(false);
      toast.success("WooCommerce connected");
    } catch {
      toast.error("Couldn't connect — check the site URL and API keys");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider?.name ?? "channel"}</DialogTitle>
          <DialogDescription>
            Create a read-only REST API key in WooCommerce (WooCommerce → Settings → Advanced →
            REST API) and paste the details below.
          </DialogDescription>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Site URL</Label>
            <Input
              value={siteUrl}
              onChangeText={setSiteUrl}
              placeholder="https://your-store.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          <View className="gap-1.5">
            <Label>Consumer key</Label>
            <Input
              value={consumerKey}
              onChangeText={setConsumerKey}
              placeholder="ck_..."
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View className="gap-1.5">
            <Label>Consumer secret</Label>
            <Input
              value={consumerSecret}
              onChangeText={setConsumerSecret}
              placeholder="cs_..."
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
          <View className="flex-row items-start gap-2 rounded-xl bg-muted p-3">
            <ExternalLink size={14} color={colors.mutedForeground} />
            <Text className="flex-1 text-xs text-muted-foreground">
              Your keys are verified against your store and stored encrypted. Read access is
              enough to import your catalog.
            </Text>
          </View>
          <Button onPress={submit} isLoading={connect.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Connect WooCommerce</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
