/**
 * Shopify Partner-app credentials, read from the environment AT USE.
 *
 * The real values (a registered Shopify Partner app's API key/secret + the
 * public callback URL) are a DEPLOY HANDOFF — absent locally, the connect flow
 * fails with a clear configuration error rather than crashing at import, so the
 * rest of the API boots and runs.
 */

import { validationError } from '../../lib/errors/error-codes.js';

/** Env var: Shopify app API key (a.k.a. client id). */
const CLIENT_ID_ENV = 'SHOPIFY_CLIENT_ID';
/** Env var: Shopify app API secret (used for token exchange + webhook/HMAC). */
const CLIENT_SECRET_ENV = 'SHOPIFY_CLIENT_SECRET';
/** Env var: comma/space-separated OAuth scopes to request. */
const SCOPES_ENV = 'SHOPIFY_SCOPES';
/** Default scopes when `SHOPIFY_SCOPES` is unset — read products only (Fase 1). */
const DEFAULT_SCOPES = ['read_products'];

/** Resolved Shopify app credentials. */
export interface ShopifyCredentials {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** Read a required env var or throw a clear configuration error. */
function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') {
    throw validationError(`${name} is not configured`);
  }
  return raw.trim();
}

/** Parse the configured scopes (comma/whitespace separated), defaulting when unset. */
function resolveScopes(): string[] {
  const raw = process.env[SCOPES_ENV]?.trim();
  if (!raw) {
    return [...DEFAULT_SCOPES];
  }
  const scopes = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];
}

/** The Shopify app's client credentials + requested scopes. */
export function getShopifyCredentials(): ShopifyCredentials {
  return {
    clientId: requireEnv(CLIENT_ID_ENV),
    clientSecret: requireEnv(CLIENT_SECRET_ENV),
    scopes: resolveScopes(),
  };
}

/** The Shopify app secret alone (webhook / callback HMAC verification). */
export function getShopifyClientSecret(): string {
  return requireEnv(CLIENT_SECRET_ENV);
}
