import { Link, Stack } from "expo-router";
import { View } from "react-native";
import Head from "expo-router/head";
import { Text } from "@mercaria/ui";

export default function NotFoundScreen() {
  return (
    <>
      <Head>
        <title>404 - Not Found | Mercaria POS</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: "Oops!" }} />
      <View className="flex-1 items-center justify-center bg-background p-5">
        <Text className="text-xl font-bold text-foreground">This screen doesn't exist.</Text>
        <Link href="/" className="mt-4 py-4">
          <Text className="text-sm text-primary">Go to the register</Text>
        </Link>
      </View>
    </>
  );
}
