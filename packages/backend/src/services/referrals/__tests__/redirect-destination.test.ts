/**
 * The redirect's destination composition (#143 acceptance 2, link rules 1, 3,
 * 5 and 6).
 *
 * "The redirect cannot be used as an open redirect or arbitrary campaign
 * injector." The mechanism is that nothing on the path ACCEPTS a URL — so most
 * of what follows tests the second line of defence: given a relative path that
 * somehow was not what `destinations.ts` produces, does the composer refuse?
 *
 * The inputs below are the classic ways an origin allow-list is defeated: a
 * protocol-relative `//host`, a backslash variant, an absolute URL, a
 * credential-bearing authority, and a hostname that merely ENDS WITH the
 * allowed one.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  composeReferralDestination,
  referralRedirectOrigin,
  REFERRAL_ROUTE_PREFIXES,
} from '../redirect.service.js';
import { referralDestinationPath } from '../destinations.js';

vi.hoisted(() => {
  process.env.REFERRAL_LINK_TOKEN_SECRET = 'test-referral-link-secret';
  process.env.REFERRAL_STATE_SECRET = 'test-referral-state-secret';
  process.env.REFERRAL_REDIRECT_BASE_URL = 'https://mercaria.co';
});

describe('referralRedirectOrigin', () => {
  it('is an allow-listed browser origin', () => {
    // The ONE origin authority (`lib/allowed-origins.ts`), shared with CORS and
    // the guest CSRF gate. A deployment-local second list is the shape an open
    // redirect takes.
    expect(referralRedirectOrigin()).toBe('https://mercaria.co');
  });
});

describe('composeReferralDestination', () => {
  it('composes every destination template onto the allow-listed origin', () => {
    const paths = [
      referralDestinationPath({ destinationType: 'home' }),
      referralDestinationPath({ destinationType: 'listing', destinationRef: 'abc123' }),
      referralDestinationPath({ destinationType: 'collection', destinationRef: 'summer' }),
      referralDestinationPath({ destinationType: 'store', destinationRef: 'nice-shop' }),
    ];
    expect(paths.map(composeReferralDestination)).toEqual([
      'https://mercaria.co/',
      'https://mercaria.co/listings/abc123',
      'https://mercaria.co/collections/summer',
      'https://mercaria.co/stores/nice-shop',
    ]);
  });

  it('carries NO query string and NO fragment', () => {
    // Acceptance 2's "arbitrary campaign injector": the route reads no query
    // parameter at all, and the composed target has nowhere for one to arrive.
    // `campaignRef`/`contentKey` go on the TOUCH, never into the URL.
    for (const path of ['/', '/listings/abc123']) {
      const url = new URL(composeReferralDestination(path));
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
    }
  });

  it('refuses every off-origin escape', () => {
    for (const hostile of [
      '//evil.example/pwned',
      '//mercaria.co.evil.example/pwned',
      'https://evil.example/pwned',
      'http://evil.example',
      'https://user:pass@evil.example/',
      '//localhost:1/',
    ]) {
      expect(() => composeReferralDestination(hostile), hostile).toThrow(/off-origin/i);
    }
  });

  it('refuses a hostname that merely ENDS WITH the allowed one', () => {
    // The suffix-test bug, stated as a case: `mercaria.co.evil.example` ends
    // with nothing an exact hostname comparison accepts, and an `endsWith`
    // implementation would send a browser straight to it.
    expect(() => composeReferralDestination('//mercaria.co.evil.example/')).toThrow(/off-origin/i);
    expect(() => composeReferralDestination('https://notmercaria.co/')).toThrow(/off-origin/i);
  });

  it('refuses a destination that would loop back onto the referral route', () => {
    // #143 link rule 6. The four templates cannot name this route; the guard is
    // for the fifth somebody adds later, which fails here rather than looping.
    for (const looping of ['/r/token', '/r/deadbeef']) {
      expect(() => composeReferralDestination(looping), looping).toThrow(/loop/i);
    }
    expect(REFERRAL_ROUTE_PREFIXES.length).toBeGreaterThan(0);
  });

  it('keeps a traversal attempt inside the origin', () => {
    // `URL` normalises `..`, so the worst a traversal achieves is a different
    // path on the SAME host — which is the property that matters: a redirect
    // target is only dangerous when it leaves.
    const composed = composeReferralDestination('/listings/../../../etc/passwd');
    expect(new URL(composed).origin).toBe('https://mercaria.co');
  });
});

describe('the destination validator upstream', () => {
  it('has already refused anything that could steer a path', () => {
    // `destinations.ts` is the first line and it is the real one: a reference
    // with a slash, a colon, a dot or a percent sign is refused BEFORE it is
    // ever stored, so the composer above is defending against a state the
    // database should not be able to hold.
    for (const ref of ['a/b', 'a:b', 'a.b', 'a%2fb', '../x', '']) {
      expect(
        () => referralDestinationPath({ destinationType: 'listing', destinationRef: ref }),
        ref,
      ).toThrow();
    }
  });
});
