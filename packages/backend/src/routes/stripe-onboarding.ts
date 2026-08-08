/**
 * The two URLs Stripe's hosted onboarding sends the seller's browser back to.
 *
 * Public and session-less by necessity: the seller arrives from stripe.com in
 * whichever browser opened the link, with no Oxy credential and no cookie. The
 * signed `state` this API issued when it minted the link is therefore the ONLY
 * thing that says who the round trip belongs to — the same shape, and the same
 * reasoning, as the connector OAuth callback next door.
 *
 * Mounted AFTER `express.json()`, unlike the webhook routers: these carry query
 * parameters, not a signed raw body, so there is nothing for a parser to consume
 * before it can be verified.
 *
 * ## Neither route writes readiness, and `return` least of all
 *
 * ADR 0001 D2 is explicit that a `return_url` redirect proves nothing. What the
 * return handler does is re-READ the account from Stripe — an authoritative call
 * to the provider, not an inference from the fact that a browser arrived — so
 * the dashboard the seller lands on shows what Stripe actually says instead of
 * whatever the last webhook happened to leave behind. If that read fails, the
 * redirect still happens: `account.updated` and the reconciliation sweep are
 * what readiness ACTUALLY depends on, and this is a latency optimisation on top
 * of them.
 *
 * ## `refresh` re-mints and never creates
 *
 * Stripe hits `refresh_url` when a link expired or was already used, mid-flow.
 * The handler mints a fresh link for the account the state names and bounces the
 * seller straight back — but it will not CREATE an account, ever. Account
 * creation stays behind the authenticated, permission-checked routes, so the
 * worst a captured or replayed state can reach is an onboarding flow for an
 * account that already exists, never a new connected account attached to
 * somebody else's store.
 */

import { Router } from 'express';
import { validateQuery } from '../middleware/validate.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { onboardingReturnQuerySchema } from '../middleware/payments-schemas.js';
import { getDb } from '../db/postgres.js';
import { findProviderAccountByOwner } from '../db/payments/providerAccountRepository.js';
import { createStripeAccountLink } from '../services/payments/stripe/client.js';
import {
  redactAccountId,
  syncAccountRow,
} from '../services/payments/stripe/account.service.js';
import { stripeOnboardingConfig } from '../services/payments/stripe/onboarding-config.js';
import {
  createOnboardingState,
  verifyOnboardingState,
  type OnboardingStateClaims,
} from '../services/payments/stripe/onboarding-state.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * Both routes are metered on the `payments` scope.
 *
 * The webhook routers carry no limiter deliberately — a per-IP bucket collapses
 * Stripe's whole address pool into one and breaks legitimate retries. These are
 * the opposite: real browsers, one seller per address, and `refresh` mints a
 * Stripe object on every hit. Not metering it would make an unauthenticated URL
 * into an unbounded Account Link generator.
 */
router.use(makeRateLimiter('payments'));

/**
 * Resolve the account a verified state names, refusing a mismatch.
 *
 * The claims carry BOTH the owner and the row id, and the row is looked up by
 * OWNER and then checked against the row id. That ordering matters: looking the
 * row up by id and trusting its owner would let a state signed for one owner
 * address whatever that row says today, while looking it up by owner and
 * comparing the id catches a token minted for an account the owner no longer
 * has.
 */
async function resolveAccount(claims: OnboardingStateClaims) {
  const row = await findProviderAccountByOwner(getDb(), {
    provider: 'stripe',
    ownerType: claims.ownerType,
    ownerId: claims.ownerId,
  });
  if (!row || row.id !== claims.accountRowId) return undefined;
  return row;
}

/** The signed claims, or `undefined` after answering 400. */
function readClaims(req: Request, res: Response): OnboardingStateClaims | undefined {
  // `validateQuery` has already refused a missing or empty `state` with the
  // standard 400 envelope; this narrows the way every other query read in the
  // codebase does, rather than asserting through `req.query`'s own type.
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  try {
    return verifyOnboardingState(state);
  } catch (err) {
    // A forged, tampered or expired state is a 400 and NOT a redirect: the only
    // destination available would be one derived from an unverified parameter,
    // which is how a signed-state check becomes an open redirect.
    log.general.warn(
      { err: isMercariaError(err) ? err.message : err },
      '[Stripe] onboarding round trip presented an unusable state',
    );
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'This onboarding link is no longer valid. Start again from your Mercaria dashboard.',
      400,
    );
    return undefined;
  }
}

/**
 * GET /stripe/onboarding/refresh — mint a fresh Account Link and bounce back.
 */
router.get('/refresh', validateQuery(onboardingReturnQuerySchema), async (req, res) => {
  const claims = readClaims(req, res);
  if (!claims) return;

  try {
    const onboarding = stripeOnboardingConfig();
    const row = await resolveAccount(claims);
    if (!row || row.revokedAt !== null) {
      // No account, or one that has been disconnected. There is nothing to
      // resume and nothing this route may create, so the seller goes back to the
      // dashboard, where an authenticated surface can tell them why.
      res.redirect(303, onboarding.returnUrl);
      return;
    }

    const state = createOnboardingState({
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      accountRowId: row.id,
    });
    const query = `?state=${encodeURIComponent(state)}`;
    const link = await createStripeAccountLink({
      account: row.providerAccountId,
      type: 'account_onboarding',
      collection_options: { fields: 'eventually_due' },
      refresh_url: `${onboarding.baseUrl}/stripe/onboarding/refresh${query}`,
      return_url: `${onboarding.baseUrl}/stripe/onboarding/return${query}`,
    });

    log.general.info(
      {
        accountRowId: row.id,
        providerAccountId: redactAccountId(row.providerAccountId),
      },
      '[Stripe] onboarding link refreshed',
    );
    res.redirect(303, link.url);
  } catch (err) {
    log.general.error({ err }, '[Stripe] onboarding refresh failed');
    sendError(
      res,
      ErrorCodes.INTERNAL_ERROR,
      'Could not resume payment onboarding. Try again from your Mercaria dashboard.',
      500,
    );
  }
});

/**
 * GET /stripe/onboarding/return — re-read from Stripe, then send the seller on.
 */
router.get('/return', validateQuery(onboardingReturnQuerySchema), async (req, res) => {
  const claims = readClaims(req, res);
  if (!claims) return;

  let destination: string;
  try {
    destination = stripeOnboardingConfig().returnUrl;
  } catch (err) {
    log.general.error({ err }, '[Stripe] onboarding return has nowhere to send the seller');
    sendError(
      res,
      ErrorCodes.INTERNAL_ERROR,
      'Payment onboarding is not fully configured on this deployment.',
      500,
    );
    return;
  }

  const row = await resolveAccount(claims);
  if (row) {
    try {
      const synced = await syncAccountRow(row);
      log.general.info(
        {
          accountRowId: synced.id,
          providerAccountId: redactAccountId(synced.providerAccountId),
          onboardingState: synced.onboardingState,
        },
        '[Stripe] onboarding returned; account re-read from Stripe',
      );
    } catch (err) {
      // Never blocks the redirect. The seller finished a hosted flow and must
      // land somewhere; readiness comes from `account.updated` and the
      // reconciliation sweep regardless of whether this read worked.
      log.general.warn(
        { err, accountRowId: row.id },
        '[Stripe] could not re-read the account on onboarding return; the webhook and the ' +
          'reconciliation sweep will converge it',
      );
    }
  }

  res.redirect(303, destination);
});

export default router;
