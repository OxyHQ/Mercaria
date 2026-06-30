import { useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useOxy } from "@oxyhq/services";
import { Check, Plus, Trash2 } from "lucide-react-native";
import type { Address, CreateAddressInput } from "@mercaria/shared-types";
import { Button, Text } from "@mercaria/ui";
import { useTranslation } from "@/hooks/useTranslation";
import { SettingsHeader } from "@/components/settings/settings-header";
import { AddressForm } from "@/components/address/AddressForm";
import { toast } from "@/components/sonner";
import {
  useAddresses,
  useCreateAddress,
  useUpdateAddress,
  useDeleteAddress,
} from "@/lib/hooks/use-addresses";

function AddressCard({
  address,
  onSetDefault,
  onDelete,
  isMutating,
}: {
  address: Address;
  onSetDefault: () => void;
  onDelete: () => void;
  isMutating: boolean;
}) {
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {address.label ?? address.recipientName}
            </Text>
            {address.isDefault ? (
              <View className="rounded-full bg-secondary px-2 py-0.5">
                <Text className="text-[11px] font-medium text-muted-foreground">Default</Text>
              </View>
            ) : null}
          </View>
          <Text className="mt-1 text-sm text-muted-foreground">{address.recipientName}</Text>
          <Text className="text-sm text-muted-foreground">{address.line1}</Text>
          {address.line2 ? (
            <Text className="text-sm text-muted-foreground">{address.line2}</Text>
          ) : null}
          <Text className="text-sm text-muted-foreground">
            {address.city}
            {address.region ? `, ${address.region}` : ""} {address.postalCode}
          </Text>
          <Text className="text-sm text-muted-foreground">{address.country}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete address"
          disabled={isMutating}
          onPress={onDelete}
          className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
        >
          <Trash2 size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      {!address.isDefault ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 self-start"
          disabled={isMutating}
          onPress={onSetDefault}
        >
          <Check size={14} className="text-foreground" />
          <Text className="ml-1 text-sm font-medium text-foreground">Set as default</Text>
        </Button>
      ) : null}
    </View>
  );
}

function AddressesBody() {
  const { isAuthenticated } = useOxy();
  const { data: addresses, isLoading } = useAddresses();
  const createAddress = useCreateAddress();
  const updateAddress = useUpdateAddress();
  const deleteAddress = useDeleteAddress();
  const [adding, setAdding] = useState(false);

  const isMutating =
    createAddress.isPending || updateAddress.isPending || deleteAddress.isPending;

  if (!isAuthenticated) {
    return (
      <View className="items-center py-16">
        <Text className="text-center text-sm text-muted-foreground">
          Sign in to manage your shipping addresses.
        </Text>
      </View>
    );
  }

  const onCreate = (input: CreateAddressInput) => {
    createAddress.mutate(input, {
      onSuccess: () => {
        toast.success("Address saved");
        setAdding(false);
      },
      onError: () => toast.error("Couldn't save the address"),
    });
  };

  const list = addresses ?? [];

  return (
    <View className="gap-4">
      {isLoading && !addresses ? (
        <View className="gap-3">
          <View className="h-32 w-full rounded-2xl bg-muted" />
          <View className="h-32 w-full rounded-2xl bg-muted" />
        </View>
      ) : (
        <>
          {list.length === 0 && !adding ? (
            <Text className="text-sm text-muted-foreground">
              You have no saved addresses yet.
            </Text>
          ) : null}

          {list.map((address) => (
            <AddressCard
              key={address.id}
              address={address}
              isMutating={isMutating}
              onSetDefault={() =>
                updateAddress.mutate(
                  { id: address.id, input: { isDefault: true } },
                  { onError: () => toast.error("Couldn't update the address") },
                )
              }
              onDelete={() =>
                deleteAddress.mutate(address.id, {
                  onSuccess: () => toast.success("Address removed"),
                  onError: () => toast.error("Couldn't remove the address"),
                })
              }
            />
          ))}

          {adding ? (
            <View className="rounded-2xl border border-border bg-card p-4">
              <Text className="mb-3 text-sm font-semibold text-foreground">New address</Text>
              <AddressForm
                onSubmit={onCreate}
                onCancel={() => setAdding(false)}
                isSubmitting={createAddress.isPending}
              />
            </View>
          ) : (
            <Button variant="outline" className="self-start" onPress={() => setAdding(true)}>
              <Plus size={16} className="text-foreground" />
              <Text className="ml-1 text-sm font-medium text-foreground">Add address</Text>
            </Button>
          )}
        </>
      )}
    </View>
  );
}

export default function SettingsAddressesScreen() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.addresses")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <AddressesBody />
      </ScrollView>
    </View>
  );
}
