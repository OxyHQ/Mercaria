/**
 * Mercaria's reader of Clarity's product feeds — the ONE importer of
 * `@clarity.surf/sdk`.
 *
 * Clarity is Oxy's one crawler of stores (Clarity `docs/product-feeds.mdx`): it
 * fetches a Shopify store's `/meta.json` and `/products.json`, or a Steam
 * market's game search, under robots.txt for its own agent and at a polite
 * pace, and keeps each source document exactly as served. Mercaria crawls
 * nothing itself any more. It registers the feed it wants (idempotent), pages
 * through the documents Clarity holds, and reads them with its OWN mapping
 * (`providers/shopify-storefront.ts`, `providers/steam-store.ts`) — so a
 * variant, a price and a `productGroupKey` mean exactly what they meant when
 * Mercaria fetched the store itself, and no source object changes identity.
 *
 * Mercaria uses Clarity's shared workload SDK factory. Oxy verifies its live
 * registered identity; external customer keys remain a separate scoped lane.
 */

import {
  ClarityClient,
  type ProductFeed,
  type ProductFeedKind,
  type ProductFeedRecordPage,
} from '@clarity.surf/sdk';
import { clarityForOxyService } from '@clarity.surf/sdk/server';
import { requiredOxyServiceClient } from '../../capabilities/oxy-service-client.js';

let client: ClarityClient | null = null;
let testFetch: typeof fetch | null = null;

function clarity(): ClarityClient {
  client ??=
    testFetch === null
      ? clarityForOxyService(requiredOxyServiceClient())
      : new ClarityClient({
          accessToken: 'test',
          fetch: testFetch,
          baseUrl: 'https://clarity.test',
        });
  return client;
}

/** Tests only: answer every Clarity request from `fetch`, or restore the real client. */
export function routeClarityFetchForTests(transport: typeof fetch | null): void {
  testFetch = transport;
  client = null;
}

/** The feed Clarity crawls for this source, registered on first ask. */
export function ensureProductFeed(
  kind: ProductFeedKind,
  identifier: string,
  label?: string,
): Promise<ProductFeed> {
  return clarity().productFeeds.register({
    kind,
    identifier,
    ...(label === undefined ? {} : { label }),
  });
}

/** One page of the documents Clarity holds for a feed, by the source's own id. */
export function productFeedRecords(
  feedId: string,
  page: { cursor?: string; limit?: number },
): Promise<ProductFeedRecordPage> {
  return clarity().productFeeds.records(feedId, page);
}

export type { ProductFeed, ProductFeedRecordPage };
