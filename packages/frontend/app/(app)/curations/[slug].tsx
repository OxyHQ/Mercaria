import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import { CurationImage, ProductCard, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { CurationHighlights } from "@/components/discovery/CurationHighlights";
import { useCurations } from "@/lib/curations/use-curations";
import { useTranslation } from "@/lib/i18n";

export default function CurationScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { curations, isLoading, isError, refetch } = useCurations();
  const curation = curations.find((item) => item.slug === slug);
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <ScreenShell>
      <Head>
        <title>
          {curation ? t(curation.titleKey) : t("curations.heading")}
        </title>
        <meta name="robots" content="noindex" />
      </Head>
      {isLoading ? (
        <View className="py-20">
          <Loading variant="inline" />
        </View>
      ) : !curation ? (
        <View className="items-center gap-4 px-4 py-20">
          <Text className="text-center text-muted-foreground">
            {t(isError ? "home.loadError" : "curations.unavailable")}
          </Text>
          <Button
            appearance="outline"
            tone="neutral"
            onPress={() =>
              isError ? void refetch() : router.replace("/explore")
            }
          >
            {t(isError ? "common.tryAgain" : "nav.explore")}
          </Button>
        </View>
      ) : (
        <>
          <View
            className="relative h-[268px] items-center justify-center overflow-hidden bg-muted"
            testID="curation-header"
          >
            <CurationImage
              imageUrl={curation.imageUrl}
              fallbackImageUrl={curation.products[0]?.imageUrl}
            />
            <View className="absolute inset-0 bg-black/45" />
            <View className="w-full max-w-[640px] items-center gap-3 px-4 py-8">
              <Text
                accessibilityRole="header"
                className="text-center text-[36px] font-bold leading-10 text-white"
              >
                {t(curation.titleKey)}
              </Text>
              <Text className="text-center text-base text-white">
                {t("curations.description")}
              </Text>
              <Button
                appearance="plain"
                tone="neutral"
                textStyle={{ color: "white" }}
                onPress={() => router.push("/explore")}
              >
                {t("nav.explore")}
              </Button>
            </View>
          </View>
          <View className="gap-6 px-4 py-8 lg:px-12">
            <Text className="text-sm text-muted-foreground">
              {t("curations.preview")}
            </Text>
            <View
              className="flex-row flex-wrap -mx-2"
              testID="curation-products"
            >
              {curation.products.map((product) => (
                <View
                  key={product.id}
                  className="mb-8 w-1/2 px-2 sm:w-1/3 lg:w-1/4 xl:w-1/5"
                >
                  <ProductCard
                    product={product}
                    onPress={(id) =>
                      router.push({
                        pathname: "/products/[id]",
                        params: { id },
                      })
                    }
                  />
                </View>
              ))}
            </View>
          </View>
          <CurationHighlights />
        </>
      )}
    </ScreenShell>
  );
}
