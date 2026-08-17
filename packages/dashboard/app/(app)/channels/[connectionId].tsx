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
  RadioTower,
  TriangleAlert,
} from "lucide-react-native";
import type {
  ChannelApiKey,
  ChannelDisconnectPolicy,
  ChannelPauseScope,
  ChannelReconciliationSummary,
  Connection,
  ConnectionStatus,
  GenerateChannelApiKeyResult,
  SyncRecordFailure,
  SyncRecordFailureReason,
  SyncResourceDirection,
  SyncRun,
} from "@mercaria/shared-types";
import { CHANNEL_DISCONNECT_POLICIES } from "@mercaria/shared-types";
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
  type Translate,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { CollectionMapping } from "@/components/channels/CollectionMapping";
import {
  WEBHOOK_FAILURE_REASON_COPY_KEYS,
  ChannelCoverage,
  deriveWebhookDelivery,
  describeOrderHorizon,
  formatWhen,
} from "@/components/channels/channel-presentation";
import { useTranslation } from "@/lib/i18n";
import {
  useChannelCatalog,
  useChannels,
  useUpdateChannelSettings,
  useChannelKeys,
  useChannelReconciliation,
  useChannelRunRecordFailures,
  useChannelRuns,
  useDisconnectChannelWithPolicy,
  useGenerateChannelKey,
  usePauseChannel,
  useReregisterChannelWebhooks,
  useRevokeChannelKey,
  useSyncChannel,
} from "@/lib/hooks/use-channels";

/**
 * Translation KEYS rather than sentences (#398) — module scope is evaluated at
 * import, before the locale store has rehydrated. The provider names are the
 * SHARED `channels.type.*` keys the channel list already renders: a provider and
 * a channel type are different things (the WooCommerce plugin and the
 * WooCommerce connector share a provider id), but "Shopify" is one word to a
 * merchant and two keys carrying it are two things a translator can disagree on.
 */
const PROVIDER_NAME_KEYS: Record<Connection["provider"], string> = {
  shopify: "channels.type.shopify",
  woocommerce: "channels.type.woocommerce",
  etsy: "channels.type.etsy",
  prestashop: "channels.type.prestashop",
  magento: "channels.type.magento",
};

const STATUS_LABEL_KEYS: Record<ConnectionStatus, string> = {
  connected: "channels.state.connected",
  error: "channels.state.needsAttention",
  disconnected: "channels.status.disconnected",
};

const DIRECTIONS: readonly SyncResourceDirection[] = ["off", "pull", "push", "bidirectional"];

const DIRECTION_LABEL_KEYS: Record<SyncResourceDirection, string> = {
  off: "channels.syncDirection.off",
  pull: "channels.syncDirection.pull",
  push: "channels.syncDirection.push",
  bidirectional: "channels.syncDirection.both",
};

function isSyncDirection(value: string): value is SyncResourceDirection {
  return value === "off" || value === "pull" || value === "push" || value === "bidirectional";
}

/** Human-readable timestamp, or a fallback when a channel has never synced. */
function formatSyncedAt(iso: string | undefined, t: Translate): string {
  if (!iso) return t("channels.settings.neverSyncedYet");
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return t("channels.settings.neverSyncedYet");
  return t("channels.lastSynced", { when: when.toLocaleString() });
}

