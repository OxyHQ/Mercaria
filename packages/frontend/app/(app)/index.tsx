import { View, ScrollView } from "react-native";
import Head from "expo-router/head";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { ProductShelf } from "@/components/marketplace/ProductShelf";
import { NEW_ARRIVALS, ON_SALE } from "@/components/marketplace/mockProducts";

export default function HomeScreen() {
  const { colors } = useColorScheme();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Mercaria</title>
        <meta
          name="description"
          content="Mercaria — buy and sell new and secondhand items."
        />
      </Head>

      {/* Header */}
      <View className="h-14 flex-row items-center border-b border-border/40 px-4">
        <MercariaWordmark width={160} color={colors.foreground} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24 pt-4"
        keyboardShouldPersistTaps="handled"
      >
        <ProductShelf title="New arrivals" items={NEW_ARRIVALS} />
        <ProductShelf title="On sale" items={ON_SALE} />
      </ScrollView>
    </View>
  );
}
