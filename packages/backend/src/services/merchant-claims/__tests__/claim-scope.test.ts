/**
 * The scope rules (#83), tested where they live — as a pure function.
 *
 * Each `describe` below is one of the issue's numbered scope rules, and the
 * fixtures are chosen so a WRONG implementation of that rule fails: a
 * substring domain match, a proof that sweeps up every storefront of a
 * merchant, and a proof that reaches another merchant's channel are each given
 * a case that would pass under the mistake and fails here.
 */

import { describe, expect, it } from 'vitest';
import {
  domainIsCoveredBy,
  resolveProvenScope,
  type ClaimProofSubject,
  type ScopeStorefrontFacts,
} from '../claim-scope.js';

const MERCHANT = 'merchant-apple';
const OTHER_MERCHANT = 'merchant-someone-else';

/** A storefront projection with sane defaults, overridden per case. */
function storefront(overrides: Partial<ScopeStorefrontFacts> & { id: string }): ScopeStorefrontFacts {
  return {
    merchantId: MERCHANT,
    provider: null,
    externalShopId: null,
    domain: null,
    ...overrides,
  };
}

describe('scope rule 1 — domain control proves THAT domain', () => {
  it('covers the proven host and its subdomains', () => {
    expect(domainIsCoveredBy('apple.com', 'apple.com')).toBe(true);
    expect(domainIsCoveredBy('store.apple.com', 'apple.com')).toBe(true);
    expect(domainIsCoveredBy('www.store.apple.com', 'apple.com')).toBe(true);
  });

  it('does NOT cover a domain that merely ends with the proven string', () => {
    // The case a substring match gets wrong. `notapple.com` ends with
    // `apple.com` textually and is a different registrable domain entirely.
    expect(domainIsCoveredBy('notapple.com', 'apple.com')).toBe(false);
    expect(domainIsCoveredBy('evilapple.com', 'apple.com')).toBe(false);
  });

  it('does NOT cover a similarly named domain (the issue’s own example)', () => {
    expect(domainIsCoveredBy('apple-store-madrid.example', 'apple.com')).toBe(false);
    // And not the other way round either: proving the lookalike proves nothing
    // about the real one, which is the direction that would matter.
    expect(domainIsCoveredBy('apple.com', 'apple-store-madrid.example')).toBe(false);
  });

  it('does not treat a parent as covered by its own subdomain', () => {
    expect(domainIsCoveredBy('apple.com', 'store.apple.com')).toBe(false);
  });

  it('verifies a requested domain scope only when the proof reaches it', () => {
    const proof: ClaimProofSubject = { kind: 'domain', domain: 'apple.com' };
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [
        { kind: 'merchant', ref: MERCHANT },
        { kind: 'domain', ref: 'store.apple.com' },
        { kind: 'domain', ref: 'apple-store-madrid.example' },
      ],
      proof,
      storefronts: [],
    });
    expect(resolved).toEqual([
      { kind: 'merchant', ref: MERCHANT, state: 'verified' },
      { kind: 'domain', ref: 'store.apple.com', state: 'verified' },
      { kind: 'domain', ref: 'apple-store-madrid.example', state: 'out_of_scope' },
    ]);
  });
});

