/**
 * Public connector OAuth callback, mounted at `/channels/oauth`.
 *
 * The external platform redirects the merchant's browser here after they
 * authorize the app. This endpoint is PUBLIC (no Oxy session — the browser is
 * the merchant's, mid-OAuth), so authenticity rests on TWO checks before any
 * connection is written:
 *   1. the platform's own signature over the callback (Shopify `hmac`), and
 *   2. our signed, expiring `state` token, which binds the flow to the
 *      `{ storeId, provider, shopDomain }` an authenticated member chose at
 *      connect time (so the `storeId` written cannot be forged).
 *
 * Server-to-server by design — there is no browser CORS involved.
 *
 * Once the connection exists it is LINKED back onto the wizard session the signed
 * `state` names, which is the only moment anything can: the merchant's browser is
 * at the platform for the whole connect and answers into a different tab, so no
 * client ever holds this connection. See the step 3 comment below.
 *
 * The success redirect is a single CONFIGURED url plus `?connected=<provider>`
 * and stays that way. Nothing a caller supplied composes it — a tampered `state`
 * is answered 400 and never a redirect derived from an unverified parameter — and
 * the wizard session id rides inside the SIGNED payload for exactly that reason.
 */

import { Router, type Request, type Response } from 'express';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { isImplementedProvider } from '../connectors/registry.js';
import { verifyOAuthState } from '../connectors/oauth-state.js';
import { getOAuthRedirectUri, getOAuthSuccessRedirectUrl } from '../connectors/config.js';
import { verifyShopifyOAuthCallback } from '../connectors/shopify/callback.js';
import { connectAndVerify } from '../services/connector-sync.service.js';
import { channelTypeForConnection } from '../services/channels/channel-catalog.js';
import { recordOAuthConnectionOnSession } from '../services/channels/channel-onboarding.service.js';
import { routeParam } from '../utils/request.js';
import { isMercariaError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

const router = Router();

/** Send a minimal, non-leaking text response to the merchant's browser. */
function sendText(res: Response, status: number, message: string): void {
  res.status(status).type('text/plain').send(message);
}

/** Read a scalar string query param, or `undefined` when absent/repeated. */
function queryString(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * GET /channels/oauth/:provider/callback — validate the callback and finalize the
 * connection (exchange code → verify → store encrypted credentials).
 */
router.get('/:provider/callback', makeRateLimiter('channels'), async (req, res) => {
  const provider = routeParam(req, 'provider');
  if (!isImplementedProvider(provider)) {
    sendText(res, 404, 'Unknown connector provider');
    return;
  }

  // 1. Platform authenticity (Shopify signs the callback query with the app secret).
  if (provider === 'shopify' && !verifyShopifyOAuthCallback(req.query)) {
    sendText(res, 401, 'Invalid callback signature');
    return;
  }

  const code = queryString(req, 'code');
  const state = queryString(req, 'state');
  if (!code || !state) {
    sendText(res, 400, 'Missing code or state');
    return;
  }

  try {
    // 2. Our signed state → the store/provider/shop the flow was started for.
    const claims = verifyOAuthState(state);
    if (claims.provider !== provider) {
      sendText(res, 400, 'State/provider mismatch');
      return;
    }
    const shop = queryString(req, 'shop');
    if (shop && shop.toLowerCase() !== claims.shopDomain) {
      sendText(res, 400, 'State/shop mismatch');
      return;
    }

    const connection = await connectAndVerify(claims.storeId, provider, {
      code,
      shopDomain: claims.shopDomain,
      redirectUri: getOAuthRedirectUri(provider),
    });

    // 3. Link it back onto the wizard the merchant started from, when the signed
    //    state named one. This is the ONLY place it can happen: the browser is at
    //    the platform for the whole of the connect, and on web it answers into a
    //    DIFFERENT tab from the one holding the wizard — so nothing on the client
    //    ever sees this connection. Without it the session's `connectionId` stays
    //    NULL, the wizard re-renders its connect step forever and activation
    //    reports `connection_not_connected` against a channel that is connected.
    //
    //    Wrapped, and deliberately: the connection is already created, verified
    //    and stored, and the authorization code is spent. Failing the callback
    //    here would report a failure for a connect that SUCCEEDED, and re-running
    //    it is not possible. The merchant's remedy is the one they already have —
    //    reopen the wizard — so the cost of the catch is a slower path to the same
    //    place, and the cost of no catch is a working connection reported broken.
    if (claims.onboardingSessionId !== undefined) {
      const sessionId = claims.onboardingSessionId;
      try {
        const link = await recordOAuthConnectionOnSession({
          storeId: claims.storeId,
          sessionId,
          connectionId: connection.id,
          actorOxyUserId: claims.userId,
          channelType: channelTypeForConnection(connection),
        });
        if (link.outcome === 'skipped') {
          log.general.warn(
            { provider, sessionId, reason: link.reason },
            'Connected, but the onboarding session was not updated',
          );
        }
      } catch (err) {
        log.general.error(
          { err, provider, sessionId },
          'Connected, but failed to update the onboarding session',
        );
      }
    }

    const successRedirect = getOAuthSuccessRedirectUrl();
    if (successRedirect) {
      const separator = successRedirect.includes('?') ? '&' : '?';
      res.redirect(302, `${successRedirect}${separator}connected=${provider}`);
      return;
    }
    sendText(res, 200, `Connected to ${provider}. You can close this window and return to Mercaria.`);
  } catch (err) {
    log.general.error({ err, provider }, 'Connector OAuth callback failed');
    if (isMercariaError(err)) {
      sendText(res, err.httpStatus, err.message);
      return;
    }
    sendText(res, 500, 'Failed to complete the connection');
  }
});

export default router;
