import { Link, Stack } from "expo-router";
import { View } from "react-native";
import Head from "expo-router/head";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

export default function NotFoundScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("errors.notFoundDocumentTitle")}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: t("errors.notFoundHeading") }} />
      <View className="flex-1 items-center justify-center bg-background p-5">
        <Text className="text-xl font-bold text-foreground">{t("errors.notFoundBody")}</Text>
        <Link href="/" className="mt-4 py-4">
          <Text className="text-sm text-primary">{t("errors.notFoundAction")}</Text>
        </Link>
      </View>
    </>
  );
}
