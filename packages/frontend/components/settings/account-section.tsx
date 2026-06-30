import { View } from "react-native";
import { Button, Text } from "@mercaria/ui";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { ChevronRight, Package, MapPin } from "lucide-react-native";

export function AccountSection() {
  const { user, showBottomSheet } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();

  // The API resolves the canonical display string; render it directly rather
  // than recomposing from first/last/full (Oxy name contract).
  const displayName = user?.name?.displayName;
  const initial = (displayName?.[0] ?? "U").toUpperCase();

  const go = (route: string) => () =>
    router.push(route as Parameters<typeof router.push>[0]);

  return (
    <View className="gap-6">
      {/* Profile Card */}
      <View className="flex-row items-center gap-4">
        <View className="w-14 h-14 rounded-full bg-muted items-center justify-center">
          <Text className="text-xl font-bold text-muted-foreground">{initial}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-lg font-semibold">{displayName}</Text>
          {user?.email && (
            <Text className="text-sm text-muted-foreground">{user.email}</Text>
          )}
        </View>
      </View>

      {/* Commerce shortcuts */}
      <View className="gap-2">
        <Button
          variant="outline"
          onPress={go("/(app)/orders")}
          className="flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2">
            <Package size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium">{t("settings.sections.orders")}</Text>
          </View>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Button>
        <Button
          variant="outline"
          onPress={go("/(app)/settings/addresses")}
          className="flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2">
            <MapPin size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium">{t("settings.sections.addresses")}</Text>
          </View>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Button>
      </View>

      {/* Manage Account */}
      <Button
        variant="outline"
        onPress={() => showBottomSheet?.("ManageAccount")}
        className="flex-row items-center justify-between"
      >
        <Text className="text-sm font-medium">{t("settings.account.title")}</Text>
        <ChevronRight size={16} className="text-muted-foreground" />
      </Button>
    </View>
  );
}
