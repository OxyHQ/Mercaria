import React from "react";
import { Pressable, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import Head from "expo-router/head";
import { Button } from "@oxy.so/bloom/button";
import { Text } from "@mercaria/ui";
import { RequireStore } from "@/components/shell/RequireStore";
import { Screen, ScreenLoading } from "@/components/shell/Screen";
import { CollectionEditor } from "@/components/collections/CollectionEditor";
import { useCollection } from "@/lib/hooks/use-collections";
import { canRetainDetailData } from "@/lib/detail-query-state";
import { useTranslation } from "@/lib/i18n";

export default function CollectionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return <><Head><title>{t("collections.documentTitle")}</title></Head>
    <RequireStore permission="products:read">{storeId => <CollectionDetail key={`${storeId}:${id}`} storeId={storeId} id={String(id)} />}</RequireStore></>;
}

function CollectionDetail({ storeId, id }: { storeId: string; id: string }) {
  const { t } = useTranslation();
  const query = useCollection(storeId, id);
  const collection = canRetainDetailData(query.error) ? query.data : undefined;
  return <Screen title={collection?.title ?? t("nav.collections")} action={
    <Link href="/collections" asChild><Pressable className="rounded-lg border border-border px-3 py-2"><Text className="text-sm text-foreground">{t("common.back")}</Text></Pressable></Link>
  }>
    {query.isError ? <View className="mb-4 gap-2" accessibilityLiveRegion="polite"><Text className="text-sm text-destructive">{t("collections.loadError")}</Text>
      <Button size="sm" appearance="outline" material="flat" disabled={query.isFetching} onPress={() => { void query.refetch(); }}>{t("common.retry")}</Button></View> : null}
    {query.isPending ? <ScreenLoading /> : null}
    {collection ? <CollectionEditor key={`${storeId}:${id}`} storeId={storeId} collection={collection} readBlocked={query.isError || query.isFetching} /> : null}
  </Screen>;
}
