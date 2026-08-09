/**
 * The dimensions an analytics event takes from the REQUEST rather than from its
 * call site (#77 envelope fields 6, 10 and 11).
 *
 * ## Every input here is a header, and every output is a bounded value
 *
 * The client declares its surface, version, market, consent state and an opaque
 * surface-session handle. Each is validated against a closed set or a shape
 * before it can become a column, so the worst a lying client achieves is
 * mislabelling its OWN events — it cannot inject prose into a dimension, cannot
 * claim to be internal traffic (that token is compared in constant time against
 * a configured secret), and cannot set an identity of any kind.
 *
 * The `User-Agent` is read here and DISCARDED here: it becomes a
 * `traffic_class` and nothing else ever sees it. There is no `user_agent`
 * column in the schema for it to reach, which is what makes "no device
 * fingerprint" structural rather than a habit.
 *
 * ## What is deliberately NOT read
 *
 * The client IP. It is available on every request and it is the single easiest
 * thing to add to a telemetry row, which is exactly why its absence has to be a
 * decision rather than an oversight: #77 identity rule 3 names IP as something
 * that must never be a general analytics user id, and the reliable way to
 * honour that is to have no path from `req.ip` into this domain at all. Rate
 * limiting still uses it — that is a different subsystem with a different
 * retention (a Redis TTL) and no join to anything.
 */

import type { Request } from 'express';
import type {
  AnalyticsClientSurface,
  AnalyticsConsentState,
  AnalyticsTrafficClass,
} from '@mercaria/shared-types';
import { ANALYTICS_CLIENT_SURFACES, ANALYTICS_CONSENT_STATES } from '@mercaria/shared-types';
import { isWellFormedSurfaceSessionId } from './identity.js';
import { ANALYTICS_INTERNAL_HEADER, classifyTraffic } from './traffic-classification.js';

/** The header a client declares its surface in. */
export const ANALYTICS_SURFACE_HEADER = 'x-mercaria-surface';

/** The header a client declares its build in. */
export const ANALYTICS_APP_VERSION_HEADER = 'x-mercaria-app-version';

/** The header a client declares its market in. */
export const ANALYTICS_MARKET_HEADER = 'x-mercaria-market';

/** The header a client declares its consent state in. */
export const ANALYTICS_CONSENT_HEADER = 'x-mercaria-analytics-consent';

/**
 * The header carrying an opaque, client-minted surface session handle.
 *
 * NOT a credential: it authorizes nothing, it is never compared against
 * anything stored, and it is hashed under the rotating server salt before it
 * becomes a column. It exists so an anonymous visitor's search → view → click
 * sequence can be counted as one session without the server minting a row for
 * every browser that loads a page (ADR 0003 T10).
 */
export const ANALYTICS_SESSION_HEADER = 'x-mercaria-analytics-session';

/** What the request contributes to every event it produces. */
export interface AnalyticsRequestContext {
  readonly clientSurface: AnalyticsClientSurface;
  readonly trafficClass: AnalyticsTrafficClass;
  readonly consentState: AnalyticsConsentState;
  readonly appVersion?: string;
  readonly market?: string;
  readonly surfaceSessionId?: string;
}

/** Read one header as a trimmed string, or `undefined`. */
function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Derive the request's analytics dimensions.
 *
 * Every fallback is the SAFEST reading rather than the most useful one: an
 * unrecognised surface is `api` (not the storefront), an unrecognised consent
 * value is `unknown` (not `granted`), and an unidentifiable client is `unknown`
 * traffic (not `human`). A dimension that guesses generously is a dimension
 * that quietly widens what is collected and what is counted.
 */
export function readAnalyticsRequestContext(req: Request): AnalyticsRequestContext {
  const declaredSurface = header(req, ANALYTICS_SURFACE_HEADER);
  const clientSurface: AnalyticsClientSurface =
    declaredSurface !== undefined &&
    (ANALYTICS_CLIENT_SURFACES as readonly string[]).includes(declaredSurface)
      ? (declaredSurface as AnalyticsClientSurface)
      : 'api';

  const declaredConsent = header(req, ANALYTICS_CONSENT_HEADER);
  const consentState: AnalyticsConsentState =
    declaredConsent !== undefined &&
    (ANALYTICS_CONSENT_STATES as readonly string[]).includes(declaredConsent)
      ? (declaredConsent as AnalyticsConsentState)
      : 'unknown';

  const trafficClass = classifyTraffic({
    ...(header(req, 'user-agent') === undefined
      ? {}
      : { userAgent: header(req, 'user-agent') as string }),
    ...(header(req, ANALYTICS_INTERNAL_HEADER) === undefined
      ? {}
      : { internalHeader: header(req, ANALYTICS_INTERNAL_HEADER) as string }),
  });

  const rawVersion = header(req, ANALYTICS_APP_VERSION_HEADER);
  const appVersion =
    rawVersion !== undefined && /^[A-Za-z0-9._+-]{1,64}$/.test(rawVersion) ? rawVersion : undefined;

  const rawMarket = header(req, ANALYTICS_MARKET_HEADER)?.toUpperCase();
  const market = rawMarket !== undefined && /^[A-Z]{2}$/.test(rawMarket) ? rawMarket : undefined;

  const rawSession = header(req, ANALYTICS_SESSION_HEADER);
  const surfaceSessionId =
    rawSession !== undefined && isWellFormedSurfaceSessionId(rawSession) ? rawSession : undefined;

  return {
    clientSurface,
    trafficClass,
    consentState,
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(market === undefined ? {} : { market }),
    ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
  };
}
