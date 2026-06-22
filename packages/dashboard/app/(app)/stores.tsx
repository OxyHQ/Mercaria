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
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { useMyStores, useCreateStore } from "@/lib/hooks/use-stores";
import { useActiveStore } from "@/lib/stores/active-store";

/** Store picker: choose the active store, or create the first one. */
export default function StoresScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
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
        <Text className="font-semibold text-primary-foreground">New store</Text>
      </View>
    </Button>
  );

  return (
    <>
      <Head>
        <title>Stores | Mercaria Dashboard</title>
      </Head>
      <Screen title="Your stores" subtitle="Pick a store to manage" action={action}>
        {isPending ? (
          <ScreenLoading />
        ) : isError ? (
          <ScreenMessage title="Couldn't load your stores" body="Please try again." />
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
                    @{store.handle} · {store.productCount} products
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
            <Text className="mt-4 text-base font-semibold text-foreground">No stores yet</Text>
            <Text className="mt-1 max-w-xs text-center text-sm text-muted-foreground">
              Create your first store to start selling on Mercaria.
            </Text>
            <Button className="mt-6" onPress={() => setCreateOpen(true)}>
              <Text className="font-semibold text-primary-foreground">Create store</Text>
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

  const submit = () => {
    if (!name.trim()) {
      toast.error("Store name is required");
      return;
    }
    createStore.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: (store) => {
          toast.success("Store created");
          setName("");
          setDescription("");
          onOpenChange(false);
          onCreated(store);
        },
        onError: () => toast.error("Couldn't create the store"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a store</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Store name</Label>
            <Input value={name} onChangeText={setName} placeholder="Acme Supply Co." />
          </View>
          <View className="gap-1.5">
            <Label>Description</Label>
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder="What do you sell?"
            />
          </View>
          <Button onPress={submit} isLoading={createStore.isPending} className="mt-2">
            <Text className="font-semibold text-primary-foreground">Create store</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
