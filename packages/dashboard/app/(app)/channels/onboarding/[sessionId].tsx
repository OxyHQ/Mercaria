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
  CHANNEL_TYPE_NAME_KEYS,
  ChannelCoverage,
  ChannelLimitationRow,
} from "@/components/channels/channel-presentation";
import { useTranslation } from "@/lib/i18n";
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

/**
 * What each step is called, and what a merchant does there — translation KEYS
 * (#398), since module scope is evaluated before the locale store rehydrates.
 */
const STEP_LABEL_KEYS: Record<ChannelOnboardingStep, string> = {
  scope: "channels.wizard.step.scope",
  select_channel: "channels.wizard.step.selectChannel",
  connect: "channels.wizard.step.connect",
  configure: "channels.wizard.step.configure",
  map: "channels.wizard.step.map",
  preview: "channels.wizard.step.preview",
  activate: "channels.wizard.step.activate",
};

/**
 * Why activation is blocked, in words a merchant can act on.
 *
 * A `Record` over the closed tuple rather than a `switch` with a default: a
 * blocker added server-side then fails `tsc` here, which is how a new reason
 * gets copy instead of falling through to "not ready".
 */
const BLOCKER_COPY_KEYS: Record<ChannelOnboardingSession["activationBlockers"][number], string> = {
  no_preview: "channels.wizard.blocker.noPreview",
  preview_scanned_nothing: "channels.wizard.blocker.previewScannedNothing",
  preview_all_invalid: "channels.wizard.blocker.previewAllInvalid",
  channel_limitation: "channels.wizard.blocker.channelLimitation",
  unsupported_direction: "channels.wizard.blocker.unsupportedDirection",
  connection_not_connected: "channels.wizard.blocker.connectionNotConnected",
};

export default function ChannelOnboardingScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("channels.wizard.documentTitle")}</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <WizardBody storeId={storeId} sessionId={sessionId} />}
      </RequireStore>
    </>
  );
}

