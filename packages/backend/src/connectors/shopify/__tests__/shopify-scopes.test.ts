/**
 * The Shopify default scope set, and the derivation it has to satisfy (#218).
 *
 * ## What this gate catches, and why a comment could not
 *
 * `SHOPIFY_SCOPES` defaulted to `['read_products']` while `registerWebhooks`
 * subscribed order and inventory topics unconditionally. Shopify gates
 * `POST /webhooks.json` on the READ scope of the topic being subscribed, so the
 * DEFAULT deployment registered three product topics and was refused the other
 * three — which is #218's partial registration, arrived at by configuration
 * rather than by anything going wrong. Nothing failed a build, nothing failed a
 * test, and a merchant saw a connected channel.
 *
 * So the two halves are pinned against each other: the topics the connector
 * registers and the endpoints its declared capabilities call, against the scope
 * set a deployment gets when it configures none. `WEBHOOK_TOPIC_SCOPES` lives in
 * the provider, beside the topics, so adding a topic without deciding its scope
 * is already a `tsc` failure — this file is what fails when the scope is decided
 * and the DEFAULT is not widened to include it.
 *
 * ## The endpoint table is the runbook's, not a re-derivation
 *
 * `docs/runbooks/connector-real-store-verification.md` §3.1 tabulates every
 * endpoint the connector calls against the scope Shopify requires for it, and
 * §3.2 is the string that follows. Restating the mapping from memory here would
 * make this a second description of a fact somebody already established against
 * Shopify's own documentation — so what is encoded below is that table, keyed on
 * the CAPABILITY that reaches each endpoint, so a capability the provider stops
 * declaring stops demanding its scopes.
 */

import { describe, expect, it } from 'vitest';
import { SHOPIFY_DEFAULT_SCOPES } from '../config.js';
import { shopifyProvider, SHOPIFY_WEBHOOK_TOPICS, WEBHOOK_TOPIC_SCOPES } from '../index.js';

/**
 * Runbook §3.1, as data: the scopes each shipped capability's endpoints need.
 *
 * `pull` is not a declared capability — every provider pulls, which is what a
 * connector IS — so it is the unconditional row.
 */
const ENDPOINT_SCOPES = {
  /** `GET /products.json`, `/collects.json`, `/smart_collections.json`. */
  pull: ['read_products'],
  /** `GET /orders.json`. */
  pullOrders: ['read_orders'],
  /** `GET /inventory_levels.json` — Shopify gates the location join separately. */
  pullInventory: ['read_inventory', 'read_locations'],
  /** `POST /products.json`, `PUT /products/{id}.json`. */
  pushesProducts: ['write_products'],
  /** `GET /orders/{id}/fulfillment_orders.json`, `POST /fulfillments.json`. */
  pushesFulfillment: [
    'read_merchant_managed_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
  ],
} as const;

describe('the Shopify default scopes cover what the connector actually calls', () => {
  it('names a scope for EVERY topic it registers', () => {
    // The vacuity floor: an empty topic list would satisfy every assertion below
    // by having nothing to check, and a topic map that lost its keys would too.
    expect(SHOPIFY_WEBHOOK_TOPICS.length).toBeGreaterThanOrEqual(6);
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(WEBHOOK_TOPIC_SCOPES[topic], `${topic} has no scope`).toBeTruthy();
    }
    expect(Object.keys(WEBHOOK_TOPIC_SCOPES).sort()).toEqual([...SHOPIFY_WEBHOOK_TOPICS].sort());
  });

  it('DEFAULTS to a scope set covering every registered topic', () => {
    // The exact failure #218 lands in: `read_products` alone, three topics
    // refused, three subscriptions created and their ids discarded.
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(
        SHOPIFY_DEFAULT_SCOPES,
        `the default scope set cannot subscribe ${topic}`,
      ).toContain(WEBHOOK_TOPIC_SCOPES[topic]);
    }
  });

  it('DEFAULTS to a scope set covering every endpoint a DECLARED capability calls', () => {
    const required = [
      ...ENDPOINT_SCOPES.pull,
      ...ENDPOINT_SCOPES.pullOrders,
      ...ENDPOINT_SCOPES.pullInventory,
      ...(shopifyProvider.capabilities.pushesProducts ? ENDPOINT_SCOPES.pushesProducts : []),
      ...(shopifyProvider.capabilities.pushesFulfillment ? ENDPOINT_SCOPES.pushesFulfillment : []),
    ];
    // The premise, asserted rather than assumed: with both capabilities false
    // this case would be checking three scopes and still passing.
    expect(shopifyProvider.capabilities.pushesProducts).toBe(true);
    expect(shopifyProvider.capabilities.pushesFulfillment).toBe(true);
    for (const scope of required) {
      expect(SHOPIFY_DEFAULT_SCOPES, `the default scope set omits ${scope}`).toContain(scope);
    }
  });

  it('requests NOTHING it cannot point at an endpoint or a topic', () => {
    // The other direction, and the one that keeps this honest: a default asking
    // for `write_orders` or `read_customers` is a merchant granting Mercaria
    // powers no shipped code uses, on a consent screen they read once.
    const justified = new Set<string>([
      ...Object.values(WEBHOOK_TOPIC_SCOPES),
      ...Object.values(ENDPOINT_SCOPES).flat(),
    ]);
    for (const scope of SHOPIFY_DEFAULT_SCOPES) {
      expect(justified, `${scope} is requested by default and nothing calls it`).toContain(scope);
    }
  });
});
