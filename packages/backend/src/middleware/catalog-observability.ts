/**
 * Per-request correlation id and catalog route observation (#367 W17).
 *
 * ## MOUNT THIS BEFORE THE ROUTERS, as a single `app.use(catalogObservability)`
 *
 * ```ts
 * app.use(catalogObservability);
 * ```
 *
 * It must sit above every router, and there are two independent reasons rather
 * than one. A middleware appended AFTER the routers never runs for a request a
 * router already answered, so it would observe exactly the traffic that produced
 * no route — the opposite of the intended population, reporting a healthy zero.
 * And the correlation id is set as a RESPONSE HEADER, which is only possible
 * before the handler writes; mounted late, `res.setHeader` would throw
 * `ERR_HTTP_HEADERS_SENT` on every request it touched.
 *
 * It reads no body and parses nothing, so it is safe above the four raw-body
 * webhook mounts as well as above `express.json()`.
 *
 * ## The route is resolved from the CAPTURED path, not from `req.route`
 *
 * The obvious implementation reads `req.baseUrl + req.route.path` inside the
 * `finish` listener. That is wrong here, and quietly: Express SAVES and RESTORES
 * `req.url` and `req.baseUrl` around a mounted router's stack, and `finish`
 * fires when the response is flushed to the socket, which is not ordered against
 * the stack unwinding. So the template would be right most of the time and
 * silently become `/` or `''` some of the time — a bucket that reads as a
 * healthy, low-latency route.
 *
 * Instead `method` and `originalUrl` are captured SYNCHRONOUSLY at the top, and
 * the template is resolved by matching that path against
 * `CATALOG_OBSERVED_ROUTES` — the same closed set the store is keyed on.
 * `originalUrl` is the one property Express never rewrites. Nothing in here
 * depends on Express internals or on when `finish` fires.
 *
 * ## An unresolvable path is DROPPED here, not handed to the store
 *
 * `observeCatalogRoute` counts an unrecognised key in `unobservedRouteReports`,
 * whose docblock says a non-zero value means "a caller is composing a key by
 * hand". That invariant is worth keeping: this middleware sees EVERY request to
 * the whole API — health probes, webhooks, orders, admin — and handing each of
 * them to the store would make that counter a traffic meter and destroy its one
 * signal. So a path that resolves to no template is dropped before the call.
 * The store's refusal then still means what it says, and it remains a real
 * backstop for a caller that bypasses this file.
 *
 * ## It cannot fail a request
 *
 * The header is set with `res.setHeader` before anything else can write, and
 * everything on the finish path is inside one `try` whose `catch` body is a
 * single counter increment. The catch deliberately does NOT log: it runs inside a
 * `res.on('finish')` listener, where a second throw — from the logger, from a
 * broken transport — has nowhere to go, and `recordMetricCollectionFailure` is
 * an integer increment that cannot throw. `observeCatalogRoute` already returns
 * `void` and throws nothing by its own contract; the `try` covers the clock, the
 * resolution and the log line beside it.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
  runWithCorrelationId,
} from '../services/catalog-observability/correlation.js';
import {
  catalogLogDebug,
  catalogLogWarn,
} from '../services/catalog-observability/catalog-log.js';
import {
  CATALOG_OBSERVED_ROUTES,
  observeCatalogRoute,
  recordMetricCollectionFailure,
} from '../services/catalog-observability/route-observations.js';

/** Nanoseconds per millisecond, for `process.hrtime.bigint()`. */
const NS_PER_MS = 1_000_000;

/** One observed key, split into the pieces a match needs. */
interface ObservedRouteMatcher {
  readonly method: string;
  readonly route: string;
  readonly segments: readonly string[];
}

/**
 * `CATALOG_OBSERVED_ROUTES` pre-split, once, at module load.
 *
 * Derived from that list rather than written again: a matcher for a route with
 * no budget could never produce an observation the store accepts, and a budget
 * with no matcher would be a threshold that can never fire. One list, and this
 * is a projection of it.
 */
