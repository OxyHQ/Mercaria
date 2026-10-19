import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { useSettingsDialog, type SettingsDialogState } from '@mercaria/ui';
import {
  AccountSettingsPage,
  AppearanceSettingsPage,
  LanguageSettingsPage,
  SettingsDialogShell,
  useSharedSettingsTitles,
} from '@mercaria/ui/settings';
import { POS_LOCALES, useTranslation } from '@/lib/i18n';

function AccountPage() {
  const { user, oxyServices } = useOxy();
  const { showBottomSheet } = useAuth();
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
      locales={POS_LOCALES}
      locale={locale}
      onChange={setLocale}
      restartRequired={directionRestartRequired}
    />
  );
}

/** Loaded by `PosSettingsProvider` on the first open request. */
export default function PosSettingsDialog(state: SettingsDialogState) {
  const titles = useSharedSettingsTitles();
  return (
    <SettingsDialogShell
      {...state}
      groups={[
        {
          key: 'settings',
          label: titles.settings,
          items: [
            { key: 'account', page: 'account', label: titles.account, icon: RiUserLine },
            { key: 'language', page: 'language', label: titles.language, icon: RiTranslate2 },
            {
              key: 'appearance',
              page: 'appearance',
              label: titles.appearance,
              icon: RiPaletteLine,
            },
          ],
        },
      ]}
      pages={{
        account: { title: titles.account, content: <AccountPage /> },
        language: { title: titles.language, content: <LanguagePage /> },
        appearance: { title: titles.appearance, content: <AppearanceSettingsPage /> },
      }}
    />
  );
}
