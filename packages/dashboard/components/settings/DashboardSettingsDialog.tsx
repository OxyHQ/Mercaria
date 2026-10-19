import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import type { SettingsNavGroup } from '@oxy.so/bloom/settings-modal';
import { useSettingsDialog, type SettingsDialogState } from '@mercaria/ui';
import {
  AccountSettingsPage,
  AppearanceSettingsPage,
  LanguageSettingsPage,
  SettingsDialogShell,
  useSharedSettingsTitles,
} from '@mercaria/ui/settings';
import { DASHBOARD_LOCALES, useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';

function AccountPage() {
  const { user, oxyServices, showBottomSheet } = useOxy();
  const { afterClose } = useSettingsDialog();
  return (
    <AccountSettingsPage
      name={user?.name?.displayName}
      username={user?.username}
      avatarUri={user?.avatar ? oxyServices.assets.publicUrl(user.avatar, 'thumb') : undefined}
      onManage={() => afterClose(() => showBottomSheet?.('ManageAccount'))}
    />
  );
}

function LanguagePage() {
  const { locale, setLocale, directionRestartRequired } = useTranslation();
  return (
    <LanguageSettingsPage
      locales={DASHBOARD_LOCALES}
      locale={locale}
      onChange={setLocale}
      restartRequired={directionRestartRequired}
    />
  );
}

/** Loaded by `DashboardSettingsProvider` on the first open request. */
export default function DashboardSettingsDialog(state: SettingsDialogState) {
  const { t } = useTranslation();
  const titles = useSharedSettingsTitles();
  const router = useRouter();
  const { can } = useActiveStoreContext();
  const { afterClose } = useSettingsDialog();

  const groups: SettingsNavGroup[] = [
    {
      key: 'settings',
      label: titles.settings,
      items: [
        { key: 'account', page: 'account', label: titles.account, icon: RiUserLine },
        { key: 'language', page: 'language', label: titles.language, icon: RiTranslate2 },
        { key: 'appearance', page: 'appearance', label: titles.appearance, icon: RiPaletteLine },
        // The way across to the STORE's configuration, which is a section of
        // the app rather than a preference: same permission as its nav row.
        ...(can('settings:write')
          ? [
              {
                key: 'store',
                label: t('nav.settings'),
                icon: RiStore2Line,
                onPress: () => afterClose(() => router.push('/settings')),
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <SettingsDialogShell
      {...state}
      groups={groups}
      pages={{
        account: { title: titles.account, content: <AccountPage /> },
        language: { title: titles.language, content: <LanguagePage /> },
        // No colour preset: `BloomProvider` pins the dashboard's (controlled
        // `colorPreset`), so a choice here would do nothing.
        appearance: { title: titles.appearance, content: <AppearanceSettingsPage /> },
      }}
    />
  );
}
