import { Pressable } from 'react-native';
import { Link } from 'expo-router';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';

/** Back to the merchandising rules list. */
export function BackLink() {
  const { t } = useTranslation();
  return (
    <Link href="/tools/merchandising" asChild>
      <Pressable className="rounded-lg border border-border px-3 py-2">
        <Text className="text-sm text-foreground">{t('common.back')}</Text>
      </Pressable>
    </Link>
  );
}
