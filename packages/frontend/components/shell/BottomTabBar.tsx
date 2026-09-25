import React, { useCallback, useMemo } from "react";
import { Platform, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { LogIn, ShoppingCart } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Avatar } from "@oxy.so/bloom/avatar";
import { BottomBar, type BottomBarProps } from "@oxy.so/bloom/bottom-bar";
import { useOxy, openAccountDialog } from "@oxy.so/services";
import { LucideGlyph, Text } from "@mercaria/ui";

import { useCart } from "@/lib/hooks/use-cart";
import { useTranslation } from "@/lib/i18n";
import {
  NAV_ITEMS,
  isNavItemActive,
  isAuthTabActive,
  type NavItem,
} from "./nav-items";

/** The destinations that have a screen; an unbuilt one has no route to push. */
type AvailableNavItem = Extract<NavItem, { available: true }>;

/** The trailing account tab's value — not a {@link NAV_ITEMS} key. */
const ACCOUNT_TAB = "account";

/** Maximum badge count shown numerically; above this threshold "9+" is shown. */
const MAX_BADGE_COUNT = 9;

const AVATAR_SIZE = 26;

function triggerHaptic() {
  if (Platform.OS === "web") return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/**
 * The signed-in user's avatar for the account tab: their Oxy photo at the
 * `thumb` rendition, or Bloom's initials disc from their display name.
 */
function AccountAvatar() {
  const { user, oxyServices } = useOxy();
  const avatarUrl = user?.avatar
    ? oxyServices.getFileDownloadUrl(user.avatar, "thumb")
    : undefined;
  return (
    <Avatar
      uri={avatarUrl}
      name={user?.name?.displayName ?? user?.username ?? undefined}
      size={AVATAR_SIZE}
    />
  );
}

/**
 * The cart glyph with its item-count badge. Bloom clones the glyph with the
 * crossfade layer's `fill`, which is forwarded to the icon; the badge keeps its
 * own primary fill in both layers.
 */
function CartGlyph({ count, fill }: { count: number; fill?: string }) {
  return (
    <View className="relative items-center justify-center">
      <LucideGlyph icon={ShoppingCart} fill={fill} />
      {count > 0 ? (
        <View
          pointerEvents="none"
          className="absolute -end-0.5 -top-0.5 h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1"
        >
          <Text className="text-[10px] font-bold text-primary-foreground">
            {count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : count}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The storefront's phone navigation: Bloom's `BottomBar` in `AppShell`'s
 * `bottomBar` slot, which pins it, applies the bottom safe area and reserves
 * its measured height under the content. Mercaria owns the destinations —
 * the same {@link NAV_ITEMS} the sidebar reads — plus the trailing account tab:
 * the signed-in user's avatar, or a sign-in glyph that opens the account dialog.
 */
export function BottomTabBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated } = useOxy();
  const { data: cart } = useCart();
  const cartCount = cart?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;

  const available = useMemo(
    () => NAV_ITEMS.filter((item): item is AvailableNavItem => item.available),
    [],
  );

  const items = useMemo<BottomBarProps["items"]>(
    () => [
      ...available.map((item) => ({
        name: item.key,
        label: t(item.labelKey),
        icon:
          item.key === "cart" ? (
            <CartGlyph count={cartCount} />
          ) : (
            <LucideGlyph icon={item.icon} />
          ),
      })),
      {
        name: ACCOUNT_TAB,
        // Resolved through `t` rather than held as a literal: the i18n guard
        // reads JSX positions and cannot follow a string through a local.
        label: isAuthenticated ? t("nav.account") : t("nav.signIn"),
        icon: isAuthenticated ? <AccountAvatar /> : <LucideGlyph icon={LogIn} />,
      },
    ],
    [available, cartCount, isAuthenticated, t],
  );

  // The settled selection: the matching destination, the account tab on a
  // `/@profile` route, or no tab at all on a pushed screen with no home here.
  const value =
    available.find((item) => isNavItemActive(item, pathname))?.key ??
    (isAuthTabActive(pathname) ? ACCOUNT_TAB : "");

  const onValueChange = useCallback(
    (name: string) => {
      triggerHaptic();
      if (name === ACCOUNT_TAB) {
        // Signed out, the account tab is the way in. Signed in it only marks
        // where you are, as it always has.
        if (!isAuthenticated) openAccountDialog();
        return;
      }
      // The route is read from the typed table, never from the tab's name.
      const destination = available.find((item) => item.key === name);
      if (destination) router.push(destination.href);
    },
    [available, isAuthenticated, router],
  );

  return <BottomBar items={items} value={value} onValueChange={onValueChange} />;
}
