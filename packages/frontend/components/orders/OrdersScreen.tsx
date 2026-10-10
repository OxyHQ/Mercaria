import { useState } from "react";
import { Button } from "@oxy.so/bloom/button";
import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { Link, useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { BUYER_ORDER_VIEWS, type BuyerOrderView, type OrderSummary } from "@mercaria/shared-types";
import {
  shopNavigationIcon,
  Text,
  commercialSellerLabel,
  formatDate,
  useFormatters,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { ReviewEligibilityPrompts } from "@/components/reviews/ReviewEligibilityPrompts";
import { useOrders } from "@/lib/hooks/use-orders";
import { ORDER_STATUS_LABEL_KEYS } from "@/lib/order-status";
import { useTranslation } from "@/lib/i18n";

function OrderRow({ order, view }: { order: OrderSummary; view: BuyerOrderView }) {
  const { t, locale } = useTranslation();
  const { formatReviewCount } = useFormatters();
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const images = order.images?.filter(image => !failedImages.has(image.url)) ?? [];
  const logo = order.store?.logoUrl ?? order.seller?.avatar;
  // From the order's own commercial presentation (#129): a `platform` order has
  // neither `store` nor `seller`, so the old coalesce left Mercaria's own sales
  // with no seller in the list at all.
  const sellerName = commercialSellerLabel(t, order.commercial);
  return (
    <Link href={{ pathname: "/orders/[id]", params: { id: order.id } }} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t("orders.row.openA11yLabel", {
          number: order.orderNumber,
        })}
        className="rounded-radius-28 border-[0.5px] border-border-image bg-bg-fill p-space-16 shadow-shop-s web:transition web:hover:scale-[1.01] web:hover:shadow-shop-m web:motion-reduce:transform-none web:motion-reduce:transition-none"
      >
        <View className="flex-row items-start gap-space-8">
          <View className="min-w-0 flex-1 gap-space-8">
            <View className="h-space-24 flex-row items-center gap-space-6">
              {logo ? <Image source={{ uri: logo }} contentFit="contain" accessibilityLabel={sellerName}
                className="size-space-24 shrink-0 rounded-radius-max bg-white" /> : null}
              <Text className="min-w-0 flex-1 text-shop-bodyTitleSmall text-text" numberOfLines={1}>{sellerName}</Text>
            </View>
            <Text className="text-shop-subtitle text-text">{t(ORDER_STATUS_LABEL_KEYS[order.status])}</Text>
          </View>
          {images.length > 0 ? (
            <View className="flex-row items-center gap-space-4" testID="order-card-images">
              {images.slice(0, 2).map((image, index) => (
                <View key={`${image.url}-${index}`} className="size-space-32 overflow-hidden rounded-radius-8 border-[0.5px] border-border-image bg-white shadow-shop-s">
                  <Image source={{ uri: image.url }} accessibilityLabel={image.alt} contentFit="cover" className="size-full"
                    onError={() => setFailedImages(current => new Set(current).add(image.url))} />
                </View>
              ))}
              {images.length > 2 ? <Text className="text-shop-badgeBold text-text">{t("orders.row.additionalImages", { images: formatReviewCount(images.length - 2) })}</Text> : null}
            </View>
          ) : null}
          {view === "past" ? <Text className="self-center text-shop-caption text-text-tertiary">{formatDate(order.createdAt, locale)}</Text> : null}
        </View>
      </Pressable>
    </Link>
  );
}

function OrdersBody({ view }: { view: BuyerOrderView }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated, canUsePrivateApi } = useOxy();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useOrders(page, view);

  const orders = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <View className="gap-5" testID="shopping-orders">
      <Text
        accessibilityRole="header"
        className="text-shop-posterXS text-text"
      >
        {t("orders.title")}
      </Text>

      <View className="flex-row gap-space-8" role="navigation" accessibilityLabel={t("orders.title")}>
        {BUYER_ORDER_VIEWS.map((tab) => (
          <Link key={tab} href={tab === "active" ? "/orders" : "/orders/past"} asChild>
            <Button material="flat" accessibilityRole="link" aria-current={tab === view ? "page" : undefined}
              className={`min-h-space-44 rounded-radius-max border-[0.5px] border-border-image px-space-16 py-space-8 shadow-shop-s ${tab === view
                ? "bg-[#121212] hover:bg-[#333333] dark:bg-white dark:hover:bg-[#e1e4e5]"
                : "bg-white hover:bg-[#f2f4f5] dark:bg-[#121212] dark:hover:bg-[#2a2a2a]"}`}>
              <Text className={`text-shop-buttonMedium ${tab === view ? "text-white dark:text-black" : "text-text"}`}>
                {t(tab === "active" ? "orders.tabs.active" : "orders.tabs.past")}
              </Text>
            </Button>
          </Link>
        ))}
      </View>

      {/*
        The verified-review surface (#76 UI rule 3). Above the list because it is
        the thing with a deadline-free ask attached; it renders nothing at all
        when the buyer has no open eligibility, which is the ordinary case.
      */}
      {isAuthenticated && canUsePrivateApi ? (
        <ReviewEligibilityPrompts />
      ) : null}

      {!isAuthenticated || !canUsePrivateApi ? (
        <EmptyState
          icon={shopNavigationIcon("orders")}
          media="circle"
          title={t("orders.empty.title")}
          description={t("orders.empty.signedOutSubtitle")}
          action={{
            label: t("nav.signIn"),
            onPress: () => openAccountDialog(),
          }}
        />
      ) : isError ? (
        <EmptyState
          icon={shopNavigationIcon("orders")}
          title={t("orders.loadError")}
          action={{
            label: t("common.tryAgain"),
            onPress: () => void refetch(),
          }}
        />
      ) : isLoading && !data ? (
        <View className="gap-4 py-6">
          {Array.from({ length: 4 }, (_, index) => (
            <View key={index} className="h-[94px] w-full rounded-radius-28 bg-muted" />
          ))}
        </View>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={shopNavigationIcon("orders")}
          media="circle"
          title={t(view === "active" ? "orders.empty.activeTitle" : "orders.empty.pastTitle")}
          description={t(view === "past" ? "orders.empty.pastSubtitle" : "orders.empty.subtitle")}
          action={{
            label: t("nav.explore"),
            onPress: () => router.push("/explore"),
          }}
        />
      ) : (
        <View className="gap-4">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} view={view} />
          ))}

          {pagination && pagination.pages > 1 ? (
            <View className="mt-2 flex-row items-center justify-between">
              <Button
                appearance="outline"
                tone="neutral"
                size="sm"
                disabled={!pagination.hasPreviousPage}
                onPress={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t("orders.pagination.previous")}
              </Button>
              <Text className="text-xs text-muted-foreground">
                {t("orders.pagination.pageOf", {
                  page: pagination.page,
                  pages: pagination.pages,
                })}
              </Text>
              <Button
                appearance="outline"
                tone="neutral"
                size="sm"
                disabled={!pagination.hasNextPage}
                onPress={() => setPage((p) => p + 1)}
              >
                {t("orders.pagination.next")}
              </Button>
            </View>
          ) : null}
        </View>
      )}

    </View>
  );
}

export function OrdersScreen({ view }: { view: BuyerOrderView }) {
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="px-4 pt-6 pb-10 md:px-0 web:max-w-[640px]">
      <Head>
        <title>{t("orders.pageTitle")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <OrdersBody key={view} view={view} />
    </ScreenShell>
  );
}
