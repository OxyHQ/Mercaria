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
/**
 * The scopes the connector needs when `SHOPIFY_SCOPES` is unset.
 *
 * It was `['read_products']` and that was the configuration #218 lands in: the
 * connector registers order and inventory webhook topics unconditionally, and
 * Shopify gates `POST /webhooks.json` on the READ scope of the topic — so the
 * DEFAULT deployment registered three product topics, was refused the other
 * three, and (before #218's fix) discarded the three ids it had just created.
 * A partial registration reported as a working connection is not graceful
 * degradation; it is a merchant told their channel is connected while half its
 * events silently never arrive.
 *
 * Every member is here because an endpoint the connector CALLS needs it, and
 * the list is `docs/runbooks/connector-real-store-verification.md` §3.2 rather
 * than a re-derivation: §3.1 tabulates every endpoint against its scope, and
 * `__tests__/shopify-scopes.test.ts` asserts this default still covers both the
 * registered webhook topics (`WEBHOOK_TOPIC_SCOPES`) and the endpoints behind
 * each declared capability.
 *
 * It requests MORE than a pull-only merchant strictly needs, and that is the
 * deliberate half: `pushProduct` and `pushFulfillment` are shipped capabilities
 * the merchant can switch on per resource at any time, and a scope Shopify did
 * not grant at install can only be added by re-authorizing — so withholding
 * them turns a settings toggle into a reconnect. A merchant who wants a
 * narrower grant sets `SHOPIFY_SCOPES` explicitly.
 *
 * ## `read_all_orders` is ABSENT on purpose — do not add it (#287)
 *
 * `read_orders` alone bounds `GET /orders.json` to the last 60 DAYS (Shopify's
 * Order reference: "Only the last 60 days' worth of orders from a store are
 * accessible from the Order resource by default"). The bound is stated at the
 * call site in `index.ts` `fetchOrders`, because a truncated import reaches
 * `completed` with consistent tallies and looks exactly like a complete one.
 *
 * Reaching further needs `read_all_orders`, and adding it HERE is the one edit
 * that breaks every connect on every deployment: Shopify grants it only on
 * written approval per app, and refuses the WHOLE grant rather than narrowing
 * it when an unapproved scope is requested. So it is an operator decision
 * recorded against a specific approved app — set `SHOPIFY_SCOPES` explicitly on
 * that deployment — and never a code default.
 */
const DEFAULT_SCOPES = [
  'read_products',
  'write_products',
  'read_orders',
  'read_inventory',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
];

/**
 * The scopes a deployment gets when it configures none.
 *
 * Exported for the gate in `__tests__/shopify-scopes.test.ts`, which is the
 * thing that fails when a topic or an endpoint is added without its scope. It is
 * a copy the test could not make for itself: reading the default through
 * `getShopifyCredentials()` would require the env to be unset, which a suite
 * that sets `SHOPIFY_CLIENT_ID` cannot rely on.
 */
export const SHOPIFY_DEFAULT_SCOPES: readonly string[] = DEFAULT_SCOPES;

/**
 * The scope that lifts the order window, named once (#380).
 *
 * Read by `shopifyProvider.orderHistoryHorizon` to decide whether a CONNECTION's
 * grant reaches past the window, and by `shopify-scopes.test.ts` to assert it
 * stays out of {@link SHOPIFY_DEFAULT_SCOPES}. A literal in either place would be
 * a second spelling of one platform fact.
 */
export const SHOPIFY_ALL_ORDERS_SCOPE = 'read_all_orders';

/**
 * How far `GET /orders.json` reaches without {@link SHOPIFY_ALL_ORDERS_SCOPE}.
 *
 * Shopify's Order reference: "Only the last 60 days' worth of orders from a
 * store are accessible from the Order resource by default." A ROLLING window, so
 * an order older than this was never imported and never will be — it is not a
 * backfill that has yet to run.
 */
export const SHOPIFY_ORDER_WINDOW_DAYS_WITHOUT_ALL_ORDERS = 60;

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

/**
 * Whether this deployment has Shopify app credentials at all — asked, not
 * caught.
 *
 * #87's channel catalog needs to say "Shopify cannot be connected on this
 * deployment" without starting a flow, and calling `getShopifyCredentials()` in
 * a `try` to find out would make a configuration question look like an error
 * path. Both halves are required because the exchange needs both.
 */
export function hasShopifyCredentials(): boolean {
  return (
    (process.env[CLIENT_ID_ENV]?.trim() ?? '') !== '' &&
    (process.env[CLIENT_SECRET_ENV]?.trim() ?? '') !== ''
  );
}
