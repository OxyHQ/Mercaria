import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Button } from '@oxy.so/bloom/button';
import {
  Text,
  MarketplaceSheet,
  ProductRichText,
  prepareProductDescription,
  useColorScheme,
  useShopControlClassName,
} from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

/** Shop's accordion uses the peek presentation: 340 decoded characters,
 * a decorative 40px fade and a full-width action. The sheet retains all text. */
const PREVIEW_LENGTH = 340;

export function ProductDescription({ description }: { description: string }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const controlClassName = useShopControlClassName();
  const [open, setOpen] = useState(false);
  const { html, full, preview, truncated } = useMemo(
    () => prepareProductDescription(description, PREVIEW_LENGTH),
    [description],
  );

  return (
    <View testID="product-description" className="gap-space-12">
      <View testID="product-description-peek" className="relative">
        {html ? (
          <ProductRichText nodes={preview} preview />
        ) : (
          <Text className="text-shop-bodySmall text-text">
            {typeof preview[0] === 'string' ? preview[0] : ''}
          </Text>
        )}
        {truncated ? (
          <LinearGradient
            testID="pdp-description-peek-fade"
            pointerEvents="none"
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            colors={['transparent', colors.card]}
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 40 }}
          />
        ) : null}
      </View>
      {truncated ? (
        <Button
          material="flat"
          onPress={() => setOpen(true)}
          className={controlClassName('tertiary')}
        >
          {t('product.readMoreDescription')}
        </Button>
      ) : null}
      <MarketplaceSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('product.description')}
        testID="product-description-dialog"
      >
        {html ? (
          <ProductRichText nodes={full} />
        ) : (
          <Text selectable className="text-shop-bodySmall text-text">
            {description}
          </Text>
        )}
      </MarketplaceSheet>
    </View>
  );
}
