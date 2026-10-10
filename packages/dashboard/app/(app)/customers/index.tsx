import React, { useState } from "react";
import { View, Pressable, useWindowDimensions } from "react-native";
import { Link } from "expo-router";
import Head from "expo-router/head";
import { User } from "lucide-react-native";
import type { Customer } from "@mercaria/shared-types";
import { Text, PriceDisplay, useColorScheme } from "@mercaria/ui";
import { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from "@oxy.so/bloom/table";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Screen } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { ResourceList, ResourceState, ListPagination } from "@/components/lists/ResourceList";
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
  const { width } = useWindowDimensions();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  const { data, isPending, isError, isFetching, isPlaceholderData, refetch } = useCustomers(storeId, page, debouncedSearch);
  // A debounce is already a new search intent: don't present old rows as matches
  // while waiting to send it. The containing surface and input stay mounted.
  const waitingForSearch = search !== debouncedSearch;
  const busy = isFetching || waitingForSearch;
  const customers = data?.data ?? [];
  const clearSearch = () => { setSearch(""); setPage(1); };
  return (
    <Screen title={t("nav.customers")} subtitle={t("customers.subtitle")}>
      <ResourceList testID="merchant-customers-list" busy={busy}
        toolbar={<TextFieldInput label={t("customers.searchPlaceholder")} value={search}
          onValueChange={next => { setSearch(next); setPage(1); }} placeholder={t("customers.searchPlaceholder")} />}
        footer={data && !isError && !waitingForSearch ? <ListPagination page={data.pagination.page} pages={data.pagination.pages}
          busy={busy} onPage={setPage} /> : null}>
        {isPending || waitingForSearch || isError || !customers.length ? (
          <ResourceState loading={isPending || waitingForSearch} error={isError} errorTitle={t("customers.loadError")}
            filtered={Boolean(debouncedSearch)} emptyTitle={t("customers.empty.title")} emptyBody={t("customers.empty.body")}
            onRetry={() => { void refetch(); }} onClear={clearSearch} />
        ) : width >= 768 ? (
          <Table accessibilityLabel={t("nav.customers")} size="sm" minWidth={600}>
            <TableHeader>
              <TableColumn flex={2}><Text className="text-xs font-semibold text-muted-foreground">{t("common.name")}</Text></TableColumn>
              <TableColumn width={140} align="end"><Text className="text-xs font-semibold text-muted-foreground">{t("customers.detail.orders")}</Text></TableColumn>
              <TableColumn width={180} align="end"><Text className="text-xs font-semibold text-muted-foreground">{t("customers.detail.lifetimeSpend")}</Text></TableColumn>
            </TableHeader>
            <TableBody>{customers.map(customer => <TableRow key={customer.id} testID="merchant-customer-row">
              <TableCell><CustomerLink customer={customer} disabled={isPlaceholderData} /></TableCell>
              <TableCell><Text className="text-sm text-foreground">{customer.stats.orderCount}</Text></TableCell>
              <TableCell><PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-sm" /></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        ) : <View>{customers.map(customer => <View key={customer.id} testID="merchant-customer-row" className="gap-2 border-b border-border p-4">
          <CustomerLink customer={customer} disabled={isPlaceholderData} />
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-xs text-muted-foreground">{t("customers.orderCount", { count: customer.stats.orderCount })}</Text>
            <PriceDisplay price={customer.stats.totalSpent} primaryClassName="text-sm font-semibold" />
          </View>
        </View>)}</View>}
      </ResourceList>
    </Screen>
  );
}

function CustomerLink({ customer, disabled }: { customer: Customer; disabled: boolean }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const name = customer.displayName ?? customer.email ?? (customer.isWalkIn ? t("customers.walkIn") : t("customers.fallbackName"));
  const content = (
    <Pressable disabled={disabled} accessibilityLabel={name}
      className="flex-row items-center gap-3 rounded py-2 active:opacity-70 web:hover:opacity-70">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <User size={18} color={colors.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{name}</Text>
        {customer.email && customer.email !== name ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{customer.email}</Text> : null}
      </View>
    </Pressable>
  );
  return disabled ? content : <Link href={{ pathname: "/customers/[id]", params: { id: customer.id } }} asChild>{content}</Link>;
}
