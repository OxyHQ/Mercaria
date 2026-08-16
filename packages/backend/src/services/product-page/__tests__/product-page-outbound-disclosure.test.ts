/**
 * The link relationship reaches a client — #67 outbound rule 8.
 *
 * ## Why this file exists separately
 *
 * `resolveProductPageOutbound`'s `outbound` branch is reachable only when
 * `OUTBOUND_REDIRECT_ENABLED` is set, and `config/index.ts` reads `process.env`
 * ONCE at module load and freezes the result. `product-page-rules.test.ts`
 * imports the module statically and therefore exercises the three
 * `unavailable` branches and nothing else — which is how the `outbound` branch
 * came to be served to the storefront with no test looking at its shape.
 *
 * So the environment is set BEFORE a dynamic import, the pattern every realdb
 * file with a config dependency in this repository uses. A static import here
 * would pull config first and the branch would be permanently `unavailable` —
 * a green-looking file measuring nothing.
 *
 * ## What went wrong, and what this pins
 *
 * `OUTBOUND_LINK_REL` and `resolveOutboundDisclosure` were both built, both
 * tested, and reached NO production caller: the composer the product page
 * actually uses returned `{kind, redirectPath, destinationHost}` and dropped
 * `rel`, while `OfferRow.tsx` documented that "`outbound.rel` … is carried as
 * DATA" and `ProductPageOutbound` had no such field. The value was a constant
 * nothing published.
 *
 * The assertions below are therefore about the CARRIER, not about the string:
 * that the branch a client is served carries the relationship at all, and that
 * it is read from the one constant rather than spelled a second time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { OUTBOUND_LINK_REL, type Offer } from '@mercaria/shared-types';

let resolveProductPageOutbound: typeof import('../outbound.js').resolveProductPageOutbound;

beforeAll(async () => {
  process.env.OUTBOUND_REDIRECT_ENABLED = 'true';
  process.env.OUTBOUND_TOKEN_SECRET = 'product-page-outbound-disclosure-secret';
  ({ resolveProductPageOutbound } = await import('../outbound.js'));
});

/** A minimal external offer. Only the fields the outbound decision reads matter. */
function externalOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-rel-1',
    kind: 'external',
    status: 'active',
    canonicalVariantId: 'variant-1',
    sellerRole: 'direct',
    availability: 'in_stock',
    condition: { key: 'new', group: 'new', mappingState: 'declared' },
    customerEligibility: 'unknown',
    delivery: { known: false, pickup: 'unknown' },
    provenance: {},
    freshness: {
      level: 'current',
      basis: 'source_policy',
      observedAt: '2026-08-10T00:00:00.000Z',
      firstSeenAt: '2026-08-10T00:00:00.000Z',
      lastSeenAt: '2026-08-10T00:00:00.000Z',
      ageSeconds: 10,
      checkedAgeSeconds: 10,
      expiry: { bounded: false },
    },
    qualitySignals: [],
    checkout: { eligible: false, reasons: ['not_native'] },
    destinationUrl: 'https://shop.example.test/item/1?utm=x',
    ...overrides,
  };
}

/** Narrow to the outbound branch, or fail NAMING what came back instead. */
function outboundBranch(offer: Offer) {
  const resolved = resolveProductPageOutbound(offer);
  if (resolved.kind !== 'outbound') {
    throw new Error(
      `expected an outbound branch; got ${resolved.kind}` +
        (resolved.kind === 'unavailable' ? ` (${resolved.reason})` : '') +
        ' — OUTBOUND_REDIRECT_ENABLED must be set before config loads',
    );
  }
  return resolved;
}

describe('#67 rule 8 — the served handoff carries its link relationship', () => {
  it('carries `rel`, read from the ONE constant rather than spelled again', () => {
    expect(outboundBranch(externalOffer()).rel).toBe(OUTBOUND_LINK_REL);
  });

  /*
   * The constant's own content, asserted once and here rather than in three
   * clients. `sponsored` is the disclosure a paid link legally owes; `nofollow`
   * covers crawlers predating it; `noopener` is unrelated to disclosure and is
   * present because a destination that can reach `window.opener` is a
   * tabnabbing surface on every link this domain emits.
   *
   * Dropping any one of them is a policy change somebody should have to make
   * deliberately, which is what this turns it into.
   */
  it('discloses the link as paid, and not merely as unfollowed', () => {
    const rel = outboundBranch(externalOffer()).rel.split(' ');
    expect(rel).toContain('sponsored');
    expect(rel).toContain('nofollow');
    expect(rel).toContain('noopener');
  });

  /*
   * The whole branch, exactly. A `toEqual` rather than three `toHaveProperty`
   * calls, so a field ADDED here is a decision somebody makes in a diff a
   * reviewer sees — which is the check that was missing when `rel` went absent.
   */
  it('serves a Mercaria path, a destination HOST and the relationship — and no URL', () => {
    const resolved = outboundBranch(externalOffer());
    expect(resolved).toEqual({
      kind: 'outbound',
      redirectPath: resolved.redirectPath,
      destinationHost: 'shop.example.test',
      rel: OUTBOUND_LINK_REL,
    });
    expect(resolved.redirectPath).toMatch(/^\/out\/mox_/u);
    // The merchant's address never reaches the page — a crawler scraping it
    // cannot follow the destination, and no click happens without a click row.
    expect(JSON.stringify(resolved)).not.toContain('https://');
    expect(JSON.stringify(resolved)).not.toContain('utm=x');
  });

  /*
   * Requirement 6 on the render side. A native offer has no outbound branch at
   * all, so there is no `rel` to read and nothing that could publish a paid
   * disclosure over Mercaria's own checkout.
   */
  it('gives a native offer no relationship, because it gets no outbound branch', () => {
    const native = resolveProductPageOutbound(
      externalOffer({ kind: 'native', destinationUrl: 'https://shop.example.test/item/1' }),
    );
    expect(native.kind).toBe('unavailable');
    expect(Object.keys(native)).not.toContain('rel');
  });
});
