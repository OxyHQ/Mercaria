import { renderListingLink } from '@/lib/catalog/product-links';
import { useConversations } from '@alia.onl/sdk';
import { View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { ProductShelf, ThreadShelf } from '@mercaria/ui';
import { useShoppingHistory, useShoppingHistoryOwner } from '@/lib/stores/shopping-history';
import { useTranslation } from '@/lib/i18n';
import { recentConversations } from '@/lib/thread/recent-conversations';

/**
 * "Keep shopping" is the person's Alia conversations, newest first — the same
 * ones the shopping thread writes (`app/(app)/thread.tsx`), read from Alia, so
 * they follow the account to every device and nothing private is kept here.
 * Signed out there are none (the query does not run).
 */
export function ShoppingHistoryShelves() {
  const owner = useShoppingHistoryOwner();
  const { products, hydrated } = useShoppingHistory();
  const conversations = useConversations();
  const router = useRouter();
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
        onPress={(conversationId) =>
          router.push({ pathname: '/thread', params: { conversationId } })
        }
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
