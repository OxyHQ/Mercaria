import { useRouter, type RoutePath } from 'expo-router';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { Button } from '@oxy.so/bloom/button';
import type { SettingsModalPage, SettingsNavGroup } from '@oxy.so/bloom/settings-modal';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFeedbackLine } from '@oxy.so/bloom/icons/RiFeedbackLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { useSettingsDialog, type SettingsDialogState } from '@mercaria/ui';
import {
  AccountSettingsPage,
  AppearanceSettingsPage,
  SettingsDialogShell,
  useSharedSettingsTitles,
  useLanguageSettingsSection,
} from '@mercaria/ui/settings';
import { STOREFRONT_LOCALES, useTranslation } from '@/lib/i18n';
import { useCurrencySettingsSection } from './currency-section';
import { AddressesSettingsPage } from './addresses-page';
import { FeedbackSettingsPage } from './feedback-page';
import { ReferralsSettingsPage } from './referrals-page';
import type { StorefrontSettingsPage } from './settings-routes';

function GeneralSettingsPage() {
  const { locale, setLocale, directionRestartRequired } = useTranslation();
  const language = useLanguageSettingsSection({
    locales: STOREFRONT_LOCALES,
    locale,
    onChange: setLocale,
    restartRequired: directionRestartRequired,
  });
  const currency = useCurrencySettingsSection();
  return <SettingsGeneralPage sections={[language, currency]} />;
}

function AccountPage() {
  const { t } = useTranslation();
  const { user, isAuthenticated, oxyServices, showBottomSheet } = useOxy();
  const { afterClose } = useSettingsDialog();
  if (!isAuthenticated) {
    // Reached only by a link to `/settings/account` while signed out.
    return (
      <SettingsGeneralPage
        sections={[
          {
            key: 'sign-in',
            rows: [
              {
                key: 'sign-in',
                label: t('nav.signIn'),
                control: (
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={() => afterClose(() => openAccountDialog())}
                  >
                    {t('nav.signIn')}
                  </Button>
                ),
              },
            ],
          },
        ]}
      />
    );
  }
  return (
    <AccountSettingsPage
      // The API resolves the canonical display string; render it directly
      // rather than recomposing from first/last/full (Oxy name contract).
      name={user?.name?.displayName}
      username={user?.username}
      avatarUri={user?.avatar ? oxyServices.assets.publicUrl(user.avatar, 'thumb') : undefined}
      onManage={() => afterClose(() => showBottomSheet?.('ManageAccount'))}
    />
  );
}

/**
 * The storefront's Settings dialog. `StorefrontSettingsProvider` loads this
 * module on the first open request, so none of it is in the startup bundle.
 */
export default function StorefrontSettingsDialog(state: SettingsDialogState) {
  const { t } = useTranslation();
  const titles = useSharedSettingsTitles();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { afterClose } = useSettingsDialog();
  const go = (route: RoutePath) => () => afterClose(() => router.push(route));

  const settingsItems: SettingsNavGroup['items'] = [
    ...(isAuthenticated
      ? [
          {
            key: 'account',
            page: 'account',
            label: t('settings.sections.account'),
            icon: RiUserLine,
          },
        ]
      : []),
    {
      key: 'general',
      page: 'general',
      label: t('settings.sections.general'),
      icon: RiSettings3Line,
    },
    { key: 'appearance', page: 'appearance', label: titles.appearance, icon: RiPaletteLine },
    ...(isAuthenticated
      ? [
          {
            key: 'addresses',
            page: 'addresses',
            label: t('settings.sections.addresses'),
            icon: RiMapPin2Line,
          },
          // Shown enrolled or not: the server's dashboard has an explicit "not
          // enrolled" branch with the joinable programmes, and gating the row on
          // enrolment would make enrolment unreachable.
          {
            key: 'referrals',
            page: 'referrals',
            label: t('settings.sections.referrals'),
            icon: RiTeamLine,
          },
        ]
      : []),
    { key: 'feedback', page: 'feedback', label: t('feedback.title'), icon: RiFeedbackLine },
  ];
  const groups: SettingsNavGroup[] = [
    { key: 'settings', label: titles.settings, items: settingsItems },
  ];
  if (isAuthenticated) {
    // Watchlists and Shopping agents have no other inbound edge: each is scoped
    // to the signed-in Oxy account the way Orders is, and the nav bar
    // (`components/shell/nav-items.ts`) is the four browse destinations. They
    // leave Settings, so they close it first.
    groups.push({
      key: 'shopping',
      label: t('profile.title'),
      items: [
        {
          key: 'orders',
          label: t('settings.sections.orders'),
          icon: RiBox3Line,
          onPress: go('/(app)/orders'),
        },
        {
          key: 'watchlists',
          label: t('settings.sections.watchlists'),
          icon: RiEyeLine,
          onPress: go('/(app)/watchlists'),
        },
        {
          key: 'shopping-agents',
          label: t('settings.sections.shoppingAgents'),
          icon: RiRobot2Line,
          onPress: go('/(app)/shopping-agents'),
        },
      ],
    });
  }

  const pages: Record<StorefrontSettingsPage, SettingsModalPage> = {
    account: { title: t('settings.sections.account'), content: <AccountPage /> },
    general: { title: t('settings.sections.general'), content: <GeneralSettingsPage /> },
    appearance: { title: titles.appearance, content: <AppearanceSettingsPage accent /> },
    addresses: { title: t('settings.sections.addresses'), content: <AddressesSettingsPage /> },
    feedback: { title: t('feedback.title'), content: <FeedbackSettingsPage /> },
    referrals: { title: t('settings.sections.referrals'), content: <ReferralsSettingsPage /> },
  };

  return <SettingsDialogShell {...state} groups={groups} pages={pages} />;
}