export default function ChannelSettingsScreen() {
  const { connectionId } = useLocalSearchParams<{ connectionId: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("channels.settings.documentTitle")}</title>
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
  const { t } = useTranslation();
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
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title={t("channels.settings.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !connection) {
    return (
      <Screen title={t("channels.settings.title")} action={back}>
        <ScreenMessage
          title={t("channels.settings.notFound")}
          body={t("channels.settings.notFoundBody")}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("channels.settings.providerTitle", {
        provider: t(PROVIDER_NAME_KEYS[connection.provider]),
      })}
      subtitle={connection.shopDomain}
      action={back}
    >
      <SettingsForm storeId={storeId} connection={connection} />
      <ChannelScope storeId={storeId} connection={connection} />
      <CollectionMapping storeId={storeId} connection={connection} />
      {connection.mode === "push_in" ? (
        <ChannelApiKeys storeId={storeId} connection={connection} />
      ) : null}
      <WebhookHealth storeId={storeId} connection={connection} />
      <PauseControls storeId={storeId} connection={connection} />
      <ManualSync storeId={storeId} connection={connection} />
      <SyncHistory storeId={storeId} connection={connection} />
      <Reconciliation storeId={storeId} connection={connection} />
      <DisconnectPanel storeId={storeId} connection={connection} />
    </Screen>
  );
}

/**
 * What this channel carries, and how far back its orders reach (#380).
 *
 * Two facts at two GRAINS, deliberately in one panel because a merchant asks
 * them as one question. The coverage is a property of the channel TYPE and comes
 * from the catalog; the horizon is a property of THIS connection's granted
 * scopes and rides on the connection. Keeping the second on the descriptor would
 * make two Shopify shops with different grants report the same bound.
 *
 * The channel type is read off `connection.channelType` rather than re-derived
 * from `(provider, mode)` here: the server derives it with the one function that
 * reads a row as a channel type, and a second spelling in the client is the one
 * that drifts — the WooCommerce plugin and the WooCommerce connector share a
 * provider id and are different channels.
 */
function ChannelScope({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data: catalog } = useChannelCatalog(storeId);
  const descriptor = catalog?.find((entry) => entry.channelType === connection.channelType);
  const horizon = describeOrderHorizon(connection.orderHorizon, t);

  // The catalog is a separate query, so it can still be in flight. Rendering a
  // partial answer here would be worse than rendering none: half a coverage list
  // reads as a complete one.
  if (!descriptor && !horizon) return null;

  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.scope.title")}
      </Text>

      {horizon ? (
        <View className="flex-row items-start gap-2 rounded-xl bg-muted p-3">
          <View className="pt-0.5">
            <History size={14} color={colors.mutedForeground} />
          </View>
          <Text className="flex-1 text-xs text-muted-foreground">{horizon}</Text>
        </View>
      ) : null}

      {descriptor ? <ChannelCoverage coverage={descriptor.entityCoverage} /> : null}
    </View>
  );
}

function SettingsForm({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { t } = useTranslation();
  const update = useUpdateChannelSettings(storeId);
  const [products, setProducts] = useState<SyncResourceDirection>(
    connection.syncSettings.products,
  );
  const [inventory, setInventory] = useState<SyncResourceDirection>(
    connection.syncSettings.inventory,
  );
  const [orders, setOrders] = useState<SyncResourceDirection>(connection.syncSettings.orders);
  const [autoPublish, setAutoPublish] = useState<boolean>(connection.syncSettings.autoPublish);
  // #376 scope: `conflictPolicy` ships with the mapping rather than after it,
  // because it DECIDES the mapping. `applyCollectionMapping` returns early when
  // `collections` is pinned in the listing's `overriddenFields`, and whether
  // those pins are honoured at all is exactly this setting — so a merchant could
  // configure a mapping and never be able to see why it did nothing.
  const [respectOverrides, setRespectOverrides] = useState<boolean>(
    connection.syncSettings.conflictPolicy === "respect_overrides",
  );

  const save = () => {
    update.mutate(
      {
        connectionId: connection.id,
        settings: {
          products,
          inventory,
          orders,
          autoPublish,
          conflictPolicy: respectOverrides ? "respect_overrides" : "connector_wins",
        },
      },
      {
        onSuccess: () => toast.success(t("channels.toast.settingsSaved")),
        onError: () => toast.error(t("channels.toast.settingsSaveFailed")),
      },
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t("channels.settings.syncDirections")}
        </Text>
        <DirectionField
          label={t("channels.entity.products")}
          hint={t("channels.settings.productsHint")}
          value={products}
          onChange={setProducts}
        />
        <DirectionField
          label={t("channels.settings.inventoryLabel")}
          hint={t("channels.settings.inventoryHint")}
          value={inventory}
          onChange={setInventory}
        />
        <DirectionField
          label={t("channels.entity.orders")}
          hint={t("channels.settings.ordersHint")}
          value={orders}
          onChange={setOrders}
        />
      </View>

      <View className="rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-4 py-1">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {t("channels.settings.autoPublish")}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t("channels.settings.autoPublishHint")}
            </Text>
          </View>
          <Switch value={autoPublish} onValueChange={setAutoPublish} />
        </View>
      </View>

      <View className="rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-4 py-1">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {t("channels.settings.keepLocalEdits")}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t("channels.settings.keepLocalEditsHint")}
            </Text>
          </View>
          <Switch value={respectOverrides} onValueChange={setRespectOverrides} />
        </View>
      </View>

      <Button onPress={save} isLoading={update.isPending} className="self-start">
        <Text className="font-semibold text-primary-foreground">
          {t("channels.settings.save")}
        </Text>
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
  const { t } = useTranslation();
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
            {t(DIRECTION_LABEL_KEYS[direction])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </View>
  );
}

