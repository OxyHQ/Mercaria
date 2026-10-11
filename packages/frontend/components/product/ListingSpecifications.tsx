import { View } from 'react-native';
import { AccordionItem, AccordionTrigger, AccordionContent } from '@oxy.so/bloom/accordion';
import { Button } from '@oxy.so/bloom/button';
import { Text, useColorScheme } from '@mercaria/ui';
import type { Listing } from '@mercaria/shared-types';
import { useTranslation } from '@/lib/i18n';
import { useSpecificationTable } from '@/lib/catalog/use-specifications';
import { SpecificationGroups } from '@/components/catalog/SpecificationGroups';

/** Only an exact active catalog attachment can supply facts for this option. */
export function ListingSpecifications({
  identity,
}: {
  identity: NonNullable<Listing['catalogIdentityByVariant']>[string] | undefined;
}) {
  const { t } = useTranslation();
  const { isDarkColorScheme } = useColorScheme();
  const state = useSpecificationTable({
    categoryId: identity?.categoryId,
    canonicalProductId: identity?.productId,
    canonicalVariantId: identity?.variantId,
  });
  if (!identity || (!state.isLoading && !state.isError && state.table.groups.length === 0))
    return null;
  return (
    <AccordionItem
      value="specifications"
      className={isDarkColorScheme ? 'border-white/10' : 'border-[#183b4e0f]'}
    >
      <AccordionTrigger className="px-0 py-space-16">
        <Text accessibilityRole="header" className="text-shop-subtitle text-text">
          {t('catalog.specs.title')}
        </Text>
      </AccordionTrigger>
      <AccordionContent contentClassName="px-0 pb-space-16">
        <View testID="listing-specifications">
          {state.isLoading ? (
            <Text
              accessibilityLiveRegion="polite"
              className="text-shop-bodySmall text-text-tertiary"
            >
              {t('common.loading')}
            </Text>
          ) : state.isError ? (
            <View className="gap-space-8">
              <Text accessibilityRole="alert" className="text-shop-bodySmall text-text-tertiary">
                {t('catalog.specs.loadError')}
              </Text>
              <Button
                appearance="outline"
                size="sm"
                onPress={() => {
                  void state.retry();
                }}
              >
                {t('common.tryAgain')}
              </Button>
            </View>
          ) : (
            <SpecificationGroups
              table={state.table}
              definitionsUnavailable={state.definitionsUnavailable}
              showTitle={false}
            />
          )}
        </View>
      </AccordionContent>
    </AccordionItem>
  );
}
