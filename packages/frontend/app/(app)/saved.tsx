import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { Heart } from "lucide-react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { SavedItemCard, Text } from "@mercaria/ui";
import type { ProductSaveSplitResolution, SavedItem } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useResolveSplitAmbiguity,
  useSavedItems,
  useToggleListingSave,
  useToggleProductSave,
} from "@/lib/hooks/use-saves";

/** Icon size for the empty-state badge. */
const EMPTY_ICON_SIZE = 28;

/**
 * The saved list (#80) — canonical product saves and exact listing saves, in
 * one stream.
 *
 * ## Two kinds, one list, and the difference is visible
 *
 * A buyer saves "this phone" and "THIS hand-thrown mug" for different reasons,
 * and the page says which is which on every row (`SavedItemCard`). What it does
 * NOT do is decide the mix: which kinds appear is the server's
 * `PRODUCT_SAVE_READS` lever, so a rollback changes what this page shows without
 * shipping a client — which is the whole of #80 acceptance 8.
 *
 * ## Signed out, this page offers rather than gates
 *
 * A product save is stored under an Oxy account id (#80 model rule 1), so there
 * is genuinely nothing to show a signed-out visitor — unlike the cart, which
 * works for a guest. The invitation says what signing in gets them and nothing
 * about what they are missing, because they are not missing anything they had.
 */
export default function SavedScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const savedItems = useSavedItems();
  const toggleProduct = useToggleProductSave();
  const toggleListing = useToggleListingSave();
  const resolveSplit = useResolveSplitAmbiguity();

  const items = useMemo<SavedItem[]>(
    () => savedItems.data?.pages.flatMap((page) => page.items) ?? [],
    [savedItems.data],
  );

  const openItem = (item: SavedItem) => {
    // A product save resolves to the canonical PRODUCT page (#71); a listing
    // save resolves to the one listing. Sending both to the listing would undo
    // the distinction the row just made.
    if (item.kind === "product") {
      router.push(`/products/${item.product.slug}`);
      return;
    }
    router.push(`/products/${item.listingId}`);
  };

  const removeItem = (item: SavedItem) => {
    if (item.kind === "product") {
      toggleProduct.mutate({
        canonicalProductId: item.save.canonicalProductId,
        saved: true,
        sourceContext: "saved_list",
      });
      return;
    }
    toggleListing.mutate({ listingId: item.listingId, saved: true });
  };

  /**
   * #79 UX rule 1 — an alert is created FROM a surface a buyer is already on.
   *
   * This navigates and never subscribes: #80 API rule 6 is that saving creates
   * no alert, and the saved-list domain may not even read one (its own isolation
   * gate). The card renders this affordance only when the deployment has price
   * alerts mounted, which the DTO says.
   */
  const createAlert = (item: SavedItem) => {
    if (item.kind !== "product") return;
    router.push(`/price-alerts?canonicalProductId=${item.save.canonicalProductId}`);
  };

  const answerSplit = (item: SavedItem, resolution: ProductSaveSplitResolution) => {
    if (item.kind !== "product") return;
    resolveSplit.mutate({ saveId: item.save.id, resolution });
  };

  return (
    <ScreenShell>
      <Head>
        <title>Saved · Mercaria</title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">Saved</Text>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : savedItems.isPending ? (
          <View className="py-24">
            <ActivityIndicator />
          </View>
        ) : savedItems.isError ? (
          <EmptyState
            title="We could not load your saved items"
            subtitle="Check your connection and try again."
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing saved yet"
            subtitle="Tap the heart on a product to follow its price, or save a listing when the exact item is what you want."
          />
        ) : (
          <View className="gap-space-12">
            {items.map((item) => (
              <SavedItemCard
                key={item.kind === "product" ? item.save.id : item.favoriteId}
                item={item}
                onPress={openItem}
                onRemove={removeItem}
                // `keep_both` is the answer a split most often deserves: the
                // product was divided because it was always two things, and a
                // buyer who saved it before the division usually wanted the one
                // they were looking at AND has no way to know which that is now.
                // It is also the only answer that cannot lose an interest they
                // had; narrowing it afterwards is one tap on this same page.
                onResolveSplit={(entry) => answerSplit(entry, "keep_both")}
                onCreatePriceAlert={createAlert}
              />
            ))}

            {savedItems.hasNextPage ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load more saved items"
                onPress={() => void savedItems.fetchNextPage()}
                disabled={savedItems.isFetchingNextPage}
                className="items-center rounded-radius-max border border-border-secondary py-space-12"
              >
                <Text className="text-buttonMedium text-text">
                  {savedItems.isFetchingNextPage ? "Loading…" : "Show more"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </ScreenShell>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="items-center px-8 py-24">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-secondary">
        <Heart size={EMPTY_ICON_SIZE} className="text-muted-foreground" />
      </View>
      <Text className="text-center text-lg font-bold text-foreground">{title}</Text>
      <Text className="mt-1 text-center text-sm text-muted-foreground">{subtitle}</Text>
    </View>
  );
}

function SignedOutInvitation() {
  return (
    <View className="gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-16">
      <Text className="text-bodyTitleSmall text-text">Sign in to save things</Text>
      <Text className="text-sm text-muted-foreground">
        Saved products follow the price and availability across every seller, on all your devices.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={() => openAccountDialog()}
        className="items-center rounded-radius-max bg-bg-fill-brand py-space-12"
      >
        <Text className="text-buttonMedium text-text-inverse">Sign in</Text>
      </Pressable>
    </View>
  );
}
