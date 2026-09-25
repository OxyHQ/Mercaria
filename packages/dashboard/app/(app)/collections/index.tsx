import React, { useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { Plus, FolderTree, Trash2 } from "lucide-react-native";
import type { Collection, CollectionType } from "@mercaria/shared-types";
import {
  Text,
  Input,
  Label,
  useColorScheme,
  toBloomIcon,
} from "@mercaria/ui";
import { Button } from "@oxy.so/bloom/button";
import { Dialog, useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { toast } from "@oxy.so/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useCollections,
  useCreateCollection,
  useDeleteCollection,
} from "@/lib/hooks/use-collections";
import { useTranslation } from "@/lib/i18n";

/** Slugify a title into a URL-safe handle. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function CollectionsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("collections.documentTitle")}</title>
      </Head>
      <RequireStore permission="collections:write">
        {(storeId) => <CollectionsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function CollectionsBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useCollections(storeId);
  const deleteCollection = useDeleteCollection(storeId);
  const createControl = useDialogControl();

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => createControl.open()}
      >
        {t("common.new")}
      </Button>
    </View>
  );

  return (
    <Screen title={t("nav.collections")} subtitle={t("collections.subtitle")} action={action}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("collections.loadError")} body={t("common.pleaseTryAgain")} />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title={t("collections.empty.title")} body={t("collections.empty.body")} />
      ) : (
        <View className="gap-2">
          {data?.map((collection) => (
            <CollectionRow
              key={collection.id}
              collection={collection}
              onDelete={() =>
                deleteCollection.mutate(collection.id, {
                  onSuccess: () => toast.success(t("collections.deleted")),
                  onError: () => toast.error(t("collections.deleteError")),
                })
              }
            />
          ))}
        </View>
      )}

      <CreateCollectionDialog storeId={storeId} control={createControl} />
    </Screen>
  );
}

function CollectionRow({
  collection,
  onDelete,
}: {
  collection: Collection;
  onDelete: () => void;
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  // The meta line is composed from three independently-translated facts rather
  // than concatenated in JSX, so a locale can reorder them. The placeholder is
  // `items`, NOT `count`: i18n-js pluralizes any key called with a `count`
  // option, which would look for `one`/`other` under a key that has neither.
  const typeLabel = t(
    collection.type === "manual" ? "collections.type.manual" : "collections.type.automated",
  );
  const itemsLabel =
    collection.type === "manual"
      ? t("collections.productCount", { count: collection.productIds.length })
      : t("collections.ruleCount", { count: collection.rules?.conditions.length ?? 0 });
  const stateLabel = t(
    collection.isPublished ? "collections.state.published" : "collections.state.draft",
  );
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <FolderTree size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{collection.title}</Text>
        <Text className="text-xs text-muted-foreground">
          {t("collections.rowMeta", {
            type: typeLabel,
            items: itemsLabel,
            state: stateLabel,
          })}
        </Text>
      </View>
      <Pressable onPress={onDelete} className="p-2 active:opacity-70">
        <Trash2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

function CreateCollectionDialog({
  storeId,
  control,
}: {
  storeId: string;
  control: DialogControlProps;
}) {
  const createCollection = useCreateCollection(storeId);
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CollectionType>("manual");

  const submit = () => {
    if (!title.trim()) {
      toast.error(t("collections.create.titleRequired"));
      return;
    }
    createCollection.mutate(
      {
        title: title.trim(),
        handle: slugify(title),
        type,
        ...(type === "automated"
          ? { rules: { appliesDisjunctively: false, conditions: [] } }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success(t("collections.create.success"));
          setTitle("");
          setType("manual");
          control.close();
        },
        onError: () => toast.error(t("collections.create.error")),
      },
    );
  };

  return (
    <Dialog control={control} title={t("collections.create.dialogTitle")}>
      <View className="gap-4">
        <View className="gap-1.5">
          <Label>{t("common.title")}</Label>
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder={t("collections.create.titlePlaceholder")}
          />
        </View>
        <View className="gap-1.5">
          <Label>{t("common.type")}</Label>
          <SegmentedControl
            type="radio"
            label={t("common.type")}
            value={type}
            onValueChange={setType}
          >
            <SegmentedControlItem value="manual">
              <SegmentedControlItemText>{t("collections.create.typeManual")}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="automated">
              <SegmentedControlItemText>
                {t("collections.create.typeAutomated")}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>
        <Button tone="accent" onPress={submit} loading={createCollection.isPending} className="mt-1">
          {t("common.create")}
        </Button>
      </View>
    </Dialog>
  );
}
