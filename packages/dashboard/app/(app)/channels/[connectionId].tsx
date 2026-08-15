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
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  WEBHOOK_FAILURE_REASON_COPY,
  deriveWebhookDelivery,
  formatWhen,
} from "@/components/channels/channel-presentation";
import {
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
      <WebhookHealth storeId={storeId} connection={connection} />
      <PauseControls storeId={storeId} connection={connection} />
      <SyncHistory storeId={storeId} connection={connection} />
      <Reconciliation storeId={storeId} connection={connection} />
      <DisconnectPanel storeId={storeId} connection={connection} />
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

/**
 * What each classified reason MEANS, in a merchant's own terms (#303).
 *
 * The copy lives here rather than on the row for the reason #90 keeps condition
 * labels out of the database: the stored KEY is what has to stay stable, and a
 * sentence somebody rewrites next month must not require a migration. The stored
 * `detail` is the specific half and is rendered beside it.
 */
const RECORD_FAILURE_REASON_COPY: Record<SyncRecordFailureReason, string> = {
  refused_by_rule: "Refused by a Mercaria rule",
  duplicate_record: "Duplicate of a record already imported",
  database_refused: "The database refused the write",
  unclassified: "Unrecognised failure",
};

/** What KIND of record a refusal was about, so a merchant searches the right list. */
const RECORD_SUBJECT_COPY: Record<SyncRecordFailure["subjectType"], string> = {
  product: "Product",
  order: "Order",
  inventory_item: "Inventory item",
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
  const [open, setOpen] = useState(false);
  const failures = useChannelRunRecordFailures(storeId, connectionId, run.id, open);

  if (!open) {
    return (
      <Pressable className="mt-2 self-start" onPress={() => setOpen(true)}>
        <Text className="text-xs font-semibold text-primary">
          Show which {run.counts.failed === 1 ? "record" : "records"} did not land
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="mt-2 gap-2 rounded-xl bg-muted p-3">
      {failures.isPending ? (
        <Text className="text-xs text-muted-foreground">Loading…</Text>
      ) : failures.isError ? (
        <Text className="text-xs text-muted-foreground">
          Couldn&rsquo;t load the records this sync refused.
        </Text>
      ) : (failures.data?.failures ?? []).length === 0 ? (
        // Not "nothing failed" — the run's own tally says otherwise. A run that
        // failed as a whole records no per-record rows, and rows older than the
        // retention window are gone, so this says what is KNOWN rather than
        // contradicting the count above it.
        <Text className="text-xs text-muted-foreground">
          No per-record reasons are stored for this sync.
        </Text>
      ) : (
        <View className="gap-2">
          {(failures.data?.failures ?? []).map((failure) => (
            <View key={failure.id}>
              <Text className="text-xs font-semibold text-foreground">
                {RECORD_SUBJECT_COPY[failure.subjectType]}
                {failure.externalId ? ` ${failure.externalId}` : ""} &middot;{" "}
                {RECORD_FAILURE_REASON_COPY[failure.reason]}
              </Text>
              <Text className="text-xs text-muted-foreground">{failure.detail}</Text>
            </View>
          ))}
          {failures.data && failures.data.failures.length < failures.data.failedCount ? (
            <Text className="text-[11px] text-muted-foreground">
              Showing {failures.data.failures.length} of {failures.data.failedCount}.
            </Text>
          ) : null}
        </View>
      )}
      <Pressable className="self-start" onPress={() => setOpen(false)}>
        <Text className="text-xs font-semibold text-primary">Hide</Text>
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
function SyncHistory({ storeId, connection }: { storeId: string; connection: Connection }) {
  const { colors } = useColorScheme();
  const runs = useChannelRuns(storeId, connection.id);

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Sync history</Text>
      {runs.isPending ? (
        <ScreenLoading />
      ) : runs.isError ? (
        <ScreenMessage title="Couldn't load the history" body="Please try again." />
      ) : (runs.data ?? []).length === 0 ? (
        <View className="flex-row items-start gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
            <History size={18} color={colors.mutedForeground} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">No syncs yet</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              {formatSyncedAt(connection.lastSyncAt)}
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
                {formatWhen(run.startedAt, "unknown")}
              </Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                {run.counts.created} created · {run.counts.updated} updated ·{" "}
                {run.counts.skipped} skipped · {run.counts.failed} failed
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
                  &ldquo;Updated&rdquo; counts every product examined, not only the ones that
                  differed.
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

  const providerName = PROVIDER_NAME[connection.provider];
  const delivery = deriveWebhookDelivery(connection, providerName);
  const failures = connection.webhookFailures ?? [];

  const retry = () => {
    reregister.mutate(connection.id, {
      onSuccess: () => toast.success("Registering webhooks again"),
      onError: () => toast.error("Couldn't start webhook registration"),
    });
  };

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Real-time updates</Text>
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
                {` — ${WEBHOOK_FAILURE_REASON_COPY[failure.reason]}`}
                {failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`}
                {` · last checked ${formatWhen(failure.recordedAt, "recently")}`}
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
                ? "Paused"
                : "Resumed"
              : "Already in that state",
          ),
        onError: () => toast.error("Couldn't change the pause state"),
      },
    );
  };

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Pause</Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">Pause importing</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              Stop reading from the platform. What is already imported stays on sale.
            </Text>
          </View>
          <Switch
            value={paused.has("fetch")}
            onValueChange={(next) => toggle("fetch", next)}
          />
        </View>
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">Pause publishing</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              Keep importing, but stop this channel&apos;s products reaching buyers.
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
  const report = useChannelReconciliation(storeId, connection.id);
  if (report.isPending || report.isError || !report.data) return null;
  const data = report.data;

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        Matching your existing catalog
      </Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        {data.bindingGap ? (
          <Text className="text-xs text-muted-foreground">{BINDING_GAP_COPY[data.bindingGap]}</Text>
        ) : null}
        <View className="flex-row flex-wrap gap-4">
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              Already indexed
            </Text>
            <Text className="text-base font-semibold text-foreground">
              {data.existingExternalOffers}
            </Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              From this store
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.nativeOffers}</Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              Same product, twice
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.overlaps.length}</Text>
          </View>
          <View className="min-w-[140px] gap-0.5">
            <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
              Awaiting review
            </Text>
            <Text className="text-base font-semibold text-foreground">{data.awaitingReview}</Text>
          </View>
        </View>
        <Text className="text-xs text-muted-foreground">
          Nothing is deleted or merged. Where the same product appears twice, Mercaria shows your
          own store&apos;s listing as the main one and keeps the other&apos;s price history intact.
        </Text>
        {data.awaitingReview > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {data.awaitingReview} product{data.awaitingReview === 1 ? "" : "s"} could not be
            matched automatically and are queued for a person to confirm.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Why a connection could not be tied to a verified merchant, in plain words. */
const BINDING_GAP_COPY: Record<NonNullable<ChannelReconciliationSummary["bindingGap"]>, string> = {
  merchant_not_claimed:
    "This store is not linked to a verified merchant, so there is nothing to match against yet.",
  store_not_linked:
    "This store is not linked to a merchant profile, so there is nothing to match against yet.",
  storefront_not_matched:
    "Mercaria has not indexed this exact shop before, so there is nothing to match against.",
  channel_has_no_domain: "This channel has no web address to match against.",
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
  const disconnect = useDisconnectChannelWithPolicy(storeId);
  const [policy, setPolicy] = useState<ChannelDisconnectPolicy>("keep_listings");
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <View className="mt-8 gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Disconnect</Text>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
        <Text className="text-xs text-muted-foreground">
          Choose what happens to the {DISCONNECT_POLICY_LABEL[policy].toLowerCase()} this channel
          imported. Your price history and anything another channel imported are never touched.
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
              <Text className="text-xs font-medium">{DISCONNECT_POLICY_LABEL[option]}</Text>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Text className="text-xs text-muted-foreground">
          {DISCONNECT_POLICY_HELP[policy]}
        </Text>
        <Button variant="destructive" onPress={() => setConfirmOpen(true)}>
          <Text className="font-semibold text-destructive-foreground">Disconnect channel</Text>
        </Button>
      </View>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {PROVIDER_NAME[connection.provider]}?</DialogTitle>
            <DialogDescription>{DISCONNECT_POLICY_HELP[policy]}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onPress={() => setConfirmOpen(false)}>
              <Text className="font-semibold text-foreground">Cancel</Text>
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
                        `Disconnected — ${result.listingsAffected} product${
                          result.listingsAffected === 1 ? "" : "s"
                        } changed, ${result.externalOffersPreserved} price record${
                          result.externalOffersPreserved === 1 ? "" : "s"
                        } kept`,
                      );
                      router.replace("/channels");
                    },
                    onError: () => toast.error("Couldn't disconnect the channel"),
                  },
                )
              }
            >
              <Text className="font-semibold text-destructive-foreground">Disconnect</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}

const DISCONNECT_POLICY_LABEL: Record<ChannelDisconnectPolicy, string> = {
  keep_listings: "Keep products",
  unpublish_listings: "Unpublish",
  archive_listings: "Archive",
};

const DISCONNECT_POLICY_HELP: Record<ChannelDisconnectPolicy, string> = {
  keep_listings:
    "Stop syncing and leave every product exactly as it is — still on sale, and now yours to edit in Mercaria.",
  unpublish_listings:
    "Stop syncing and take this channel's products off sale, keeping them as drafts you can republish.",
  archive_listings:
    "Stop syncing and archive this channel's products. Sold and moderated products are left alone.",
};

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
