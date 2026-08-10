/**
 * Query-parameter policy (#75 validation rule 5, legacy rule 6).
 *
 * The two halves pull in opposite directions and this file drives both: a
 * tracking parameter must never reach a canonical URL, AND it must survive a
 * redirect. The third property is what makes the pair safe — an UNCLASSIFIED
 * parameter survives nothing, because a parameter nobody has classified may be
 * a token.
 */

import { describe, expect, it } from 'vitest';
import {
  SEO_CANONICAL_QUERY_KINDS,
  SEO_NON_CANONICAL_QUERY_KINDS,
} from '@mercaria/shared-types';
import {
  buildCanonicalUrl,
  canonicalParamsForRoute,
  canonicalQueryOf,
  carryQueryAcrossRedirect,
  classifyQueryParam,
} from '../query-params.js';
import { PUBLIC_ROUTES } from '../routes.js';

const ORIGIN = 'https://mercaria.co';

describe('the two vocabularies are DISJOINT', () => {
  it('shares no member', () => {
    const canonical = new Set<string>(SEO_CANONICAL_QUERY_KINDS);
    for (const kind of SEO_NON_CANONICAL_QUERY_KINDS) {
      expect(canonical.has(kind), `'${kind}' is in both tuples`).toBe(false);
    }
    expect(SEO_CANONICAL_QUERY_KINDS.length).toBeGreaterThan(0);
    expect(SEO_NON_CANONICAL_QUERY_KINDS.length).toBeGreaterThan(0);
  });
});

describe('classification', () => {
  it('recognises the address parameters', () => {
    expect(classifyQueryParam('variant')).toBe('variant');
    expect(classifyQueryParam('page')).toBe('page');
  });

  it('recognises attribution and preference', () => {
    for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'gclid', 'fbclid']) {
      expect(classifyQueryParam(name), name).toBe('attribution');
    }
    for (const name of ['currency', 'sort', 'intent', 'market']) {
      expect(classifyQueryParam(name), name).toBe('preference');
    }
  });

  it('answers `unclassified` for everything else', () => {
    // The only safe default. Carrying what we do not recognise is how a
    // password-reset token ends up in a `Referer` on somebody else's domain.
    for (const name of ['token', 'email', 'session', 'utm_sauce', 'UTM_SOURCE', '']) {
      expect(classifyQueryParam(name), name).toBe('unclassified');
    }
  });
});

describe('the canonical URL', () => {
  it('carries only the parameters that are part of the address', () => {
    const query = new URLSearchParams({
      variant: 'v1',
      utm_source: 'newsletter',
      currency: 'EUR',
      token: 'secret',
    });
    expect(
      buildCanonicalUrl(ORIGIN, '/p/iphone', canonicalQueryOf('canonical_product', query)),
    ).toBe('https://mercaria.co/p/iphone?variant=v1');
  });

  it('drops a canonical parameter the route does not recognise', () => {
    // `?variant=` names a configuration on a product page and nothing at all on
    // a store page, so `/stores/acme?variant=x` is a duplicate of
    // `/stores/acme` and must canonicalise to it.
    const query = new URLSearchParams({ variant: 'v1' });
    expect(buildCanonicalUrl(ORIGIN, '/stores/acme', canonicalQueryOf('native_store', query))).toBe(
      'https://mercaria.co/stores/acme',
    );
  });

  it('is order-stable however the request spelled it', () => {
    const forward = canonicalQueryOf('canonical_product', new URLSearchParams('variant=v&page=2'));
    const reverse = canonicalQueryOf('canonical_product', new URLSearchParams('page=2&variant=v'));
    expect(forward).toEqual(reverse);
  });

  it('strips a query string the caller left on the path', () => {
    expect(buildCanonicalUrl(ORIGIN, '/p/iphone?utm_source=x')).toBe(
      'https://mercaria.co/p/iphone',
    );
  });

  it('never emits a tracking parameter, for any route', () => {
    const hostile = new URLSearchParams({
      utm_source: 'a',
      utm_medium: 'b',
      gclid: 'c',
      fbclid: 'd',
      ref: 'e',
      currency: 'EUR',
      sort: 'price',
      token: 'secret',
    });
    for (const route of PUBLIC_ROUTES) {
      const url = buildCanonicalUrl(ORIGIN, '/probe', canonicalQueryOf(route.id, hostile));
      expect(url, route.id).toBe('https://mercaria.co/probe');
    }
  });

  it('every route declares which canonical parameters it takes', () => {
    for (const route of PUBLIC_ROUTES) {
      const declared = canonicalParamsForRoute(route.id);
      for (const kind of declared) {
        expect(SEO_CANONICAL_QUERY_KINDS, `${route.id} declares '${kind}'`).toContain(kind);
      }
    }
  });
});

describe('what survives a redirect', () => {
  it('carries attribution, preference and address parameters', () => {
    const carried = carryQueryAcrossRedirect(
      new URLSearchParams('utm_source=newsletter&currency=EUR&variant=v1'),
    );
    expect(new URLSearchParams(carried).get('utm_source')).toBe('newsletter');
    expect(new URLSearchParams(carried).get('currency')).toBe('EUR');
    expect(new URLSearchParams(carried).get('variant')).toBe('v1');
  });

  it('DROPS anything unclassified', () => {
    const carried = carryQueryAcrossRedirect(
      new URLSearchParams('utm_source=news&token=secret&email=a%40b.example'),
    );
    expect(carried).toBe('utm_source=news');
  });

  it('preserves the order the shopper arrived with', () => {
    expect(carryQueryAcrossRedirect(new URLSearchParams('utm_medium=b&utm_source=a'))).toBe(
      'utm_medium=b&utm_source=a',
    );
  });

  it('preserves a repeated parameter rather than collapsing it', () => {
    expect(carryQueryAcrossRedirect(new URLSearchParams('ref=a&ref=b'))).toBe('ref=a&ref=b');
  });

  it('is empty when nothing survives', () => {
    expect(carryQueryAcrossRedirect(new URLSearchParams('token=secret'))).toBe('');
    expect(carryQueryAcrossRedirect(new URLSearchParams(''))).toBe('');
  });
});
