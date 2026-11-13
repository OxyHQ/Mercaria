import { renderListingLink } from '@/lib/catalog/product-links';
import { useConversations } from '@alia.onl/sdk/runtime';
import { useAskAgent } from '@alia.onl/sdk/ask';
import { View } from 'react-native';
import { Link } from 'expo-router';
import { ProductShelf, ThreadShelf } from '@mercaria/ui';
import { useShoppingHistory, useShoppingHistoryOwner } from '@/lib/stores/shopping-history';
import { useTranslation } from '@/lib/i18n';
import { MERCARIA_APP } from '@/lib/alia/mercaria-app';
import { recentConversations } from '@/lib/thread/recent-conversations';

/**
 * "Keep shopping" is the person's Alia conversations started in Mercaria,
 * newest first — the ones Alia's sheet starts here, labelled with
 * `MERCARIA_APP` — read from Alia, so they follow the account to every device
 * and nothing private is kept here. Their Homiio or Alia chats are not
 * Mercaria's and are not shown. A card reopens its conversation in the sheet.
 * Signed out there are none (the query does not run).
 */
export function ShoppingHistoryShelves() {
  const owner = useShoppingHistoryOwner();
  const { products, hydrated } = useShoppingHistory();
  const conversations = useConversations({ app: MERCARIA_APP });
  const { resume } = useAskAgent();
  const { t, locale } = useTranslation();
  if (!hydrated) return null;
  const recentProducts = products
    .filter((item) => item.owner === owner)
    .map((item) => item.product);
  return (
    <>
      <ThreadShelf
        title={t('home.keepShopping')}
        items={recentConversations(conversations.data?.pages ?? [], locale)}
        onPress={(conversationId) => resume(undefined, conversationId)}
      />
      {recentProducts.length ? (
        <View testID="recently-viewed-shelf">
          <ProductShelf
            title={t('home.recentlyViewed')}
            items={recentProducts.slice(0, 12)}
            cardVariant="image-only"
            renderTitleLink={(child) => (
              <Link href="/recently-viewed" asChild>
                {child}
              </Link>
            )}
            renderProductLink={renderListingLink}
          />
        </View>
      ) : null}
    </>
  );
}