const MATCHERS: readonly ObservedRouteMatcher[] = CATALOG_OBSERVED_ROUTES.map((key) => {
  const separator = key.indexOf(' ');
  const route = key.slice(separator + 1);
  return {
    method: key.slice(0, separator),
    route,
    segments: splitPath(route),
  };
});

/** Path segments, with empty ones dropped so a trailing slash cannot matter. */
function splitPath(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * The template `path` was served by, or `undefined` when it is not observed.
 *
 * A `:param` segment matches exactly one non-empty segment and never spans a
 * `/`, so `/categories/:id` cannot absorb `/categories/a/b` — the trap that
 * makes a template-matching helper report a bucket for traffic it never served.
 * Static segments are compared case-insensitively, because Express's own routing
 * is case-insensitive by default and two buckets for `/Search` and `/search`
 * would each hold half the samples.
 *
 * Exported for the test: the resolution is the part of this file that can be
 * wrong without anything else noticing.
 */
export function resolveObservedRouteTemplate(method: string, path: string): string | undefined {
  const segments = splitPath(path);
  const upperMethod = method.toUpperCase();
  for (const matcher of MATCHERS) {
    if (matcher.method !== upperMethod) continue;
    if (matcher.segments.length !== segments.length) continue;
    let matched = true;
    for (let index = 0; index < matcher.segments.length; index += 1) {
      const expected = matcher.segments[index];
      if (expected.startsWith(':')) continue;
      if (expected.toLowerCase() !== segments[index].toLowerCase()) {
        matched = false;
        break;
      }
    }
    if (matched) return matcher.route;
  }
  return undefined;
}

/** The pathname of a URL that may carry a query string or a fragment. */
export function pathnameOf(originalUrl: string): string {
  const queryAt = originalUrl.indexOf('?');
  const withoutQuery = queryAt === -1 ? originalUrl : originalUrl.slice(0, queryAt);
  const hashAt = withoutQuery.indexOf('#');
  return hashAt === -1 ? withoutQuery : withoutQuery.slice(0, hashAt);
}

/**
 * Establish this request's correlation id and observe it if it is a catalog read.
 *
 * Mount as `app.use(catalogObservability)` — see the header for where and why.
 */
export function catalogObservability(req: Request, res: Response, next: NextFunction): void {
  const resolution = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
  const correlationId = resolution.correlationId;

  // Set before anything can write, so a client always has a handle to quote in a
  // bug report — including on a 500, which is when it matters most.
  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  // Captured synchronously: see the header on why `finish` must not read these
  // off the request.
  const method = req.method;
  const path = pathnameOf(req.originalUrl);
  const startedAt = process.hrtime.bigint();

  if (resolution.origin === 'minted' && resolution.reason !== 'none_presented') {
    // Only when a client actually presented something that was rejected. The
    // ordinary case — no header at all — is every request, and logging it would
    // be a line per request that says nothing.
    runWithCorrelationId(correlationId, () => {
      catalogLogWarn({
        event: 'correlation_inbound_refused',
        reasonCode: resolution.reason,
        method,
      });
    });
  }

  res.on('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / NS_PER_MS;
      const route = resolveObservedRouteTemplate(method, path);
      if (route === undefined) return;

      observeCatalogRoute({ method, route, statusCode: res.statusCode, durationMs });

      // The correlation id is passed through the store explicitly rather than
      // read from `AsyncLocalStorage`: an `EventEmitter` listener runs in the
      // emitter's async context, not the one it was registered in, so
      // `currentCorrelationId()` here would be `undefined` — and an id that is
      // silently absent on exactly the line that ties a request to its trace is
      // the failure this whole file exists to prevent.
      runWithCorrelationId(correlationId, () => {
        catalogLogDebug({
          event: 'route_observed',
          method,
          route,
          statusCode: res.statusCode,
          durationMs,
        });
      });
    } catch {
      // A counter increment, and nothing else. See the header.
      recordMetricCollectionFailure();
    }
  });

  runWithCorrelationId(correlationId, next);
}
