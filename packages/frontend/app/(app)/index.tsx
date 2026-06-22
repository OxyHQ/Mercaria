import { View, ScrollView, Pressable, Platform } from "react-native";
import Head from "expo-router/head";
import {
  CategoryCarousel,
  CategoryPills,
  MerchantCarousel,
  ProductShelf,
  Text,
  useColorScheme,
} from "@mercaria/ui";
import { HeroSearch } from "@/components/shell/HeroSearch";
import { Footer } from "@/components/shell/Footer";
import { useFeed } from "@/lib/hooks/use-feed";

/** Spread (px) of the gutter-color mask around the rounded frame. Paints a ring
 *  of the gutter color over any content bleeding into the thin gutter + corners. */
const GUTTER_MASK_SPREAD = 40;

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
  return (
    <>
      {/* Hero search header (provides branding — replaces the old top bar) */}
      <HeroSearch />

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
          />
        );
      })}

      <Footer />
    </>
  );
}

export default function HomeScreen() {
  const { data, isLoading, isError, refetch } = useFeed();
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === "web";
  const onRetry = () => refetch();

  const head = (
    <Head>
      <title>Mercaria</title>
      <meta
        name="description"
        content="Mercaria — buy and sell new and secondhand items."
      />
    </Head>
  );

  // WEB: the feed flows in normal document flow (no vertical ScrollView) so the
  // BODY scrolls — scrolling works from anywhere, incl. over the sticky rail and
  // gutter (Shop's pattern, pure NativeWind classes, zero scroll JS).
  if (isWeb) {
    return (
      <>
        {head}
        {/* Decorative rounded-panel frame + bleed mask (desktop only, gated by
            CSS `max-md:hidden` — no JS width check). A STICKY overlay pinned to
            the viewport; the negative bottom margin gives it ~0 layout height so
            it doesn't push the feed, while it frames the viewport and stays put as
            the body scrolls under it. The `boxShadow` paints a ring of the GUTTER
            color (Bloom `background` token — not hardcoded) around the rounded
            rect, masking any feed content that bleeds into the thin gutter +
            rounded corners; `clipPath: inset(-12px)` keeps that ring from
            spilling onto the rail. `pointer-events-none` passes clicks. */}
        <View
          pointerEvents="none"
          className="max-md:hidden web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-3xl border border-border web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
          style={{
            boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${colors.background}`,
          }}
        />
        {/* The content panel flows in the document and scrolls with the body,
            passing under the sticky frame. Full-bleed below md, rounded card panel
            at md+. The feed is centered (`mx-auto max-w-[2000px]`). */}
        <View className="relative w-full bg-card pb-24 web:min-h-screen web:overflow-x-clip md:rounded-3xl">
          <View className="web:mx-auto web:w-full web:max-w-[2000px]">
            <FeedBody
              data={data}
              isLoading={isLoading}
              isError={isError}
              refetch={onRetry}
            />
          </View>
        </View>
      </>
    );
  }

  // NATIVE: a single full-height ScrollView (no document scroll on native).
  return (
    <View className="flex-1 bg-card">
      {head}
      <ScrollView
        className="flex-1 bg-card"
        contentContainerClassName="pb-24"
        keyboardShouldPersistTaps="handled"
      >
        <FeedBody
          data={data}
          isLoading={isLoading}
          isError={isError}
          refetch={onRetry}
        />
      </ScrollView>
    </View>
  );
}
