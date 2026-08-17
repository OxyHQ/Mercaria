import { Link, Stack } from 'expo-router';
import { View, Text } from 'react-native';
import Head from 'expo-router/head';
import { useTranslation } from '@/lib/i18n';

export default function NotFoundScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('shell.notFound.headTitle')}</title>
        <meta name="description" content="The page you're looking for doesn't exist. Return to Mercaria to keep browsing." />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: t('shell.notFound.screenTitle') }} />
      <View className="flex-1 items-center justify-center p-5 bg-background">
        <Text className="text-xl font-bold text-foreground">{t('shell.notFound.message')}</Text>

        <Link href="/" className="mt-4 py-4">
          <Text className="text-sm text-primary">{t('shell.notFound.goHome')}</Text>
        </Link>
      </View>
    </>
  );
}
