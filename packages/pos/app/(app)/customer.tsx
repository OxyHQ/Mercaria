import React, { useMemo, useState } from "react";
import { View, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { UserX } from "lucide-react-native";
import type { Customer } from "@mercaria/shared-types";
import { Text, useColorScheme } from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextField, TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useCustomers, useCreateCustomer } from "@/lib/hooks/use-customers";
import { useRegisterCart } from "@/lib/stores/register-cart";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useTranslation } from "@/lib/i18n";

/** Debounce (ms) for the customer search box. */
const SEARCH_DEBOUNCE_MS = 300;

/** Attach (or clear) the customer for the current register sale. */
export default function CustomerScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("customer.documentTitle")}</title>
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
  const { t } = useTranslation();
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
    <Screen title={t("customer.title")} subtitle={t("customer.subtitle")}>
      <View className="gap-4">
        <Pressable
          onPress={() => attach(null)}
          accessibilityRole="button"
          className="min-h-[56px] flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80"
        >
          <UserX size={20} color={colors.mutedForeground} />
          <Text className="text-base font-semibold text-foreground">
            {t("customer.walkInOption")}
          </Text>
        </Pressable>

        <TextField style={{ height: 48 }}>
          <TextFieldInput
            label={t("customer.searchPlaceholder")}
            value={search}
            onValueChange={setSearch}
          />
        </TextField>

        {isPending ? (
          <ScreenLoading />
        ) : isError ? (
          <ScreenMessage title={t("customer.loadFailed")} body={t("common.pleaseTryAgain")} />
        ) : customers.length > 0 ? (
          <View className="gap-2">
            {customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} onPress={() => attach(customer.id)} />
            ))}
          </View>
        ) : (
          <Text className="px-1 text-sm text-muted-foreground">{t("customer.noMatches")}</Text>
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
  const { t } = useTranslation();
  const subtitle = customer.email ?? customer.phone ?? (customer.isWalkIn ? t("customer.walkIn") : "");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="min-h-[56px] flex-row items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-80 web:hover:border-primary"
    >
      <View className="flex-1">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {customer.displayName ?? t("customer.fallbackName")}
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
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const createCustomer = useCreateCustomer(storeId);

  const submit = () => {
    if (!displayName.trim() && !email.trim() && !phone.trim()) {
      toast.error(t("customer.quickAddEmpty"));
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
          toast.success(t("customer.added"));
          onCreated(customer.id);
        },
        onError: () => toast.error(t("customer.addFailed")),
      },
    );
  };

  return (
    <View className="gap-3 rounded-2xl border border-dashed border-border p-4">
      <Text className="text-base font-semibold text-foreground">{t("customer.quickAdd")}</Text>
      <Field label={t("common.name")}>
        <TextField style={{ height: 44 }}>
          <TextFieldInput
            label={t("common.name")}
            value={displayName}
            onValueChange={setDisplayName}
            placeholder={t("customer.namePlaceholder")}
          />
        </TextField>
      </Field>
      <Field label={t("customer.email")}>
        <TextField style={{ height: 44 }}>
          <TextFieldInput
            label={t("customer.email")}
            value={email}
            onValueChange={setEmail}
            placeholder={t("customer.emailPlaceholder")}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        </TextField>
      </Field>
      <Field label={t("customer.phone")}>
        <TextField style={{ height: 44 }}>
          <TextFieldInput
            label={t("customer.phone")}
            value={phone}
            onValueChange={setPhone}
            placeholder={t("customer.phonePlaceholder")}
            keyboardType="phone-pad"
          />
        </TextField>
      </Field>
      <Button
        tone="accent"
        size="lg"
        onPress={submit}
        loading={createCustomer.isPending}
        className="mt-1"
        style={{ height: 48 }}
      >
        {t("customer.addAndAttach")}
      </Button>
    </View>
  );
}
