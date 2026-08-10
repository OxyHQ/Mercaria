/**
 * The redirect registry (#75 §"Legacy migration" rule 7) — every address that
 * answers with another one, and the proof that none of them can loop.
 *
 * ## Two kinds of redirect, one resolver
 *
 * A **route** redirect is a pure path rewrite: `/m/:handle` → `/stores/:handle`
 * carries the same segment to the same entity and cannot be wrong. It is
 * declared here as a rule.
 *
 * An **identity** redirect is a fact about a row: a merged canonical product
 * answers with its winner, and an address that named a product by its id
 * answers with the slug. Those are resolved by the caller, which has the row —
 * this module only asserts the result is a legal one.
 *
 * ## Loop prevention is structural, not a counter
 *
 * The route rules are checked at MODULE LOAD: every rule's TARGET pattern must
 * be a route with no rule of its own. A registry whose targets are all terminal
 * cannot cycle, whatever order the rules are applied in — which is a stronger
 * statement than "we stopped after ten hops", and it fails at boot rather than
 * under a crawler.
 *
 * Identity redirects still get a hop cap, because their graph lives in the
 * database and this process does not own it: `resolveProductRow` already caps
 * merge chains, and {@link assertRedirectTerminates} is the second half — a
 * redirect whose destination redirects again is refused rather than served, so
 * a crawler is never handed a chain to walk.
 */

import type {
  PublicRouteId,
  SeoRedirect,
  SeoRedirectReason,
  SeoRedirectStatus,
} from '@mercaria/shared-types';
import { matchPublicRoute, publicRoute, PUBLIC_ROUTES } from './routes.js';

/**
 * One retired route pattern and its live successor.
 *
 * Both sides name a REGISTERED route id, so a rule cannot point at a pattern
 * nobody serves, and the single dynamic segment is carried across verbatim.
 */
interface RouteRedirectRule {
  readonly from: PublicRouteId;
  readonly to: PublicRouteId;
  readonly status: SeoRedirectStatus;
  readonly reason: SeoRedirectReason;
}

/**
 * The route-level rules, in full.
 *
 * ONE today, and that is the point: every other redirect in Mercaria is an
 * identity fact resolved from a row. A registry of hand-written path rewrites
 * is where a marketplace eventually sends somebody to the wrong product, so it
 * stays as small as the migration allows.
 */
const ROUTE_REDIRECT_RULES: readonly RouteRedirectRule[] = Object.freeze([
  {
    from: 'native_store_legacy',
    to: 'native_store',
    status: 301,
    reason: 'retired_route',
  },
] satisfies readonly RouteRedirectRule[]);

const RULES_BY_SOURCE: ReadonlyMap<PublicRouteId, RouteRedirectRule> = new Map(
  ROUTE_REDIRECT_RULES.map((rule) => [rule.from, rule]),
);

/** Does a route pattern redirect on its own, before any identity is resolved? */
export function routeRedirectRuleFor(routeId: PublicRouteId): boolean {
  return RULES_BY_SOURCE.has(routeId);
}

/**
 * Apply the route-level rules to one already-matched path.
 *
 * Returns `undefined` when the path's route has no rule, which is the ordinary
 * case: the caller then resolves identity and may still answer with a redirect
 * of its own.
 */
export function resolveRouteRedirect(
  routeId: PublicRouteId,
  handle: string | undefined,
  carriedQuery: string,
): SeoRedirect | undefined {
  const rule = RULES_BY_SOURCE.get(routeId);
  if (!rule) return undefined;

  const target = publicRoute(rule.to);
  const targetSegments = target.pattern.split('/').filter((segment) => segment !== '');
  const dynamic = targetSegments.filter((segment) => segment.startsWith(':')).length;
  if (dynamic > 0 && (handle === undefined || handle === '')) {
    // The source matched with no segment but the target needs one. Nothing can
    // be composed, so nothing is: the caller answers 404 rather than sending a
    // browser to a half-built address.
    return undefined;
  }

  const path = `/${targetSegments
    .map((segment) => (segment.startsWith(':') ? encodeURIComponent(handle ?? '') : segment))
    .join('/')}`;

  return {
    status: rule.status,
    location: carriedQuery === '' ? path : `${path}?${carriedQuery}`,
    reason: rule.reason,
  };
}

/**
 * Build an identity redirect — a merged entity's winner, or the canonical
 * spelling of an address that used an id.
 *
 * The location is checked before it is returned: a destination that would
 * itself redirect is a loop waiting to be walked, and this refuses to compose
 * one rather than trusting the caller to have resolved the chain.
 */
export function buildIdentityRedirect(
  path: string,
  carriedQuery: string,
  reason: SeoRedirectReason,
): SeoRedirect {
  assertRedirectTerminates(path);
  return {
    status: 301,
    location: carriedQuery === '' ? path : `${path}?${carriedQuery}`,
    reason,
  };
}

/**
 * A redirect destination must be a route that does not redirect.
 *
 * Throws rather than returning a verdict: every caller is composing a redirect
 * it is about to serve, and there is no sensible way to continue with a
 * destination that bounces. The 500 that results is the correct outcome — it is
 * a bug in the resolver, and a crawler that received the chain would cache it.
 */
export function assertRedirectTerminates(path: string): void {
  const matched = matchPublicRoute(path);
  if (!matched) {
    throw new Error(`Redirect destination '${path}' matches no public route.`);
  }
  if (RULES_BY_SOURCE.has(matched.route.id)) {
    throw new Error(
      `Redirect destination '${path}' is itself a redirect source ('${matched.route.id}').`,
    );
  }
}

/**
 * Every rule's target is terminal, asserted at MODULE LOAD.
 *
 * This is the loop proof. With no target that is also a source, the rule graph
 * has depth one by construction and no traversal of it can revisit a node —
 * so there is no cycle to detect at request time and no hop counter to tune.
 */
for (const rule of ROUTE_REDIRECT_RULES) {
  if (rule.from === rule.to) {
    throw new Error(`Redirect rule '${rule.from}' points at itself.`);
  }
  if (RULES_BY_SOURCE.has(rule.to)) {
    throw new Error(
      `Redirect rule '${rule.from}' → '${rule.to}' targets a route that itself redirects.`,
    );
  }
  const target = publicRoute(rule.to);
  if (target.availability !== 'live') {
    throw new Error(
      `Redirect rule '${rule.from}' → '${rule.to}' targets a route with no screen behind it.`,
    );
  }
  const source = publicRoute(rule.from);
  const arity = (pattern: string): number =>
    pattern.split('/').filter((segment) => segment.startsWith(':')).length;
  if (arity(source.pattern) !== arity(target.pattern)) {
    throw new Error(
      `Redirect rule '${rule.from}' → '${rule.to}' cannot carry its segment: the patterns ` +
        'take a different number of them.',
    );
  }
}

/**
 * Every `redirect_only` route has a rule, asserted at MODULE LOAD.
 *
 * The other direction of the same gate: a route declared as redirect-only with
 * no rule behind it is a 404 wearing a plan, and it would be discovered by
 * whoever followed the old link.
 */
for (const route of PUBLIC_ROUTES) {
  if (route.availability === 'redirect_only' && !RULES_BY_SOURCE.has(route.id)) {
    throw new Error(`Route '${route.id}' is redirect-only and has no redirect rule.`);
  }
}
