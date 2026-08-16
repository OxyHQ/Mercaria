import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import { Text, Button, Input, Label, Textarea, Switch, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useStore, useUpdateStoreSettings } from "@/lib/hooks/use-stores";

export default function PoliciesScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.policies.documentTitle")}</title>
      </Head>
      <RequireStore permission="settings:write">
        {(storeId) => <PoliciesBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function PoliciesBody({ storeId }: { storeId: string }) {
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
      <Screen title={t("settings.policies.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("settings.policies.title")} action={back}>
        <ScreenMessage
          title={t("settings.policies.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("settings.policies.title")}
      subtitle={t("settings.policies.subtitle")}
      action={back}
    >
      <PoliciesForm storeId={storeId} store={data} />
    </Screen>
  );
}

function PoliciesForm({ storeId, store }: { storeId: string; store: Store }) {
  const updateSettings = useUpdateStoreSettings(storeId);
  const { t } = useTranslation();

  const [returnWindow, setReturnWindow] = useState(String(store.policies.returnWindowDays ?? 0));
  const [refundPolicy, setRefundPolicy] = useState(store.policies.refundPolicy ?? "");
  const [privacyPolicy, setPrivacyPolicy] = useState(store.policies.privacyPolicy ?? "");
  const [termsOfService, setTermsOfService] = useState(store.policies.termsOfService ?? "");
  const [lowStockAlerts, setLowStockAlerts] = useState(
    store.notificationSettings?.lowStockAlerts ?? true,
  );
  const [orderEmails, setOrderEmails] = useState(store.notificationSettings?.orderEmails ?? true);

  const save = () => {
    const parsedWindow = Number.parseInt(returnWindow || "0", 10);
    updateSettings.mutate(
      {
        policies: {
          returnWindowDays: Number.isFinite(parsedWindow) ? Math.max(0, parsedWindow) : 0,
          refundPolicy: refundPolicy.trim(),
          privacyPolicy: privacyPolicy.trim(),
          termsOfService: termsOfService.trim(),
        },
        notificationSettings: { lowStockAlerts, orderEmails },
      },
      {
        onSuccess: () => toast.success(t("settings.policies.saved")),
        onError: () => toast.error(t("settings.policies.saveFailed")),
      },
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-1.5">
        <Label>{t("settings.policies.returnWindowLabel")}</Label>
        <Input value={returnWindow} onChangeText={setReturnWindow} keyboardType="number-pad" />
      </View>
      <View className="gap-1.5">
        <Label>{t("settings.policies.refundPolicyLabel")}</Label>
        <Textarea
          value={refundPolicy}
          onChangeText={setRefundPolicy}
          placeholder={t("settings.policies.refundPolicyPlaceholder")}
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("settings.policies.privacyPolicyLabel")}</Label>
        <Textarea
          value={privacyPolicy}
          onChangeText={setPrivacyPolicy}
          placeholder={t("settings.policies.privacyPolicyPlaceholder")}
        />
      </View>
      <View className="gap-1.5">
        <Label>{t("settings.policies.termsLabel")}</Label>
        <Textarea
          value={termsOfService}
          onChangeText={setTermsOfService}
          placeholder={t("settings.policies.termsPlaceholder")}
        />
      </View>

      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="mb-3 text-sm font-semibold text-foreground">
          {t("settings.policies.notifications")}
        </Text>
        <View className="flex-row items-center justify-between py-2">
          <Text className="flex-1 text-sm text-foreground">
            {t("settings.policies.lowStockAlerts")}
          </Text>
          <Switch value={lowStockAlerts} onValueChange={setLowStockAlerts} />
        </View>
        <View className="flex-row items-center justify-between py-2">
          <Text className="flex-1 text-sm text-foreground">
            {t("settings.policies.orderEmails")}
          </Text>
          <Switch value={orderEmails} onValueChange={setOrderEmails} />
        </View>
      </View>

      <Button onPress={save} isLoading={updateSettings.isPending} className="self-start">
        <Text className="font-semibold text-primary-foreground">
          {t("settings.policies.saveSettings")}
        </Text>
      </Button>
    </View>
  );
}
