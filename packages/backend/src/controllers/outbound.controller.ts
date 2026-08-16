/**
 * `GET /out/:token` — the HTTP half of the affiliate outbound redirect (#67).
 *
 * ## What the handler is allowed to read
 *
 * The path segment, and four headers the traffic classifier is permitted to see.
 * It reads NO query parameter and NO body, which is what makes "the destination
 * cannot come from the request" a property of this file rather than a filter
 * inside it — there is nothing to filter.
 *
 * ## 302, `no-store`, `no-referrer`, `noindex`
 *
 * A `301`/`308` is permanently cacheable, so a browser that stopped asking
 * would keep following a link whose offer had been retired, its source's rights
 * withdrawn or its host revoked — and would stop producing the click record the
 * whole domain is built on. `no-store` says the same thing to every cache in
 * between. `Referrer-Policy: no-referrer` stops the merchant learning which
 * Mercaria page a shopper came from, which is a fact about the shopper's
 * browsing rather than about the purchase. `X-Robots-Tag: noindex, nofollow` is
 * requirement 8's server-side half: a crawler that reaches the redirect anyway
 * must not index it or pass equity through it, which the page's own
 * `rel="sponsored nofollow noopener"` cannot say on the crawler's behalf once
 * it has the URL.
 *
 * ## Every refusal is the SAME answer
 *
 * One 404 with one sentence, for a bad token, an unknown offer, a retired one,
 * a stale one, a withdrawn right and a host nobody approved. A distinguishable
 * answer lets somebody probe which offer ids exist and which sources are
 * paused; the operator reads the real reason off the click row, where it is
 * recorded in full.
 */

import type { Request, Response } from 'express';
import type { OutboundClientSurface } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { resolveOutboundRedirect } from '../services/outbound/redirect.service.js';
import { INTERNAL_TRAFFIC_HEADER } from '../services/referrals/traffic.js';

/** A single header value, or `undefined`. Express may hand back an array. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw.trim();
  if (Array.isArray(raw)) return raw[0]?.trim() === '' ? undefined : raw[0]?.trim();
  return undefined;
}

/**
 * The surface, as the CLIENT declares it, defaulting to `web`.
 *
 * Self-declared and unverified, which is why it is a coarse four-member enum
 * and never a device string. Nothing depends on it being true — it is a
 * reporting dimension, not an authorization input.
 */
function declaredSurface(value: string | undefined): OutboundClientSurface {
  if (value === 'ios' || value === 'android' || value === 'web' || value === 'other') {
    return value;
  }
  return 'web';
}

/** The declared consent mode, defaulting to `unknown` — never to `granted`. */
function declaredConsent(value: string | undefined): 'granted' | 'denied' | 'unknown' {
  if (value === 'granted' || value === 'denied') return value;
  return 'unknown';
}

/** The one sentence every refusal answers with. */
const UNAVAILABLE = 'This offer is no longer available.';

export async function affiliateOutboundHandler(req: Request, res: Response): Promise<void> {
  const token = req.params.token;
  if (typeof token !== 'string' || token === '') {
    res.status(404).json({ success: false, error: UNAVAILABLE });
    return;
  }

  let decision: Awaited<ReturnType<typeof resolveOutboundRedirect>>;
  try {
    decision = await resolveOutboundRedirect({
      token,
      trafficSignals: {
        userAgent: headerValue(req, 'user-agent'),
        purposeHeaders: {
          'sec-purpose': headerValue(req, 'sec-purpose'),
          purpose: headerValue(req, 'purpose'),
          'x-purpose': headerValue(req, 'x-purpose'),
          'x-moz': headerValue(req, 'x-moz'),
        },
        internalTrafficToken: headerValue(req, INTERNAL_TRAFFIC_HEADER),
      },
      clientSurface: declaredSurface(headerValue(req, 'x-mercaria-surface')),
      consentMode: declaredConsent(headerValue(req, 'x-mercaria-outbound-consent')),
    });
  } catch (err) {
    // A failure here is Mercaria's, not the visitor's, and it must not become a
    // redirect: answering the safe page is the only outcome that cannot send
    // somebody somewhere on the strength of a half-completed decision.
    log.general.error({ err }, '[Outbound] redirect resolution failed');
    res.status(404).json({ success: false, error: UNAVAILABLE });
    return;
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (decision.outcome === 'refused') {
    // The bounded reason, never the destination and never a header value.
    log.general.info(
      { reason: decision.reason, clickId: decision.clickId },
      '[Outbound] redirect refused',
    );
    res.status(404).json({ success: false, error: UNAVAILABLE });
    return;
  }

  res.redirect(302, decision.url);
}

/** Whether the route may be mounted at all. Read by `app.ts`. */
export function affiliateOutboundEnabled(): boolean {
  return config.affiliateOutbound.redirectEnabled;
}
