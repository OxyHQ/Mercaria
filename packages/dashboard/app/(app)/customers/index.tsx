import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { Link } from "expo-router";
import Head from "expo-router/head";
import { User } from "lucide-react-native";
import type { Customer } from "@mercaria/shared-types";
import { Text, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { ListPagination } from "@/components/lists/ResourceList";
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
        {(storeId) => <CustomersBody key={storeId} storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function CustomersBody({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  const { data, isPending, isError, isFetching, isPlaceholderData } = useCustomers(storeId, page, debouncedSearch);

  return (
    <Screen
      title={t("nav.customers")}
      subtitle={t("customers.subtitle")}

    >
      <View className="mb-4">
        <TextFieldInput
          label={t("customers.searchPlaceholder")}
          value={search}
          onValueChange={(t) => {
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
              disabled={isPlaceholderData}
            />
          ))}
        </View>
      )}

      {data && !isError ? <ListPagination page={data.pagination.page} pages={data.pagination.pages}
        busy={isFetching} onPage={setPage} /> : null}
    </Screen>
  );
}

function CustomerRow({ customer, disabled }: { customer: Customer; disabled: boolean }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const name = customer.displayName ?? customer.email ?? (customer.isWalkIn ? t("customers.walkIn") : t("customers.fallbackName"));
  const content = (
    <Pressable
      disabled={disabled}
      accessibilityLabel={name}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3 active:opacity-80 web:hover:border-primary"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <User size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("customers.orderCount", { count: customer.stats.orderCount })}
        </Text>
      </View>
      <PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-sm font-semibold" />
    </Pressable>
  );
  return disabled ? content : <Link href={{ pathname: "/customers/[id]", params: { id: customer.id } }} asChild>{content}</Link>;
}
