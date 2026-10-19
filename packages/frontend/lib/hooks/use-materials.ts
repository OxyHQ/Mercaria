import { useMemo } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { createMercariaClient } from '@mercaria.co/sdk';
import config from '../config';

export function useMaterialsClient() {
  const { oxyServices } = useOxy();
  return useMemo(
    () =>
      createMercariaClient({
        apiBaseUrl: config.apiUrl,
        getAccessToken: () => oxyServices.session.accessToken || null,
      }).materials,
    [oxyServices],
  );
}

/** Uniqueness token, never a credential. Preserve it on an uncertain response. */
export function materialRequestKey() {
  return `material_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}
