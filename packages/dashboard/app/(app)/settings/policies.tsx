import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import { Text, Button, Input, Label, Textarea, Switch, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useStore, useUpdateStoreSettings } from "@/lib/hooks/use-stores";

export default function PoliciesScreen() {
  return (
    <>
      <Head>
        <title>Policies | Mercaria Dashboard</title>
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
  const { data, isPending, isError } = useStore(storeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title="Policies & notifications" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title="Policies & notifications" action={back}>
        <ScreenMessage title="Couldn't load settings" body="Please try again." />
      </Screen>
    );
  }

  return (
    <Screen title="Policies & notifications" subtitle="Store-wide rules and alerts" action={back}>
      <PoliciesForm storeId={storeId} store={data} />
    </Screen>
  );
}

function PoliciesForm({ storeId, store }: { storeId: string; store: Store }) {
  const updateSettings = useUpdateStoreSettings(storeId);

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
        onSuccess: () => toast.success("Settings saved"),
        onError: () => toast.error("Couldn't save settings"),
      },
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-1.5">
        <Label>Return window (days)</Label>
        <Input value={returnWindow} onChangeText={setReturnWindow} keyboardType="number-pad" />
      </View>
      <View className="gap-1.5">
        <Label>Refund policy</Label>
        <Textarea value={refundPolicy} onChangeText={setRefundPolicy} placeholder="Your refund policy…" />
      </View>
      <View className="gap-1.5">
        <Label>Privacy policy</Label>
        <Textarea value={privacyPolicy} onChangeText={setPrivacyPolicy} placeholder="Your privacy policy…" />
      </View>
      <View className="gap-1.5">
        <Label>Terms of service</Label>
        <Textarea value={termsOfService} onChangeText={setTermsOfService} placeholder="Your terms of service…" />
      </View>

      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="mb-3 text-sm font-semibold text-foreground">Notifications</Text>
        <View className="flex-row items-center justify-between py-2">
          <Text className="flex-1 text-sm text-foreground">Low-stock alerts</Text>
          <Switch value={lowStockAlerts} onValueChange={setLowStockAlerts} />
        </View>
        <View className="flex-row items-center justify-between py-2">
          <Text className="flex-1 text-sm text-foreground">Order emails</Text>
          <Switch value={orderEmails} onValueChange={setOrderEmails} />
        </View>
      </View>

      <Button onPress={save} isLoading={updateSettings.isPending} className="self-start">
        <Text className="font-semibold text-primary-foreground">Save settings</Text>
      </Button>
    </View>
  );
}
