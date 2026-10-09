import { View } from "react-native";
import { useRouter } from "expo-router";
import { ProductShelf, ThreadShelf } from "@mercaria/ui";
import {
  useShoppingHistory,
  useShoppingHistoryOwner,
} from "@/lib/stores/shopping-history";
import { useTranslation } from "@/lib/i18n";

export function ShoppingHistoryShelves() {
  const owner = useShoppingHistoryOwner();
  const { threads, products, hydrated } = useShoppingHistory();
  const router = useRouter();
  const { t, locale } = useTranslation();
  if (!hydrated) return null;
  const recentThreads = threads.filter(
    (thread) => thread.owner === owner && (__DEV__ || !thread.preview),
  );
  const recentProducts = products
    .filter((item) => item.owner === owner)
    .map((item) => item.product);
  return (
    <>
      <ThreadShelf
        title={t("home.keepShopping")}
        items={recentThreads.map((thread) => {
          const date = new Date(thread.updatedAt);
          const today = date.toDateString() === new Date().toDateString();
          return {
            id: thread.id,
            title: thread.title,
            dateLabel: new Intl.DateTimeFormat(
              locale,
              today
                ? { hour: "numeric", minute: "2-digit" }
                : { month: "long", day: "numeric" },
            ).format(date),
            imageUrls: thread.messages
              .flatMap((message) =>
                (message.examples ?? []).flatMap((product) =>
                  product.imageUrl ? [product.imageUrl] : [],
                ),
              )
              .slice(0, 2),
          };
        })}
        onPress={(conversationId) =>
          router.push({ pathname: "/thread", params: { conversationId } })
        }
      />
      {recentProducts.length ? (
        <View testID="recently-viewed-shelf">
          <ProductShelf
            title={t("home.recentlyViewed")}
            items={recentProducts.slice(0, 12)}
            cardVariant="image-only"
            onPressTitle={() => router.push("/recently-viewed")}
            onPressItem={(id) =>
              router.push({ pathname: "/products/[id]", params: { id } })
            }
          />
        </View>
      ) : null}
    </>
  );
}
