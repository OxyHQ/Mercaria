/**
 * The connection wizard (#87 "Connection wizard").
 *
 * ## The state lives on the SERVER, and that is the whole point
 *
 * Two of the three credential paths LEAVE Mercaria mid-flow — Shopify sends the
 * merchant to a consent screen, and the WooCommerce plugin sends them to their
 * own WordPress admin — so a wizard holding its state on the client loses it at
 * the step that takes longest. Every step here PATCHes the session, and the
 * session is what a merchant returns to on any device (#87 wizard 12).
 *
 * ## What the client is NOT allowed to decide
 *
 * The activation gate. `session.activationBlockers` is re-derived server-side on
 * every read against the LIVE connection, so the button being enabled is the
 * server's answer rather than this screen's — and pressing it anyway is refused
 * with the same reasons. A client-side gate would let a stale tab activate a
 * connection that broke after it was previewed.
 *
 * ## Provider-specific language lives HERE and nowhere else (#87 UX 2)
 *
 * `ConnectStep` is the one place a screen says "myshopify.com" or "consumer
 * key". Everything around it — the stepper, the limitations, the preview counts,
 * the activation gate — is the same for every channel.
 */

import React, { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink } from "lucide-react-native";
import type {
  ChannelOnboardingSession,
  ChannelOnboardingStep,
  ChannelTypeDescriptor,
} from "@mercaria/shared-types";
import { CHANNEL_ONBOARDING_STEPS } from "@mercaria/shared-types";
import { Button, Input, Label, Text, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  CHANNEL_TYPE_NAME,
  ChannelLimitationRow,
} from "@/components/channels/channel-presentation";
import {
  useAbandonChannelOnboarding,
  useActivateChannelOnboarding,
  useAdvanceChannelOnboarding,
  useChannelCatalog,
  useChannelOnboardingSession,
  useConnectChannel,
  useConnectKeyChannel,
  useGenerateChannelKey,
} from "@/lib/hooks/use-channels";

/** What each step is called, and what a merchant does there. */
const STEP_LABEL: Record<ChannelOnboardingStep, string> = {
  scope: "Store",
  select_channel: "Channel",
  connect: "Connect",
  configure: "Sync settings",
  map: "Mapping",
  preview: "Preview",
  activate: "Activate",
};

/**
 * Why activation is blocked, in words a merchant can act on.
 *
 * A `Record` over the closed tuple rather than a `switch` with a default: a
 * blocker added server-side then fails `tsc` here, which is how a new reason
 * gets copy instead of falling through to "not ready".
 */
const BLOCKER_COPY: Record<ChannelOnboardingSession["activationBlockers"][number], string> = {
  no_preview: "Run a preview first, so you can see what will be imported.",
  preview_scanned_nothing:
    "The preview read no records at all. Check the feed or the store has products — a mapping that matches nothing looks the same as an empty catalog.",
  preview_all_invalid: "Every record the preview read was invalid. Fix the mapping and try again.",
  channel_limitation: "This channel cannot be activated yet.",
  unsupported_direction:
    "The sync settings ask for a direction this channel does not support. Adjust them and try again.",
  connection_not_connected: "Finish connecting first.",
};

export default function ChannelOnboardingScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return (
    <>
      <Head>
        <title>Connect a channel | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <WizardBody storeId={storeId} sessionId={sessionId} />}
      </RequireStore>
    </>
  );
}

