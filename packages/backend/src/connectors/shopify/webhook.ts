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
import type { WebhookEventKind } from '../types.js';
import { getShopifyClientSecret } from './config.js';

/**
 * The topics we register + act on. Product `delete` ARCHIVES the mapped listing
 * (never hard-deletes). Order `create`/`updated` upsert the mapped Mercaria order
 * idempotently (never duplicate).
 */
export type ShopifyWebhookTopic =
  | 'products/create'
  | 'products/update'
  | 'products/delete'
  | 'orders/create'
  | 'orders/updated'
  | 'inventory_levels/update';

/** The webhook topics this connector handles (product + order + inventory sync). */
const HANDLED_TOPICS: readonly ShopifyWebhookTopic[] = [
  'products/create',
  'products/update',
  'products/delete',
  'orders/create',
  'orders/updated',
  'inventory_levels/update',
];

/** Narrow a raw `X-Shopify-Topic` header value to a topic we handle. */
export function isHandledWebhookTopic(topic: string | undefined): topic is ShopifyWebhookTopic {
  return typeof topic === 'string' && (HANDLED_TOPICS as readonly string[]).includes(topic);
}

/**
 * Map a raw Shopify webhook topic to its provider-neutral {@link WebhookEventKind},
 * or `undefined` when it is not a topic the sync engine acts on. This is what makes
 * the dispatcher provider-aware — Shopify's slash-delimited topics and WooCommerce's
 * dot-delimited topics resolve to the SAME canonical kinds.
 */
export function classifyShopifyWebhookTopic(topic: string): WebhookEventKind | undefined {
  switch (topic) {
    case 'products/create':
    case 'products/update':
      return 'product_upsert';
    case 'products/delete':
      return 'product_delete';
    case 'orders/create':
    case 'orders/updated':
      return 'order_upsert';
    case 'inventory_levels/update':
      return 'inventory_update';
    default:
      return undefined;
  }
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
