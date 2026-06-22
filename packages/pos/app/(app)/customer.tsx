import React, { useMemo, useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { UserX } from "lucide-react-native";
import type { Customer } from "@mercaria/shared-types";
import { Text, Input, Button, Label, useColorScheme } from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useCustomers, useCreateCustomer } from "@/lib/hooks/use-customers";
import { useRegisterCart } from "@/lib/stores/register-cart";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

/** Debounce (ms) for the customer search box. */
const SEARCH_DEBOUNCE_MS = 300;

/** Attach (or clear) the customer for the current register sale. */
export default function CustomerScreen() {
  return (
    <>
      <Head>
        <title>Customer | Mercaria POS</title>
      </Head>
      <RequireStore permission="customers:read">
        {(storeId) => <CustomerPicker storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function CustomerPicker({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const setCustomerId = useRegisterCart((s) => s.setCustomerId);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const { data, isPending, isError } = useCustomers(storeId, debouncedSearch);

  const customers = useMemo(() => data?.data ?? [], [data]);

  const attach = (id: string | null) => {
    setCustomerId(id);
    router.replace("/");
  };

  return (
    <Screen title="Customer" subtitle="Attach a customer or keep it a walk-in">
      <View className="gap-4">
        <Pressable
          onPress={() => attach(null)}
          accessibilityRole="button"
          className="min-h-[56px] flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80"
        >
          <UserX size={20} color={colors.mutedForeground} />
          <Text className="text-base font-semibold text-foreground">Walk-in (no customer)</Text>
        </Pressable>

        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Search customers"
          className="h-12"
        />

        {isPending ? (
          <ScreenLoading />
        ) : isError ? (
          <ScreenMessage title="Couldn't load customers" body="Please try again." />
        ) : customers.length > 0 ? (
          <View className="gap-2">
            {customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} onPress={() => attach(customer.id)} />
            ))}
          </View>
        ) : (
          <Text className="px-1 text-sm text-muted-foreground">No customers match.</Text>
        )}

        <QuickAddCustomer
          storeId={storeId}
          onCreated={(id) => attach(id)}
        />
      </View>
    </Screen>
  );
}

function CustomerRow({ customer, onPress }: { customer: Customer; onPress: () => void }) {
  const subtitle = customer.email ?? customer.phone ?? (customer.isWalkIn ? "Walk-in" : "");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="min-h-[56px] flex-row items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
    >
      <View className="flex-1">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {customer.displayName ?? "Customer"}
        </Text>
        {subtitle ? (
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function QuickAddCustomer({
  storeId,
  onCreated,
}: {
  storeId: string;
  onCreated: (id: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const createCustomer = useCreateCustomer(storeId);

  const submit = () => {
    if (!displayName.trim() && !email.trim() && !phone.trim()) {
      toast.error("Enter a name, email or phone");
      return;
    }
    createCustomer.mutate(
      {
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      {
        onSuccess: (customer) => {
          toast.success("Customer added");
          onCreated(customer.id);
        },
        onError: () => toast.error("Couldn't add the customer"),
      },
    );
  };

  return (
    <View className="gap-3 rounded-2xl border border-dashed border-border p-4">
      <Text className="text-base font-semibold text-foreground">Quick add</Text>
      <View className="gap-1.5">
        <Label>Name</Label>
        <Input value={displayName} onChangeText={setDisplayName} placeholder="Jane Doe" className="h-11" />
      </View>
      <View className="gap-1.5">
        <Label>Email</Label>
        <Input
          value={email}
          onChangeText={setEmail}
          placeholder="jane@example.com"
          autoCapitalize="none"
          keyboardType="email-address"
          className="h-11"
        />
      </View>
      <View className="gap-1.5">
        <Label>Phone</Label>
        <Input
          value={phone}
          onChangeText={setPhone}
          placeholder="+1 555 0100"
          keyboardType="phone-pad"
          className="h-11"
        />
      </View>
      <Button onPress={submit} isLoading={createCustomer.isPending} className="mt-1 h-12">
        <Text className="font-semibold text-primary-foreground">Add &amp; attach</Text>
      </Button>
    </View>
  );
}