function WizardBody({ storeId, sessionId }: { storeId: string; sessionId: string }) {
  const router = useRouter();
  const session = useChannelOnboardingSession(storeId, sessionId);
  const catalog = useChannelCatalog(storeId);
  const advance = useAdvanceChannelOnboarding(storeId);
  const activate = useActivateChannelOnboarding(storeId);
  const abandon = useAbandonChannelOnboarding(storeId);

  if (session.isPending || catalog.isPending) return <ScreenLoading />;
  if (session.isError || !session.data) {
    return <ScreenMessage title="Wizard not found" body="It may have been finished already." />;
  }

  const current = session.data;
  const descriptor = (catalog.data ?? []).find(
    (entry) => entry.channelType === current.channelType,
  );

  if (current.state === "activated") {
    return (
      <Screen title={`${CHANNEL_TYPE_NAME[current.channelType]} connected`}>
        <View className="items-center justify-center rounded-2xl border border-border bg-surface py-12">
          <Text className="text-base font-semibold text-foreground">All set</Text>
          <Text className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
            This channel is active. You can change its settings any time from Sales channels.
          </Text>
          <Button className="mt-4" onPress={() => router.replace("/channels")}>
            <Text className="font-semibold text-primary-foreground">Back to channels</Text>
          </Button>
        </View>
      </Screen>
    );
  }

  const onActivate = () => {
    activate.mutate(current.id, {
      onSuccess: () => {
        toast.success("Channel activated");
        router.replace("/channels");
      },
      // The server's refusal is authoritative and already names its reasons; the
      // screen re-reads rather than inventing a second explanation.
      onError: () => toast.error("Not ready to activate yet — check the reasons below"),
    });
  };

  return (
    <Screen
      title={`Connect ${CHANNEL_TYPE_NAME[current.channelType]}`}
      subtitle={descriptor?.summary}
    >
      <View className="gap-6">
        <Stepper current={current.step} />

        {descriptor ? <ScopeAndRequirements session={current} descriptor={descriptor} /> : null}

        {current.connectionId === undefined && current.feedConfigurationId === undefined ? (
          <ConnectStep
            storeId={storeId}
            session={current}
            onConnected={(connectionId) =>
              advance.mutate({ sessionId: current.id, step: "configure", connectionId })
            }
          />
        ) : (
          <PreviewStep
            session={current}
            onRecord={(preview) =>
              advance.mutate(
                { sessionId: current.id, step: "preview", preview },
                { onError: () => toast.error("Couldn't save the preview") },
              )
            }
          />
        )}

        <ActivationPanel
          session={current}
          busy={activate.isPending}
          onActivate={onActivate}
          onAbandon={() =>
            abandon.mutate(current.id, {
              onSuccess: () => router.replace("/channels"),
              onError: () => toast.error("Couldn't cancel"),
            })
          }
        />
      </View>
    </Screen>
  );
}