describe('scope rule 2 — a platform account proves that shop, not every brand', () => {
  const proof: ClaimProofSubject = {
    kind: 'platform_connection',
    provider: 'shopify',
    externalShopId: 'shop-1',
    shopDomain: 'shop-one.myshopify.com',
  };

  it('covers the storefront with the SAME source identity', () => {
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [{ kind: 'storefront', ref: 'sf-same' }],
      proof,
      storefronts: [
        storefront({ id: 'sf-same', provider: 'shopify', externalShopId: 'shop-1' }),
      ],
    });
    expect(resolved[0]?.state).toBe('verified');
  });

  it('does NOT cover the merchant’s OTHER channels', () => {
    // The mistake this catches: treating "this claimant runs a Shopify shop
    // for this merchant" as evidence about the merchant's Amazon presence and
    // its second Shopify store.
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [
        { kind: 'storefront', ref: 'sf-amazon' },
        { kind: 'storefront', ref: 'sf-other-shop' },
      ],
      proof,
      storefronts: [
        storefront({ id: 'sf-amazon', provider: 'amazon', externalShopId: 'seller-9' }),
        storefront({ id: 'sf-other-shop', provider: 'shopify', externalShopId: 'shop-2' }),
      ],
    });
    expect(resolved.map((entry) => entry.state)).toEqual(['out_of_scope', 'out_of_scope']);
  });

  it('covers a channel on the shop’s own host, and not one on a different host', () => {
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [
        { kind: 'storefront', ref: 'sf-host' },
        { kind: 'storefront', ref: 'sf-elsewhere' },
      ],
      proof,
      storefronts: [
        storefront({ id: 'sf-host', domain: 'shop-one.myshopify.com' }),
        storefront({ id: 'sf-elsewhere', domain: 'shop-two.myshopify.com' }),
      ],
    });
    expect(resolved.map((entry) => entry.state)).toEqual(['verified', 'out_of_scope']);
  });

  it('never infers a domain a connection does not report', () => {
    const domainless: ClaimProofSubject = {
      kind: 'platform_connection',
      provider: 'woocommerce',
      externalShopId: 'site-7',
      shopDomain: null,
    };
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [{ kind: 'domain', ref: 'example.com' }],
      proof: domainless,
      storefronts: [],
    });
    expect(resolved[0]?.state).toBe('out_of_scope');
  });
});

describe('scope rule 4 — one storefront may be covered while others stay unclaimed', () => {
  it('partitions the requested set instead of collapsing to one verdict', () => {
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [
        { kind: 'merchant', ref: MERCHANT },
        { kind: 'storefront', ref: 'sf-es' },
        { kind: 'storefront', ref: 'sf-fr' },
      ],
      proof: { kind: 'domain', domain: 'apple.es' },
      storefronts: [
        storefront({ id: 'sf-es', domain: 'apple.es' }),
        storefront({ id: 'sf-fr', domain: 'apple.fr' }),
      ],
    });
    expect(resolved).toEqual([
      { kind: 'merchant', ref: MERCHANT, state: 'verified' },
      { kind: 'storefront', ref: 'sf-es', state: 'verified' },
      { kind: 'storefront', ref: 'sf-fr', state: 'out_of_scope' },
    ]);
  });
});

describe('a proof never reaches another merchant’s channel', () => {
  it('refuses a storefront belonging to a different merchant, even on the proven domain', () => {
    // A shared host (a marketplace, a reseller platform, a parked domain) must
    // not let one merchant's proof verify a channel somebody else operates.
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [{ kind: 'storefront', ref: 'sf-theirs' }],
      proof: { kind: 'domain', domain: 'shared-host.example' },
      storefronts: [
        storefront({
          id: 'sf-theirs',
          merchantId: OTHER_MERCHANT,
          domain: 'shared-host.example',
        }),
      ],
    });
    expect(resolved[0]?.state).toBe('out_of_scope');
  });

  it('refuses a merchant scope naming a merchant this claim is not about', () => {
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [{ kind: 'merchant', ref: OTHER_MERCHANT }],
      proof: { kind: 'domain', domain: 'apple.com' },
      storefronts: [],
    });
    expect(resolved[0]?.state).toBe('out_of_scope');
  });

  it('refuses a storefront the caller named but did not supply', () => {
    // Fails CLOSED: an unresolvable id is not "probably fine".
    const resolved = resolveProvenScope({
      merchantId: MERCHANT,
      requested: [{ kind: 'storefront', ref: 'sf-missing' }],
      proof: { kind: 'domain', domain: 'apple.com' },
      storefronts: [],
    });
    expect(resolved[0]?.state).toBe('out_of_scope');
  });
});
