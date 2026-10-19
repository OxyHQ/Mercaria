import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { useQuery } from '@tanstack/react-query';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { TransportReview } from '@/components/materials/MaterialTransportPanel';
import { useMoovo } from '@/lib/hooks/use-moovo';
import { useTranslation } from '@/lib/i18n';

export default function TransportApproval() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, canUsePrivateApi, activeSessionId, openAccountDialog } = useOxy();
  const moovo = useMoovo();
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['transport-approval', id, user?.id, activeSessionId],
    enabled: !!id && !!user && canUsePrivateApi,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => {
      if (!user) throw new Error('Sign in');
      return moovo.get(id, user.id);
    },
  });
  return (
    <ScreenShell>
      <View className="gap-space-16 p-space-16">
        <Text className="text-xl font-semibold">{t('transport.heading')}</Text>
        <Button onPress={() => openAccountDialog()}>{t('materials.switchAccount')}</Button>
        {query.isError ? (
          <Text>{t('transport.unavailable')}</Text>
        ) : query.data && user ? (
          <TransportReview
            key={`${id}:${user.id}:${activeSessionId}`}
            transport={query.data}
            accountId={user.id}
            participant={false}
            onChange={() => void query.refetch()}
          />
        ) : (
          <Text>{t('transport.signIn')}</Text>
        )}
      </View>
    </ScreenShell>
  );
}