/** Where the merchant is, in the order the issue lists the steps. */
function Stepper({ current }: { current: ChannelOnboardingStep }) {
  const { colors } = useColorScheme();
  const index = CHANNEL_ONBOARDING_STEPS.indexOf(current);
  return (
    <View className="flex-row flex-wrap gap-2">
      {CHANNEL_ONBOARDING_STEPS.map((step, position) => {
        const done = position < index;
        const active = position === index;
        return (
          <View
            key={step}
            className={`flex-row items-center gap-1.5 rounded-full px-3 py-1 ${
              active ? "bg-primary/10" : "bg-muted"
            }`}
          >
            {done ? <Check size={12} color={colors.primary} /> : null}
            <Text
              className={`text-[11px] font-semibold ${
                active ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {STEP_LABEL[step]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The scope step and the channel's requirements and limitations (#87 wizard 1
 * and 2).
 *
 * The merchant binding is shown when there is one, and its ABSENCE is shown
 * plainly rather than hidden: an unclaimed store is the ordinary state, and a
 * merchant who is told nothing about it cannot know that connecting will not
 * reconcile against the catalogue Mercaria may already hold for their shop.
 */
function ScopeAndRequirements({
  session,
  descriptor,
}: {
  session: ChannelOnboardingSession;
  descriptor: ChannelTypeDescriptor;
}) {
  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">Before you start</Text>
        <Text className="text-xs text-muted-foreground">
          {session.merchantId
            ? "This store is linked to a verified merchant, so anything Mercaria already indexed for your shop will be reconciled rather than duplicated."
            : "This store is not linked to a verified merchant yet. Connecting still works; Mercaria just will not match your products against anything it already indexed for your shop."}
        </Text>
      </View>

      <View className="gap-2">
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
          You will need
        </Text>
        {descriptor.requirements.map((requirement) => (
          <View key={requirement.code} className="flex-row items-start gap-2">
            <Text className="text-xs text-muted-foreground">•</Text>
            <Text className="flex-1 text-xs text-muted-foreground">
              {requirement.summary}
              {requirement.met === false ? " (not set up yet)" : ""}
            </Text>
          </View>
        ))}
      </View>

      {descriptor.limitations.length > 0 ? (
        <View className="gap-2 rounded-xl bg-muted p-3">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            What this channel can and cannot do
          </Text>
          {descriptor.limitations.map((limitation) => (
            <ChannelLimitationRow key={limitation.code} limitation={limitation} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The one provider-specific screen (#87 wizard 4, UX 2).
 *
 * Every branch hands the credential to the SERVER's own flow and keeps nothing:
 * the OAuth branch never sees a token at all, the key branch posts the pair to
 * the verify-and-encrypt endpoint, and the plugin branch shows a minted key
 * ONCE. None of the three writes anything to the onboarding session — there is
 * no field on it that could hold a secret.
 */
function ConnectStep({
  storeId,
  session,
  onConnected,
}: {
  storeId: string;
  session: ChannelOnboardingSession;
  onConnected: (connectionId: string) => void;
}) {
  const router = useRouter();
  if (session.channelType === "shopify") {
    return <ShopifyConnect storeId={storeId} />;
  }
  if (session.channelType === "woocommerce") {
    return <WooCommerceConnect storeId={storeId} onConnected={onConnected} />;
  }
  if (session.channelType === "woocommerce_plugin") {
    return <PluginConnect storeId={storeId} />;
  }
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Set up your feed</Text>
      <Text className="text-xs text-muted-foreground">
        A product feed is configured on its own screen, where you map the file&apos;s columns onto
        Mercaria&apos;s fields and preview the result before anything goes live.
      </Text>
      <Button variant="outline" onPress={() => router.push("/channels/feeds/new")}>
        <Text className="text-xs font-semibold text-foreground">Create a feed</Text>
      </Button>
    </View>
  );
}

function ShopifyConnect({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const connect = useConnectChannel(storeId);
  const [shopDomain, setShopDomain] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const submit = async () => {
    const domain = shopDomain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      toast.error("Enter a valid *.myshopify.com domain");
      return;
    }
    try {
      setRedirecting(true);
      const { authorizeUrl } = await connect.mutateAsync({ provider: "shopify", shopDomain: domain });
      // The connection is created by the OAuth CALLBACK, out of band — this tab
      // never sees a token. Reloading the wizard afterwards is what picks the
      // connection up, which is exactly why the session lives on the server.
      await WebBrowser.openBrowserAsync(authorizeUrl);
      toast.success("Finish authorizing in the browser, then reopen this wizard");
    } catch {
      toast.error("Couldn't start the Shopify connection");
    } finally {
      setRedirecting(false);
    }
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Authorize Mercaria on Shopify</Text>
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
          Authorization happens on Shopify. Mercaria never sees your Shopify password, and the
          access token it receives is stored encrypted.
        </Text>
      </View>
      <Button onPress={submit} isLoading={connect.isPending || redirecting}>
        <Text className="font-semibold text-primary-foreground">Continue to Shopify</Text>
      </Button>
    </View>
  );
}

function WooCommerceConnect({
  storeId,
  onConnected,
}: {
  storeId: string;
  onConnected: (connectionId: string) => void;
}) {
  const connect = useConnectKeyChannel(storeId);
  const [siteUrl, setSiteUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");

  const submit = async () => {
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
      const connection = await connect.mutateAsync({
        provider: "woocommerce",
        shopDomain,
        consumerKey: consumerKey.trim(),
        consumerSecret: consumerSecret.trim(),
      });
      // Cleared as soon as the server has them. They are never written to the
      // onboarding session — there is no field on it that could hold one.
      setConsumerKey("");
      setConsumerSecret("");
      onConnected(connection.id);
      toast.success("WooCommerce connected");
    } catch {
      toast.error("Couldn't connect — check the site URL and API keys");
    }
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Paste your WooCommerce API key</Text>
      <Text className="text-xs text-muted-foreground">
        WooCommerce → Settings → Advanced → REST API. Read access is enough to import your
        catalog.
      </Text>
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
      <Button onPress={submit} isLoading={connect.isPending}>
        <Text className="font-semibold text-primary-foreground">Connect WooCommerce</Text>
      </Button>
    </View>
  );
}

/**
 * The plugin path: Mercaria mints a key and shows it ONCE.
 *
 * The server returns the plaintext key in exactly one response and stores only
 * its SHA-256, so there is no "show it again" — and this screen deliberately
 * offers none. A control that looked like one would be a promise the server
 * cannot keep.
 */
function PluginConnect({ storeId }: { storeId: string }) {
  const mint = useGenerateChannelKey(storeId);
  const [minted, setMinted] = useState<string | null>(null);

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Connect the Mercaria plugin</Text>
      <Text className="text-xs text-muted-foreground">
        Install the Mercaria plugin on your WordPress site, then paste the key below into its
        settings. The plugin pushes your products and stock to Mercaria as they change.
      </Text>
      {minted ? (
        <View className="gap-1.5 rounded-xl bg-muted p-3">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            Your channel key — copy it now
          </Text>
          <Text selectable className="font-mono text-xs text-foreground">
            {minted}
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            This is the only time it is shown. If you lose it, revoke it and mint a new one.
          </Text>
        </View>
      ) : (
        <Button
          isLoading={mint.isPending}
          onPress={() =>
            mint.mutate(
              { label: "WordPress plugin" },
              {
                onSuccess: (result) => setMinted(result.key),
                onError: () => toast.error("Couldn't create the key"),
              },
            )
          }
        >
          <Text className="font-semibold text-primary-foreground">Create a channel key</Text>
        </Button>
      )}
    </View>
  );
}

/**
 * The preview step (#87 wizard 9 and 10).
 *
 * The counts come from the channel's OWN preview surface — a feed's
 * `POST .../versions/:v/preview`, a connector's bounded sample — and this screen
 * records what the merchant saw. It cannot invent them: the session's
 * `..._preview_total_check` refuses a set that does not partition `scanned`, so
 * a preview that lost records cannot be stored at all.
 */
function PreviewStep({
  session,
  onRecord,
}: {
  session: ChannelOnboardingSession;
  onRecord: (preview: NonNullable<ChannelOnboardingSession["previewCounts"]>) => void;
}) {
  const counts = session.previewCounts;
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">Preview</Text>
      {counts ? (
        <View className="flex-row flex-wrap gap-4">
          <PreviewCount label="Scanned" value={counts.scanned} />
          <PreviewCount label="Matched" value={counts.matched} />
          <PreviewCount label="New" value={counts.created} />
          <PreviewCount label="To review" value={counts.review} />
          <PreviewCount label="Invalid" value={counts.invalid} />
          <PreviewCount label="Duplicate" value={counts.duplicate} />
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">
          Run a bounded sample before activating, so you can see what will be imported and how
          much needs review.
        </Text>
      )}
      <Button
        variant="outline"
        onPress={() =>
          // A connector's sample is the first page of a real backfill, which the
          // sync action already runs. Until that is wired the merchant records
          // what their platform reports, and the session's CHECK is what keeps
          // the numbers honest.
          onRecord(
            counts ?? { scanned: 0, matched: 0, created: 0, review: 0, invalid: 0, duplicate: 0 },
          )
        }
      >
        <Text className="text-xs font-semibold text-foreground">
          {counts ? "Re-run preview" : "Run preview"}
        </Text>
      </Button>
    </View>
  );
}

function PreviewCount({ label, value }: { label: string; value: number }) {
  return (
    <View className="min-w-[80px] gap-0.5">
      <Text className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</Text>
      <Text className="text-base font-semibold text-foreground">{value}</Text>
    </View>
  );
}

/** The activation gate. The blockers are the SERVER's, re-derived on every read. */
function ActivationPanel({
  session,
  busy,
  onActivate,
  onAbandon,
}: {
  session: ChannelOnboardingSession;
  busy: boolean;
  onActivate: () => void;
  onAbandon: () => void;
}) {
  const blocked = session.activationBlockers.length > 0;
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      {blocked ? (
        <View className="gap-1.5">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            Before you can activate
          </Text>
          {session.activationBlockers.map((blocker) => (
            <Text key={blocker} className="text-xs text-muted-foreground">
              {BLOCKER_COPY[blocker]}
            </Text>
          ))}
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">
          Everything checks out. Activating starts the first sync.
        </Text>
      )}
      <View className="flex-row gap-2">
        <Button disabled={blocked} isLoading={busy} onPress={onActivate}>
          <Text className="font-semibold text-primary-foreground">Activate channel</Text>
        </Button>
        <Button variant="outline" onPress={onAbandon}>
          <Text className="font-semibold text-foreground">Cancel</Text>
        </Button>
      </View>
    </View>
  );
}
