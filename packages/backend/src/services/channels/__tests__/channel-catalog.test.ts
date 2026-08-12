/**
 * The channel catalog (#87), and the one property that makes it worth having:
 * **it cannot claim a capability the provider refuses.**
 *
 * The catalog is what a merchant reads before choosing how to supply their
 * products, so a descriptor saying WooCommerce publishes products back is not a
 * cosmetic error — it is a sync a merchant configures, waits for, and eventually
 * reports as broken. Before #87 that claim lived in the dashboard as a
 * hard-coded table; now it is derived from `ConnectorProvider.capabilities`,
 * which the #69 contract suite measures both branches of.
 *
 * These cases pin the derivation. The contract suite pins the declaration.
 * Neither is sufficient alone: the suite would go green on a correct provider
 * whose catalog entry said something else, and these would go green on a catalog
 * faithfully reporting a declaration that had stopped being true.
 */

import { describe, expect, it } from 'vitest';
import { channelSupportsDirection, CHANNEL_TYPE_IDS } from '@mercaria/shared-types';
import { shopifyProvider } from '../../../connectors/shopify/index.js';
import { wooCommerceProvider } from '../../../connectors/woocommerce/index.js';
import {
  activationBlockingLimitations,
  channelTypeForConnection,
  describeChannel,
  isChannelTypeId,
  listChannelTypes,
  providerForChannelType,
} from '../channel-catalog.js';

describe('the catalog reads the provider rather than restating it', () => {
  it('gives Shopify a push direction because Shopify implements one', () => {
    // The premise, asserted rather than assumed: if this declaration ever flips,
    // the assertion below stops meaning what it says and this case says so.
    expect(shopifyProvider.capabilities.pushesProducts).toBe(true);

    const descriptor = describeChannel('shopify');
    expect(descriptor.resources.products).toContain('push');
    expect(channelSupportsDirection(descriptor.resources, 'products', 'bidirectional')).toBe(true);
  });

  it('withholds a push direction from WooCommerce because WooCommerce implements none', () => {
    expect(wooCommerceProvider.capabilities.pushesProducts).toBe(false);

    const descriptor = describeChannel('woocommerce');
    expect(descriptor.resources.products).not.toContain('push');
    // The direction a settings form may offer, and the one it may not.
    expect(channelSupportsDirection(descriptor.resources, 'products', 'pull')).toBe(true);
    expect(channelSupportsDirection(descriptor.resources, 'products', 'push')).toBe(false);
    expect(channelSupportsDirection(descriptor.resources, 'products', 'bidirectional')).toBe(false);
    // `off` is always available — turning a resource off is not a capability.
    expect(channelSupportsDirection(descriptor.resources, 'products', 'off')).toBe(true);
  });

  it('names the missing capability as a limitation as well as an absent direction', () => {
    // Two different questions: what a form may offer, and what a merchant should
    // know before choosing the channel. A merchant who sees only the absence
    // concludes the option is coming soon.
    const codes = describeChannel('woocommerce').limitations.map(
      (limitation) => limitation.code,
    );
    expect(codes).toContain('no_product_push');
    expect(codes).toContain('no_fulfilment_push');
    expect(codes).toContain('no_inventory_webhook');
  });
});

describe('the open defects #69 filed are surfaced, not hidden', () => {
  it('carries each one with its issue number, and drops the ones that are fixed', () => {
    // The coordinator's instruction on this issue in so many words: where
    // onboarding would walk a merchant into a known defect, say so and reference
    // the issue.
    //
    // The EXACT set, not a `toContain`: a list that only ever grows is a wizard
    // warning about problems somebody fixed, which is the cry-wolf failure one
    // step further on — and it is the direction this list will drift, because
    // adding an entry is somebody's diligence and removing one is somebody
    // remembering. #218's entry went with the fix; #219, #220 and #221 stand.
    const limitations = describeChannel('woocommerce').limitations;
    const byIssue = new Map(
      limitations
        .filter((limitation) => limitation.openIssue !== undefined)
        .map((limitation) => [limitation.openIssue, limitation]),
    );

    expect([...byIssue.keys()].sort()).toEqual([219, 220, 221]);
    expect(
      limitations.map((limitation) => limitation.code),
      'a fixed defect must not be reported to a merchant',
    ).not.toContain('webhook_registration_not_atomic');
    for (const limitation of byIssue.values()) {
      expect(limitation.severity).toBe('degrades');
      // The summary says what the MERCHANT will observe. A summary describing
      // the code ("registerWebhooks discards its ids") is one nobody can act on.
      expect(limitation.summary.length).toBeGreaterThan(40);
    }
  });

  it('does not attach them to Shopify', () => {
    // All four are WooCommerce's. Attaching them everywhere would be the
    // cry-wolf failure — a warning on every channel is a warning on none.
    const shopify = describeChannel('shopify').limitations;
    expect(shopify.filter((limitation) => limitation.openIssue !== undefined)).toEqual([]);
  });
});

