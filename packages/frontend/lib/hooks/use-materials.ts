import { useEffect, useMemo } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { createMaterialsSessionClient } from '../api/materials-session-client';
import config from '../config';

export function useMaterialsClient() {
  const { oxyServices } = useOxy();
  const client = useMemo(
    () => createMaterialsSessionClient(oxyServices, config.apiUrl),
    [oxyServices],
  );
  useEffect(() => {
    client.activate();
    return () => client.dispose();
  }, [client]);
  return client.materials;
}

/** Uniqueness token, never a credential. Preserve it on an uncertain response. */
export function materialRequestKey() {
  return `material_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}
