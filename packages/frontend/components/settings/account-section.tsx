import { View } from "react-native";
import { Button, Text } from "@mercaria/ui";
import { useOxy } from "@oxyhq/services";
import { useRouter, type RoutePath } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { ChevronRight, Package, MapPin, ListChecks, Bot, Users } from "lucide-react-native";

export function AccountSection() {
  const { user, showBottomSheet } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();

  // The API resolves the canonical display string; render it directly rather
  // than recomposing from first/last/full (Oxy name contract).
  const displayName = user?.name?.displayName;
  const initial = (displayName?.[0] ?? "U").toUpperCase();

  // `RoutePath` rather than `string`: these destinations are literals written a
  // few lines below, so typing the parameter moves the check from nowhere to
  // the place they are written, and deleting one of those screens fails the
  // build here instead of under somebody's thumb (#330).
  const go = (route: RoutePath) => () => router.push(route);

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
        {/*
          The three rows below are the ONLY inbound edge each of these screens
          has. Every one is scoped to the signed-in Oxy account exactly as
          Orders and Addresses are, which is why they belong in this list and
          not in the nav bar — that model (`components/shell/nav-items.ts`) is
          the storefront's four browse destinations, and adding a personal
          list to it is a product decision nobody has taken.

          The cost of putting them ONLY here is stated rather than hidden:
          `/settings` redirects a signed-out visitor away, while all three
          screens are built to OFFER sign-in rather than gate (each says so in
          its own header). So the invitation they render is currently
          unreachable, and giving it an entry point is a separate decision.
        */}
        <Button
          variant="outline"
          onPress={go("/(app)/watchlists")}
          className="flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2">
            <ListChecks size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium">{t("settings.sections.watchlists")}</Text>
          </View>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Button>
        <Button
          variant="outline"
          onPress={go("/(app)/shopping-agents")}
          className="flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2">
            <Bot size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium">{t("settings.sections.shoppingAgents")}</Text>
          </View>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Button>
        {/*
          Shown to every signed-in account, enrolled or not, because that is
          what the server already does: `readReferralPartnerDashboard` has an
          explicit "not enrolled" branch returning the joinable programmes and
          the enrolment checklist, and `GET /referral-partner/dashboard` is the
          one route in that controller which does NOT call `requirePartner`.
          Gating this row on enrolment would make enrolment unreachable.
        */}
        <Button
          variant="outline"
          onPress={go("/(app)/referral-partner")}
          className="flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2">
            <Users size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium">{t("settings.sections.referralPartner")}</Text>
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
