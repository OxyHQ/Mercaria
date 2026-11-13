import type { OxyServices, LinkedHttpClient } from '@oxy.so/core';
import { createMercariaClient } from '@mercaria.co/sdk';

/** Materials never uses guest commerce credentials. Oxy owns its account and refresh. */
export function createMaterialsSessionClient(oxy: OxyServices, baseURL: string) {
  let linked: LinkedHttpClient | undefined;
  let active = true;
  const client = createMercariaClient({
    apiBaseUrl: baseURL,
    fetch: (input, init) => {
      if (!active) return Promise.reject(new Error('The materials client has been disposed'));
      linked ??= oxy.createLinkedClient({ baseURL });
      return linked.fetchOptional(input, init);
    },
  });
  return {
    materials: client.materials,
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      linked?.dispose();
      linked = undefined;
    },
  };
}
