import type { OxyServices, LinkedHttpClient } from '@oxy.so/core';
import { createGoWayClient, DEFAULT_GOWAY_API_BASE_URL } from '@goway.to/sdk';

/** Keep GoWay's wire contracts; delegate identity and refresh to the host's Oxy session. */
export function createGoWaySessionClient(
  oxy: OxyServices,
  baseURL: string | undefined,
  locale: string,
) {
  const origin = baseURL ?? DEFAULT_GOWAY_API_BASE_URL;
  let linked: LinkedHttpClient | undefined;
  let active = true;
  const client = createGoWayClient({
    apiBaseUrl: origin,
    locale,
    fetch: (input, init) => {
      if (!active) return Promise.reject(new Error('The GoWay client has been disposed'));
      linked ??= oxy.createLinkedClient({ baseURL: origin });
      return linked.fetchOptional(input, init);
    },
  });
  return {
    client,
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
