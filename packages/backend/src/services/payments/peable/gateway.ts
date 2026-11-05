/**
 * The one Peable client the marketplace's non-payment calls share — seller
 * accounts and the event handlers that re-read the gateway.
 *
 * Built on first use from `createPeableClient()` (the one module that reaches
 * the gateway, which suites replace with the fake gateway), so a deployment
 * without the rail never builds it. `PeablePaymentProvider` holds its own
 * instance from the same factory.
 */

import type { Peable } from '@peable.to/sdk';
import { createPeableClient } from './client.js';

let client: Peable | undefined;

export function peableGateway(): Peable {
  client ??= createPeableClient();
  return client;
}
