import React, { useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { Plus, FolderTree, Trash2 } from "lucide-react-native";
import type { Collection, CollectionType } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  ToggleGroup,
  ToggleGroupItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
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
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useCollections(storeId);
  const deleteCollection = useDeleteCollection(storeId);
  const [createOpen, setCreateOpen] = useState(false);

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">{t("common.new")}</Text>
        </View>
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

      <CreateCollectionDialog storeId={storeId} open={createOpen} onOpenChange={setCreateOpen} />
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
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
          onOpenChange(false);
        },
        onError: () => toast.error(t("collections.create.error")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("collections.create.dialogTitle")}</DialogTitle>
        </DialogHeader>
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
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => typeof v === "string" && v && setType(v as CollectionType)}
            >
              <ToggleGroupItem value="manual">
                <Text className="text-sm text-foreground">
                  {t("collections.create.typeManual")}
                </Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="automated">
                <Text className="text-sm text-foreground">
                  {t("collections.create.typeAutomated")}
                </Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          <Button onPress={submit} isLoading={createCollection.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">{t("common.create")}</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
