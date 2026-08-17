/**
 * Sales channels — ONE area for every way a merchant supplies a catalogue (#87).
 *
 * ## What changed, and why it is not cosmetic
 *
 * This screen used to hold a local `PROVIDERS` table with an `available` flag
 * per connector. That table was the thing #87 acceptance 7 names: a
 * provider-specific client flag standing in for a readiness result nobody owned.
 * It also could not describe the product feed (#63) or the native catalogue at
 * all, so a merchant had three mental models for one question.
 *
 * Everything on this screen now comes from the server:
 *
 *  - the CATALOG (`GET .../channels/catalog`) says what may be connected, what
 *    each channel supports, and what is wrong with it today — including the
 *    connector defects that are still OPEN (#221; #218, #219 and #220 are
 *    fixed), which a merchant sees BEFORE choosing rather than after a week of
 *    silent webhook failures;
 *  - the SUMMARY (`GET .../channels/summary`) is connectors, feeds and the
 *    native catalogue in one shape;
 *  - the READINESS result (`GET .../channels/readiness`) is the one authority on
 *    whether a merchant can actually sell, with its three axes kept apart
 *    (#87 UX 5 and 6).
 *
 * The credential forms moved to the wizard's connect step, which is where a
 * provider-specific screen belongs (#87 UX 2): a Shopify consent redirect and a
 * WooCommerce key pair genuinely are different things, and everything around
 * them is now shared.
 */

import React from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  FileSpreadsheet,
  Plug,
  Store as StoreIcon,
} from "lucide-react-native";
import type {
  ChannelHealthState,
  ChannelPauseScope,
  ChannelReadiness,
  ChannelSummary,
  ChannelTypeDescriptor,
} from "@mercaria/shared-types";
import { Button, Text, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  CHANNEL_TYPE_NAME_KEYS,
  ChannelCoverage,
  ChannelLimitationRow,
  ChannelStateBadge,
  NativeCheckoutBadge,
  READINESS_BLOCKER_COPY_KEYS,
  formatWhen,
} from "@/components/channels/channel-presentation";
import { useTranslation } from "@/lib/i18n";
import {
  useChannelCatalog,
  useChannelReadiness,
  useChannelSummary,
  useStartChannelOnboarding,
} from "@/lib/hooks/use-channels";

/**
 * Translation KEYS per pause scope, not sentences (#485).
 *
 * `pausedScopes` is `ChannelPauseScope[]` — the API's wire vocabulary — and it
 * used to be joined and interpolated into `channels.pausedScopes` verbatim, so
 * a merchant read "En pausa: fetch y publication" in Spanish and
 * "موقوف مؤقتًا: fetch و publication" in Arabic. The label around the two words
 * was translated; the two words carrying the meaning were not.
 *
 * Nothing in CI could see it: the values come from an API response, so part A
 * finds no literal, part B passes (the key exists in all twelve bundles) and
 * part C passes (both keys are referenced). `docs/app-i18n.md` names this exact
 * shape under "What the guard cannot see".
 *
 * The keys are LITERAL rather than `` t(`channels.pauseScope.${scope}`) ``: a
 * runtime-built key names no leaf, so part C would report both as dead copy and
 * refuse them. Written out, part C holds the two sides together — rename one
 * and the other is referenced by nothing.
 *
 * These are TERMS, deliberately distinct from `channels.pause.importing` and
 * `channels.pause.publishing`, which are the toggle LABELS on the connection
 * screen. #442 is what happens when one key serves both roles: an action label
 * is an imperative ("Pause importing"), and interpolating one here would read
 * "Paused: pause importing". The scope VALUES are untouched — they are the
 * API's vocabulary, not copy.
 */
const CHANNEL_PAUSE_SCOPE_LABEL_KEYS: Record<ChannelPauseScope, string> = {
  fetch: "channels.pauseScope.fetch",
  publication: "channels.pauseScope.publication",
};

