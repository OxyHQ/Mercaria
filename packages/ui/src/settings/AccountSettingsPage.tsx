import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import { View } from 'react-native';
import { Text } from '../components/ui/text';
import { useSharedUiTranslation } from '../i18n/ui-translation';

export interface AccountSettingsPageProps {
  name?: string;
  username?: string;
  avatarUri?: string;
  /** Opens the Oxy account sheet — through `afterClose`, so it is not under the dialog. */
  onManage: () => void;
}

/**
 * Who is signed in, and the way to their Oxy account. Mercaria keeps no profile
 * of its own: Oxy owns identity, so name, photo, security and devices are all
 * edited there.
 */
export function AccountSettingsPage({
  name,
  username,
  avatarUri,
  onManage,
}: AccountSettingsPageProps) {
  const t = useSharedUiTranslation();
  return (
    <View className="gap-6">
      <View className="flex-row items-center gap-3 px-3">
        <Avatar uri={avatarUri} name={name ?? username} size={56} />
        <View className="min-w-0 flex-1 gap-0.5">
          {name ? (
            <Text className="text-lg font-semibold text-foreground" numberOfLines={1}>
              {name}
            </Text>
          ) : null}
          {username ? (
            <Text className="text-sm text-muted-foreground" numberOfLines={1}>
              {`@${username}`}
            </Text>
          ) : null}
        </View>
      </View>
      <SettingsProfilePage
        sections={[
          {
            key: 'oxy',
            rows: [
              {
                key: 'manage',
                label: t('ui.settings.account.oxyAccount'),
                description: t('ui.settings.account.manageDescription'),
                control: (
                  <Button size="sm" appearance="subtle" tone="neutral" onPress={onManage}>
                    {t('ui.settings.account.manage')}
                  </Button>
                ),
              },
            ],
          },
        ]}
      />
    </View>
  );
}
