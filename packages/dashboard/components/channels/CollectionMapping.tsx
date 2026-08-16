/**
 * Mapping a channel's own collections/categories onto Mercaria collections (#376).
 *
 * Until this screen existed, `syncSettings.collectionMapping` was configurable
 * only through the API and NO Mercaria client set it — so every imported product
 * landed in no collection at all, and the merchant had no way to change that.
 * The connect wizard has always advertised the step ("Map categories or
 * collections").
 *
 * ## Why the platform's list comes from the server
 *
 * The mapping's KEYS are the platform's own ids. A merchant cannot discover them
 * and could not type them correctly if they could, and a wrong key fails
 * SILENTLY — `applyCollectionMapping` reports nothing when a ref does not match,
 * so a mapping that is configured and displayed simply never fires. Picking from
 * the platform's real list is what makes the key correct by construction.
 *
 * ## What the screen deliberately does not decide
 *
 * Whether a stored row still works is the SERVER's verdict, arriving as
 * `state` on each row. In particular `target_automated` is not a fact this
 * screen could derive: it rests on knowing that an automated collection's
 * membership is owned by its rules, and that a connector membership and a
 * rule-derived one are indistinguishable in the database — so both writers
 * delete each other's rows. Restating that here is how two answers drift.
 */

import React, { useMemo, useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { CircleAlert, FolderTree, Link2Off } from "lucide-react-native";
import type {
  ChannelCollectionMappingState,
  ChannelCollectionsUnavailableReason,
  ChannelCollectionTarget,
  ChannelCollectionsView,
  Connection,
  ExternalCollection,
  ExternalTaxonomyNoun,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from "@/lib/i18n";
import { useChannelCollections, useUpdateChannelSettings } from "@/lib/hooks/use-channels";

/**
 * The platform's word for a grouping, singular and plural — as translation KEYS
 * (#398), because this module is evaluated at import, before the locale store
 * has rehydrated.
 */
const NOUN_COPY_KEYS: Record<ExternalTaxonomyNoun, { one: string; many: string }> = {
  collection: {
    one: "channels.collectionMapping.noun.collection.singular",
    many: "channels.collectionMapping.noun.collection.plural",
  },
  category: {
    one: "channels.collectionMapping.noun.category.singular",
    many: "channels.collectionMapping.noun.category.plural",
  },
};

/**
 * Why a stored row will not do what it says, in the merchant's terms.
 *
 * Each names the REMEDY, because "this row is broken" without one is a message
 * that cannot be acted on. `ok` has no copy: a working row says nothing.
 */
const STATE_COPY_KEYS: Record<Exclude<ChannelCollectionMappingState, "ok">, string> = {
  external_missing: "channels.collectionMapping.state.externalMissing",
  target_missing: "channels.collectionMapping.state.targetMissing",
  target_automated: "channels.collectionMapping.state.targetAutomated",
};

const UNAVAILABLE_COPY_KEYS: Record<ChannelCollectionsUnavailableReason, string> = {
  push_in_connection: "channels.collectionMapping.unavailable.pushInConnection",
  disconnected: "channels.collectionMapping.unavailable.disconnected",
  platform_unavailable: "channels.collectionMapping.unavailable.platformUnavailable",
};

export function CollectionMapping({
  storeId,
  connection,
}: {
  storeId: string;
  connection: Connection;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useChannelCollections(storeId, connection.id);
  const update = useUpdateChannelSettings(storeId);
  const [picking, setPicking] = useState<string | undefined>(undefined);

  const stored = useMemo(() => connection.syncSettings.collectionMapping ?? {}, [connection]);

  /**
   * Save a whole new mapping.
   *
   * `collectionMapping` is one jsonb value read and written WHOLE, so a partial
   * PATCH is not expressible — the request carries the complete map either way.
   * Building it from the CURRENT stored value plus one change keeps that honest.
   */
  const save = (next: Record<string, string>) => {
    update.mutate(
      { connectionId: connection.id, settings: { collectionMapping: next } },
      {
        onSuccess: () => {
          setPicking(undefined);
          toast.success(t("channels.toast.collectionMappingSaved"));
        },
        // The server refuses a target it cannot honour (an automated collection,
        // a deleted one, another store's) and its message names which. Surfacing
        // that rather than a generic failure is the difference between a merchant
        // fixing it and a merchant retrying it.
        onError: (err: unknown) => {
          const message =
            err instanceof Error && err.message
              ? err.message
              : t("channels.toast.collectionMappingSaveFailed");
          toast.error(message);
        },
      },
    );
  };

  const setTarget = (externalId: string, collectionId: string | undefined) => {
    const next = { ...stored };
    if (collectionId === undefined) {
      delete next[externalId];
    } else {
      next[externalId] = collectionId;
    }
    save(next);
  };

  if (isLoading) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t("channels.collectionMapping.title")}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }
  if (isError || !data) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t("channels.collectionMapping.title")}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t("channels.collectionMapping.loadFailed")}
        </Text>
      </View>
    );
  }

  const noun = NOUN_COPY_KEYS[data.noun];
  const listed = data.external.outcome === "listed" ? data.external.collections : [];
  const byExternalId = new Map(listed.map((c) => [c.externalId, c]));
  // Rows the platform no longer publishes still have to be editable, or a
  // merchant cannot remove the mapping the screen is warning them about.
  const orphanRows = data.mapping.filter((row) => !byExternalId.has(row.externalId));
  const stateByExternalId = new Map(data.mapping.map((row) => [row.externalId, row]));

  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="gap-1">
        <Text className="text-sm font-semibold text-foreground">
          {t("channels.collectionMapping.title")}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("channels.collectionMapping.body", { many: t(noun.many), one: t(noun.one) })}
        </Text>
      </View>

      {data.external.outcome === "unavailable" ? (
        <View className="flex-row gap-2 rounded-xl bg-muted p-3">
          <CircleAlert size={16} className="mt-0.5 text-muted-foreground" />
          <Text className="flex-1 text-xs text-muted-foreground">
            {t(UNAVAILABLE_COPY_KEYS[data.external.reason])}
          </Text>
        </View>
      ) : null}

      {data.targets.length === 0 ? (
        <View className="flex-row gap-2 rounded-xl bg-muted p-3">
          <FolderTree size={16} className="mt-0.5 text-muted-foreground" />
          <Text className="flex-1 text-xs text-muted-foreground">
            {t("channels.collectionMapping.noManualCollections")}
          </Text>
        </View>
      ) : null}

      {listed.map((external) => (
        <MappingRow
          key={external.externalId}
          external={external}
          noun={data.noun}
          targets={data.targets}
          state={stateByExternalId.get(external.externalId)?.state}
          mappedTo={stored[external.externalId]}
          disabled={update.isPending}
          onPress={() => setPicking(external.externalId)}
          onClear={() => setTarget(external.externalId, undefined)}
        />
      ))}

      {orphanRows.map((row) => (
        <MappingRow
          key={row.externalId}
          external={{ externalId: row.externalId, title: row.externalTitle ?? row.externalId }}
          noun={data.noun}
          targets={data.targets}
          state={row.state}
          mappedTo={row.collectionId}
          disabled={update.isPending}
          onPress={() => setPicking(row.externalId)}
          onClear={() => setTarget(row.externalId, undefined)}
        />
      ))}

      <Dialog
        open={picking !== undefined}
        onOpenChange={(open) => setPicking(open ? picking : undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("channels.collectionMapping.pickTitle")}</DialogTitle>
            <DialogDescription>{t("channels.collectionMapping.pickBody")}</DialogDescription>
          </DialogHeader>
          <ScrollView className="max-h-80">
            <View className="gap-2 py-2">
              {data.targets.map((target) => (
                <Pressable
                  key={target.id}
                  accessibilityRole="button"
                  className="rounded-xl border border-border p-3"
                  disabled={update.isPending}
                  onPress={() => picking !== undefined && setTarget(picking, target.id)}
                >
                  <Text className="text-sm font-medium text-foreground">{target.title}</Text>
                  <Text className="text-xs text-muted-foreground">/{target.handle}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <Button
            variant="outline"
            disabled={update.isPending}
            onPress={() => picking !== undefined && setTarget(picking, undefined)}
          >
            <Text className="font-semibold text-foreground">
              {t("channels.collectionMapping.dontMap")}
            </Text>
          </Button>
        </DialogContent>
      </Dialog>
    </View>
  );
}

/** One platform grouping and what it currently maps onto. */
function MappingRow({
  external,
  noun,
  targets,
  state,
  mappedTo,
  disabled,
  onPress,
  onClear,
}: {
  external: Pick<ExternalCollection, "externalId" | "title"> &
    Partial<Pick<ExternalCollection, "productCount" | "parentExternalId">>;
  noun: ExternalTaxonomyNoun;
  targets: readonly ChannelCollectionTarget[];
  state: ChannelCollectionMappingState | undefined;
  mappedTo: string | undefined;
  disabled: boolean;
  onPress: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const target = targets.find((candidate) => candidate.id === mappedTo);
  const problem = state !== undefined && state !== "ok" ? t(STATE_COPY_KEYS[state]) : undefined;

  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-medium text-foreground">{external.title}</Text>
          <Text className="text-xs text-muted-foreground">
            {external.productCount === undefined
              ? t("channels.collectionMapping.channelNoun", {
                  noun: t(NOUN_COPY_KEYS[noun].one),
                })
              : t("channels.collectionMapping.productsOnChannel", {
                  count: external.productCount,
                })}
          </Text>
        </View>
        <Button variant="outline" size="sm" disabled={disabled} onPress={onPress}>
          <Text className="text-xs font-semibold text-foreground">
            {target
              ? target.title
              : mappedTo
                ? t("channels.collectionMapping.fixMapping")
                : t("channels.collectionMapping.map")}
          </Text>
        </Button>
      </View>

      {mappedTo && !target ? (
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center gap-2"
          disabled={disabled}
          onPress={onClear}
        >
          <Link2Off size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground underline">
            {t("channels.collectionMapping.removeMapping")}
          </Text>
        </Pressable>
      ) : null}

      {problem ? (
        <View className="flex-row gap-2 rounded-lg bg-destructive/10 p-2">
          <CircleAlert size={14} className="mt-0.5 text-destructive" />
          <Text className="flex-1 text-xs text-destructive">{problem}</Text>
        </View>
      ) : null}
    </View>
  );
}
