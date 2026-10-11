import { View } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

export function BrandWordmark() {
  const { t } = useTranslation();
  return (
    <View className="min-w-0">
      <Text className="text-sm font-semibold text-foreground">{t('brand.name')}</Text>
      <Text className="text-xs text-muted-foreground">{t('brand.byline')}</Text>
    </View>
  );
}
