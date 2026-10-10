import { View } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import { Avatar } from "@oxy.so/bloom/avatar";
import { Button } from "@oxy.so/bloom/button";
import { Card } from "@oxy.so/bloom/card";
import { Image } from "expo-image";
import {
  Heart,
  MapPin,
  Settings,
  ChevronRight,
  UserRound,
} from "lucide-react-native";
import {
  Text,
  toBloomIcon,
  LucideGlyph,
  ShopNavigationIcon,
  useColorScheme,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useTranslation } from "@/lib/i18n";
import { useSavedItems } from "@/lib/hooks/use-saves";

export default function ProfileScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isAuthenticated, canUsePrivateApi, oxyServices } = useOxy();
  const savedItems = useSavedItems();
  const savedImages = (
    isAuthenticated && canUsePrivateApi ? (savedItems.data?.pages ?? []) : []
  )
    .flatMap((page) => page.items)
    .map((item) =>
      item.kind === "product" ? item.product.imageFileId : item.imageFileId,
    )
    .filter((fileId): fileId is string => Boolean(fileId))
    .slice(0, 3);
  const { isDarkColorScheme, colors } = useColorScheme();
  const rowStyle = {
    minHeight: 72,
    borderRadius: 16,
    paddingHorizontal: 20,
    backgroundColor: isDarkColorScheme
      ? "rgba(255,255,255,0.06)"
      : "rgba(0,0,0,0.04)",
    boxShadow: "none",
  };
  const name = user?.name?.displayName ?? user?.username;
  const avatar = user?.avatar
    ? oxyServices.assets.publicUrl(user.avatar, "thumb")
    : undefined;

  return (
    <ScreenShell contentClassName="px-4 py-8 md:px-8 md:py-12">
      <Head>
        <title>{t("profile.title")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <View
        className="mx-auto w-full max-w-[640px] gap-8"
        testID="shopping-profile"
      >
        <Card
          appearance="plain"
          border="hairline"
          elevation="none"
          radius="radius-20"
          cornerCurve="round"
          style={{
            padding: 16,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
          }}
          accessibilityLabel={
            isAuthenticated ? t("nav.account") : t("nav.signIn")
          }
          onPress={() => openAccountDialog()}
        >
          <Avatar
            uri={avatar}
            name={name}
            size={56}
            placeholderColor={colors.muted}
            placeholderIcon={
              !name ? (
                <ShopNavigationIcon
                  name="profile"
                  size={28}
                  fill={colors.foreground}
                />
              ) : undefined
            }
          />
          <View className="min-w-0 flex-1 gap-1">
            <Text
              accessibilityRole="header"
              className="text-xl font-semibold text-foreground"
              numberOfLines={1}
            >
              {name ?? t("profile.title")}
            </Text>
            <Text className="text-sm text-muted-foreground" numberOfLines={1}>
              {user?.username ? `@${user.username}` : t("nav.signIn")}
            </Text>
          </View>
          <LucideGlyph icon={ChevronRight} size={22} fill={colors.foreground} />
        </Card>
        <Text className="text-base text-muted-foreground">
          {t("profile.subtitle")}
        </Text>
        <View className="flex-row gap-4">
          <Card
            appearance="plain"
            border="hairline"
            elevation="none"
            radius="radius-20"
            cornerCurve="round"
            style={{ flex: 1, padding: 16, gap: 12 }}
            accessibilityLabel={t("nav.saved")}
            onPress={() => router.push("/saved")}
          >
            {savedImages.length ? (
              <View className="h-14 flex-row gap-2 overflow-hidden">
                {savedImages.map((fileId, index) => (
                  <Image
                    key={`${fileId}-${index}`}
                    source={{
                      uri: oxyServices.assets.publicUrl(fileId, "thumb"),
                    }}
                    className="h-14 w-14 rounded-xl"
                    contentFit="cover"
                  />
                ))}
              </View>
            ) : (
              <View className="h-14 w-14 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
                <LucideGlyph icon={Heart} size={28} fill={colors.foreground} />
              </View>
            )}
            <Text className="text-base font-semibold text-foreground">
              {t("nav.saved")}
            </Text>
          </Card>
          <Card
            appearance="plain"
            border="hairline"
            elevation="none"
            radius="radius-20"
            cornerCurve="round"
            style={{ flex: 1, padding: 16, gap: 12 }}
            accessibilityLabel={t("settings.sections.orders")}
            onPress={() => router.push("/orders")}
          >
            <View className="h-14 w-14 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
              <ShopNavigationIcon
                name="orders"
                size={28}
                fill={colors.foreground}
              />
            </View>
            <Text className="text-base font-semibold text-foreground">
              {t("settings.sections.orders")}
            </Text>
          </Card>
        </View>
        <View className="gap-3">
          {isAuthenticated ? (
            <Button
              appearance="plain"
              tone="neutral"
              style={rowStyle}
              leadingIcon={toBloomIcon(MapPin)}
              trailingIcon={toBloomIcon(ChevronRight)}
              textStyle={{ flex: 1 }}
              onPress={() => router.push("/settings/addresses")}
            >
              {t("settings.sections.addresses")}
            </Button>
          ) : null}
          <Button
            appearance="plain"
            tone="neutral"
            style={rowStyle}
            leadingIcon={toBloomIcon(Settings)}
            trailingIcon={toBloomIcon(ChevronRight)}
            textStyle={{ flex: 1 }}
            onPress={() => router.push("/settings/general")}
          >
            {t("settings.sections.general")}
          </Button>
          {isAuthenticated ? (
            <Button
              appearance="plain"
              tone="neutral"
              style={rowStyle}
              leadingIcon={toBloomIcon(UserRound)}
              trailingIcon={toBloomIcon(ChevronRight)}
              textStyle={{ flex: 1 }}
              onPress={() => router.push("/settings")}
            >
              {t("settings.account.title")}
            </Button>
          ) : null}
        </View>
      </View>
    </ScreenShell>
  );
}
