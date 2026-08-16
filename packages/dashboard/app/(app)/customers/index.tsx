import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, ChevronRight, User } from "lucide-react-native";
import type { Customer } from "@mercaria/shared-types";
import { Text, Input, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useCustomers } from "@/lib/hooks/use-customers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useTranslation } from "@/lib/i18n";

export default function CustomersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("customers.documentTitle")}</title>
      </Head>
      <RequireStore permission="customers:read">
        {(storeId) => <CustomersBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function CustomersBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  const { data, isPending, isError } = useCustomers(storeId, page, debouncedSearch);

  return (
    <Screen
      title={t("nav.customers")}
      subtitle={t("customers.subtitle")}
      action={<StoreSwitcher />}
    >
      <View className="mb-4">
        <Input
          value={search}
          onChangeText={(t) => {
            setSearch(t);
            setPage(1);
          }}
          placeholder={t("customers.searchPlaceholder")}
        />
      </View>

      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("customers.loadError")} body={t("common.pleaseTryAgain")} />
      ) : (data?.data.length ?? 0) === 0 ? (
        <ScreenMessage title={t("customers.empty.title")} body={t("customers.empty.body")} />
      ) : (
        <View className="gap-2">
          {data?.data.map((customer) => (
            <CustomerRow
              key={customer.id}
              customer={customer}
              onPress={() => router.push(`/customers/${customer.id}`)}
            />
          ))}
        </View>
      )}

      {data && data.pagination.pages > 1 ? (
        <View className="mt-4 flex-row items-center justify-center gap-4">
          <Pressable
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
          >
            <ChevronLeft size={18} color={colors.foreground} />
          </Pressable>
          <Text className="text-sm text-muted-foreground">
            {t("common.pageOf", {
              current: data.pagination.page,
              total: data.pagination.pages,
            })}
          </Text>
          <Pressable
            onPress={() => setPage((p) => p + 1)}
            disabled={page >= data.pagination.pages}
            className="h-9 w-9 items-center justify-center rounded-lg border border-border active:opacity-70 disabled:opacity-40"
          >
            <ChevronRight size={18} color={colors.foreground} />
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

function CustomerRow({ customer, onPress }: { customer: Customer; onPress: () => void }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3 active:opacity-80 web:hover:border-primary"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <User size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {customer.displayName ??
            customer.email ??
            (customer.isWalkIn ? t("customers.walkIn") : t("customers.fallbackName"))}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("customers.orderCount", { count: customer.stats.orderCount })}
        </Text>
      </View>
      <PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-sm font-semibold" />
    </Pressable>
  );
}
