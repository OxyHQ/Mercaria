import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import {
  CartShelf,
  CategoryCarousel,
  CategoryPills,
  MerchantCarousel,
  ProductShelf,
  Text,
} from "@mercaria/ui";
import type { CartVendor } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { HeroSearch } from "@/components/shell/HeroSearch";
import { Footer } from "@/components/shell/Footer";
import { useFeed } from "@/lib/hooks/use-feed";
import { useCart } from "@/lib/hooks/use-cart";

/** Number of placeholder shelves shown while the feed loads. */
const SKELETON_SHELF_COUNT = 2;
/** Number of placeholder cards shown per skeleton shelf. */
const SKELETON_CARD_COUNT = 3;

function FeedSkeleton() {
  return (
    <View accessibilityLabel="Loading products">
      {Array.from({ length: SKELETON_SHELF_COUNT }).map((_, shelfIndex) => (
        <View key={shelfIndex} className="mb-6">
          {/* Heading placeholder */}
          <View className="mx-4 mb-3 h-5 w-40 rounded-md bg-muted" />
          {/* Card row placeholder */}
          <View className="flex-row gap-3 px-4">
            {Array.from({ length: SKELETON_CARD_COUNT }).map((__, cardIndex) => (
              <View key={cardIndex} className="flex-1 gap-2">
                <View className="aspect-square w-full rounded-2xl bg-muted" />
                <View className="h-3 w-1/2 rounded bg-muted" />
                <View className="h-3 w-3/4 rounded bg-muted" />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function FeedError({ onRetry }: { onRetry: () => void }) {
  return (
    <View className="items-center px-8 py-16">
      <Text className="text-center text-base text-muted-foreground">
        Couldn&apos;t load products. Pull to refresh or try again.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        onPress={onRetry}
        className="mt-4 rounded-full border border-border px-5 py-2"
      >
        <Text className="text-sm font-semibold text-foreground">Try again</Text>
      </Pressable>
    </View>
  );
}

interface FeedBodyProps {
  data: ReturnType<typeof useFeed>["data"];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/** The feed content — identical on web and native, only its scroll host differs. */
function FeedBody({ data, isLoading, isError, refetch }: FeedBodyProps) {
  const router = useRouter();
  const { data: cart } = useCart();

  const onPressVendor = (vendor: CartVendor) => {
    if (vendor.kind === "store" && vendor.handle) {
      router.push(`/stores/${vendor.handle}` as Parameters<typeof router.push>[0]);
    }
  };

  const onCheckout = () => {
    router.push("/cart" as Parameters<typeof router.push>[0]);
  };

  const onPressProduct = (id: string) => {
    router.push(`/products/${id}` as Parameters<typeof router.push>[0]);
  };

  return (
    <>
      {/* Hero search header (provides branding — replaces the old top bar) */}
      <HeroSearch />

      <CartShelf
        groups={cart?.groups ?? []}
        onPressVendor={onPressVendor}
        onCheckout={onCheckout}
      />

      {isLoading && !data ? <FeedSkeleton /> : null}

      {isError && !data ? <FeedError onRetry={refetch} /> : null}

      {/* Defensive: a feed that is partial or in transition (hot-reload, an
          older cached payload) must never crash the home. Guard the section
          list and each section's items against undefined. */}
      {(data?.sections ?? []).map((section) => {
        if (section.kind === "category-pills") {
          return <CategoryPills key={section.id} pills={section.pills ?? []} />;
        }
        if (section.kind === "products") {
          return (
            <ProductShelf
              key={section.id}
              title={section.title}
              items={section.products ?? []}
              onPressItem={onPressProduct}
            />
          );
        }
        if (section.kind === "categories") {
          return (
            <CategoryCarousel
              key={section.id}
              categories={section.categories ?? []}
            />
          );
        }
        return (
          <MerchantCarousel
            key={section.id}
            title={section.title}
            merchants={section.merchants ?? []}
            onPressMerchant={(handle) =>
              router.push(`/stores/${handle}` as Parameters<typeof router.push>[0])
            }
          />
        );
      })}

      <Footer />
    </>
  );
}

export default function HomeScreen() {
  const { data, isLoading, isError, refetch } = useFeed();
  const onRetry = () => refetch();

  return (
    <ScreenShell>
      <Head>
        <title>Mercaria</title>
        <meta
          name="description"
          content="Mercaria — buy and sell new and secondhand items."
        />
      </Head>
      <FeedBody
        data={data}
        isLoading={isLoading}
        isError={isError}
        refetch={onRetry}
      />
    </ScreenShell>
  );
}