export default function ChannelsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("channels.documentTitle")}</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <ChannelsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function ChannelsBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const summary = useChannelSummary(storeId);
  const catalog = useChannelCatalog(storeId);
  const readiness = useChannelReadiness(storeId);

  const pending = summary.isPending || catalog.isPending || readiness.isPending;
  const failed = summary.isError || catalog.isError || readiness.isError;

  return (
    <Screen
      title={t("channels.title")}
      subtitle={t("channels.subtitle")}
      action={<StoreSwitcher />}
    >
      {pending ? (
        <ScreenLoading />
      ) : failed ? (
        <ScreenMessage title={t("channels.loadFailed")} body={t("common.pleaseTryAgain")} />
      ) : (
        <View className="gap-8">
          {readiness.data ? <ReadinessPanel readiness={readiness.data} /> : null}
          <ConnectedChannels channels={summary.data ?? []} />
          <AvailableChannels
            storeId={storeId}
            descriptors={catalog.data ?? []}
            connected={summary.data ?? []}
          />
        </View>
      )}
    </Screen>
  );
}

/**
 * The readiness axes, side by side and never collapsed (#87 UX 5 and 6).
 *
 * A merchant with a perfect Shopify sync and no Stripe account sees a healthy
 * catalogue, blocked payouts, and a list naming exactly which of the two is in
 * the way. One combined badge would say "not ready" and leave them guessing.
 */
