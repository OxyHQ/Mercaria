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
 *    connector defects that are still OPEN (#219–#221; #218 is fixed), which a
 *    merchant sees BEFORE choosing rather than after a week of silent webhook
 *    failures;
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
  CHANNEL_TYPE_NAME,
  ChannelLimitationRow,
  ChannelStateBadge,
  NativeCheckoutBadge,
  READINESS_BLOCKER_COPY,
  formatWhen,
} from "@/components/channels/channel-presentation";
import {
  useChannelCatalog,
  useChannelReadiness,
  useChannelSummary,
  useStartChannelOnboarding,
} from "@/lib/hooks/use-channels";

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
  const summary = useChannelSummary(storeId);
  const catalog = useChannelCatalog(storeId);
  const readiness = useChannelReadiness(storeId);

  const pending = summary.isPending || catalog.isPending || readiness.isPending;
  const failed = summary.isError || catalog.isError || readiness.isError;

  return (
    <Screen
      title="Sales channels"
      subtitle="Every way your products reach Mercaria — connected stores, product feeds and your own catalog"
      action={<StoreSwitcher />}
    >
      {pending ? (
        <ScreenLoading />
      ) : failed ? (
        <ScreenMessage title="Couldn't load channels" body="Please try again." />
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
  const ready = readiness.nativeCheckout.state === "healthy";

  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        {ready ? (
          <CheckCircle2 size={18} color={colors.primary} />
        ) : (
          <CircleAlert size={18} color={colors.mutedForeground} />
        )}
        <Text className="text-sm font-semibold text-foreground">
          {ready ? "Ready to sell on Mercaria" : "Not selling on Mercaria yet"}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-3">
        <ReadinessAxis
          label="Catalog"
          state={readiness.catalog.state}
          detail={
            readiness.catalog.connectedChannelTypes.length === 0
              ? "No channel connected"
              : `${readiness.catalog.connectedChannelTypes.length} channel${
                  readiness.catalog.connectedChannelTypes.length === 1 ? "" : "s"
                } · ${
                  readiness.catalog.lastSuccessfulSyncAt
                    ? `last synced ${formatWhen(readiness.catalog.lastSuccessfulSyncAt, "never")}`
                    : "never synced"
                }`
          }
        />
        <ReadinessAxis
          label="Payouts"
          state={readiness.payments.state}
          detail={
            readiness.payments.railEnabled
              ? readiness.payments.state === "healthy"
                ? "Set up"
                : "Not set up"
              : "Card payments are off for this deployment"
          }
        />
      </View>

      {readiness.nativeCheckout.blockers.length > 0 ? (
        <View className="gap-1.5 rounded-xl bg-muted p-3">
          {readiness.nativeCheckout.blockers.map((blocker) => (
            <Text key={blocker} className="text-xs text-muted-foreground">
              {READINESS_BLOCKER_COPY[blocker]}
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

  // The native catalogue is always present, so "nothing connected" means nothing
  // BESIDES it — a list that hid the native row would tell a merchant with fifty
  // hand-typed products that they have no channels at all.
  const external = channels.filter((channel) => channel.channelType !== "native");

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Your channels</Text>
      {external.length === 0 ? (
        <View className="items-center justify-center rounded-2xl border border-dashed border-border py-12">
          <Plug size={32} className="text-muted-foreground" />
          <Text className="mt-4 text-base font-semibold text-foreground">
            Only your Mercaria catalog
          </Text>
          <Text className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
            Connect a store or a product feed below to bring an existing catalog in.
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
                    {CHANNEL_TYPE_NAME[channel.channelType]}
                  </Text>
                  <ChannelStateBadge state={channel.state} />
                  <NativeCheckoutBadge supported={channel.supportsNativeCheckout} />
                </View>
                <Text className="text-xs text-muted-foreground">{channel.label}</Text>
                <Text className="text-xs text-muted-foreground">
                  {channel.lastSyncAt
                    ? `Last synced ${formatWhen(channel.lastSyncAt, "never")}`
                    : "Never synced"}
                  {channel.nextScheduledSyncAt
                    ? ` · next ${formatWhen(channel.nextScheduledSyncAt, "unscheduled")}`
                    : ""}
                </Text>
                {channel.pausedScopes.length > 0 ? (
                  <Text className="text-xs font-medium text-muted-foreground">
                    Paused: {channel.pausedScopes.join(" and ")}
                  </Text>
                ) : null}
                {channel.lastRunCounts ? (
                  <Text className="text-xs text-muted-foreground">
                    Last run — {channel.lastRunCounts.created} created,{" "}
                    {channel.lastRunCounts.updated} updated, {channel.lastRunCounts.skipped}{" "}
                    skipped, {channel.lastRunCounts.failed} failed
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
      onError: () => toast.error(`Couldn't start connecting ${descriptor.name}`),
    });
  };

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Add a channel</Text>
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
                            Not available yet
                          </Text>
                        </View>
                      ) : null}
                      {descriptor.availability === "not_configured" ? (
                        <View className="rounded-full bg-muted px-2 py-0.5">
                          <Text className="text-[10px] font-semibold text-muted-foreground">
                            Not configured here
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
                      isLoading={start.isPending}
                      onPress={() => onConnect(descriptor)}
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        {taken ? "Connected" : "Connect"}
                      </Text>
                    </Button>
                  ) : null}
                </View>

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
