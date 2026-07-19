/**
 * Unit tests for Shopify inbound-webhook authenticity — the HMAC over the RAW
 * request body keyed by the app secret. No network, no DB. Asserts a genuine
 * signature verifies, and a tampered body / wrong secret / missing header is
 * rejected (so the ingress route returns 401), plus the handled-topic guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyShopifyWebhook, isHandledWebhookTopic } from '../webhook.js';

const ENV_VAR = 'SHOPIFY_CLIENT_SECRET';
const SECRET = 'shpss_test_secret_0123456789abcdef';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_VAR];
  process.env[ENV_VAR] = SECRET;
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = saved;
  }
});

/** The base64 HMAC-SHA256 Shopify sends in `X-Shopify-Hmac-Sha256`. */
function sign(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifyShopifyWebhook', () => {
  it('accepts a body signed with the app secret', () => {
    const body = Buffer.from(JSON.stringify({ id: 123, title: 'Roasted Coffee' }), 'utf8');
    expect(verifyShopifyWebhook(body, sign(body))).toBe(true);
  });

  it('rejects when the body is tampered with after signing', () => {
    const original = Buffer.from(JSON.stringify({ id: 123 }), 'utf8');
    const hmac = sign(original);
    const tampered = Buffer.from(JSON.stringify({ id: 999 }), 'utf8');
    expect(verifyShopifyWebhook(tampered, hmac)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyShopifyWebhook(body, sign(body, 'a-different-secret'))).toBe(false);
  });

  it('rejects a missing or empty HMAC header', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyShopifyWebhook(body, undefined)).toBe(false);
    expect(verifyShopifyWebhook(body, '')).toBe(false);
  });

  it('rejects a garbage HMAC header', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyShopifyWebhook(body, 'not-a-real-hmac')).toBe(false);
  });
});

describe('isHandledWebhookTopic', () => {
  it('accepts the product topics we register + act on', () => {
    expect(isHandledWebhookTopic('products/create')).toBe(true);
    expect(isHandledWebhookTopic('products/update')).toBe(true);
    expect(isHandledWebhookTopic('products/delete')).toBe(true);
  });

  it('rejects unhandled or missing topics', () => {
    expect(isHandledWebhookTopic('orders/create')).toBe(false);
    expect(isHandledWebhookTopic('app/uninstalled')).toBe(false);
    expect(isHandledWebhookTopic(undefined)).toBe(false);
  });
});
