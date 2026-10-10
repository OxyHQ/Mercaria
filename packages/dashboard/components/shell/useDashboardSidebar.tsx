import React, { useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'expo-router';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { ProfileButton, openAccountDialog } from '@oxy.so/services';
import { toBloomIcon, useColorScheme, useSidebarCollapse } from '@mercaria/ui';
import { Logo } from '@/components/Logo';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { NAV_ITEMS, isNavItemActive } from './nav-items';

/**
 * The dashboard's navigation as Bloom `Sidebar` props, for `AppShell`'s
 * `sidebar` slot. Navigation belongs to Mercaria; measurement, collapse, the
 * drawer and the row chrome belong to Bloom. The same descriptor feeds the
 * in-flow rail and the drawer.
 *
 * Rows come from {@link NAV_ITEMS}, each gated by the caller's permission on the
 * active store (the server is the authority — gating here only hides
 * affordances that would 403). Labels are resolved here because the table holds
 * KEYS. The active-store switcher lives in the sidebar header and the mobile shell
 * header, so it stays reachable on detail screens too.
 */
export function useDashboardSidebar(): SidebarProps {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const pathname = usePathname();
  const { can, store } = useActiveStoreContext();
  const { collapsed, setCollapsed } = useSidebarCollapse();

  const goStores = useCallback(() => router.push('/stores'), [router]);
  const goSettings = useCallback(() => router.push('/(app)/settings'), [router]);

  const visible = useMemo(() => NAV_ITEMS.filter((item) => can(item.permission)), [can]);
  const selected = visible.find((item) => isNavItemActive(item, pathname))?.key;

  return useMemo<SidebarProps>(
    () => ({
      surface: 'plain',
      style: { backgroundColor: colors.background },
      testID: 'merchant-sidebar',
      size: 'sm',
      showSearch: true,
      searchShortcut: false,
      searchShortcutLabel: '',
      searchLabel: t('nav.searchNavigation'),
      searchButtonLabel: t('nav.searchNavigation'),
      searchPlaceholder: t('nav.searchNavigation'),
      filterLabel: t('nav.searchNavigation'),
      clearSearchLabel: t('nav.clearSearch'),
      noResultsLabel: t('nav.noResults'),
      // Bloom's own chrome labels default to English; every one it draws here
      // is passed translated.
      accessibilityLabel: t('nav.mainNavigation'),
      collapseLabel: t('nav.collapseSidebar'),
      expandLabel: t('nav.expandSidebar'),
      closeLabel: t('nav.closeSidebar'),
      showThemeToggle: false,
      collapsed,
      onCollapsedChange: setCollapsed,
      logo: {
        icon: <Logo size={28} />,
        wordmark: store?.name ?? t('stores.selectStore'),
        accessibilityLabel: t('stores.switch'),
        onPress: goStores,
      },
      selected,
      items: visible
        .filter((item) => item.key !== 'settings')
        .map((item) => ({
          key: item.key,
          label: t(item.labelKey),
          icon: toBloomIcon(item.icon),
          // The route is read from the typed table, never from the row Bloom
          // hands back, so every push is checked against the real route tree.
          onPress: () => router.push(item.href),
        })),
      secondaryItems: visible
        .filter((item) => item.key === 'settings')
        .map((item) => ({
          key: item.key,
          label: t(item.labelKey),
          icon: toBloomIcon(item.icon),
          onPress: () => router.push(item.href),
        })),
      // Account trigger. ProfileButton owns all three auth states and follows
      // the rail's collapsed state.
      footer: ({ collapsed: railCollapsed }) => (
        <ProfileButton
          expanded={!railCollapsed}
          onNavigateManage={goSettings}
          onAddAccount={() => openAccountDialog()}
        />
      ),
    }),
    [
      collapsed,
      colors.background,
      goStores,
      goSettings,
      router,
      selected,
      setCollapsed,
      store?.name,
      t,
      visible,
    ],
  );
}
