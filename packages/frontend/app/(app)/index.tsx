import { View, ScrollView } from "react-native";
import Head from "expo-router/head";
import { ShoppingBag } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { MarketplaceWordmark } from "@/components/ui/marketplace-wordmark";
import { useTranslation } from "@/hooks/useTranslation";
import { useColorScheme } from "@/lib/useColorScheme";

export default function HomeScreen() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Marketplace</title>
        <meta
          name="description"
          content="Marketplace — buy and sell new and secondhand items."
        />
      </Head>

      {/* Header */}
      <View className="h-14 flex-row items-center border-b border-border/40 px-4">
        <MarketplaceWordmark width={160} color={colors.foreground} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pb-24 pt-3"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center justify-center py-24">
          <ShoppingBag size={64} color={colors.mutedForeground} strokeWidth={1.5} />
          <Text className="mt-4 text-base font-semibold text-foreground">
            {t("home.emptyTitle")}
          </Text>
          <Text className="mt-1 text-center text-sm text-muted-foreground">
            {t("home.emptySubtitle")}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
