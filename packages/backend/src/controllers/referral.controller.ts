/**
 * The referral edge controllers (THIN) — #143.
 *
 * Every handler delegates: resolution, classification, destination composition
 * and binding all live in `services/referrals/`, so a controller cannot produce
 * a second answer to any of them and no response shape here can widen what a
 * projection emits.
 *
 * The one thing these DO own is carriage — cookie versus header, and the cache
 * and referrer headers on the redirect — because that is an HTTP fact rather
 * than a domain one.
 */

import type { Request, Response } from 'express';
import type {
  ReferralClientSurface,
  ReferralConsentMode,
  ReferralStateView,
} from '@mercaria/shared-types';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';
import { config } from '../config/index.js';
import {
  bindCarriedReferral,
  bindEnteredCode,
  bindMerchantCandidate,
  type ReferralBindContext,
} from '../services/referrals/binding.service.js';
import { resolveReferralRedirect } from '../services/referrals/redirect.service.js';
import {
  clearReferralState,
  readReferralStateCookie,
  referralStateCookieProfile,
  setReferralState,
  verifyReferralState,
  REFERRAL_STATE_REQUEST_HEADER,
  type ReferralStateTransport,
} from '../services/referrals/referral-state.js';
import {
  classifyReferralTraffic,
  INTERNAL_TRAFFIC_HEADER,
} from '../services/referrals/traffic.js';

/**
 * The header a NATIVE client may declare consent on.
 *
 * A top-level browser navigation cannot set one and this route accepts no query
 * parameter, so on the web the declaration arrives at BIND time instead. The
 * framework that would let a web client declare at click time — a CMP, a stored
 * consent record, a jurisdiction table — does not exist in this repository, and
 * that gap is a named seam rather than a default somebody guessed.
 */
const CONSENT_HEADER = 'x-mercaria-referral-consent';

/** A single header value, or `undefined`. Express may hand back an array. */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw.trim();
  if (Array.isArray(raw)) return raw[0]?.trim() === '' ? undefined : raw[0]?.trim();
  return undefined;
}

/** The declared consent mode, defaulting to `unknown` — never to `granted`. */
function declaredConsent(value: string | undefined): ReferralConsentMode {
  if (value === 'granted' || value === 'denied') return value;
  return 'unknown';
}

/** Classify one request from the three headers the classifier may read. */
function classify(req: Request): ReturnType<typeof classifyReferralTraffic> {
  return classifyReferralTraffic(
    {
      userAgent: headerValue(req, 'user-agent'),
      purposeHeaders: {
        'sec-purpose': headerValue(req, 'sec-purpose'),
        purpose: headerValue(req, 'purpose'),
        'x-purpose': headerValue(req, 'x-purpose'),
        'x-moz': headerValue(req, 'x-moz'),
      },
      internalTrafficToken: headerValue(req, INTERNAL_TRAFFIC_HEADER),
    },
    config.analytics.internalTrafficToken,
  );
}

/**
 * How the carrier reaches this client.
 *
 * Header when the client PRESENTED one that way, cookie otherwise — the #103
 * rule that a credential is answered in the kind it arrived in, so a native
 * client that stores tokens itself never has a cookie jar it cannot read and a
 * browser never gets a header it will not persist.
 */
function stateTransport(req: Request): ReferralStateTransport {
  return headerValue(req, REFERRAL_STATE_REQUEST_HEADER) !== undefined ? 'header' : 'cookie';
}

/** The presented carrier, header first, then cookie. */
function presentedState(req: Request): string | undefined {
  const fromHeader = headerValue(req, REFERRAL_STATE_REQUEST_HEADER);
  if (fromHeader !== undefined) return fromHeader;
  // `maxAge` is irrelevant to a READ; the profile is consulted for its NAME.
  const profile = referralStateCookieProfile(0);
  return readReferralStateCookie(req.headers.cookie, profile.name);
}

/** The bind context every referral write runs under. */
function bindContext(req: Request, surface: ReferralClientSurface | undefined): ReferralBindContext {
  const body = req.body as { consent?: string } | undefined;
  return {
    actor: req.commerceActor ?? { kind: 'anonymous' },
    clientSurface: surface ?? 'web',
    consentMode: declaredConsent(body?.consent),
    trafficClass: classify(req).trafficClass,
    at: new Date(),
  };
}

/**
 * `GET /r/:token` — resolve a partner's link and send the browser on.
 *
 * The response headers are load-bearing:
 *
 *  - `302`, never `301`/`308`: a permanent redirect is cacheable forever, and a
 *    browser that stopped asking would keep following a revoked link, stop
 *    spending the click ceiling, and make the operator lever inert.
 *  - `Cache-Control: no-store` plus `Pragma: no-cache`, so no intermediary
 *    holds the `Set-Cookie` this response may carry, and every click reaches
 *    the row that decides.
 *  - `Referrer-Policy: no-referrer`, so the destination page never learns the
 *    token from a `Referer` header — the token is the credential-shaped part of
 *    the URL even though it authorizes nothing.
 */
