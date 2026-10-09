import { View } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { ProductCard, Text } from "@mercaria/ui";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useShoppingHistory,
  useShoppingHistoryOwner,
} from "@/lib/stores/shopping-history";
import { useTranslation } from "@/lib/i18n";

export default function RecentlyViewedScreen() {
  const owner = useShoppingHistoryOwner();
  const { products, hydrated } = useShoppingHistory();
  const { t } = useTranslation();
  const router = useRouter();
  const items = hydrated ? products.filter((item) => item.owner === owner) : [];
  return (
    <ScreenShell contentClassName="px-4 py-6 lg:px-12">
      <Head>
        <title>{t("home.recentlyViewed")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <Text
        accessibilityRole="header"
        className="mb-6 text-[32px] font-semibold"
      >
        {t("home.recentlyViewed")}
      </Text>
      <View
        className="flex-row flex-wrap gap-4"
        testID="recently-viewed-products"
      >
        {items.map(({ product }) => (
          <View key={product.id} className="w-[47%] md:w-48">
            <ProductCard
              product={product}
              onPress={(id) =>
                router.push({ pathname: "/products/[id]", params: { id } })
              }
            />
          </View>
        ))}
      </View>
      {hydrated && !items.length ? (
        <EmptyState
          description={t("home.recentlyViewedEmpty")}
          action={{
            label: t("nav.explore"),
            onPress: () => router.push("/explore"),
          }}
        />
      ) : null}
    </ScreenShell>
  );
}
