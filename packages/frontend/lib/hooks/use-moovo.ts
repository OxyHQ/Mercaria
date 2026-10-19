import { useEffect, useMemo } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { moovoForOxy } from '@oxy.so/moovo-sdk';

export function useMoovo() {
  const { oxyServices } = useOxy();
  const client = useMemo(
    () =>
      moovoForOxy(oxyServices, {
        apiBaseUrl: process.env.EXPO_PUBLIC_MOOVO_API_URL || 'https://api.moovo.now',
      }),
    [oxyServices],
  );
  useEffect(() => () => client.dispose(), [client]);
  return client.transports;
}
