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
import type {
  CatalogSourceHealthState,
  CatalogSourceRunKind,
  CatalogSourceRunStatus,
  CatalogSourceStatus,
  FeedDeliveryMode,
  FeedFieldRole,
  FeedFormat,
  FeedImportReportMode,
} from "@mercaria/shared-types";
import { Button, Input, Label, Text, ToggleGroup, ToggleGroupItem, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { formatWhen } from "@/components/channels/channel-presentation";
import { useTranslation } from "@/lib/i18n";
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

/**
 * The six closed vocabularies this screen renders (#560).
 *
 * All six arrived here as bare identifiers — `auth_failure`, `superseded`,
 * `incremental` — and were printed verbatim, so a merchant reading this screen
 * in German got German chrome around English wire values. `Record`s over the
 * shared-types unions rather than lookups with a fallback: a fallback renders
 * the identifier again, which is the defect, and a member added upstream fails
 * `tsc` here instead.
 *
 * ONE map serves the source's `healthState` and a run's `outcome`, because they
 * are one union (`catalog_source_runs.outcome` is a
 * `CatalogSourceHealthState`) — the health of a source IS the outcome of its
 * last pass, and two maps over one union are two things a translator can make
 * disagree.
 *
 * `outcome` and `healthState` are NOT findings of the i18n guard's check J: it
 * reads a JSX child property access, and those two sit inside a template
 * literal and beside a fixed separator respectively. They are fixed here anyway
 * because they render on the SAME LINE as values that are — leaving them would
 * have produced "Active · auth_failure", which is worse than either half.
 */
const SOURCE_STATUS_LABEL_KEYS: Record<CatalogSourceStatus, string> = {
  draft: "feeds.source.status.draft",
  active: "feeds.source.status.active",
  paused: "feeds.source.status.paused",
  revoked: "feeds.source.status.revoked",
  failed: "feeds.source.status.failed",
};

const SOURCE_HEALTH_LABEL_KEYS: Record<CatalogSourceHealthState, string> = {
  unknown: "feeds.source.health.unknown",
  full_feed_success: "feeds.source.health.full_feed_success",
  partial_feed: "feeds.source.health.partial_feed",
  auth_failure: "feeds.source.health.auth_failure",
  rate_limit: "feeds.source.health.rate_limit",
  source_outage: "feeds.source.health.source_outage",
  schema_drift: "feeds.source.health.schema_drift",
  rights_suspended: "feeds.source.health.rights_suspended",
  parse_failure: "feeds.source.health.parse_failure",
  matching_ambiguity: "feeds.source.health.matching_ambiguity",
  anomalous_change: "feeds.source.health.anomalous_change",
};

const RUN_KIND_LABEL_KEYS: Record<CatalogSourceRunKind, string> = {
  backfill: "feeds.run.kind.backfill",
  incremental: "feeds.run.kind.incremental",
  webhook: "feeds.run.kind.webhook",
  manual: "feeds.run.kind.manual",
};

const RUN_STATUS_LABEL_KEYS: Record<CatalogSourceRunStatus, string> = {
  pending: "feeds.run.status.pending",
  running: "feeds.run.status.running",
  completed: "feeds.run.status.completed",
  failed: "feeds.run.status.failed",
};

const VERSION_STATUS_LABEL_KEYS: Record<FeedVersion["status"], string> = {
  draft: "feeds.versions.status.draft",
  active: "feeds.versions.status.active",
  superseded: "feeds.versions.status.superseded",
};

const REPORT_MODE_LABEL_KEYS: Record<FeedImportReportMode, string> = {
  preview: "feeds.reports.mode.preview",
  validation: "feeds.reports.mode.validation",
  import: "feeds.reports.mode.import",
};

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
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("feeds.detail.documentTitle")}</title>
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
  const { t, locale } = useTranslation();
  const feed = useFeed(storeId, configurationId);
  const status = useFeedStatus(storeId, configurationId);
  const sync = useSyncFeed(storeId, configurationId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (feed.isPending) {
    return (
      <Screen title={t("feeds.detail.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (feed.isError || !feed.data) {
    return (
      <Screen title={t("feeds.detail.title")} action={back}>
        <ScreenMessage
          title={t("feeds.detail.notFound")}
          body={t("feeds.detail.notFoundBody")}
        />
      </Screen>
    );
  }

  const { configuration, versions } = feed.data;
  const active = versions.find((version) => version.status === "active");

  return (
    <Screen title={configuration.label} subtitle={t("feeds.detail.title")} action={back}>
      <View className="gap-8">
        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">{t("common.status")}</Text>
          {status.data?.source ? (
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                {t(SOURCE_STATUS_LABEL_KEYS[status.data.source.status])} ·{" "}
                {t(SOURCE_HEALTH_LABEL_KEYS[status.data.source.healthState])}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("feeds.detail.readSchedule", {
                  last: formatWhen(
                    status.data.source.lastAttemptAt ?? undefined,
                    t("feeds.never"),
                    locale,
                  ),
                  next: formatWhen(
                    status.data.source.nextRunAt ?? undefined,
                    t("feeds.unscheduled"),
                    locale,
                  ),
                })}
              </Text>
              {status.data.source.lastError ? (
                <Text className="text-xs text-destructive">{status.data.source.lastError}</Text>
              ) : null}
            </View>
          ) : (
            <Text className="text-xs text-muted-foreground">{t("feeds.detail.neverRead")}</Text>
          )}
          <Text className="text-xs text-muted-foreground">
            {t("feeds.detail.identityColumns", {
              columns: configuration.identityKeyFields.join(", "),
            })}
          </Text>
          <Button
            variant="outline"
            isLoading={sync.isPending}
            disabled={active === undefined}
            onPress={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success(t("feeds.toast.syncStarted")),
                onError: () => toast.error(t("feeds.toast.syncStartFailed")),
              })
            }
          >
            <View className="flex-row items-center gap-1.5">
              <RefreshCw size={14} color={colors.foreground} />
              <Text className="text-xs font-semibold text-foreground">
                {active === undefined
                  ? t("feeds.detail.activateMappingFirst")
                  : t("feeds.detail.syncNow")}
              </Text>
            </View>
          </Button>
        </View>

        {status.data && status.data.runs.length > 0 ? (
          <View className="gap-3">
            <Text className="text-sm font-semibold text-muted-foreground">
              {t("feeds.detail.recentRuns")}
            </Text>
            {status.data.runs.map((run) => (
              <View key={run.id} className="rounded-2xl border border-border bg-surface p-4">
                <Text className="text-sm font-semibold text-foreground">
                  {t(RUN_KIND_LABEL_KEYS[run.kind])} · {t(RUN_STATUS_LABEL_KEYS[run.status])}
                  {run.outcome ? ` · ${t(SOURCE_HEALTH_LABEL_KEYS[run.outcome])}` : ""}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {formatWhen(run.startedAt, t("common.unknown"), locale)}
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {t("feeds.detail.runCounts", {
                    fetched: run.fetched,
                    stored: run.stored,
                    unchanged: run.unchanged,
                    rejected: run.rejected,
                    listed: run.offersUpserted,
                    retired: run.offersRetired,
                  })}
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
  const { t } = useTranslation();
  const preview = usePreviewFeedVersion(storeId, configurationId);
  const validate = useValidateFeedVersion(storeId, configurationId);
  const activate = useActivateFeedVersion(storeId, configurationId);
  const [previewed, setPreviewed] = useState<{ versionId: string; result: FeedPreview } | null>(
    null,
  );

  if (versions.length === 0) {
    return (
      <View className="items-center justify-center rounded-2xl border border-dashed border-border py-10">
        <Text className="text-sm font-semibold text-foreground">
          {t("feeds.versions.empty")}
        </Text>
        <Text className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
          {t("feeds.versions.emptyBody")}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("feeds.versions.title")}
      </Text>
      {versions.map((version) => (
        <View key={version.id} className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">
              {t("feeds.versions.version", { version: version.version })}
            </Text>
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
                {t(VERSION_STATUS_LABEL_KEYS[version.status])}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-muted-foreground">
            {t("feeds.versions.summary", {
              format: version.format.toUpperCase(),
              delivery:
                version.deliveryMode === "snapshot"
                  ? t("feeds.versions.deliveryFullSnapshot")
                  : t("feeds.versions.deliveryChangesOnly"),
              fetch:
                version.fetchMode === "url"
                  ? t("feeds.versions.fetchedOverHttps")
                  : t("feeds.versions.uploaded"),
            })}
          </Text>

          {previewed?.versionId === version.id ? (
            <View className="gap-2 rounded-xl bg-muted p-3">
              <Text className="text-[11px] font-semibold uppercase text-muted-foreground">
                {t("feeds.versions.preview")}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("feeds.versions.previewCounts", {
                  scanned: previewed.result.counts.scanned,
                  valid: previewed.result.counts.valid,
                  invalid: previewed.result.counts.invalid,
                  matched: previewed.result.counts.matched,
                  created: previewed.result.counts.created,
                  review: previewed.result.counts.review,
                })}
              </Text>
              {previewed.result.counts.scanned === 0 ? (
                <Text className="text-xs text-destructive">
                  {t("feeds.versions.previewReadNothing")}
                </Text>
              ) : null}
              {previewed.result.suggestions.length > 0 ? (
                <Text className="text-xs text-muted-foreground">
                  {t("feeds.versions.suggestedColumns", {
                    columns: previewed.result.suggestions
                      .map((suggestion) => `${suggestion.sourceField} → ${suggestion.role}`)
                      .join(", "),
                  })}
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
                  onError: () => toast.error(t("feeds.toast.previewFailed")),
                })
              }
            >
              <Text className="text-xs font-semibold text-foreground">
                {t("feeds.versions.preview")}
              </Text>
            </Button>
            <Button
              variant="outline"
              size="sm"
              isLoading={validate.isPending}
              onPress={() =>
                validate.mutate(version.id, {
                  onSuccess: (report) =>
                    toast.success(
                      t("feeds.toast.checked", {
                        scanned: report.scanned,
                        invalid: report.invalid,
                      }),
                    ),
                  onError: () => toast.error(t("feeds.toast.checkFailed")),
                })
              }
            >
              <Text className="text-xs font-semibold text-foreground">
                {t("feeds.versions.checkWholeFeed")}
              </Text>
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
                      onSuccess: () => toast.success(t("feeds.toast.mappingActivated")),
                      onError: () => toast.error(t("feeds.toast.mappingActivateFailed")),
                    },
                  );
                }}
              >
                <Text className="text-xs font-semibold text-primary-foreground">
                  {version.validatedReportId === null
                    ? t("feeds.versions.checkItFirst")
                    : t("feeds.versions.activate")}
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
  const { t } = useTranslation();
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
      toast.error(t("feeds.toast.urlMustBeHttps"));
      return;
    }
    if (deliveryMode === null) {
      toast.error(t("feeds.toast.deliveryModeRequired"));
      return;
    }
    if (!fieldMappings.some((mapping) => mapping.role === "title")) {
      toast.error(t("feeds.toast.titleMappingRequired"));
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
          toast.success(t("feeds.toast.mappingSaved"));
          setColumns({});
        },
        onError: () => toast.error(t("feeds.toast.mappingSaveFailed")),
      },
    );
  };

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{t("feeds.draft.title")}</Text>

      <View className="gap-1.5">
        <Label>{t("feeds.draft.urlLabel")}</Label>
        <Input
          value={feedUrl}
          onChangeText={setFeedUrl}
          placeholder={t("feeds.draft.urlPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text className="text-xs text-muted-foreground">{t("feeds.draft.urlHint")}</Text>
      </View>

      <View className="gap-1.5">
        <Label>{t("feeds.draft.formatLabel")}</Label>
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
        <Label>{t("feeds.draft.deliveryLabel")}</Label>
        <ToggleGroup
          type="single"
          value={deliveryMode ?? ""}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== "") setDeliveryMode(next as FeedDeliveryMode);
          }}
        >
          <ToggleGroupItem value="snapshot">
            <Text className="text-xs font-medium">{t("feeds.draft.deliverySnapshot")}</Text>
          </ToggleGroupItem>
          <ToggleGroupItem value="delta">
            <Text className="text-xs font-medium">{t("feeds.draft.deliveryDelta")}</Text>
          </ToggleGroupItem>
        </ToggleGroup>
        <Text className="text-xs text-muted-foreground">{t("feeds.draft.deliveryHint")}</Text>
      </View>

      <View className="gap-2">
        <Label>{t("feeds.draft.columnsLabel")}</Label>
        {COMMON_ROLES.map((role) => (
          <View key={role} className="gap-1">
            <Text className="text-xs font-medium text-muted-foreground">
              {role.replace(/_/g, " ")}
              {role === "title" ? t("feeds.draft.requiredSuffix") : ""}
            </Text>
            <Input
              value={columns[role] ?? ""}
              onChangeText={(value) => setColumns((prev) => ({ ...prev, [role]: value }))}
              placeholder={t("feeds.draft.columnPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}
      </View>

      <Button onPress={submit} isLoading={draft.isPending}>
        <Text className="font-semibold text-primary-foreground">{t("feeds.draft.save")}</Text>
      </Button>
    </View>
  );
}

/** The validation and import reports, and the CSV a merchant downloads. */
function Reports({ storeId, configurationId }: { storeId: string; configurationId: string }) {
  const { t, locale } = useTranslation();
  const reports = useFeedReports(storeId, configurationId);
  if (reports.isPending || reports.isError || (reports.data ?? []).length === 0) return null;

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-muted-foreground">
        {t("feeds.reports.title")}
      </Text>
      {(reports.data ?? []).map((report) => (
        <View key={report.id} className="rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">
            {t(REPORT_MODE_LABEL_KEYS[report.mode])}
          </Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            {formatWhen(report.createdAt, t("common.unknown"), locale)}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {t("feeds.reports.counts", {
              scanned: report.scanned,
              valid: report.valid,
              invalid: report.invalid,
            })}
          </Text>
          <Text className="mt-1 text-[11px] text-muted-foreground">
            {t("feeds.reports.note")}
          </Text>
        </View>
      ))}
    </View>
  );
}
