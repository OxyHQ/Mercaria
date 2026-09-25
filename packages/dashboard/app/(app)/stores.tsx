import React, { useState } from "react";
import { RiStore2Line } from "@oxy.so/bloom/icons/RiStore2Line";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { Check, Plus, Store as StoreIcon } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import {
  Text,
  useColorScheme,
  toBloomIcon,
} from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Dialog, useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import { toast } from "@oxy.so/bloom/toast";
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
  const createControl = useDialogControl();

  const onSelect = (store: Store) => {
    setActiveStoreId(store.id);
    router.replace("/");
  };

  const action = (
    <Button
      tone="accent"
      leadingIcon={toBloomIcon(Plus)}
      onPress={() => createControl.open()}
    >
      {t("stores.newStore")}
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
          <View className="rounded-2xl border border-dashed border-border">
            <EmptyState
              icon={RiStore2Line}
              title={t("stores.empty.title")}
              description={t("stores.empty.body")}
              action={{ label: t("stores.createStore"), onPress: () => createControl.open() }}
            />
          </View>
        )}
      </Screen>

      <CreateStoreDialog
        control={createControl}
        onCreated={(store) => {
          setActiveStoreId(store.id);
          router.replace("/");
        }}
      />
    </>
  );
}

function CreateStoreDialog({
  control,
  onCreated,
}: {
  control: DialogControlProps;
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
          // Navigating away unmounts this dialog, so it waits for the exit
          // animation to finish rather than racing it.
          control.close(() => onCreated(store));
        },
        onError: () => toast.error(t("stores.create.error")),
      },
    );
  };

  return (
    <Dialog control={control} title={t("stores.create.dialogTitle")}>
      <View className="gap-4">
        <Field label={t("stores.create.nameLabel")}>
          <TextFieldInput
            label={t("stores.create.nameLabel")}
            value={name}
            onValueChange={setName}
            placeholder={t("stores.create.namePlaceholder")}
          />
        </Field>
        <Field label={t("common.description")}>
          <TextFieldInput
            label={t("common.description")}
            value={description}
            onValueChange={setDescription}
            placeholder={t("stores.create.descriptionPlaceholder")}
          />
        </Field>
        <Button tone="accent" onPress={submit} loading={createStore.isPending} className="mt-2">
          {t("stores.createStore")}
        </Button>
      </View>
    </Dialog>
  );
}
