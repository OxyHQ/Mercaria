/**
 * Connector provider registry.
 *
 * Resolves a {@link ConnectorProviderId} to its {@link ConnectorProvider}. Only
 * implemented providers appear in the map; requesting any other id (an unknown
 * value, or a platform not yet built — WooCommerce/Etsy/…) throws NOT_FOUND.
 */

import type { ConnectorProviderId } from '@mercaria/shared-types';
import { notFound } from '../lib/errors/error-codes.js';
import type { ConnectorProvider } from './types.js';
import { shopifyProvider } from './shopify/index.js';

/** The implemented providers, keyed by id. */
const PROVIDERS: Partial<Record<ConnectorProviderId, ConnectorProvider>> = {
  shopify: shopifyProvider,
};

/** Resolve a provider by id, or throw NOT_FOUND when it is not available. */
export function getConnectorProvider(id: ConnectorProviderId): ConnectorProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw notFound(`Connector provider not available: ${id}`);
  }
  return provider;
}

/** Whether a provider id is implemented (used to reject unknown route params early). */
export function isImplementedProvider(id: string): id is ConnectorProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}
