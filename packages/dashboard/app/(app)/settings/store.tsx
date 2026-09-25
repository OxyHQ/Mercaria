import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import { Text, ColorPicker, useColorScheme } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Textarea } from "@oxy.so/bloom/textarea";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useStore, useUpdateStore } from "@/lib/hooks/use-stores";

export default function StoreProfileScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.store.documentTitle")}</title>
      </Head>
      <RequireStore permission="store:manage">
        {(storeId) => <StoreProfileBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function StoreProfileBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useStore(storeId);

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
      <Screen title={t("settings.store.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("settings.store.title")} action={back}>
        <ScreenMessage
          title={t("settings.store.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      </Screen>
    );
  }

  return (
    <Screen title={t("settings.store.title")} subtitle={`@${data.handle}`} action={back}>
      <StoreProfileForm storeId={storeId} store={data} />
    </Screen>
  );
}

function StoreProfileForm({ storeId, store }: { storeId: string; store: Store }) {
  const updateStore = useUpdateStore(storeId);
  const { t } = useTranslation();
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description);
  const [brandColor, setBrandColor] = useState(store.brandColor);

  const save = () => {
    if (!name.trim()) {
      toast.error(t("settings.store.nameRequired"));
      return;
    }
    updateStore.mutate(
      { name: name.trim(), description: description.trim(), brandColor },
      {
        onSuccess: () => toast.success(t("settings.store.updated")),
        onError: () => toast.error(t("settings.store.updateFailed")),
      },
    );
  };

  return (
    <View className="gap-5">
      <Field label={t("settings.store.nameLabel")}>
        <TextFieldInput
          label={t("settings.store.nameLabel")}
          value={name}
          onValueChange={setName}
          placeholder={null}
        />
      </Field>
      <Field label={t("common.description")}>
        <Textarea autoResize value={description} onValueChange={setDescription} />
      </Field>
      <ColorPicker
        label={t("settings.store.brandColorLabel")}
        selected={brandColor}
        onSelect={setBrandColor}
      />

      <Button tone="accent" onPress={save} loading={updateStore.isPending} className="self-start">
        {t("settings.store.saveChanges")}
      </Button>
    </View>
  );
}