/**
 * What each classified reason MEANS, in a merchant's own terms (#303).
 *
 * The copy lives here rather than on the row for the reason #90 keeps condition
 * labels out of the database: the stored KEY is what has to stay stable, and a
 * sentence somebody rewrites next month must not require a migration. The stored
 * `detail` is the specific half and is rendered beside it.
 */
const RECORD_FAILURE_REASON_COPY_KEYS: Record<SyncRecordFailureReason, string> = {
  refused_by_rule: "channels.runFailures.reason.refusedByRule",
  duplicate_record: "channels.runFailures.reason.duplicateRecord",
  database_refused: "channels.runFailures.reason.databaseRefused",
  unclassified: "channels.runFailures.reason.unclassified",
};

/** What KIND of record a refusal was about, so a merchant searches the right list. */
const RECORD_SUBJECT_COPY_KEYS: Record<SyncRecordFailure["subjectType"], string> = {
  product: "channels.runFailures.subject.product",
  order: "channels.runFailures.subject.order",
  inventory_item: "channels.runFailures.subject.inventoryItem",
};

/**
 * The records ONE run refused, on demand (#303).
 *
 * `failedCount` is rendered beside the list rather than instead of it, because
 * the two legitimately differ: a whole-run failure counts one without naming a
 * record, a run may refuse more records than one page stores, and the rows are
 * swept at thirty days while the run row is kept forever. A shorter list must
 * not read as a smaller problem.
 */
