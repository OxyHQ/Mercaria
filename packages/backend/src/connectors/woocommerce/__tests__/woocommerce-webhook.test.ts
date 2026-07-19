/**
 * Unit tests for WooCommerce inbound-webhook authenticity + topic classification.
 * WooCommerce signs each delivery with `X-WC-Webhook-Signature` = base64(HMAC-SHA256(
 * rawBody, per-connection secret)). No network, no DB. Asserts a genuine signature
 * verifies, a tampered body / wrong secret / missing header / empty secret is rejected
 * (so the ingress route returns 401), the handled-topic guard, and that the raw
 * dot-delimited topics classify to the provider-neutral kinds.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWooCommerceWebhook,
  isHandledWooCommerceWebhookTopic,
  classifyWooCommerceWebhookTopic,
} from '../webhook.js';

const SECRET = 'wc_conn_secret_0123456789abcdef';

/** The base64 HMAC-SHA256 WooCommerce sends in `X-WC-Webhook-Signature`. */
function sign(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifyWooCommerceWebhook', () => {
  it('accepts a body signed with the connection secret', () => {
    const body = Buffer.from(JSON.stringify({ id: 727, status: 'processing' }), 'utf8');
    expect(verifyWooCommerceWebhook(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects when the body is tampered with after signing', () => {
    const original = Buffer.from(JSON.stringify({ id: 727 }), 'utf8');
    const signature = sign(original);
    const tampered = Buffer.from(JSON.stringify({ id: 999 }), 'utf8');
    expect(verifyWooCommerceWebhook(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyWooCommerceWebhook(body, sign(body, 'another-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing / empty signature header', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyWooCommerceWebhook(body, undefined, SECRET)).toBe(false);
    expect(verifyWooCommerceWebhook(body, '', SECRET)).toBe(false);
  });

  it('rejects when the stored secret is empty (no secret ⇒ never authentic)', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyWooCommerceWebhook(body, sign(body, ''), '')).toBe(false);
  });
});

describe('isHandledWooCommerceWebhookTopic', () => {
  it('accepts the product + order topics we act on', () => {
    for (const topic of [
      'product.created',
      'product.updated',
      'product.deleted',
      'product.restored',
      'order.created',
      'order.updated',
    ]) {
      expect(isHandledWooCommerceWebhookTopic(topic)).toBe(true);
    }
  });

  it('rejects unhandled or missing topics', () => {
    expect(isHandledWooCommerceWebhookTopic('coupon.created')).toBe(false);
    expect(isHandledWooCommerceWebhookTopic('order.deleted')).toBe(false);
    expect(isHandledWooCommerceWebhookTopic(undefined)).toBe(false);
  });
});

describe('classifyWooCommerceWebhookTopic', () => {
  it('maps dot-delimited topics to the provider-neutral kinds', () => {
    expect(classifyWooCommerceWebhookTopic('product.created')).toBe('product_upsert');
    expect(classifyWooCommerceWebhookTopic('product.updated')).toBe('product_upsert');
    expect(classifyWooCommerceWebhookTopic('product.restored')).toBe('product_upsert');
    expect(classifyWooCommerceWebhookTopic('product.deleted')).toBe('product_delete');
    expect(classifyWooCommerceWebhookTopic('order.created')).toBe('order_upsert');
    expect(classifyWooCommerceWebhookTopic('order.updated')).toBe('order_upsert');
    expect(classifyWooCommerceWebhookTopic('coupon.created')).toBeUndefined();
  });
});
