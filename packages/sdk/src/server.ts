import {
  createMercariaClient,
  DEFAULT_MERCARIA_API_BASE_URL,
  type MercariaClient,
  type MercariaClientOptions,
} from './client';
import type { MercariaFetch } from './runtime';

/** The receiving Mercaria application, not a customer credential or user. */
export const MERCARIA_SERVICE_AUDIENCE = 'oxy-service:6a37d0cc5d4b5f15482a9340' as const;

/** OxyServer owns workload minting, revocation, refresh and origin protection. */
export interface MercariaWorkloadOwner {
  createServiceClient(options: { baseURL: string; audience: typeof MERCARIA_SERVICE_AUDIENCE }): {
    fetch: MercariaFetch;
    dispose(): void;
  };
}
export type MercariaServiceOptions = Omit<MercariaClientOptions, 'fetch' | 'getAccessToken'>;
/** Public catalogue reads only; workload identity supplies attribution, not a user account. */
export type MercariaServiceClient = Omit<MercariaClient, 'materials'> & { dispose(): void };

export function mercariaForOxyService(
  oxy: MercariaWorkloadOwner,
  options: MercariaServiceOptions = {},
): MercariaServiceClient {
  if ('fetch' in options || 'getAccessToken' in options) {
    throw new TypeError('The shared Oxy workload transport owns authentication and fetch');
  }
  const transport = oxy.createServiceClient({
    baseURL: options.apiBaseUrl ?? DEFAULT_MERCARIA_API_BASE_URL,
    audience: MERCARIA_SERVICE_AUDIENCE,
  });
  try {
    const client = createMercariaClient({ ...options, fetch: transport.fetch });
    return Object.freeze({
      products: client.products,
      catalog: client.catalog,
      stores: client.stores,
      collections: client.collections,
      locations: client.locations,
      links: client.links,
      dispose: () => transport.dispose(),
    });
  } catch (error) {
    transport.dispose();
    throw error;
  }
}
