/**
 * WooCommerce inbound-webhook authenticity check + topic classification.
 *
 * WooCommerce signs every delivery with `X-WC-Webhook-Signature`: the base64-encoded
 * HMAC-SHA256 of the RAW request body, keyed by the webhook's `secret`. Unlike
 * Shopify (one app-wide secret), a WooCommerce webhook's secret is chosen PER webhook
 * at registration, so it is a `per_connection` secret: the connector generates one
 * secret per `Connection`, sets it on every webhook it creates for that connection,
 * and stores it (encrypted) on the `Connection`. The ingress route resolves the
 * connection (by the `:connectionId` in the delivery URL), decrypts its stored secret,
 * and verifies with it here. The comparison is constant-time (`verifySecret`).
 */

import { createHmac } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import type { WebhookEventKind } from '../types.js';

/**
 * The WooCommerce webhook topics we register + act on. WooCommerce topics are
 * `{resource}.{event}` (dot-delimited). Product `deleted` ARCHIVES the mapped
 * listing (never hard-deletes); `restored` re-imports it. Order `created`/`updated`
 * upsert the mapped Mercaria order idempotently (never duplicate).
 */
export type WooCommerceWebhookTopic =
  | 'product.created'
  | 'product.updated'
  | 'product.deleted'
  | 'product.restored'
  | 'order.created'
  | 'order.updated';

/** The webhook topics this connector handles (product + order sync). */
const HANDLED_TOPICS: readonly WooCommerceWebhookTopic[] = [
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
  'order.created',
  'order.updated',
];

/**
 * The topics REGISTERED on connect. WooCommerce has no dedicated inventory webhook —
 * a stock change fires `product.updated`, so inventory stays fresh through the product
 * upsert path + the scheduled inventory reconcile. `product.restored` is handled if it
 * arrives but is not registered (a restore also fires `product.updated`).
 */
export const REGISTERED_WEBHOOK_TOPICS: readonly WooCommerceWebhookTopic[] = [
  'product.created',
  'product.updated',
  'product.deleted',
  'order.created',
  'order.updated',
];

/** Narrow a raw `X-WC-Webhook-Topic` header value to a topic we handle. */
export function isHandledWooCommerceWebhookTopic(
  topic: string | undefined,
): topic is WooCommerceWebhookTopic {
  return typeof topic === 'string' && (HANDLED_TOPICS as readonly string[]).includes(topic);
}

/**
 * Map a raw WooCommerce webhook topic to its provider-neutral {@link WebhookEventKind},
 * or `undefined` when it is not a topic the sync engine acts on. This is the
 * WooCommerce half of the provider-aware dispatch (mirrors `classifyShopifyWebhookTopic`).
 */
export function classifyWooCommerceWebhookTopic(topic: string): WebhookEventKind | undefined {
  switch (topic) {
    case 'product.created':
    case 'product.updated':
    case 'product.restored':
      return 'product_upsert';
    case 'product.deleted':
      return 'product_delete';
    case 'order.created':
    case 'order.updated':
      return 'order_upsert';
    default:
      return undefined;
  }
}

/**
 * Verify WooCommerce's webhook HMAC over the RAW request body, keyed by the
 * connection's stored webhook `secret`. Returns false when the header is
 * missing/empty or does not match — the caller MUST reject (401) on false.
 * `rawBody` is the exact bytes WooCommerce signed (a Buffer from the raw-body
 * parser); parsing/re-serializing the JSON first would change the bytes and break
 * the check.
 */
export function verifyWooCommerceWebhook(
  rawBody: Buffer,
  providedSignature: string | undefined,
  secret: string,
): boolean {
  if (typeof providedSignature !== 'string' || providedSignature.length === 0) {
    return false;
  }
  if (secret.length === 0) {
    return false;
  }
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');
  return verifySecret(providedSignature, digest);
}
