import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Text, toBloomIcon } from "@mercaria/ui";
import { useOxy } from "@oxy.so/services";
import { useRouter, type RoutePath } from "expo-router";
import { useTranslation } from "@/lib/i18n";
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
          appearance="outline"
          tone="neutral"
          onPress={go("/(app)/orders")}
          leadingIcon={toBloomIcon(Package)}
          trailingIcon={toBloomIcon(ChevronRight)}
          textStyle={{ flex: 1 }}
        >
          {t("settings.sections.orders")}
        </Button>
        <Button
          appearance="outline"
          tone="neutral"
          onPress={go("/(app)/settings/addresses")}
          leadingIcon={toBloomIcon(MapPin)}
          trailingIcon={toBloomIcon(ChevronRight)}
          textStyle={{ flex: 1 }}
        >
          {t("settings.sections.addresses")}
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
          appearance="outline"
          tone="neutral"
          onPress={go("/(app)/watchlists")}
          leadingIcon={toBloomIcon(ListChecks)}
          trailingIcon={toBloomIcon(ChevronRight)}
          textStyle={{ flex: 1 }}
        >
          {t("settings.sections.watchlists")}
        </Button>
        <Button
          appearance="outline"
          tone="neutral"
          onPress={go("/(app)/shopping-agents")}
          leadingIcon={toBloomIcon(Bot)}
          trailingIcon={toBloomIcon(ChevronRight)}
          textStyle={{ flex: 1 }}
        >
          {t("settings.sections.shoppingAgents")}
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
          appearance="outline"
          tone="neutral"
          onPress={go("/(app)/referral-partner")}
          leadingIcon={toBloomIcon(Users)}
          trailingIcon={toBloomIcon(ChevronRight)}
          textStyle={{ flex: 1 }}
        >
          {t("settings.sections.referralPartner")}
        </Button>
      </View>

      {/* Manage Account */}
      <Button
        appearance="outline"
        tone="neutral"
        onPress={() => showBottomSheet?.("ManageAccount")}
        trailingIcon={toBloomIcon(ChevronRight)}
        textStyle={{ flex: 1 }}
      >
        {t("settings.account.title")}
      </Button>
    </View>
  );
}
