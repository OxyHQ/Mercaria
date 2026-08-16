import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Check, Plus, Store as StoreIcon } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useMyStores, useCreateStore } from "@/lib/hooks/use-stores";
import { useTranslation } from "@/lib/i18n";
import { useActiveStore } from "@/lib/stores/active-store";

/** Store picker: choose the active store, or create the first one. */
export default function StoresScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data: stores, isPending, isError } = useMyStores();
  const { activeStoreId, setActiveStoreId } = useActiveStore();
  const [createOpen, setCreateOpen] = useState(false);

  const onSelect = (store: Store) => {
    setActiveStoreId(store.id);
    router.replace("/");
  };

  const action = (
    <Button onPress={() => setCreateOpen(true)}>
      <View className="flex-row items-center gap-2">
        <Plus size={16} color={colors.primaryForeground} />
        <Text className="font-semibold text-primary-foreground">{t("stores.newStore")}</Text>
      </View>
    </Button>
  );

  return (
    <>
      <Head>
        <title>{t("stores.documentTitle")}</title>
      </Head>
      <Screen title={t("stores.title")} subtitle={t("stores.subtitle")} action={action}>
        {isPending ? (
          <ScreenLoading />
        ) : isError ? (
          <ScreenMessage title={t("stores.loadError")} body={t("common.pleaseTryAgain")} />
        ) : stores && stores.length > 0 ? (
          <View className="gap-3">
            {stores.map((store) => (
              <Pressable
                key={store.id}
                onPress={() => onSelect(store)}
                className="flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
              >
                <View
                  className="h-12 w-12 items-center justify-center rounded-xl"
                  style={{ backgroundColor: store.brandColor }}
                >
                  <StoreIcon size={22} color="#fff" />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold text-foreground">{store.name}</Text>
                  <Text className="text-sm text-muted-foreground">
                    {t("stores.storeMeta", {
                      handle: store.handle,
                      count: store.productCount,
                    })}
                  </Text>
                </View>
                {activeStoreId === store.id ? (
                  <Check size={20} color={colors.primary} />
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : (
          <View className="items-center justify-center rounded-2xl border border-dashed border-border py-16">
            <StoreIcon size={36} color={colors.mutedForeground} />
            <Text className="mt-4 text-base font-semibold text-foreground">
              {t("stores.empty.title")}
            </Text>
            <Text className="mt-1 max-w-xs text-center text-sm text-muted-foreground">
              {t("stores.empty.body")}
            </Text>
            <Button className="mt-6" onPress={() => setCreateOpen(true)}>
              <Text className="font-semibold text-primary-foreground">
                {t("stores.createStore")}
              </Text>
            </Button>
          </View>
        )}
      </Screen>

      <CreateStoreDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(store) => {
          setActiveStoreId(store.id);
          router.replace("/");
        }}
      />
    </>
  );
}

function CreateStoreDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (store: Store) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createStore = useCreateStore();
  const { t } = useTranslation();

  const submit = () => {
    if (!name.trim()) {
      toast.error(t("stores.create.nameRequired"));
      return;
    }
    createStore.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: (store) => {
          toast.success(t("stores.create.success"));
          setName("");
          setDescription("");
          onOpenChange(false);
          onCreated(store);
        },
        onError: () => toast.error(t("stores.create.error")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("stores.create.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>{t("stores.create.nameLabel")}</Label>
            <Input
              value={name}
              onChangeText={setName}
              placeholder={t("stores.create.namePlaceholder")}
            />
          </View>
          <View className="gap-1.5">
            <Label>{t("common.description")}</Label>
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder={t("stores.create.descriptionPlaceholder")}
            />
          </View>
          <Button onPress={submit} isLoading={createStore.isPending} className="mt-2">
            <Text className="font-semibold text-primary-foreground">
              {t("stores.createStore")}
            </Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
