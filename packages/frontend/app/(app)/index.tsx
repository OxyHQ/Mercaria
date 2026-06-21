import { View, ScrollView, Pressable } from "react-native";
import Head from "expo-router/head";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { ProductShelf } from "@/components/marketplace/ProductShelf";
import { useFeed } from "@/lib/hooks/use-feed";

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

export default function HomeScreen() {
  const { colors } = useColorScheme();
  const { data, isLoading, isError, refetch } = useFeed();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Mercaria</title>
        <meta
          name="description"
          content="Mercaria — buy and sell new and secondhand items."
        />
      </Head>

      {/* Header */}
      <View className="h-14 flex-row items-center border-b border-border/40 px-4">
        <MercariaWordmark width={160} color={colors.foreground} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24 pt-4"
        keyboardShouldPersistTaps="handled"
      >
        {isLoading && !data ? <FeedSkeleton /> : null}

        {isError && !data ? <FeedError onRetry={() => refetch()} /> : null}

        {data
          ? data.shelves.map((shelf) => (
              <ProductShelf key={shelf.id} title={shelf.title} items={shelf.products} />
            ))
          : null}
      </ScrollView>
    </View>
  );
}
