import { useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useOxy } from "@oxyhq/services";
import { Check, Plus, Trash2 } from "lucide-react-native";
import type { Address, CreateAddressInput } from "@mercaria/shared-types";
import { Button, Text, formatRegionName } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { SettingsHeader } from "@/components/settings/settings-header";
import { AddressForm } from "@/components/address/AddressForm";
import { toast } from "@oxyhq/bloom/toast";
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
  const { t, locale } = useTranslation();
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
                <Text className="text-[11px] font-medium text-muted-foreground">
                  {t("address.list.default")}
                </Text>
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
          <Text className="text-sm text-muted-foreground">
            {formatRegionName(address.country, locale)}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("address.list.deleteLabel")}
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
          <Text className="ms-1 text-sm font-medium text-foreground">
            {t("address.list.setDefault")}
          </Text>
        </Button>
      ) : null}
    </View>
  );
}

function AddressesBody() {
  const { t } = useTranslation();
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
          {t("address.list.signedOut")}
        </Text>
      </View>
    );
  }

  const onCreate = (input: CreateAddressInput) => {
    createAddress.mutate(input, {
      onSuccess: () => {
        toast.success(t("address.toast.saved"));
        setAdding(false);
      },
      onError: () => toast.error(t("address.toast.saveFailed")),
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
            <Text className="text-sm text-muted-foreground">{t("address.list.empty")}</Text>
          ) : null}

          {list.map((address) => (
            <AddressCard
              key={address.id}
              address={address}
              isMutating={isMutating}
              onSetDefault={() =>
                updateAddress.mutate(
                  { id: address.id, input: { isDefault: true } },
                  { onError: () => toast.error(t("address.toast.updateFailed")) },
                )
              }
              onDelete={() =>
                deleteAddress.mutate(address.id, {
                  onSuccess: () => toast.success(t("address.toast.removed")),
                  onError: () => toast.error(t("address.toast.removeFailed")),
                })
              }
            />
          ))}

          {adding ? (
            <View className="rounded-2xl border border-border bg-card p-4">
              <Text className="mb-3 text-sm font-semibold text-foreground">
                {t("address.list.newAddress")}
              </Text>
              <AddressForm
                onSubmit={onCreate}
                onCancel={() => setAdding(false)}
                isSubmitting={createAddress.isPending}
              />
            </View>
          ) : (
            <Button variant="outline" className="self-start" onPress={() => setAdding(true)}>
              <Plus size={16} className="text-foreground" />
              <Text className="ms-1 text-sm font-medium text-foreground">
                {t("address.list.addAddress")}
              </Text>
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