function WizardBody({ storeId, sessionId }: { storeId: string; sessionId: string }) {
  const router = useRouter();
  const { t } = useTranslation();
  // The instant the merchant was sent to a platform's consent screen, or null.
  //
  // A Shopify connect leaves this tab and the connection is created by the
  // callback, out of band — so this tab has nothing to observe unless it asks.
  // It is the SCREEN's fact (only this component knows a handoff happened) and
  // the QUERY's job to stop asking once the session carries a connection.
  const [oauthHandoffAt, setOAuthHandoffAt] = useState<number | null>(null);
  const session = useChannelOnboardingSession(storeId, sessionId, {
    awaitingConnectionSince: oauthHandoffAt,
  });
  const catalog = useChannelCatalog(storeId);
  const advance = useAdvanceChannelOnboarding(storeId);
  const activate = useActivateChannelOnboarding(storeId);
  const abandon = useAbandonChannelOnboarding(storeId);

  if (session.isPending || catalog.isPending) return <ScreenLoading />;
  if (session.isError || !session.data) {
    return (
      <ScreenMessage
        title={t("channels.wizard.notFound")}
        body={t("channels.wizard.notFoundBody")}
      />
    );
  }

  const current = session.data;
  const descriptor = (catalog.data ?? []).find(
    (entry) => entry.channelType === current.channelType,
  );

  if (current.state === "activated") {
    // A connected channel imports NOTHING until a resource is set to pull — every
    // direction defaults to `off` — so this panel used to end the flow by naming
    // the settings screen in prose and handing the merchant back to the index. It
    // now takes them there. Feed sessions have no connection to point at and keep
    // the old destination.
    const settingsHref =
      current.connectionId === undefined
        ? ("/channels" as const)
        : ({
            pathname: "/channels/[connectionId]" as const,
            params: { connectionId: current.connectionId },
          } as const);
    return (
      <Screen
        title={t("channels.wizard.connectedTitle", {
          channel: t(CHANNEL_TYPE_NAME_KEYS[current.channelType]),
        })}
      >
        <View className="items-center justify-center rounded-2xl border border-border bg-surface py-12">
          <Text className="text-base font-semibold text-foreground">
            {t("channels.wizard.allSet")}
          </Text>
          <Text className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
            {current.connectionId === undefined
              ? t("channels.wizard.activeFeedBody")
              : t("channels.wizard.activeConnectionBody")}
          </Text>
          <Button className="mt-4" onPress={() => router.replace(settingsHref)}>
            <Text className="font-semibold text-primary-foreground">
              {current.connectionId === undefined
                ? t("channels.wizard.backToChannels")
                : t("channels.wizard.chooseWhatToImport")}
            </Text>
          </Button>
        </View>
      </Screen>
    );
  }

  const onActivate = () => {
    activate.mutate(current.id, {
      onSuccess: () => {
        toast.success(t("channels.toast.channelActivated"));
        router.replace("/channels");
      },
      // The server's refusal is authoritative and already names its reasons; the
      // screen re-reads rather than inventing a second explanation.
      onError: () => toast.error(t("channels.toast.notReadyToActivate")),
    });
  };

  return (
    <Screen
      title={t("channels.wizard.title", {
        channel: t(CHANNEL_TYPE_NAME_KEYS[current.channelType]),
      })}
      subtitle={descriptor?.summary}
    >
      <View className="gap-6">
        <Stepper current={current.step} />

        {descriptor ? <ScopeAndRequirements session={current} descriptor={descriptor} /> : null}

        {current.connectionId === undefined && current.feedConfigurationId === undefined ? (
          <ConnectStep
            storeId={storeId}
            session={current}
            awaitingOAuth={oauthHandoffAt !== null}
            onOAuthHandoff={() => setOAuthHandoffAt(Date.now())}
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
                { onError: () => toast.error(t("channels.toast.previewSaveFailed")) },
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
              onError: () => toast.error(t("channels.toast.cancelFailed")),
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
  const { t } = useTranslation();
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
              {t(STEP_LABEL_KEYS[step])}
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
  const { t } = useTranslation();
  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">
          {t("channels.wizard.beforeYouStart")}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {session.merchantId
            ? t("channels.wizard.merchantLinked")
            : t("channels.wizard.merchantNotLinked")}
        </Text>
      </View>

      <View className="gap-2">
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
          {t("channels.wizard.youWillNeed")}
        </Text>
        {descriptor.requirements.map((requirement) => (
          <View key={requirement.code} className="flex-row items-start gap-2">
            <Text className="text-xs text-muted-foreground">•</Text>
            <Text className="flex-1 text-xs text-muted-foreground">
              {requirement.summary}
              {requirement.met === false ? t("channels.wizard.notSetUpYet") : ""}
            </Text>
          </View>
        ))}
      </View>

      {/*
        #380, the FULL form: every entity, with the reason each absent one is
        absent. This is the step where a merchant decides, so it is where the
        reasons belong — and it is the step that has to answer "will my discounts
        come across" BEFORE the answer costs somebody a support thread.
      */}
      <View className="gap-2 rounded-xl bg-muted p-3">
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
          {t("channels.scope.title")}
        </Text>
        <ChannelCoverage coverage={descriptor.entityCoverage} />
      </View>

      {descriptor.limitations.length > 0 ? (
        <View className="gap-2 rounded-xl bg-muted p-3">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            {t("channels.wizard.canAndCannot")}
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
  awaitingOAuth,
  onOAuthHandoff,
  onConnected,
}: {
  storeId: string;
  session: ChannelOnboardingSession;
  awaitingOAuth: boolean;
  onOAuthHandoff: () => void;
  onConnected: (connectionId: string) => void;
}) {
  const router = useRouter();
  const { t } = useTranslation();
  if (session.channelType === "shopify") {
    return (
      <ShopifyConnect
        storeId={storeId}
        session={session}
        awaiting={awaitingOAuth}
        onHandoff={onOAuthHandoff}
      />
    );
  }
  if (session.channelType === "woocommerce") {
    return <WooCommerceConnect storeId={storeId} onConnected={onConnected} />;
  }
  if (session.channelType === "woocommerce_plugin") {
    return <PluginConnect storeId={storeId} />;
  }
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("channels.wizard.feed.title")}
      </Text>
      <Text className="text-xs text-muted-foreground">{t("channels.wizard.feed.body")}</Text>
      <Button variant="outline" onPress={() => router.push("/channels/feeds/new")}>
        <Text className="text-xs font-semibold text-foreground">
          {t("channels.wizard.feed.create")}
        </Text>
      </Button>
    </View>
  );
}

function ShopifyConnect({
  storeId,
  session,
  awaiting,
  onHandoff,
}: {
  storeId: string;
  session: ChannelOnboardingSession;
  awaiting: boolean;
  onHandoff: () => void;
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const connect = useConnectChannel(storeId);
  const [shopDomain, setShopDomain] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const submit = async () => {
    const domain = shopDomain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      toast.error(t("channels.toast.invalidShopifyDomain"));
      return;
    }
    try {
      setRedirecting(true);
      // The session id is sent so the SERVER can sign it into the OAuth `state`.
      // The connection is created by the callback, out of band — this tab never
      // sees a token or a connection id — so the callback is the only thing that
      // can record which wizard the connect belonged to.
      const { authorizeUrl } = await connect.mutateAsync({
        provider: "shopify",
        shopDomain: domain,
        onboardingSessionId: session.id,
      });
      // Armed BEFORE the browser opens: on web `openBrowserAsync` resolves as
      // soon as the tab is opened, and on native not until it is dismissed. The
      // wizard has to be watching across both.
      onHandoff();
      await WebBrowser.openBrowserAsync(authorizeUrl);
    } catch {
      toast.error(t("channels.toast.shopifyConnectFailed"));
    } finally {
      setRedirecting(false);
    }
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("channels.wizard.shopify.title")}
      </Text>
      <View className="gap-1.5">
        <Label>{t("channels.wizard.shopify.domainLabel")}</Label>
        <Input
          value={shopDomain}
          onChangeText={setShopDomain}
          placeholder={t("channels.wizard.shopify.domainPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>
      <View className="flex-row items-start gap-2 rounded-xl bg-muted p-3">
        <ExternalLink size={14} color={colors.mutedForeground} />
        <Text className="flex-1 text-xs text-muted-foreground">
          {t("channels.wizard.shopify.authNote")}
        </Text>
      </View>
      {/*
        Shown once the merchant has been handed off, because the wizard is now
        WAITING rather than idle and a screen that looks unchanged is the whole
        complaint. It says the page will update itself, which is a promise the
        poll in `useChannelOnboardingSession` keeps — and it stays until the
        session carries a connection, at which point this step stops rendering.
      */}
      {awaiting ? (
        <View className="gap-1 rounded-xl bg-primary/10 p-3">
          <Text className="text-xs font-semibold text-primary">
            {t("channels.wizard.shopify.waitingTitle")}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t("channels.wizard.shopify.waitingBody")}
          </Text>
        </View>
      ) : null}
      <Button onPress={submit} isLoading={connect.isPending || redirecting}>
        <Text className="font-semibold text-primary-foreground">
          {awaiting
            ? t("channels.wizard.shopify.openAgain")
            : t("channels.wizard.shopify.continue")}
        </Text>
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
  const { t } = useTranslation();
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
      toast.error(t("channels.toast.siteUrlMustBeHttps"));
      return;
    }
    if (consumerKey.trim() === "" || consumerSecret.trim() === "") {
      toast.error(t("channels.toast.consumerKeyAndSecretRequired"));
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
      toast.success(t("channels.toast.wooConnected"));
    } catch {
      toast.error(t("channels.toast.wooConnectFailed"));
    }
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("channels.wizard.woo.title")}
      </Text>
      <Text className="text-xs text-muted-foreground">{t("channels.wizard.woo.body")}</Text>
      <View className="gap-1.5">
        <Label>{t("channels.wizard.woo.siteUrlLabel")}</Label>
        <Input
          value={siteUrl}
          onChangeText={setSiteUrl}
          placeholder={t("channels.wizard.woo.siteUrlPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("channels.wizard.woo.consumerKeyLabel")}</Label>
        <Input
          value={consumerKey}
          onChangeText={setConsumerKey}
          placeholder={t("channels.wizard.woo.consumerKeyPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("channels.wizard.woo.consumerSecretLabel")}</Label>
        <Input
          value={consumerSecret}
          onChangeText={setConsumerSecret}
          placeholder={t("channels.wizard.woo.consumerSecretPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </View>
      <Button onPress={submit} isLoading={connect.isPending}>
        <Text className="font-semibold text-primary-foreground">
          {t("channels.wizard.woo.connect")}
        </Text>
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
  const { t } = useTranslation();
  const mint = useGenerateChannelKey(storeId);
  const [minted, setMinted] = useState<string | null>(null);

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("channels.wizard.plugin.title")}
      </Text>
      <Text className="text-xs text-muted-foreground">{t("channels.wizard.plugin.body")}</Text>
      {minted ? (
        <View className="gap-1.5 rounded-xl bg-muted p-3">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            {t("channels.wizard.plugin.keyHeading")}
          </Text>
          <Text selectable className="font-mono text-xs text-foreground">
            {minted}
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            {t("channels.wizard.plugin.keyNote")}
          </Text>
        </View>
      ) : (
        <Button
          isLoading={mint.isPending}
          onPress={() =>
            mint.mutate(
              // The label is stored on the key row and rendered back to the
              // merchant in the key list, so it is copy — the same default the
              // manual "Generate key" dialog suggests.
              { label: t("channels.keys.labelPlaceholder") },
              {
                onSuccess: (result) => setMinted(result.key),
                onError: () => toast.error(t("channels.toast.keyCreateFailed")),
              },
            )
          }
        >
          <Text className="font-semibold text-primary-foreground">
            {t("channels.wizard.plugin.createKey")}
          </Text>
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
  const { t } = useTranslation();
  const counts = session.previewCounts;
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("channels.wizard.preview.title")}
      </Text>
      {counts ? (
        <View className="flex-row flex-wrap gap-4">
          <PreviewCount label={t("channels.wizard.preview.scanned")} value={counts.scanned} />
          <PreviewCount label={t("channels.wizard.preview.matched")} value={counts.matched} />
          <PreviewCount label={t("common.new")} value={counts.created} />
          <PreviewCount label={t("channels.wizard.preview.toReview")} value={counts.review} />
          <PreviewCount label={t("channels.wizard.preview.invalid")} value={counts.invalid} />
          <PreviewCount label={t("channels.wizard.preview.duplicate")} value={counts.duplicate} />
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">
          {t("channels.wizard.preview.body")}
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
          {counts
            ? t("channels.wizard.preview.rerun")
            : t("channels.wizard.preview.run")}
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
  const { t } = useTranslation();
  const blocked = session.activationBlockers.length > 0;
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      {blocked ? (
        <View className="gap-1.5">
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
            {t("channels.wizard.beforeYouActivate")}
          </Text>
          {session.activationBlockers.map((blocker) => (
            <Text key={blocker} className="text-xs text-muted-foreground">
              {t(BLOCKER_COPY_KEYS[blocker])}
            </Text>
          ))}
        </View>
      ) : (
        <Text className="text-xs text-muted-foreground">
          {t("channels.wizard.everythingChecksOut")}
        </Text>
      )}
      <View className="flex-row gap-2">
        <Button disabled={blocked} isLoading={busy} onPress={onActivate}>
          <Text className="font-semibold text-primary-foreground">
            {t("channels.wizard.activateChannel")}
          </Text>
        </Button>
        <Button variant="outline" onPress={onAbandon}>
          <Text className="font-semibold text-foreground">{t("common.cancel")}</Text>
        </Button>
      </View>
    </View>
  );
}