function RunRecordFailures({
  storeId,
  connectionId,
  run,
}: {
  storeId: string;
  connectionId: string;
  run: SyncRun;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failures = useChannelRunRecordFailures(storeId, connectionId, run.id, open);

  if (!open) {
    return (
      <Pressable className="mt-2 self-start" onPress={() => setOpen(true)}>
        <Text className="text-xs font-semibold text-primary">
          {t("channels.runFailures.show", { count: run.counts.failed })}
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="mt-2 gap-2 rounded-xl bg-muted p-3">
      {failures.isPending ? (
        <Text className="text-xs text-muted-foreground">{t("common.loading")}</Text>
      ) : failures.isError ? (
        <Text className="text-xs text-muted-foreground">
          {t("channels.runFailures.loadFailed")}
        </Text>
      ) : (failures.data?.failures ?? []).length === 0 ? (
        // Not "nothing failed" — the run's own tally says otherwise. A run that
        // failed as a whole records no per-record rows, and rows older than the
        // retention window are gone, so this says what is KNOWN rather than
        // contradicting the count above it.
        <Text className="text-xs text-muted-foreground">{t("channels.runFailures.none")}</Text>
      ) : (
        <View className="gap-2">
          {(failures.data?.failures ?? []).map((failure) => (
            <View key={failure.id}>
              <Text className="text-xs font-semibold text-foreground">
                {t("channels.runFailures.line", {
                  subject: t(RECORD_SUBJECT_COPY_KEYS[failure.subjectType]),
                  externalId: failure.externalId ? ` ${failure.externalId}` : "",
                  reason: t(RECORD_FAILURE_REASON_COPY_KEYS[failure.reason]),
                })}
              </Text>
              <Text className="text-xs text-muted-foreground">{failure.detail}</Text>
            </View>
          ))}
          {failures.data && failures.data.failures.length < failures.data.failedCount ? (
            <Text className="text-[11px] text-muted-foreground">
              {t("channels.runFailures.showing", {
                shown: failures.data.failures.length,
                total: failures.data.failedCount,
              })}
            </Text>
          ) : null}
        </View>
      )}
      <Pressable className="self-start" onPress={() => setOpen(false)}>
        <Text className="text-xs font-semibold text-primary">
          {t("channels.runFailures.hide")}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The real run history (#87 management 8).
 *
 * The placeholder this replaces said a per-run history was "a follow-up — the
 * channels list endpoint returns the connection status and last-synced time
 * only". `GET .../channels/:id/runs` is that follow-up: a socket tells a
 * merchant what happens while they are watching, and this is what happened
 * overnight.
 */
/**
 * Why a merchant may not press this, or `null` when they may.
 *
 * Every reason is one the SERVER also refuses, which is the point: a disabled
 * control Mercaria invented would be a second answer to what `requestBackfill`
 * decides, and the two would drift. Two states the server does NOT refuse are
 * deliberately absent from this list —
 *
 * - a FETCH-PAUSED channel, because pausing gates the scheduled sweeps
 *   (`findPullConnectionsToReconcile`) and not a manual import. Pressing this is
 *   an explicit act, so it runs, and the copy below says so rather than
 *   disabling a button that would have worked.
 * - `status: 'error'`, which is what a failed run leaves behind. Retrying is the
 *   remedy for most of them, and a channel that disabled its own retry after one
 *   bad night would need a reconnect to do what a second press fixes.
 */
function manualSyncBlockedReason(connection: Connection, t: Translate): string | null {
  if (connection.status !== "connected") {
    return t("channels.import.blockedDisconnected");
  }
  // The endpoint is the PRODUCT backfill specifically: `requestBackfill` refuses
  // on `syncSettingsProducts` alone, so a channel pulling only orders is refused
  // by the server too. Naming products rather than "syncing" is what keeps this
  // from promising an order import the button does not run.
  if (connection.syncSettings.products !== "pull" && connection.syncSettings.products !== "bidirectional") {
    return t("channels.import.blockedDirection");
  }
  return null;
}

/**
 * Import this channel's catalogue now.
 *
 * The control that did not exist, which is the whole of the reported defect: the
 * endpoint, the client function and the mutation hook were all present and
 * `useSyncChannel` had ZERO callers in any screen, so a merchant whose first
 * import never ran had no way to ask for one. Re-importing is also the ordinary
 * remedy after fixing a mapping or widening a scope, and until now that meant
 * disconnecting and reconnecting the channel.
 *
 * ABSENT rather than disabled for a `push_in` channel, on `WebhookHealth`'s
 * precedent: a plugin pushes INTO Mercaria and has no catalogue to pull, so a
 * permanently disabled button would be explaining a capability that channel never
 * had.
 */
function ManualSync({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { t } = useTranslation();
  const sync = useSyncChannel(storeId);

  if (connection.mode !== "pull") return null;

  const blocked = manualSyncBlockedReason(connection, t);
  const paused = (connection.pausedScopes ?? []).includes("fetch");

  const run = () => {
    sync.mutate(connection.id, {
      // A 202: the server has ACCEPTED the import, not finished it. Saying
      // "Imported" here would be a claim about pages of somebody else's platform
      // that have not been read yet — the run's own row is what reports the
      // outcome, and it is directly below.
      onSuccess: () => toast.success(t("channels.toast.importStarted")),
      onError: () => toast.error(t("channels.toast.importStartFailed")),
    });
  };

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.import.title")}
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="flex-1 gap-1">
          <Text className="text-sm font-medium text-foreground">
            {t("channels.import.heading", {
              provider: t(PROVIDER_NAME_KEYS[connection.provider]),
            })}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {blocked ??
              (paused
                ? t("channels.import.bodyPaused")
                : t("channels.import.body"))}
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          onPress={run}
          isLoading={sync.isPending}
          disabled={blocked !== null}
          className="self-start"
        >
          <Text className="text-sm font-medium text-foreground">{t("channels.import.now")}</Text>
        </Button>
      </View>
    </View>
  );
}

function SyncHistory({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const runs = useChannelRuns(storeId, connection.id);

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.history.title")}
      </Text>
      {runs.isPending ? (
        <ScreenLoading />
      ) : runs.isError ? (
        <ScreenMessage
          title={t("channels.history.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      ) : (runs.data ?? []).length === 0 ? (
        <View className="flex-row items-start gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
            <History size={18} color={colors.mutedForeground} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {t("channels.history.empty")}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {formatSyncedAt(connection.lastSyncAt, t)}
            </Text>
          </View>
        </View>
      ) : (
        <View className="gap-2">
          {(runs.data ?? []).map((run) => (
            <View key={run.id} className="rounded-2xl border border-border bg-surface p-4">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">{run.kind}</Text>
                <View
                  className={`rounded-full px-2 py-0.5 ${
                    run.status === "failed" ? "bg-destructive/10" : "bg-muted"
                  }`}
                >
                  <Text
                    className={`text-[10px] font-semibold ${
                      run.status === "failed" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {run.status}
                  </Text>
                </View>
              </View>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {formatWhen(run.startedAt, t("common.unknown"))}
              </Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                {t("channels.history.counts", {
                  created: run.counts.created,
                  updated: run.counts.updated,
                  skipped: run.counts.skipped,
                  failed: run.counts.failed,
                })}
              </Text>
              {/*
                Runbook §8.5, said out loud rather than left to puzzle over: a
                resync that changed nothing still tallies as `updated`, because
                the patch is built from every unpinned connector-managed field
                whether or not it differed. A merchant reading "40 updated" after
                a no-op reconcile would otherwise conclude their catalogue is
                being rewritten nightly.
              */}
              {run.counts.updated > 0 && run.counts.created === 0 ? (
                <Text className="mt-1 text-[11px] text-muted-foreground">
                  {t("channels.history.updatedNote")}
                </Text>
              ) : null}
              {run.error ? (
                <Text className="mt-1 text-xs text-destructive">{run.error}</Text>
              ) : null}
              {/*
                The summary above is elided at three reasons with three ids each
                (#294), so a run that refused a hundred products names nine of
                them. This is where the rest live (#303) — behind a press, since
                a history page that fetched every run's reasons up front would
                download all of them to render a control most people never open.
              */}
              {run.counts.failed > 0 ? (
                <RunRecordFailures
                  storeId={storeId}
                  connectionId={connection.id}
                  run={run}
                />
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Real-time sync, and the one control that repairs it (#262).
 *
 * ## Why this panel exists at all
 *
 * #218 recorded the topics a platform REFUSED on the connection and degraded the
 * catalogue axis of `ChannelReadiness` while any existed, and nothing rendered
 * either — so a merchant saw "needs attention" with no way to find out what or to
 * do anything about it. #262 added the endpoint; this is the half that makes it
 * reachable.
 *
 * ## It renders even when nothing is wrong, deliberately
 *
 * The tempting version shows the panel only on a refusal, and it would leave the
 * ONE case automatic recovery cannot detect with no remedy either: a merchant who
 * deleted Mercaria's webhooks in the Shopify or WooCommerce admin has complete
 * stored ids and no refusal, so the sweep's derived population is blind to it by
 * construction. Re-registering is exactly the repair, and a button that only
 * appears once something is already recorded as broken could never be pressed for
 * it. Hence the healthy state says what it holds and offers the same action.
 *
 * ## The state comes from `deriveWebhookDelivery`, not from the refusal list
 *
 * `webhookRegistration` is the authority on whether Mercaria is still trying and
 * `webhookFailures` is a separate fact about which topics were refused, so the
 * derivation reads them in that order. Reading the refusals first renders a
 * channel Mercaria has GIVEN UP on as healthy whenever the failure went
 * unrecorded — see the note on `deriveWebhookDelivery` for the case that
 * produces exactly that.
 */
function WebhookHealth({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const reregister = useReregisterChannelWebhooks(storeId);

  // Two of the endpoint's three refusals, kept as an ABSENT control rather than a
  // button that answers 400: a push-in channel has nothing to subscribe and a
  // disconnected one has no real-time sync to talk about. The third — a
  // connection whose stored credential will not resolve — is NOT checkable here,
  // because the DTO carries no credential-presence fact by design, so it stays a
  // 400 surfaced through this panel's own error toast.
  if (connection.mode !== "pull" || connection.status !== "connected") {
    return null;
  }

  const providerName = t(PROVIDER_NAME_KEYS[connection.provider]);
  const delivery = deriveWebhookDelivery(connection, providerName, t);
  const failures = connection.webhookFailures ?? [];

  const retry = () => {
    reregister.mutate(connection.id, {
      onSuccess: () => toast.success(t("channels.toast.webhooksRegistering")),
      onError: () => toast.error(t("channels.toast.webhooksRegisterFailed")),
    });
  };

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.webhooks.title")}
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-start gap-2">
          <View className="pt-0.5">
            {/*
              `ChannelLimitationRow`'s convention: `useColorScheme` exposes no
              destructive token, so the severity is carried by the ICON and the
              copy rather than by a colour this palette does not have. A redder
              triangle would not tell anybody to widen a permission anyway.
            */}
            {delivery.state === "healthy" ? (
              <RadioTower size={15} color={colors.mutedForeground} />
            ) : (
              <TriangleAlert size={15} color={colors.mutedForeground} />
            )}
          </View>
          <View className="flex-1 gap-1">
            <Text className="text-sm font-medium text-foreground">{delivery.headline}</Text>
            <Text className="text-xs text-muted-foreground">{delivery.detail}</Text>
          </View>
        </View>

        {/*
          The TOPICS, named. "Which events will not arrive" is the merchant's
          actual question, and `webhookIds` cannot answer it — only this list can.
        */}
        {failures.length > 0 ? (
          <View className="gap-1 rounded-xl bg-muted/40 p-3">
            {failures.map((failure) => (
              <Text key={failure.topic} className="text-xs text-muted-foreground">
                <Text className="text-xs font-medium text-foreground">{failure.topic}</Text>
                {t("channels.webhooks.failureDetail", {
                  reason: t(WEBHOOK_FAILURE_REASON_COPY_KEYS[failure.reason]),
                  http:
                    failure.httpStatus === undefined
                      ? ""
                      : t("channels.webhooks.httpStatus", { status: failure.httpStatus }),
                  when: formatWhen(failure.recordedAt, t("channels.recently")),
                })}
              </Text>
            ))}
          </View>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          onPress={retry}
          isLoading={reregister.isPending}
          className="self-start"
        >
          <Text className="text-sm font-medium text-foreground">{delivery.actionLabel}</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * Pausing fetch and publication independently (#87 management 4).
 *
 * Two switches rather than one, because they are two facts with opposite
 * remedies: a merchant investigating wrong prices stops PUBLICATION while the
 * connector keeps observing; a merchant whose host is rate-limiting stops FETCH
 * and leaves what is already imported on sale.
 */
function PauseControls({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { t } = useTranslation();
  const pause = usePauseChannel(storeId);
  const paused = new Set(connection.pausedScopes ?? []);

  const toggle = (scope: ChannelPauseScope, next: boolean) => {
    pause.mutate(
      { connectionId: connection.id, scope, paused: next },
      {
        onSuccess: (result) =>
          toast.success(
            result.changed
              ? next
                ? t("channels.toast.paused")
                : t("channels.toast.resumed")
              : t("channels.toast.alreadyInThatState"),
          ),
        onError: () => toast.error(t("channels.toast.pauseFailed")),
      },
    );
  };

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.pause.title")}
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">
              {t("channels.pause.importing")}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {t("channels.pause.importingHint")}
            </Text>
          </View>
          <Switch
            value={paused.has("fetch")}
            onValueChange={(next) => toggle("fetch", next)}
          />
        </View>
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">
              {t("channels.pause.publishing")}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {t("channels.pause.publishingHint")}
            </Text>
          </View>
          <Switch
            value={paused.has("publication")}
            onValueChange={(next) => toggle("publication", next)}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * What Mercaria already indexed for this merchant (#87 reconcile).
 *
 * A REPORT, never an action: both representations survive, both keep their own
 * observation chain, and the comparison surface goes on showing what each seller
 * published. The binding gap is shown plainly when there is one, because the
 * commonest of them — an unclaimed merchant — is the ordinary state of a store
 * and explains why the numbers are zero.
 */
function Reconciliation({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { t } = useTranslation();
  const report = useChannelReconciliation(storeId, connection.id);
  if (report.isPending || report.isError || !report.data) return null;
  const data = report.data;

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.reconciliation.title")}
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        {data.bindingGap ? (
          <Text className="text-xs text-muted-foreground">
            {t(BINDING_GAP_COPY_KEYS[data.bindingGap])}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-4">
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              {t("channels.reconciliation.alreadyIndexed")}
            </Text>
            <Text className="text-base font-semibold text-foreground">
              {data.existingExternalOffers}
            </Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              {t("channels.reconciliation.fromThisStore")}
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.nativeOffers}</Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              {t("channels.reconciliation.sameProductTwice")}
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.overlaps.length}</Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              {t("channels.reconciliation.awaitingReview")}
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.awaitingReview}</Text>
          </View>
        </View>
        <Text className="text-xs text-muted-foreground">
          {t("channels.reconciliation.body")}
        </Text>
        {data.awaitingReview > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {t("channels.reconciliation.awaitingReviewNote", { count: data.awaitingReview })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Why a connection could not be tied to a verified merchant, in plain words. */
const BINDING_GAP_COPY_KEYS: Record<
  NonNullable<ChannelReconciliationSummary["bindingGap"]>,
  string
> = {
  merchant_not_claimed: "channels.reconciliation.gap.merchantNotClaimed",
  store_not_linked: "channels.reconciliation.gap.storeNotLinked",
  storefront_not_matched: "channels.reconciliation.gap.storefrontNotMatched",
  channel_has_no_domain: "channels.reconciliation.gap.channelHasNoDomain",
};

/**
 * Disconnecting, with an explicit policy (#87 management 7).
 *
 * Three options and no default. They are all defensible and only the merchant
 * knows which they mean — somebody moving to editing in Mercaria wants their
 * listings kept, somebody who connected the wrong shop wants them gone. Picking
 * one silently is how a catalogue disappears.
 */
function DisconnectPanel({ storeId, connection }: { storeId: string; connection: Connection }) {
  const router = useRouter();
  const { t } = useTranslation();
  const disconnect = useDisconnectChannelWithPolicy(storeId);
  const [policy, setPolicy] = useState<ChannelDisconnectPolicy>("keep_listings");
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("channels.disconnect.title")}
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        {/*
          Policy-INDEPENDENT on purpose. This sits above the chooser, so it is an
          instruction to choose, not a description of the current choice — the
          per-policy sentence is DISCONNECT_POLICY_HELP_KEYS, rendered directly
          below the toggle group and again in the confirm dialog. Interpolating
          the selected label here read "…happens to the keep products this
          channel imported" (#442), and giving the sentence its own per-policy
          copy would be a second description of what policyHelp already says.
        */}
        <Text className="text-xs text-muted-foreground">
          {t("channels.disconnect.intro")}
        </Text>
        <ToggleGroup
          type="single"
          value={policy}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== "") {
              setPolicy(next as ChannelDisconnectPolicy);
            }
          }}
        >
          {CHANNEL_DISCONNECT_POLICIES.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              <Text className="text-xs font-medium">{t(DISCONNECT_POLICY_LABEL_KEYS[option])}</Text>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Text className="text-xs text-muted-foreground">
          {t(DISCONNECT_POLICY_HELP_KEYS[policy])}
        </Text>
        <Button variant="destructive" onPress={() => setConfirmOpen(true)}>
          <Text className="font-semibold text-destructive-foreground">
            {t("channels.disconnect.action")}
          </Text>
        </Button>
      </View>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("channels.disconnect.confirmTitle", {
                provider: t(PROVIDER_NAME_KEYS[connection.provider]),
              })}
            </DialogTitle>
            <DialogDescription>{t(DISCONNECT_POLICY_HELP_KEYS[policy])}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirmOpen(false)}>
              <Text className="font-semibold text-foreground">{t("common.cancel")}</Text>
            </Button>
            <Button
              variant="destructive"
              isLoading={disconnect.isPending}
              onPress={() =>
                disconnect.mutate(
                  { connectionId: connection.id, policy },
                  {
                    onSuccess: (result) => {
                      toast.success(
                        t("channels.toast.disconnected", {
                          products: t("channels.disconnect.productsChanged", {
                            count: result.listingsAffected,
                          }),
                          records: t("channels.disconnect.recordsKept", {
                            count: result.externalOffersPreserved,
                          }),
                        }),
                      );
                      router.replace("/channels");
                    },
                    onError: () => toast.error(t("channels.toast.disconnectFailed")),
                  },
                )
              }
            >
              <Text className="font-semibold text-destructive-foreground">
                {t("channels.disconnect.confirmAction")}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}

const DISCONNECT_POLICY_LABEL_KEYS: Record<ChannelDisconnectPolicy, string> = {
  keep_listings: "channels.disconnect.policy.keepListings",
  unpublish_listings: "channels.disconnect.policy.unpublishListings",
  archive_listings: "channels.disconnect.policy.archiveListings",
};

const DISCONNECT_POLICY_HELP_KEYS: Record<ChannelDisconnectPolicy, string> = {
  keep_listings: "channels.disconnect.policyHelp.keepListings",
  unpublish_listings: "channels.disconnect.policyHelp.unpublishListings",
  archive_listings: "channels.disconnect.policyHelp.archiveListings",
};

/** Human-readable "last used" line for a key, or a never-used fallback. */
function formatLastUsed(iso: string | undefined, t: Translate): string {
  if (!iso) return t("channels.keys.neverUsed");
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return t("channels.keys.neverUsed");
  return t("channels.keys.lastUsed", { when: when.toLocaleString() });
}

/**
 * API keys area for a push-in channel. The merchant mints a long-lived key here,
 * copies it (and the connection id) into their WordPress/WooCommerce plugin, and
 * revokes it if it leaks. The plaintext key is shown EXACTLY once, at creation.
 */
function ChannelApiKeys({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data: keys, isPending, isError } = useChannelKeys(storeId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [minted, setMinted] = useState<GenerateChannelApiKeyResult | null>(null);

  return (
    <View className="mt-8 gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-muted-foreground">
          {t("channels.keys.title")}
        </Text>
        <Button variant="outline" size="sm" onPress={() => setDialogOpen(true)}>
          <View className="flex-row items-center gap-1.5">
            <Plus size={14} color={colors.foreground} />
            <Text className="text-xs font-semibold text-foreground">
              {t("channels.keys.generate")}
            </Text>
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
              {t("channels.keys.heading")}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {t("channels.keys.body")}
            </Text>
            <View className="mt-2 flex-row items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5">
              <Text className="text-[11px] font-medium text-muted-foreground">
                {t("channels.keys.connectionId")}
              </Text>
              <Text selectable className="flex-1 text-[11px] font-semibold text-foreground">
                {connection.id}
              </Text>
              <CopyButton value={connection.id} label={t("channels.keys.connectionIdSubject")} />
            </View>
          </View>
        </View>

        {minted ? (
          <MintedKeyCard result={minted} onDone={() => setMinted(null)} />
        ) : null}

        {isPending ? (
          <Text className="text-xs text-muted-foreground">{t("channels.keys.loading")}</Text>
        ) : isError ? (
          <Text className="text-xs text-destructive">{t("channels.keys.loadFailed")}</Text>
        ) : (keys?.length ?? 0) === 0 ? (
          <Text className="text-xs text-muted-foreground">{t("channels.keys.empty")}</Text>
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
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
      <View className="flex-row items-center gap-2">
        <TriangleAlert size={15} color={colors.primary} />
        <Text className="flex-1 text-xs font-semibold text-foreground">
          {t("channels.keys.copyNow")}
        </Text>
      </View>
      <View className="flex-row items-center gap-2 rounded-lg bg-surface px-2.5 py-2">
        <Text selectable className="flex-1 text-[11px] font-semibold text-foreground">
          {result.key}
        </Text>
        <CopyButton value={result.key} label={t("channels.keys.apiKeySubject")} />
      </View>
      <Button size="sm" onPress={onDone} className="self-start">
        <Text className="text-xs font-semibold text-primary-foreground">{t("common.done")}</Text>
      </Button>
    </View>
  );
}

/** A single existing key row: label, prefix, last-used, and a revoke action. */
function KeyRow({ storeId, apiKey }: { storeId: string; apiKey: ChannelApiKey }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const revoke = useRevokeChannelKey(storeId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onRevoke = () => {
    revoke.mutate(apiKey.id, {
      onSuccess: () => {
        toast.success(t("channels.toast.keyRevoked"));
        setConfirmOpen(false);
      },
      onError: () => toast.error(t("channels.toast.keyRevokeFailed")),
    });
  };

  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border bg-background p-3">
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{apiKey.label}</Text>
        <Text className="mt-0.5 text-[11px] text-muted-foreground">
          <Text className="font-mono text-[11px] text-muted-foreground">{apiKey.prefix}…</Text>
          {"  ·  "}
          {formatLastUsed(apiKey.lastUsedAt, t)}
        </Text>
      </View>
      <Pressable
        onPress={() => setConfirmOpen(true)}
        className="h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 active:opacity-70"
      >
        <Trash2 size={14} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-muted-foreground">
          {t("channels.keys.revoke")}
        </Text>
      </Pressable>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("channels.keys.revokeConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("channels.keys.revokeConfirmBody", { label: apiKey.label })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirmOpen(false)}>
              <Text className="font-semibold text-foreground">{t("common.cancel")}</Text>
            </Button>
            <Button variant="destructive" onPress={onRevoke} isLoading={revoke.isPending}>
              <Text className="font-semibold text-destructive-foreground">
                {t("channels.keys.revoke")}
              </Text>
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
  const { t } = useTranslation();
  const generate = useGenerateChannelKey(storeId);
  const [label, setLabel] = useState("");

  const submit = () => {
    const trimmed = label.trim();
    if (trimmed === "") {
      toast.error(t("channels.toast.keyLabelRequired"));
      return;
    }
    generate.mutate(
      { label: trimmed, connectionId: connection.id },
      {
        onSuccess: (result) => {
          setLabel("");
          onMinted(result);
          toast.success(t("channels.toast.keyGenerated"));
        },
        onError: () => toast.error(t("channels.toast.keyGenerateFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("channels.keys.generateTitle")}</DialogTitle>
          <DialogDescription>{t("channels.keys.generateBody")}</DialogDescription>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>{t("channels.keys.labelField")}</Label>
            <Input
              value={label}
              onChangeText={setLabel}
              placeholder={t("channels.keys.labelPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <Button onPress={submit} isLoading={generate.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">
              {t("channels.keys.generate")}
            </Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}

/** A small copy-to-clipboard button that briefly confirms with a check. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    toast.success(t("channels.keys.copied", { label }));
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Pressable
      onPress={copy}
      accessibilityLabel={t("channels.keys.copyAccessibility", { label })}
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
