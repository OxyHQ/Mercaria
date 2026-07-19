/**
 * Shopify inbound-webhook authenticity check.
 *
 * Shopify signs every webhook with `X-Shopify-Hmac-Sha256`: the base64-encoded
 * HMAC-SHA256 of the RAW request body, keyed by the app's client secret. Verifying
 * it proves the delivery genuinely came from Shopify before we act on it, so the
 * ingress route MUST read the raw body (never let `express.json` consume it first)
 * and pass the exact bytes here. The comparison is constant-time (`verifySecret`).
 */

import { createHmac } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { getShopifyClientSecret } from './config.js';

/** The topics we register + act on. Delete ARCHIVES the mapped listing (never hard-deletes). */
export type ShopifyWebhookTopic = 'products/create' | 'products/update' | 'products/delete';

/** The product webhook topics this connector handles. */
const HANDLED_TOPICS: readonly ShopifyWebhookTopic[] = [
  'products/create',
  'products/update',
  'products/delete',
];

/** Narrow a raw `X-Shopify-Topic` header value to a topic we handle. */
export function isHandledWebhookTopic(topic: string | undefined): topic is ShopifyWebhookTopic {
  return typeof topic === 'string' && (HANDLED_TOPICS as readonly string[]).includes(topic);
}

/**
 * Verify Shopify's webhook HMAC over the RAW request body. Returns false when the
 * header is missing/empty or does not match — the caller MUST reject (401) on
 * false. `rawBody` is the exact bytes Shopify signed (a Buffer from the raw-body
 * parser); parsing/re-serializing the JSON first would change the bytes and break
 * the check.
 */
export function verifyShopifyWebhook(rawBody: Buffer, providedHmac: string | undefined): boolean {
  if (typeof providedHmac !== 'string' || providedHmac.length === 0) {
    return false;
  }
  const digest = createHmac('sha256', getShopifyClientSecret()).update(rawBody).digest('base64');
  return verifySecret(providedHmac, digest);
}
