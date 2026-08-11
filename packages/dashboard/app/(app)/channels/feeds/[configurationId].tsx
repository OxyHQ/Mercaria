/**
 * One product feed: its mapping versions, its preview, its validation and its
 * runs (#63's deferred merchant screens, picked up by #87).
 *
 * ## Four properties this screen renders rather than re-implements
 *
 *  - **A version's URL is never shown.** A feed URL is a credential — Awin's
 *    download carries the key in the path — so the server emits a HOST for every
 *    reader including the store that typed it. There is no field here to put the
 *    full URL in.
 *  - **`deliveryMode` has no default.** `snapshot` says a row missing from the
 *    file is gone; `delta` says it is evidence of nothing. The wrong answer
 *    either retires a healthy catalogue or leaves delisted products on sale
 *    forever, so the form makes the merchant choose.
 *  - **Activation CITES a validation report.** The server requires the report
 *    id, so a version cannot go live against evidence nobody produced.
 *  - **An error report carries no VALUES.** The download is a record INDEX, an
 *    issue code, a severity and the merchant's own column name — they have the
 *    file, so the index is what they need.
 */

import React, { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, RefreshCw } from "lucide-react-native";
import type { FeedDeliveryMode, FeedFieldRole, FeedFormat } from "@mercaria/shared-types";
import { Button, Input, Label, Text, ToggleGroup, ToggleGroupItem, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { formatWhen } from "@/components/channels/channel-presentation";
import type { FeedPreview, FeedVersion } from "@/lib/api/feeds";
import {
  useActivateFeedVersion,
  useDraftFeedVersion,
  useFeed,
  useFeedReports,
  useFeedStatus,
  usePreviewFeedVersion,
  useSyncFeed,
  useValidateFeedVersion,
} from "@/lib/hooks/use-feeds";

/** The formats the importer parses. */
const FORMATS: readonly FeedFormat[] = ["csv", "tsv", "xml", "json", "jsonl"];

/**
 * The roles a merchant maps their columns onto, in the order they matter.
 *
 * A SUBSET of the server's full role list, chosen for a first mapping — `title`
 * is the only one the importer requires, and the rest are what makes a listing
 * worth comparing. The server refuses an unrecognised role, so a merchant
 * needing one of the others sends it through the API rather than being silently
 * given a wrong mapping.
 */
const COMMON_ROLES: readonly FeedFieldRole[] = [
  "title",
  "description",
  "brand",
  "gtin",
  "mpn",
  "sku",
  "price",
  "price_currency",
  "availability",
  "condition",
  "image",
  "destination_url",
];

export default function FeedScreen() {
  const { configurationId } = useLocalSearchParams<{ configurationId: string }>();
  return (
    <>
      <Head>
        <title>Product feed | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="channels:write">
        {(storeId) => <FeedBody storeId={storeId} configurationId={configurationId} />}
      </RequireStore>
    </>
  );
}

function FeedBody({ storeId, configurationId }: { storeId: string; configurationId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const feed = useFeed(storeId, configurationId);
  const status = useFeedStatus(storeId, configurationId);
  const sync = useSyncFeed(storeId, configurationId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (feed.isPending) {
    return (
      <Screen title="Product feed" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (feed.isError || !feed.data) {
    return (
      <Screen title="Product feed" action={back}>
        <ScreenMessage title="Feed not found" body="It may have been removed." />
      </Screen>
    );
  }

  const { configuration, versions } = feed.data;
  const active = versions.find((version) => version.status === "active");

  return (
    <Screen title={configuration.label} subtitle="Product feed" action={back}>
      <View className="gap-8">
        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">Status</Text>
          {status.data?.source ? (
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                {status.data.source.status} · {status.data.source.healthState}
              </Text>
              <Text className="text-xs text-muted-foreground">
                Last read {formatWhen(status.data.source.lastAttemptAt ?? undefined, "never")} ·
                next {formatWhen(status.data.source.nextRunAt ?? undefined, "unscheduled")}
              </Text>
              {status.data.source.lastError ? (
                <Text className="text-xs text-destructive">{status.data.source.lastError}</Text>
              ) : null}
            </View>
          ) : (
            <Text className="text-xs text-muted-foreground">
              This feed has not been read yet.
            </Text>
          )}
          <Text className="text-xs text-muted-foreground">
            Identity columns: {configuration.identityKeyFields.join(", ")} — frozen for the life
            of this feed.
          </Text>
          <Button
            variant="outline"
            isLoading={sync.isPending}
            disabled={active === undefined}
            onPress={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success("Sync started"),
                onError: () => toast.error("Couldn't start the sync"),
              })
            }
          >
            <View className="flex-row items-center gap-1.5">
              <RefreshCw size={14} color={colors.foreground} />
              <Text className="text-xs font-semibold text-foreground">
                {active === undefined ? "Activate a mapping first" : "Sync now"}
              </Text>
            </View>
          </Button>
        </View>

        {status.data && status.data.runs.length > 0 ? (
          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted-foreground">Recent runs</Text>
            {status.data.runs.map((run) => (
              <View key={run.id} className="rounded-2xl border border-border bg-surface p-4">
                <Text className="text-sm font-semibold text-foreground">
                  {run.kind} · {run.status}
                  {run.outcome ? ` · ${run.outcome}` : ""}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {formatWhen(run.startedAt, "unknown")}
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {run.fetched} read · {run.stored} stored · {run.unchanged} unchanged ·{" "}
                  {run.rejected} rejected · {run.offersUpserted} listed · {run.offersRetired}{" "}
                  retired
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <Versions storeId={storeId} configurationId={configurationId} versions={versions} />
        <DraftVersion storeId={storeId} configurationId={configurationId} />
        <Reports storeId={storeId} configurationId={configurationId} />
      </View>
    </Screen>
  );
}

/** The mapping versions, with the preview / validate / activate sequence. */
function Versions({
  storeId,
  configurationId,
  versions,
}: {
  storeId: string;
  configurationId: string;
  versions: FeedVersion[];
}) {
  const preview = usePreviewFeedVersion(storeId, configurationId);
  const validate = useValidateFeedVersion(storeId, configurationId);
  const activate = useActivateFeedVersion(storeId, configurationId);
  const [previewed, setPreviewed] = useState<{ versionId: string; result: FeedPreview } | null>(
    null,
  );

  if (versions.length === 0) {
    return (
      <View className="items-center justify-center rounded-2xl border border-dashed border-border py-10">
        <Text className="text-sm font-semibold text-foreground">No mapping yet</Text>
        <Text className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
          Describe your file below and map its columns onto Mercaria&apos;s fields.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Mappings</Text>
      {versions.map((version) => (
        <View key={version.id} className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">Version {version.version}</Text>
            <View
              className={`rounded-full px-2 py-0.5 ${
                version.status === "active" ? "bg-primary/10" : "bg-muted"
              }`}
            >
              <Text
                className={`text-[10px] font-semibold ${
                  version.status === "active" ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {version.status}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-muted-foreground">
            {version.format.toUpperCase()} · {version.deliveryMode === "snapshot"
              ? "full snapshot"
              : "changes only"}
            {version.fetchMode === "url" ? " · fetched over HTTPS" : " · uploaded"}
          </Text>

          {previewed?.versionId === version.id ? (
            <View className="gap-2 rounded-xl bg-muted p-3">
              <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
                Preview
              </Text>
              <Text className="text-xs text-muted-foreground">
                {previewed.result.counts.scanned} read · {previewed.result.counts.valid} valid ·{" "}
                {previewed.result.counts.invalid} invalid · {previewed.result.counts.matched}{" "}
                matched · {previewed.result.counts.created} new ·{" "}
                {previewed.result.counts.review} to review
              </Text>
              {previewed.result.counts.scanned === 0 ? (
                <Text className="text-xs text-destructive">
                  The preview read nothing. An empty result and a mapping that matches no rows look
                  identical — check the file and the record path before activating.
                </Text>
              ) : null}
              {previewed.result.suggestions.length > 0 ? (
                <Text className="text-xs text-muted-foreground">
                  Suggested columns:{" "}
                  {previewed.result.suggestions
                    .map((suggestion) => `${suggestion.sourceField} → ${suggestion.role}`)
                    .join(", ")}
                </Text>
              ) : null}
            </View>
          ) : null}

          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              isLoading={preview.isPending}
              onPress={() =>
                preview.mutate(version.id, {
                  onSuccess: (result) => setPreviewed({ versionId: version.id, result }),
                  onError: () => toast.error("Couldn't preview the feed"),
                })
              }
            >
              <Text className="text-xs font-semibold text-foreground">Preview</Text>
            </Button>
            <Button
              variant="outline"
              size="sm"
              isLoading={validate.isPending}
              onPress={() =>
                validate.mutate(version.id, {
                  onSuccess: (report) =>
                    toast.success(
                      `Checked ${report.scanned} records — ${report.invalid} need attention`,
                    ),
                  onError: () => toast.error("Couldn't check the feed"),
                })
              }
            >
              <Text className="text-xs font-semibold text-foreground">Check whole feed</Text>
            </Button>
            {version.status === "draft" ? (
              <Button
                size="sm"
                isLoading={activate.isPending}
                disabled={version.validatedReportId === null}
                onPress={() => {
                  if (version.validatedReportId === null) return;
                  activate.mutate(
                    { versionId: version.id, reportId: version.validatedReportId },
                    {
                      onSuccess: () => toast.success("Mapping activated"),
                      onError: () => toast.error("Couldn't activate the mapping"),
                    },
                  );
                }}
              >
                <Text className="text-xs font-semibold text-primary-foreground">
                  {version.validatedReportId === null ? "Check it first" : "Activate"}
                </Text>
              </Button>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Describe the file and map its columns — the draft form. */
function DraftVersion({
  storeId,
  configurationId,
}: {
  storeId: string;
  configurationId: string;
}) {
  const draft = useDraftFeedVersion(storeId, configurationId);
  const [feedUrl, setFeedUrl] = useState("");
  const [format, setFormat] = useState<FeedFormat>("csv");
  const [deliveryMode, setDeliveryMode] = useState<FeedDeliveryMode | null>(null);
  const [columns, setColumns] = useState<Record<string, string>>({});

  const fieldMappings = useMemo(
    () =>
      COMMON_ROLES.flatMap((role) => {
        const sourceField = columns[role]?.trim();
        return sourceField ? [{ role, sourceField }] : [];
      }),
    [columns],
  );

  const submit = () => {
    if (!feedUrl.trim().startsWith("https://")) {
      toast.error("The feed URL must start with https://");
      return;
    }
    if (deliveryMode === null) {
      toast.error("Choose whether the file is a full snapshot or only changes");
      return;
    }
    if (!fieldMappings.some((mapping) => mapping.role === "title")) {
      toast.error("Map a column onto the product title");
      return;
    }
    draft.mutate(
      {
        fetchMode: "url",
        feedUrl: feedUrl.trim(),
        format,
        deliveryMode,
        fieldMappings,
      },
      {
        onSuccess: () => {
          toast.success("Mapping saved — preview it before activating");
          setColumns({});
        },
        onError: () => toast.error("Couldn't save the mapping"),
      },
    );
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">New mapping</Text>

      <View className="gap-1.5">
        <Label>Feed URL</Label>
        <Input
          value={feedUrl}
          onChangeText={setFeedUrl}
          placeholder="https://example.com/products.csv"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text className="text-xs text-muted-foreground">
          HTTPS only. Mercaria stores this privately and only ever shows you the host — a feed URL
          often carries an access key.
        </Text>
      </View>

      <View className="gap-1.5">
        <Label>Format</Label>
        <ToggleGroup
          type="single"
          value={format}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== "") setFormat(next as FeedFormat);
          }}
        >
          {FORMATS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              <Text className="text-xs font-medium">{option.toUpperCase()}</Text>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </View>

      <View className="gap-1.5">
        <Label>What does this file contain?</Label>
        <ToggleGroup
          type="single"
          value={deliveryMode ?? ""}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== "") setDeliveryMode(next as FeedDeliveryMode);
          }}
        >
          <ToggleGroupItem value="snapshot">
            <Text className="text-xs font-medium">Everything I sell</Text>
          </ToggleGroupItem>
          <ToggleGroupItem value="delta">
            <Text className="text-xs font-medium">Only what changed</Text>
          </ToggleGroupItem>
        </ToggleGroup>
        <Text className="text-xs text-muted-foreground">
          There is no default, on purpose. If the file lists everything you sell, a product missing
          from it is one you stopped selling and Mercaria will delist it. If it lists only changes,
          a missing product means nothing and Mercaria will leave it alone. Getting this wrong
          either delists a healthy catalog or keeps sold-out products on sale.
        </Text>
      </View>

      <View className="gap-2">
        <Label>Map your columns</Label>
        {COMMON_ROLES.map((role) => (
          <View key={role} className="gap-1">
            <Text className="text-xs font-medium text-muted-foreground">
              {role.replace(/_/g, " ")}
              {role === "title" ? " (required)" : ""}
            </Text>
            <Input
              value={columns[role] ?? ""}
              onChangeText={(value) => setColumns((prev) => ({ ...prev, [role]: value }))}
              placeholder="your column name"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}
      </View>

      <Button onPress={submit} isLoading={draft.isPending}>
        <Text className="font-semibold text-primary-foreground">Save mapping</Text>
      </Button>
    </View>
  );
}

/** The validation and import reports, and the CSV a merchant downloads. */
function Reports({ storeId, configurationId }: { storeId: string; configurationId: string }) {
  const reports = useFeedReports(storeId, configurationId);
  if (reports.isPending || reports.isError || (reports.data ?? []).length === 0) return null;

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">Reports</Text>
      {(reports.data ?? []).map((report) => (
        <View key={report.id} className="rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">{report.mode}</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            {formatWhen(report.createdAt, "unknown")}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {report.scanned} read · {report.valid} valid · {report.invalid} need attention
          </Text>
          <Text className="mt-1 text-[11px] text-muted-foreground">
            The downloadable report gives the row number and what was wrong with it — never the
            values, since you already have the file.
          </Text>
        </View>
      ))}
    </View>
  );
}
