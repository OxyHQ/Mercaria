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
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import {
  useCollections,
  useCreateCollection,
  useDeleteCollection,
} from "@/lib/hooks/use-collections";

/** Slugify a title into a URL-safe handle. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function CollectionsScreen() {
  return (
    <>
      <Head>
        <title>Collections | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="collections:write">
        {(storeId) => <CollectionsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function CollectionsBody({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const { data, isPending, isError } = useCollections(storeId);
  const deleteCollection = useDeleteCollection(storeId);
  const [createOpen, setCreateOpen] = useState(false);

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">New</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen title="Collections" subtitle="Group products for merchandising" action={action}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load collections" body="Please try again." />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title="No collections yet" body="Create one to organize your catalog." />
      ) : (
        <View className="gap-2">
          {data?.map((collection) => (
            <CollectionRow
              key={collection.id}
              collection={collection}
              onDelete={() =>
                deleteCollection.mutate(collection.id, {
                  onSuccess: () => toast.success("Collection deleted"),
                  onError: () => toast.error("Couldn't delete the collection"),
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
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <FolderTree size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{collection.title}</Text>
        <Text className="text-xs text-muted-foreground">
          {collection.type} ·{" "}
          {collection.type === "manual"
            ? `${collection.productIds.length} products`
            : `${collection.rules?.conditions.length ?? 0} rules`}{" "}
          · {collection.isPublished ? "published" : "draft"}
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
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CollectionType>("manual");

  const submit = () => {
    if (!title.trim()) {
      toast.error("Title is required");
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
          toast.success("Collection created");
          setTitle("");
          setType("manual");
          onOpenChange(false);
        },
        onError: () => toast.error("Couldn't create the collection"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Title</Label>
            <Input value={title} onChangeText={setTitle} placeholder="Summer essentials" />
          </View>
          <View className="gap-1.5">
            <Label>Type</Label>
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => typeof v === "string" && v && setType(v as CollectionType)}
            >
              <ToggleGroupItem value="manual">
                <Text className="text-sm text-foreground">Manual</Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="automated">
                <Text className="text-sm text-foreground">Automated</Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          <Button onPress={submit} isLoading={createCollection.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Create</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
