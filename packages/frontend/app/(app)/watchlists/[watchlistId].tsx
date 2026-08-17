import { ActivityIndicator, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { BasketTotalCard } from "@/components/watchlist/BasketTotalCard";
import { WatchlistItemRow } from "@/components/watchlist/WatchlistItemRow";
import {
  useRecordWatchlistSnapshot,
  useRemoveWatchlistItem,
  useResolveWatchlistSplit,
  useWatchlist,
  useWatchlistBasket,
} from "@/lib/hooks/use-watchlists";
import { useTranslation } from "@/lib/i18n";

/**
 * One watchlist (#81 UX rules 2–6).
 *
 * ## The list renders even when the basket does not
 *
 * `useWatchlist` and `useWatchlistBasket` are two queries with two error
 * states. A comparison that is down leaves a card saying the total is
 * unavailable beside a list somebody can still reorder, re-quantify and edit —
 * which is #81 acceptance 7 as a property of the query graph rather than of a
 * `try` somewhere. The rows come from the BASKET when it resolved and from the
 * LIST when it did not, so an item never disappears because pricing failed.
 */
export default function WatchlistDetailScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { watchlistId } = useLocalSearchParams<{ watchlistId: string }>();
  const detail = useWatchlist(watchlistId);
  const basket = useWatchlistBasket(watchlistId);
  const removeItem = useRemoveWatchlistItem();
  const resolveSplit = useResolveWatchlistSplit();
  const recordSnapshot = useRecordWatchlistSnapshot();

  const list = detail.data?.watchlist;
  const items = detail.data?.items ?? [];

  return (
    <ScreenShell>
      <Head>
        <title>
          {list
            ? t("watchlists.detail.pageTitle", { name: list.name })
            : t("watchlists.detail.pageTitleFallback")}
        </title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        {detail.isPending ? (
          <View className="py-24">
            <ActivityIndicator />
          </View>
        ) : detail.isError || !list ? (
          <Text className="text-sm text-text-secondary">{t("watchlists.detail.loadError")}</Text>
        ) : (
          <>
            <Text className="text-2xl font-bold text-foreground">
              {list.icon ? `${list.icon} ` : ""}
              {list.name}
            </Text>
            {list.description ? (
              <Text className="text-sm text-text-secondary">{list.description}</Text>
            ) : null}

            {basket.isPending ? (
              <View className="py-space-16">
                <ActivityIndicator />
              </View>
            ) : basket.isError || !basket.data ? (
              <View className="gap-space-4 rounded-radius-lg border border-border-secondary p-space-16">
                <Text className="text-sm text-text-secondary">{t("watchlists.basket.title")}</Text>
                <Text className="text-base text-foreground">
                  {t("watchlists.detail.priceError")}
                </Text>
              </View>
            ) : (
              <BasketTotalCard basket={basket.data} />
            )}

            {basket.data ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("watchlists.detail.saveMeasurement")}
                disabled={recordSnapshot.isPending}
                onPress={() => recordSnapshot.mutate({ watchlistId })}
                className="items-center rounded-radius-max border border-border-secondary py-space-12"
              >
                <Text className="text-buttonMedium text-text">
                  {recordSnapshot.isPending
                    ? t("watchlists.detail.saving")
                    : t("watchlists.detail.saveMeasurement")}
                </Text>
              </Pressable>
            ) : null}

            <View className="gap-space-12">
              {basket.data
                ? basket.data.lines.map((line) => (
                    <WatchlistItemRow
                      key={line.item.id}
                      line={line}
                      onOpen={(canonicalProductId) =>
                        router.push(`/products/${canonicalProductId}`)
                      }
                      onRemove={(itemId) =>
                        removeItem.mutate({
                          watchlistId,
                          itemId,
                          expectedVersion: list.version,
                        })
                      }
                    />
                  ))
                : items.map((item) => (
                    // The basket did not resolve, so the row shows what the LIST
                    // knows and no price at all — never a zero, and never a
                    // silently shorter list.
                    <View
                      key={item.id}
                      className="gap-space-4 rounded-radius-lg border border-border-secondary p-space-16"
                    >
                      <Text className="text-base font-semibold text-foreground">
                        {item.quantity > 1 ? `${item.quantity} × ` : ""}
                        {item.canonicalProductId}
                      </Text>
                      <Text className="text-sm text-text-secondary">
                        {t("watchlists.detail.priceUnavailable")}
                      </Text>
                    </View>
                  ))}

              {items.length === 0 ? (
                <Text className="text-sm text-text-secondary">
                  {t("watchlists.detail.empty")}
                </Text>
              ) : null}
            </View>

            {items.some((item) => item.resolution.state === "ambiguous_after_split") ? (
              <View className="gap-space-8 rounded-radius-lg border border-border-secondary p-space-16">
                <Text className="text-base text-foreground">
                  {t("watchlists.detail.splitPrompt")}
                </Text>
                {items
                  .filter((item) => item.resolution.state === "ambiguous_after_split")
                  .map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      accessibilityLabel={t("watchlists.detail.keepBothA11y")}
                      onPress={() =>
                        resolveSplit.mutate({
                          watchlistId,
                          itemId: item.id,
                          expectedVersion: list.version,
                          // `keep_both` is the answer a split most often
                          // deserves and the only one that cannot lose an
                          // interest the buyer had; narrowing it afterwards is
                          // one tap on this same page.
                          resolution: "keep_both",
                        })
                      }
                    >
                      <Text className="text-sm text-text-secondary">
                        {t("watchlists.detail.keepBothFor", {
                          product: item.canonicalProductId,
                        })}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            ) : null}
          </>
        )}
      </View>
    </ScreenShell>
  );
}
