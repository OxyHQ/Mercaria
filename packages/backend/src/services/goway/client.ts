/**
 * The backend's one GoWay client.
 *
 * Built lazily from `config.goway` and never with an access token: every read
 * Mercaria makes is a PUBLIC one — the same a signed-out shopper's browser
 * could make — so there is no credential to hold, leak or rotate, and GoWay's
 * own CORS and authorization rules do the work for writes, which only the
 * merchant's dashboard makes, with the merchant's session (ADR 0013).
 *
 * `null` when `GOWAY_API_URL` is unset. Every caller treats that exactly like
 * an outage — `unavailable`, which fails a collection closed — and the two
 * levers that need GoWay refuse to turn on without it (`config/index.ts`).
 */

import { createGoWayClient, type GoWayClient, type GoWayFetch } from '@goway.to/sdk';
import { config } from '../../config/index.js';

let client: GoWayClient | null = null;
let testTransport: { apiBaseUrl: string; fetch: GoWayFetch } | null = null;

/** The client, or `null` when this deployment has no GoWay configured. */
export function goWayClient(): GoWayClient | null {
  if (client) return client;
  const apiBaseUrl = testTransport?.apiBaseUrl ?? config.goway.apiUrl;
  if (apiBaseUrl === '') return null;
  client = createGoWayClient({
    apiBaseUrl,
    timeoutMs: config.goway.timeoutMs,
    ...(testTransport === null ? {} : { fetch: testTransport.fetch }),
  });
  return client;
}

/**
 * Tests only: send every GoWay request through `fetch` against `apiBaseUrl`,
 * or restore the configured client with `null`.
 *
 * The SDK takes a custom `fetch`, which is the whole seam a fake GoWay needs:
 * the real SDK still builds every URL, validates every request and parses every
 * response with GoWay's own contract.
 */
export function useGoWayTransportForTests(transport: { apiBaseUrl: string; fetch: GoWayFetch } | null): void {
  testTransport = transport;
  client = null;
}
