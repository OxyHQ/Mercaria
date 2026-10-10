import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { Loading } from "@oxy.so/bloom/loading";
import { Select, SelectTrigger, SelectValue, SelectIcon, SelectContent, SelectItem, SelectItemText, SelectItemIndicator } from "@oxy.so/bloom/select";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

export function StatusFilter<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="min-w-40">
      <Select value={value} onValueChange={(next) => {
        const option = options.find(item => item.value === next);
        if (option) onChange(option.value);
      }}>
        <SelectTrigger label={t("common.status")}><SelectValue /><SelectIcon /></SelectTrigger>
        <SelectContent label={t("common.status")} items={options} renderItem={item => (
          <SelectItem value={item.value} label={item.label}>
            <SelectItemText>{item.label}</SelectItemText><SelectItemIndicator />
          </SelectItem>
        )} />
      </Select>
    </View>
  );
}

/** Keep the resource surface mounted while queries change, including empty/error states. */
export function ResourceList({ toolbar, busy, children, footer, testID }: {
  toolbar: React.ReactNode; busy: boolean; children: React.ReactNode; footer?: React.ReactNode; testID: string;
}) {
  const { t } = useTranslation();
  const [settledHeight, setSettledHeight] = useState(360);
  return (
    <View testID={testID} className="overflow-hidden rounded-xl border border-border bg-white dark:bg-surface">
      <View className="gap-3 border-b border-border p-3">{toolbar}</View>
      <View className="h-7 justify-center px-4" accessibilityLiveRegion="polite">
        {busy ? <Text className="text-xs text-muted-foreground">{t("common.loading")}</Text> : null}
      </View>
      <View style={{ minHeight: busy ? settledHeight : 360 }} onLayout={event => {
        if (!busy) setSettledHeight(Math.max(360, event.nativeEvent.layout.height));
      }}>{children}</View>
      <View className="min-h-14">{footer}</View>
    </View>
  );
}

export function ResourceState({ loading, error, errorTitle, emptyTitle, emptyBody, filtered, onRetry, onClear, action }: {
  loading?: boolean; error?: boolean; errorTitle: string; emptyTitle: string; emptyBody?: string; filtered: boolean;
  onRetry: () => void; onClear: () => void; action?: { label: string; onPress: () => void };
}) {
  const { t } = useTranslation();
  if (loading) return <View className="min-h-[360px] items-center justify-center"><Loading variant="inline" size="sm" accessibilityLabel={t("common.loading")} /></View>;
  return <EmptyState title={error ? errorTitle : filtered ? t("resourceList.noResults") : emptyTitle}
    description={error ? t("common.pleaseTryAgain") : filtered ? undefined : emptyBody}
    action={error ? { label: t("common.retry"), onPress: onRetry } : filtered ? { label: t("resourceList.clearFilters"), onPress: onClear } : action} />;
}

export function ListPagination({ page, pages, busy, onPage }: { page: number; pages: number; busy: boolean; onPage: (page: number) => void }) {
  const { t } = useTranslation();
  if (pages <= 1) return null;
  return <View className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3">
    <Text className="text-xs text-muted-foreground">{t("common.pageOf", { current: page, total: pages })}</Text>
    <View className="flex-row gap-2">
      <Button size="sm" material="flat" appearance="outline" disabled={busy || page <= 1} onPress={() => onPage(page - 1)}>{t("resourceList.previous")}</Button>
      <Button size="sm" material="flat" appearance="outline" disabled={busy || page >= pages} onPress={() => onPage(page + 1)}>{t("resourceList.next")}</Button>
    </View>
  </View>;
}
