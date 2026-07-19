/**
 * Shopify OAuth callback authenticity check.
 *
 * Shopify signs every OAuth redirect with an `hmac` computed over the remaining
 * query parameters (sorted, `key=value` joined with `&`) using the app secret.
 * Verifying it proves the callback genuinely came from Shopify before we exchange
 * the code. The comparison is constant-time (`verifySecret`).
 */

import { createHmac } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';
import { getShopifyClientSecret } from './config.js';

/** Render a query value the way it appears in Shopify's HMAC message. */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(',');
  }
  return String(value);
}

/**
 * Verify Shopify's `hmac` over the callback query. Returns false when the `hmac`
 * is missing/malformed or does not match — the caller MUST reject (401) on false.
 */
export function verifyShopifyOAuthCallback(query: Record<string, unknown>): boolean {
  const provided = query.hmac;
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${renderValue(query[key])}`)
    .join('&');
  const digest = createHmac('sha256', getShopifyClientSecret()).update(message).digest('hex');
  return verifySecret(provided, digest);
}