describe('native checkout support', () => {
  it('is true for connectors and the native catalogue, false for a feed', () => {
    // A connector writes NATIVE listings the store owns. A feed produces
    // EXTERNAL offers, which `offers_kind_shape_check` forbids from carrying a
    // `product_variant_id` — so there is no id a cart line could hold, and this
    // field is that structural fact surfaced rather than a policy choice.
    expect(describeChannel('shopify').supportsNativeCheckout).toBe(true);
    expect(describeChannel('woocommerce').supportsNativeCheckout).toBe(true);
    expect(describeChannel('woocommerce_plugin').supportsNativeCheckout).toBe(true);
    expect(describeChannel('native').supportsNativeCheckout).toBe(true);
    expect(describeChannel('product_feed').supportsNativeCheckout).toBe(false);
  });

  it('says so in a limitation a merchant can read', () => {
    const feed = describeChannel('product_feed');
    expect(feed.limitations.map((limitation) => limitation.code)).toContain(
      'external_offers_only',
    );
    expect(feed.resources.orders).toEqual([]);
    expect(feed.resources.inventory).toEqual([]);
  });
});

describe('a channel TYPE is broader than a connector provider id', () => {
  it('maps the two WooCommerce channels onto one provider', () => {
    expect(providerForChannelType('woocommerce')).toBe('woocommerce');
    expect(providerForChannelType('woocommerce_plugin')).toBe('woocommerce');
    // And the two feed-shaped members have no provider at all, which is the
    // whole reason the catalog is not keyed on `ConnectorProviderId`.
    expect(providerForChannelType('product_feed')).toBeUndefined();
    expect(providerForChannelType('native')).toBeUndefined();
  });

  it('reads a stored connection as the right channel type', () => {
    // `connections` distinguishes the pull connector from the plugin by `mode`
    // alone — they share `provider = 'woocommerce'` and the unique index on
    // `(store_id, provider)`.
    expect(channelTypeForConnection({ provider: 'woocommerce', mode: 'pull' })).toBe('woocommerce');
    expect(channelTypeForConnection({ provider: 'woocommerce', mode: 'push_in' })).toBe(
      'woocommerce_plugin',
    );
    expect(channelTypeForConnection({ provider: 'shopify', mode: 'pull' })).toBe('shopify');
  });

  it('recognizes exactly the members of the tuple', () => {
    for (const id of CHANNEL_TYPE_IDS) {
      expect(isChannelTypeId(id)).toBe(true);
    }
    expect(isChannelTypeId('bigcommerce')).toBe(false);
    expect(isChannelTypeId('')).toBe(false);
  });
});

describe('the list a merchant reads', () => {
  it('covers every channel type exactly once', () => {
    // A vacuity floor on the catalog itself: a `listChannelTypes` that silently
    // dropped a member would produce a shorter, entirely plausible list.
    const listed = listChannelTypes();
    expect(listed).toHaveLength(CHANNEL_TYPE_IDS.length);
    expect(new Set(listed.map((entry) => entry.channelType)).size).toBe(CHANNEL_TYPE_IDS.length);
  });

  it('leads with what can actually be done', () => {
    const listed = listChannelTypes();
    const rank = { available: 0, not_configured: 1, not_implemented: 2 } as const;
    for (let index = 1; index < listed.length; index += 1) {
      expect(rank[listed[index].availability]).toBeGreaterThanOrEqual(
        rank[listed[index - 1].availability],
      );
    }
  });

  it('marks an unbuilt connector as blocking, and nothing else', () => {
    // `blocks_activation` is the only severity the onboarding gate reads, so it
    // must mean "no merchant can get past this" rather than "this is bad".
    expect(activationBlockingLimitations('etsy').map((limitation) => limitation.code)).toEqual([
      'not_implemented',
    ]);
    expect(activationBlockingLimitations('shopify')).toEqual([]);
    expect(activationBlockingLimitations('woocommerce')).toEqual([]);
    expect(activationBlockingLimitations('product_feed')).toEqual([]);
  });

  it('reports an unconfigured deployment as unconfigured, not unbuilt', () => {
    // Two different messages and two different remedies: `not_implemented` is
    // "Mercaria has not built this", `not_configured` is "this deployment has
    // not been given credentials". Telling a merchant the first when the second
    // is true sends them to support with the wrong question.
    //
    // Shopify's availability depends on env this suite does not set, so the
    // assertion is on the DISCRIMINATION rather than on a particular value.
    const shopify = describeChannel('shopify');
    expect(shopify.availability).not.toBe('not_implemented');
    expect(describeChannel('etsy').availability).toBe('not_implemented');
    expect(describeChannel('native').availability).toBe('available');
  });
});
