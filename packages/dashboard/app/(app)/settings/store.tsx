import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import type { Store } from "@mercaria/shared-types";
import { Text, Button, Input, Label, Textarea, ColorPicker, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useStore, useUpdateStore } from "@/lib/hooks/use-stores";

export default function StoreProfileScreen() {
  return (
    <>
      <Head>
        <title>Store profile | Mercaria Dashboard</title>
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
      <Screen title="Store profile" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title="Store profile" action={back}>
        <ScreenMessage title="Couldn't load store" body="Please try again." />
      </Screen>
    );
  }

  return (
    <Screen title="Store profile" subtitle={`@${data.handle}`} action={back}>
      <StoreProfileForm storeId={storeId} store={data} />
    </Screen>
  );
}

function StoreProfileForm({ storeId, store }: { storeId: string; store: Store }) {
  const updateStore = useUpdateStore(storeId);
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description);
  const [brandColor, setBrandColor] = useState(store.brandColor);

  const save = () => {
    if (!name.trim()) {
      toast.error("Store name is required");
      return;
    }
    updateStore.mutate(
      { name: name.trim(), description: description.trim(), brandColor },
      {
        onSuccess: () => toast.success("Store updated"),
        onError: () => toast.error("Couldn't update the store"),
      },
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-1.5">
        <Label>Store name</Label>
        <Input value={name} onChangeText={setName} />
      </View>
      <View className="gap-1.5">
        <Label>Description</Label>
        <Textarea value={description} onChangeText={setDescription} />
      </View>
      <ColorPicker label="Brand color" selected={brandColor} onSelect={setBrandColor} />

      <Button onPress={save} isLoading={updateStore.isPending} className="self-start">
        <Text className="font-semibold text-primary-foreground">Save changes</Text>
      </Button>
    </View>
  );
}