export async function referralRedirectHandler(req: Request, res: Response): Promise<void> {
  const token = routeParam(req, 'token');
  const verdict = classify(req);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    const outcome = await resolveReferralRedirect({
      token,
      trafficClass: verdict.trafficClass,
      // A browser navigation is the only thing that reaches this route: a
      // native app would need a VERIFIED universal link or App Link to
      // intercept it, and Mercaria declares neither (the named seam).
      clientSurface: 'web',
      consentMode: declaredConsent(headerValue(req, CONSENT_HEADER)),
      actor: req.commerceActor ?? { kind: 'anonymous' },
      at: new Date(),
    });

    if (outcome.outcome === 'not_found') {
      // ONE answer for an unknown token, a revoked link, a spent ceiling and a
      // program whose redirect lever is down. A distinguishable refusal would
      // let a stranger enumerate which programs exist and which are paused.
      log.general.info(
        { disposition: outcome.disposition, signal: verdict.signal },
        '[Referrals] link resolution refused',
      );
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    if (outcome.state !== undefined) {
      setReferralState(res, outcome.state.token, stateTransport(req), outcome.state.maxAgeMs);
    }
    res.redirect(302, outcome.location);
  } catch {
    // A malformed token, a link this deployment does not serve and an expired
    // one all raise, and all answer the SAME 404 the refusals above do — so the
    // error VALUE is deliberately not read: branching on it here is how a
    // distinguishable refusal, and an enumeration oracle, would get built.
    log.general.info({ signal: verdict.signal }, '[Referrals] link resolution failed');
    sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
  }
}

/**
 * `POST /referrals/bind` — redeem a carried click for the resolved actor.
 *
 * Idempotent in the way that matters: a redeemed carrier is CLEARED, so a
 * second call finds nothing and answers `none` rather than recording a second
 * touch for one click.
 */
export async function referralBindHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { surface?: ReferralClientSurface } | undefined;
    const context = bindContext(req, body?.surface);
    const transport = stateTransport(req);

    if (context.consentMode === 'denied') {
      // The declaration's one effect: nothing is written and the carrier goes.
      clearReferralState(res, transport);
      sendSuccess(res, { state: 'none', reason: 'state_unusable', disclosureRequired: false });
      return;
    }

    const result = await bindCarriedReferral({ stateToken: presentedState(req), context });
    if (result.redeemed) clearReferralState(res, transport);
    const { redeemed: _redeemed, ...view } = result;
    sendSuccess(res, view);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to bind referral state');
  }
}

/**
 * `POST /referrals/code-entry` — the buyer typed a code.
 *
 * Recorded as its own touch KIND, separately from a passive link touch (#143
 * code rule 7). Under ADR 0005 D4's last-touch rule a typed code beats a stale
 * click automatically, because code entry IS a touch and is by construction the
 * latest one — there is no precedence branch anywhere for it to disagree with.
 */
export async function referralCodeEntryHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      code: string;
      moment: 'in_app' | 'at_checkout';
      surface?: ReferralClientSurface;
    };
    const result = await bindEnteredCode({
      code: body.code,
      moment: body.moment,
      context: bindContext(req, body.surface),
    });
    sendSuccess(res, result);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to record the referral code');
  }
}

/** `POST /referrals/merchant-binding` — bind a carried click to a claim. */
export async function referralMerchantBindingHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { merchantId: string; surface?: ReferralClientSurface };
    const result = await bindMerchantCandidate({
      merchantId: body.merchantId,
      stateToken: presentedState(req),
      context: bindContext(req, body.surface),
    });
    sendSuccess(res, result);
  } catch (error: unknown) {
    respondWithError(res, error, 'Failed to bind the merchant referral');
  }
}

/**
 * `GET /referrals/state` — what this caller's browser is holding.
 *
 * Answers ONLY what a disclosure banner needs, and it answers it from the
 * CARRIER rather than from any stored attribution: a request for "who am I
 * attributed to" would be a partner-identity read on somebody's session, which
 * #143 authenticated rule 7 forbids in both directions. So there is no partner,
 * no program, no code and no attribution id in the response — and no query
 * parameter that could ask for one.
 */
export function referralStateHandler(req: Request, res: Response): void {
  const claims = verifyReferralState(presentedState(req), new Date());
  const view: ReferralStateView = {
    state: claims === null ? 'none' : 'pending',
    // Disclosure travels with the LINK, and a carrier is proof a link was
    // followed — so a client holding one renders the disclosure whether or not
    // it has bound yet.
    disclosureRequired: claims !== null,
  };
  sendSuccess(res, view);
}
