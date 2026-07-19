/**
 * Connector platform configuration read from the environment.
 *
 * These are resolved AT USE (never cached at import) with a clear, actionable
 * error when a required value is missing — mirroring `lib/connector-crypto.ts`,
 * so the process still boots (and unrelated paths run) when connectors are not
 * yet configured; only an actual connector operation fails.
 *
 * SECRETS (Shopify client id/secret) live in `shopify/config.ts`, not here.
 */

import { validationError } from '../lib/errors/error-codes.js';
import type { ConnectorProviderId } from '@mercaria/shared-types';

/** Env var: the PUBLIC base URL of this backend (used to build OAuth callbacks). */
const REDIRECT_BASE_ENV = 'CONNECTOR_OAUTH_REDIRECT_BASE_URL';
/** Env var: HMAC secret used to sign/verify the OAuth `state` CSRF token. */
const STATE_SECRET_ENV = 'CONNECTOR_OAUTH_STATE_SECRET';
/** Env var: where to send the merchant's browser after a successful connect. */
const SUCCESS_REDIRECT_ENV = 'CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL';

/** Read a required env var or throw a clear configuration error. */
function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') {
    throw validationError(`${name} is not configured`);
  }
  return raw.trim();
}

/**
 * The public callback URL the platform redirects back to for `provider`, e.g.
 * `https://api.mercaria.co/channels/oauth/shopify/callback`. Both the connect
 * route (which sends it to the platform) and the callback route (which exchanges
 * the code) build it from this ONE base so they always agree.
 */
export function getOAuthRedirectUri(provider: ConnectorProviderId): string {
  const base = requireEnv(REDIRECT_BASE_ENV).replace(/\/+$/, '');
  return `${base}/channels/oauth/${provider}/callback`;
}

/**
 * The public inbound-webhook URL the platform delivers events to for `provider`,
 * e.g. `https://api.mercaria.co/channels/webhooks/shopify`. Registered on the
 * platform at connect time and matched by the public webhook route. Built from
 * the SAME base as the OAuth callback so the two always agree.
 */
export function getWebhookAddress(provider: ConnectorProviderId): string {
  const base = requireEnv(REDIRECT_BASE_ENV).replace(/\/+$/, '');
  return `${base}/channels/webhooks/${provider}`;
}

/** The HMAC secret for the OAuth `state` token. */
export function getOAuthStateSecret(): string {
  return requireEnv(STATE_SECRET_ENV);
}

/**
 * Optional post-connect redirect (the dashboard's channels screen). When unset
 * the callback responds with a plain success page instead of redirecting.
 */
export function getOAuthSuccessRedirectUrl(): string | undefined {
  const raw = process.env[SUCCESS_REDIRECT_ENV];
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}