function ReadinessPanel({ readiness }: { readiness: ChannelReadiness }) {
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();
  const ready = readiness.nativeCheckout.state === "healthy";
  const connectedCount = readiness.catalog.connectedChannelTypes.length;

  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        {ready ? (
          <CheckCircle2 size={18} color={colors.primary} />
        ) : (
          <CircleAlert size={18} color={colors.mutedForeground} />
        )}
        <Text className="text-sm font-semibold text-foreground">
          {ready ? t("channels.readiness.ready") : t("channels.readiness.notReady")}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-3">
        <ReadinessAxis
          label={t("channels.readiness.catalog")}
          state={readiness.catalog.state}
          detail={
            connectedCount === 0
              ? t("channels.readiness.noChannelConnected")
              : t("channels.readiness.catalogDetail", {
                  channels: t("channels.readiness.channelCount", { count: connectedCount }),
                  sync: readiness.catalog.lastSuccessfulSyncAt
                    ? t("channels.readiness.lastSynced", {
                        when: formatWhen(
                          readiness.catalog.lastSuccessfulSyncAt,
                          t("channels.never"),
                          locale,
                        ),
                      })
                    : t("channels.readiness.neverSynced"),
                })
          }
        />
        <ReadinessAxis
          label={t("channels.readiness.payouts")}
          state={readiness.payments.state}
          detail={
            readiness.payments.railEnabled
              ? readiness.payments.state === "healthy"
                ? t("channels.readiness.payoutsSetUp")
                : t("channels.readiness.payoutsNotSetUp")
              : t("channels.readiness.cardPaymentsOff")
          }
        />
      </View>

      {readiness.nativeCheckout.blockers.length > 0 ? (
        <View className="gap-1.5 rounded-xl bg-muted p-3">
          {readiness.nativeCheckout.blockers.map((blocker) => (
            <Text key={blocker} className="text-xs text-muted-foreground">
              {t(READINESS_BLOCKER_COPY_KEYS[blocker])}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ReadinessAxis({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: ChannelHealthState;
}) {
  const tone =
    state === "healthy"
      ? "text-primary"
      : state === "degraded"
        ? "text-foreground"
        : "text-muted-foreground";
  return (
    <View className="min-w-[180px] flex-1 gap-0.5">
      <Text className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</Text>
      <Text className={`text-xs font-medium ${tone}`}>{detail}</Text>
    </View>
  );
}

/** Everything currently supplying a catalogue, in one list. */
function ConnectedChannels({ channels }: { channels: ChannelSummary[] }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();

  // The native catalogue is always present, so "nothing connected" means nothing
  // BESIDES it — a list that hid the native row would tell a merchant with fifty
  // hand-typed products that they have no channels at all.
  const external = channels.filter((channel) => channel.channelType !== "native");

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.yourChannels")}
      </Text>
      {external.length === 0 ? (
        <View className="items-center justify-center rounded-2xl border border-dashed border-border py-12">
          <Plug size={32} className="text-muted-foreground" />
          <Text className="mt-4 text-base font-semibold text-foreground">
            {t("channels.empty.title")}
          </Text>
          <Text className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
            {t("channels.empty.body")}
          </Text>
        </View>
      ) : null}
      <View className="gap-2">
        {channels.map((channel) => (
          <Pressable
            key={channel.id}
            disabled={channel.channelType === "native"}
            onPress={() =>
              router.push(
                channel.channelType === "product_feed"
                  ? `/channels/feeds/${channel.id}`
                  : `/channels/${channel.id}`,
              )
            }
            className="rounded-2xl border border-border bg-surface p-4 active:opacity-70"
          >
            <View className="flex-row items-start gap-3">
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
                {channel.channelType === "product_feed" ? (
                  <FileSpreadsheet size={20} color={colors.mutedForeground} />
                ) : (
                  <StoreIcon size={20} color={colors.mutedForeground} />
                )}
              </View>
              <View className="flex-1 gap-1">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-sm font-semibold text-foreground">
                    {t(CHANNEL_TYPE_NAME_KEYS[channel.channelType])}
                  </Text>
                  <ChannelStateBadge state={channel.state} />
                  <NativeCheckoutBadge supported={channel.supportsNativeCheckout} />
                </View>
                <Text className="text-xs text-muted-foreground">{channel.label}</Text>
                <Text className="text-xs text-muted-foreground">
                  {channel.lastSyncAt
                    ? t("channels.lastSynced", {
                        when: formatWhen(channel.lastSyncAt, t("channels.never"), locale),
                      })
                    : t("channels.neverSynced")}
                  {channel.nextScheduledSyncAt
                    ? t("channels.nextScheduled", {
                        when: formatWhen(
                          channel.nextScheduledSyncAt,
                          t("channels.unscheduled"),
                          locale,
                        ),
                      })
                    : ""}
                </Text>
                {channel.pausedScopes.length > 0 ? (
                  <Text className="text-xs font-medium text-muted-foreground">
                    {t("channels.pausedScopes", {
                      scopes: channel.pausedScopes
                        .map((scope) => t(CHANNEL_PAUSE_SCOPE_LABEL_KEYS[scope]))
                        .join(t("channels.andJoin")),
                    })}
                  </Text>
                ) : null}
                {channel.lastRunCounts ? (
                  <Text className="text-xs text-muted-foreground">
                    {t("channels.lastRunCounts", {
                      created: channel.lastRunCounts.created,
                      updated: channel.lastRunCounts.updated,
                      skipped: channel.lastRunCounts.skipped,
                      failed: channel.lastRunCounts.failed,
                    })}
                  </Text>
                ) : null}
              </View>
              {channel.channelType === "native" ? null : (
                <ArrowRight size={16} color={colors.mutedForeground} />
              )}
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * What may be connected, straight from the server's catalog.
 *
 * "Already connected" is decided against the SUMMARY rather than a local flag —
 * which is also what makes the WooCommerce pull connector and the WooCommerce
 * plugin correctly exclude each other: they share a `connections` unique index,
 * and the summary is what knows.
 */
function AvailableChannels({
  storeId,
  descriptors,
  connected,
}: {
  storeId: string;
  descriptors: ChannelTypeDescriptor[];
  connected: ChannelSummary[];
}) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const start = useStartChannelOnboarding(storeId);

  const connectedTypes = new Set(
    connected
      .filter((channel) => channel.channelType !== "native")
      .map((channel) => channel.channelType),
  );
  // The two WooCommerce channels share `UNIQUE(store_id, provider)`, so having
  // either rules out the other. Stated here because it is a fact about the
  // schema that the descriptor's `single_connection_per_provider` limitation
  // explains but cannot enforce on a button.
  const wooTaken = connectedTypes.has("woocommerce") || connectedTypes.has("woocommerce_plugin");

  const onConnect = (descriptor: ChannelTypeDescriptor) => {
    start.mutate(descriptor.channelType, {
      onSuccess: (session) => router.push(`/channels/onboarding/${session.id}`),
      onError: () =>
        toast.error(t("channels.toast.startConnectFailed", { name: descriptor.name })),
    });
  };

  // WHICH channel is being started, not WHETHER one is. `start` is one mutation
  // shared by every row, so `start.isPending` alone is true for all of them at
  // once and every Connect button spins when one is pressed — a spinner on a
  // button nobody pressed, which reads as the app having misunderstood the tap.
  //
  // `variables` is the argument of the in-flight `mutate`, which here IS the
  // channel type, so it identifies the row without threading a second piece of
  // state through. It is undefined before the first call and retained after one
  // settles, hence the `isPending` conjunct rather than a bare comparison.
  const startingChannelType = start.isPending ? start.variables : undefined;

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.addChannel")}
      </Text>
      <View className="gap-2">
        {descriptors
          .filter((descriptor) => descriptor.channelType !== "native")
          .map((descriptor) => {
            const taken = descriptor.channelType.startsWith("woocommerce")
              ? wooTaken
              : connectedTypes.has(descriptor.channelType);
            const connectable = descriptor.availability === "available" && !taken;
            // Only what a merchant should read BEFORE choosing. The full list,
            // informational entries included, is on the wizard's channel step.
            const notable = descriptor.limitations.filter(
              (limitation) => limitation.severity !== "informational",
            );

            return (
              <View
                key={descriptor.channelType}
                className="gap-3 rounded-2xl border border-border bg-surface p-4"
              >
                <View className="flex-row items-start gap-3">
                  <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
                    {descriptor.kind === "product_feed" ? (
                      <FileSpreadsheet size={20} color={colors.mutedForeground} />
                    ) : (
                      <StoreIcon size={20} color={colors.mutedForeground} />
                    )}
                  </View>
                  <View className="flex-1 gap-1">
                    <View className="flex-row flex-wrap items-center gap-2">
                      <Text className="text-sm font-semibold text-foreground">
                        {descriptor.name}
                      </Text>
                      <NativeCheckoutBadge supported={descriptor.supportsNativeCheckout} />
                      {descriptor.availability === "not_implemented" ? (
                        <View className="rounded-full bg-muted px-2 py-0.5">
                          <Text className="text-[10px] font-semibold text-muted-foreground">
                            {t("channels.availability.notImplemented")}
                          </Text>
                        </View>
                      ) : null}
                      {descriptor.availability === "not_configured" ? (
                        <View className="rounded-full bg-muted px-2 py-0.5">
                          <Text className="text-[10px] font-semibold text-muted-foreground">
                            {t("channels.availability.notConfigured")}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text className="text-xs text-muted-foreground">{descriptor.summary}</Text>
                  </View>
                  {descriptor.availability === "available" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!connectable}
                      isLoading={startingChannelType === descriptor.channelType}
                      onPress={() => onConnect(descriptor)}
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        {taken ? t("channels.state.connected") : t("channels.connect")}
                      </Text>
                    </Button>
                  ) : null}
                </View>

                {/*
                  #380. The COMPACT form, and it is on every card rather than
                  only the ones with something wrong: a channel's absences are
                  not a defect and the `notable` filter below deliberately hides
                  every informational limitation, which is why Shopify displayed
                  nothing at all here. What a channel does not carry is the half
                  a merchant cannot discover by using it, so it is the half that
                  belongs before the choice.
                */}
                <ChannelCoverage coverage={descriptor.entityCoverage} compact />

                {notable.length > 0 ? (
                  <View className="gap-2 rounded-xl bg-muted p-3">
                    {notable.map((limitation) => (
                      <ChannelLimitationRow key={limitation.code} limitation={limitation} />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
      </View>
    </View>
  );
}
