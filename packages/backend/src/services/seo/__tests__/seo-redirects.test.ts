/**
 * The redirect registry (#75 §"Legacy migration" rule 7) — and the proof it
 * cannot loop.
 *
 * The loop proof is structural rather than empirical: every route-level rule's
 * TARGET is a route with no rule of its own, asserted at module load, so the
 * rule graph has depth one and no traversal can revisit a node. This file
 * exercises the assertion from the outside and drives the two things a service
 * bug could still get wrong — carrying the segment, and composing a destination
 * that itself redirects.
 */

import { describe, expect, it } from 'vitest';
import { SEO_REDIRECT_REASONS } from '@mercaria/shared-types';
import {
  assertRedirectTerminates,
  buildIdentityRedirect,
  resolveRouteRedirect,
  routeRedirectRuleFor,
} from '../redirects.js';
import { PUBLIC_ROUTES } from '../routes.js';

describe('the retired native-store route', () => {
  it('carries the handle to /stores/:handle with a 301', () => {
    expect(resolveRouteRedirect('native_store_legacy', 'acme', '')).toEqual({
      status: 301,
      location: '/stores/acme',
      reason: 'retired_route',
    });
  });

  it('carries the surviving query string across', () => {
    expect(resolveRouteRedirect('native_store_legacy', 'acme', 'utm_source=newsletter')).toEqual({
      status: 301,
      location: '/stores/acme?utm_source=newsletter',
      reason: 'retired_route',
    });
  });

  it('encodes the segment rather than emitting it raw', () => {
    const redirect = resolveRouteRedirect('native_store_legacy', 'a b/c', '');
    expect(redirect?.location).toBe('/stores/a%20b%2Fc');
  });

  it('composes nothing when the segment is missing', () => {
    // The caller then answers 404 rather than sending a browser to `/stores/`.
    expect(resolveRouteRedirect('native_store_legacy', undefined, '')).toBeUndefined();
    expect(resolveRouteRedirect('native_store_legacy', '', '')).toBeUndefined();
  });

  it('is the only route-level rule', () => {
    const sources = PUBLIC_ROUTES.filter((route) => routeRedirectRuleFor(route.id));
    expect(sources.map((route) => route.id)).toEqual(['native_store_legacy']);
  });
});

describe('a live route does not redirect', () => {
  it('answers undefined for every route with no rule', () => {
    for (const route of PUBLIC_ROUTES) {
      if (route.id === 'native_store_legacy') continue;
      expect(resolveRouteRedirect(route.id, 'x', ''), `${route.id} redirected`).toBeUndefined();
    }
  });
});

describe('LOOP PREVENTION', () => {
  it('every rule target is terminal — the whole proof', () => {
    // The module-level assertion has already run by the time this file loads;
    // this states the property it enforces so a reader can see what "cannot
    // loop" means here rather than trusting a comment.
    for (const route of PUBLIC_ROUTES) {
      if (!routeRedirectRuleFor(route.id)) continue;
      const redirect = resolveRouteRedirect(route.id, 'probe', '');
      expect(redirect).toBeDefined();
      expect(() => assertRedirectTerminates(redirect?.location.split('?')[0] ?? '')).not.toThrow();
    }
  });

  it('refuses a destination that is itself a redirect source', () => {
    expect(() => assertRedirectTerminates('/m/acme')).toThrow(/itself a redirect source/u);
  });

  it('refuses a destination that matches no public route', () => {
    expect(() => assertRedirectTerminates('/nowhere/at/all')).toThrow(/matches no public route/u);
  });

  it('an identity redirect is checked before it is returned', () => {
    expect(buildIdentityRedirect('/p/winner', '', 'merged')).toEqual({
      status: 301,
      location: '/p/winner',
      reason: 'merged',
    });
    expect(() => buildIdentityRedirect('/m/acme', '', 'merged')).toThrow(
      /itself a redirect source/u,
    );
  });
});

describe('the reason vocabulary', () => {
  it('has no `query_normalized` member', () => {
    // Stripping a tracking parameter with a 301 destroys the attribution the
    // landing page is about to read. The canonical TAG consolidates the
    // address; the parameter reaches the page. A member here would be an
    // invitation to do it the other way.
    expect(SEO_REDIRECT_REASONS).not.toContain('query_normalized');
    expect([...SEO_REDIRECT_REASONS].sort()).toEqual([
      'canonical_spelling',
      'merged',
      'retired_route',
    ]);
  });

  it('offers no temporary status', () => {
    const redirect = buildIdentityRedirect('/p/winner', '', 'canonical_spelling');
    expect(redirect.status).toBe(301);
  });
});
