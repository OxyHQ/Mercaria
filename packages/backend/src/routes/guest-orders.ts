/**
 * The guest order portal's public surface (#108).
 *
 * Seven routes and no eighth. Each is one of the four things a person with a
 * placed guest order can legitimately do — get a link, use a link, look at
 * their orders, or cut off everyone else's access — plus the confirmation the
 * paying device pulls and the sign-out that closes its own session.
 *
 * ## Mounted UNCONDITIONALLY, and that is acceptance 10
 *
 * "Existing guest orders remain accessible when guest checkout creation is
 * feature-disabled later." So this router reads none of the four guest levers,
 * and `guest-portal-isolation.test.ts` fails the build if it starts to. Turning
 * guest commerce off stops new sessions and new guest checkouts; it must never
 * strand a person who already paid.
 *
 * ## Nothing here accepts a scope, a purpose, a destination or an email as an
 * authorization input
 *
 * The exchange takes one opaque token. The reads take a group id that is
 * COMPARED to the credential's rather than trusted. Recovery takes an address
 * it only ever hashes, and an order number it only ever narrows with. There is
 * no body field anywhere below that could widen what a caller may reach — which
 * is #108 magic-link rule 7 and invariant I4, held by the schemas.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import {
  clearPortalCredential,
  declaredPortalTransport,
  passesPortalCookieCsrf,
  requirePortalSession,
  resolvePortalSession,
  setPortalCredential,
} from '../middleware/guest-portal.js';
import { resolveCommerceActor } from '../middleware/commerce-actor.js';
import {
  exchangeMagicLinkToken,
  mintPostCheckoutGrant,
  recordContactVerification,
  revokePortalGrant,
  stepUpSatisfied,
  toPortalSessionState,
} from '../services/guest-portal/grant.service.js';
import {
  groupHasBeenPaid,
  readGuestOrderPortalView,
  readGuestOrderStatusView,
  secureAccess,
} from '../services/guest-portal/portal.service.js';
import {
  requestGuestOrderRecovery,
  requestStepUpLink,
} from '../services/guest-portal/recovery.service.js';
import { grantHasScope } from '../services/guest-portal/scopes.js';
import {
  claimGuestCheckoutGroup,
  previewGuestClaim,
  type GuestClaimRefusal,
} from '../services/guest-claims/claim.service.js';
// #77's emitter, and ONLY the emitter. It returns `void`, so there is nothing
// to await and a telemetry failure cannot turn a buyer's order read into an
// error — the signature is the guarantee.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';

const router = Router();

/**
 * The ONE sentence every recovery request gets, verbatim from #108.
 *
 * A constant rather than an inline string, because the property under test is
 * that the match and non-match paths return the SAME bytes — and two literals
 * are two things that can drift.
 */
export const GUEST_RECOVERY_ACKNOWLEDGEMENT =
  'If a matching guest purchase exists, Mercaria will send a secure access link.';

/**
 * `.strict()` throughout — the `checkoutSchema` decision. A body able to carry
 * a scope, a destination address or a group id is where one would eventually be
 * trusted, so none of them can even reach a handler.
 */
const recoverySchema = z
  .object({
    email: z.string().trim().min(3).max(320),
    /** PUBLIC and a HINT (ADR 0003 T6). Never a proof, never sufficient alone. */
    orderNumber: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const exchangeSchema = z
  .object({
    /**
     * The `mgx_` token the client read out of the URL FRAGMENT.
     *
     * A body field and never a query parameter, deliberately: a query string
     * reaches access logs, proxy logs and `Referer` headers, which is the whole
     * reason ADR 0003 T4 puts the token in the fragment in the first place.
     */
    token: z.string().trim().min(1).max(128),
  })
  .strict();

const confirmationSchema = z
  .object({
    checkoutGroupId: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * `POST /guest/orders/recover` — ask for an access link.
 *
 * ALWAYS 202 with the same body. The work runs after the response is written,
 * so a match and a non-match cannot be told apart by timing either (ADR 0003
 * T5). A malformed body is the one exception and is a 400: it says nothing
 * about whether any address exists, and answering 202 to a request that named
 * no address at all would hide a client bug behind a security property.
 */
function requestRecovery(req: Request, res: Response): void {
  const parsed = recoverySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A valid email address is required', 400);
    return;
  }

  res.status(202).json({ success: true, data: { message: GUEST_RECOVERY_ACKNOWLEDGEMENT } });

  // Emitted on EVERY request, matched or not, and carrying no checkout group —
  // #77's #108 contract verbatim. An event emitted only on a match, or one
  // naming the group it matched, would be the enumeration oracle the 202 exists
  // to close, and the denominator of `order_portal_delivery_success` would stop
  // meaning "people who asked".
  emitAnalyticsEvent(req, { eventType: 'guest_recovery_requested', buyerOrigin: 'guest' });

  // AFTER the response. `void` with an explicit catch: the work is durable
  // (a queued message row), the caller is already gone, and a rejection here
  // must be logged rather than becoming an unhandled rejection.
  void requestGuestOrderRecovery(
    {
      email: parsed.data.email,
      ...(parsed.data.orderNumber === undefined ? {} : { orderNumber: parsed.data.orderNumber }),
      clientIp: req.ip ?? '',
    },
    new Date(),
  ).catch((err: unknown) => {
    log.guest.error({ err }, '[GuestPortal] recovery work failed after the 202');
  });
}

/**
 * `POST /guest/orders/exchange` — trade a magic-link token for a portal session.
 *
 * The token arrives in the BODY because the client read it from the fragment,
 * which never leaves the browser. The credential leaves in a `Set-Cookie` or
 * the `X-Mercaria-Portal-Token` header and NEVER in the body, on either
 * transport.
 *
 * A rotation is possible here: if the caller already held a portal session and
 * the link was a step-up, the old credential is revoked inside the exchange
 * transaction (magic-link rule 9).
 */
async function exchangeToken(req: Request, res: Response): Promise<void> {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    // Same 401 as an unusable token, deliberately: a 400 for a malformed one
    // and a 401 for an expired one is a two-value oracle over the token space.
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Access link is not valid', 401);
    return;
  }

  const transport = declaredPortalTransport(req);
  // The exchange SETS a cookie, so it is as CSRF-relevant as a write
  // authenticated by one (ADR 0003 D10).
  if (transport === 'cookie' && !passesPortalCookieCsrf(req, res)) return;

  const now = new Date();
  const credential = await exchangeMagicLinkToken({
    presented: parsed.data.token,
    ...(req.portalGrant === undefined ? {} : { supersedesGrantId: req.portalGrant.id }),
    now,
  });
  if (credential === null) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Access link is not valid', 401);
    return;
  }

  // #108 email-verification rule 1: exchanging a link sent to the checkout
  // contact marks that contact verified. Best-effort and outside the exchange
  // transaction — see `recordContactVerification`.
  const paidBefore = await groupHasBeenPaid(credential.grant.checkoutGroupId);
  await recordContactVerification({
    checkoutGroupId: credential.grant.checkoutGroupId,
    paidBefore,
    now,
  });

  setPortalCredential(res, credential.token, transport);
  // The GRANT's row id, never the token: an id authorizes nothing and cannot be
  // presented anywhere, which is why the analytics vocabulary has a column it
  // may sit in and no column a credential could.
  emitAnalyticsEvent(req, {
    eventType: 'guest_recovery_exchanged',
    buyerOrigin: 'guest',
    checkoutGroupId: credential.grant.checkoutGroupId,
  });
  sendSuccess(res, credential.state, 201);
}

/**
 * `POST /guest/orders/confirmation` — the paying device pulls its bounded
 * credential.
 *
 * Runs on the COMMERCE actor resolver, because the proof it requires is a live
 * guest session — and that is the only route in this router that reads one. The
 * session must be the one whose contact record the group names, which is a JOIN
 * rather than a comparison, so a session that placed nothing matches nothing.
 *
 * The credential it mints is `tracking:read` and nothing else, so this is not
 * the cart token becoming order access (invariant I3): it is a separate,
 * narrower, separately revocable credential over one group, and full detail
 * still needs the inbox.
 */
async function mintConfirmation(req: Request, res: Response): Promise<void> {
  const parsed = confirmationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'checkoutGroupId is required', 400);
    return;
  }

  const actor = req.commerceActor;
  if (actor?.kind !== 'guest') {
    // Uniform with "not your group": an Oxy caller reads their orders through
    // `/orders`, and an anonymous one has proved nothing.
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }

  const transport = declaredPortalTransport(req);
  if (transport === 'cookie' && !passesPortalCookieCsrf(req, res)) return;

  const result = await mintPostCheckoutGrant({
    checkoutGroupId: parsed.data.checkoutGroupId,
    guestSessionId: actor.guestSessionId,
    now: new Date(),
  });
  if (result.status === 'refused') {
    if (result.refusal === 'too_many_live_grants') {
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'This order already has as many active confirmation sessions as it may',
        409,
      );
      return;
    }
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }

  setPortalCredential(res, result.credential.token, transport);
  sendSuccess(res, result.credential.state, 201);
}

/** `GET /guest/orders/session` — what this credential is and what it may do. */
function inspectSession(req: Request, res: Response): void {
  const grant = req.portalGrant;
  if (grant === undefined) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Portal access is not valid', 401);
    return;
  }
  sendSuccess(res, toPortalSessionState(grant, new Date()));
}

/**
 * `GET /guest/orders/:groupId` — the full portal view.
 *
 * Requires `orders:read`, which only a verified credential can hold, and the
 * group in the path must be the credential's own. A mismatch is a 404 and not a
 * 403: "this group exists but is not yours" is a fact about somebody else's
 * purchase.
 */
async function readPortal(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  if (!grantHasScope(grant.scopes, 'orders:read')) {
    sendError(
      res,
      ErrorCodes.FORBIDDEN,
      'Confirm your email address to see the full order',
      403,
    );
    return;
  }
  const view = await readGuestOrderPortalView(grant, new Date());
  // AFTER the read succeeded, so the metric counts portals that OPENED rather
  // than portals that were asked for.
  emitAnalyticsEvent(req, {
    eventType: 'guest_order_portal_opened',
    buyerOrigin: 'guest',
    checkoutGroupId: grant.checkoutGroupId,
  });
  sendSuccess(res, view);
}

/**
 * `GET /guest/orders/:groupId/status` — the bounded confirmation view.
 *
 * A separate route rather than a shape the full read degrades into, because the
 * two answers are different TYPES: one route returning two shapes is how a
 * client ends up rendering whichever it got.
 */
async function readStatus(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  if (!grantHasScope(grant.scopes, 'tracking:read')) {
    sendError(res, ErrorCodes.FORBIDDEN, 'This session cannot read order status', 403);
    return;
  }
  sendSuccess(res, await readGuestOrderStatusView(grant));
}

/**
 * `POST /guest/orders/:groupId/step-up` — send a fresh link before a sensitive
 * action (#108 authorization rule 3).
 *
 * Answers 202 like recovery, but for a different reason: the caller already
 * holds a credential that proves the inbox, so there is nothing to conceal —
 * the 202 says the message is queued, which is all that is true at that moment.
 * A session that is ALREADY fresh is told so rather than being sent a
 * pointless link.
 */
async function requestStepUp(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  const now = new Date();
  if (stepUpSatisfied(grant, now)) {
    sendSuccess(res, { stepUpSatisfied: true, linkSent: false });
    return;
  }
  const linkSent = await requestStepUpLink({ checkoutGroupId: grant.checkoutGroupId, now });
  res.status(202).json({ success: true, data: { stepUpSatisfied: false, linkSent } });
}

/**
 * `POST /guest/orders/:groupId/secure-access` — revoke every OTHER credential.
 *
 * A sensitive mutation, so it requires a FRESH inbox proof: the whole point is
 * that a thief holding a stolen credential must not be able to lock the owner
 * out with it, and a stolen credential is by definition not fresh unless the
 * thief also has the inbox — at which point the order is not the loss.
 */
async function secureGroup(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  const now = new Date();
  if (!stepUpSatisfied(grant, now)) {
    sendError(
      res,
      ErrorCodes.FORBIDDEN,
      'Confirm your email address again before changing access',
      403,
    );
    return;
  }
  sendSuccess(res, await secureAccess(grant, now));
}

/**
 * `GET /guest/orders/:groupId/claim` — the claim REVIEW screen's read (#109).
 *
 * Requires BOTH proofs, exactly as the POST does, and changes nothing. It is a
 * separate route rather than a field on the portal view because the portal view
 * is served to a credential with no Oxy session behind it, and "would this
 * account already own these" has no answer without one.
 *
 * It is also what makes "never auto-submit the claim immediately after
 * sign-in" (UX rule 10) a property of the API: there is no response from this
 * endpoint that completes a claim.
 */
async function readClaimPreview(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  const actor = req.commerceActor;
  if (actor?.kind !== 'oxy') {
    // The same 401 an absent portal credential gets, and for the same reason:
    // an unauthenticated caller learns nothing about whether this group is
    // claimable, claimed, or real.
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Sign in to save these orders', 401);
    return;
  }

  const preview = await previewGuestClaim({ grant, oxyUserId: actor.oxyUserId });
  if (preview === null) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  sendSuccess(res, preview);
}

/**
 * `POST /guest/orders/:groupId/claim` — move the group into the Oxy account
 * (#109, ADR 0003 D14 and diagram 8).
 *
 * The two proofs are read from the request and NOTHING else is: the resolved
 * portal grant and the resolved Oxy actor. The body is EMPTY — there is no
 * schema, because a body able to carry an account id, an email or an order
 * number is where one would eventually be trusted, and the claim service has no
 * parameter for any of them either.
 *
 * A success clears the portal credential, because the claim revoked it: leaving
 * a dead cookie in the jar would make the next portal read a confusing 401
 * rather than an obvious "you are signed in now".
 */
async function performClaim(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant === undefined || req.params.groupId !== grant.checkoutGroupId) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
    return;
  }
  const actor = req.commerceActor;
  if (actor?.kind !== 'oxy') {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Sign in to save these orders', 401);
    return;
  }

  // Emitted BEFORE the attempt, so the denominator counts confirmations rather
  // than successes. A started claim that then conflicts is exactly the case
  // `oxy_claim_funnel` needs both halves of.
  emitAnalyticsEvent(req, {
    eventType: 'guest_claim_started',
    buyerOrigin: 'guest',
    checkoutGroupId: grant.checkoutGroupId,
  });

  const outcome = await claimGuestCheckoutGroup({
    grant,
    oxyUserId: actor.oxyUserId,
    // The ONE consumer of this field besides #104's own merge endpoint. It is
    // not a proof and is never compared — see `claim.service.ts`.
    ...(actor.presentedGuestSessionId === undefined
      ? {}
      : { presentedGuestSessionId: actor.presentedGuestSessionId }),
    now: new Date(),
  });

  if (outcome.status === 'refused') {
    refuseClaim(req, res, grant.checkoutGroupId, outcome.refusal);
    return;
  }

  clearPortalCredential(res, req.portalTransport ?? 'cookie');
  emitAnalyticsEvent(req, {
    eventType: 'guest_claim_completed',
    buyerOrigin: 'guest',
    checkoutGroupId: grant.checkoutGroupId,
  });
  sendSuccess(res, outcome.result, outcome.result.alreadyClaimed ? 200 : 201);
}

/**
 * Map a bounded refusal onto a status and a sentence.
 *
 * An exhaustive `switch` rather than a lookup with a fallback, so a refusal
 * added to the service's union without deciding how a buyer is told fails
 * `tsc` — the `CheckoutRefusalReason` device (#106).
 *
 * None of the sentences names the account holding a contested group. A rival
 * claimant learns that somebody else holds it, which they must in order to
 * understand the refusal, and never who — that is a fact about a stranger's
 * purchase.
 */
function refuseClaim(
  req: Request,
  res: Response,
  checkoutGroupId: string,
  refusal: GuestClaimRefusal,
): void {
  switch (refusal) {
    case 'claiming_unavailable':
      sendError(
        res,
        ErrorCodes.GUEST_CLAIM_DISABLED,
        'Saving orders to an Oxy account is temporarily unavailable. Your order is unaffected.',
        403,
      );
      return;
    case 'claim_scope_missing':
    case 'inbox_not_verified':
      sendError(
        res,
        ErrorCodes.FORBIDDEN,
        'Confirm your email address before saving these orders to your account',
        403,
      );
      return;
    case 'access_revoked':
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Portal access is not valid', 401);
      return;
    case 'group_not_found':
      sendError(res, ErrorCodes.NOT_FOUND, 'Order not found', 404);
      return;
    case 'claimed_by_another_account':
      emitAnalyticsEvent(req, {
        eventType: 'guest_claim_conflicted',
        buyerOrigin: 'guest',
        checkoutGroupId,
      });
      sendError(
        res,
        ErrorCodes.CONFLICT,
        'These orders are already saved to another Oxy account. Contact support if that is ' +
          'not what you expected — Mercaria will not move them automatically.',
        409,
      );
      return;
  }
}

/**
 * `DELETE /guest/orders/session` — sign this credential out.
 *
 * Always 204: revocation is idempotent, and answering differently for a live,
 * expired or absent credential would make this a validity oracle. The cookie is
 * cleared unconditionally, which is a no-op when none was set.
 */
async function signOut(req: Request, res: Response): Promise<void> {
  const grant = req.portalGrant;
  if (grant !== undefined) {
    await revokePortalGrant(grant.id, new Date());
  }
  clearPortalCredential(res, req.portalTransport ?? 'cookie');
  res.status(204).end();
}

/** Wrap an async handler so a rejection becomes a response, never a hang. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
  fallback: string,
): (req: Request, res: Response) => void {
  return (req, res) => {
    void fn(req, res).catch((err: unknown) => {
      log.guest.error({ err, path: req.path }, `[GuestPortal] ${fallback}`);
      respondWithError(res, err, fallback);
    });
  };
}

// Recovery is anonymous by definition and gets the tighter network bucket.
router.post('/recover', makeRateLimiter('guest-recover'), requestRecovery);

// Everything below may present a portal credential; `resolvePortalSession`
// attaches it when one resolves and refuses nothing on its own.
router.use(resolvePortalSession);

// The confirmation mint is the ONE route that reads a guest SESSION, so the
// commerce resolver runs only here — mounting it router-wide would put a second
// credential resolution on every portal read for no reason.
router.post(
  '/confirmation',
  makeRateLimiter('guest-portal'),
  resolveCommerceActor,
  handle(mintConfirmation, 'Failed to create a confirmation session'),
);

router.post(
  '/exchange',
  makeRateLimiter('guest-portal'),
  handle(exchangeToken, 'Failed to exchange the access link'),
);
router.get('/session', makeRateLimiter('guest-portal'), inspectSession);
router.delete(
  '/session',
  makeRateLimiter('guest-portal'),
  handle(signOut, 'Failed to sign out of the portal'),
);

router.get(
  '/:groupId',
  makeRateLimiter('guest-portal'),
  requirePortalSession,
  handle(readPortal, 'Failed to read the order'),
);
router.get(
  '/:groupId/status',
  makeRateLimiter('guest-portal'),
  requirePortalSession,
  handle(readStatus, 'Failed to read the order status'),
);
router.post(
  '/:groupId/step-up',
  makeRateLimiter('guest-portal'),
  requirePortalSession,
  handle(requestStepUp, 'Failed to send a confirmation link'),
);
router.post(
  '/:groupId/secure-access',
  makeRateLimiter('guest-portal'),
  requirePortalSession,
  handle(secureGroup, 'Failed to secure access'),
);

/**
 * The claim pair (#109). BOTH resolvers run, and that is the two-sided proof
 * ADR 0003 D14 requires expressed as middleware: `requirePortalSession` refuses
 * without a live portal credential, and the handler refuses without an `oxy`
 * actor. Neither alone reaches the service.
 *
 * `resolveCommerceActor` is mounted here rather than router-wide for the reason
 * `/confirmation` states: a second credential resolution on every portal read
 * costs a database round trip nothing else needs.
 */
router.get(
  '/:groupId/claim',
  makeRateLimiter('guest-claim'),
  requirePortalSession,
  resolveCommerceActor,
  handle(readClaimPreview, 'Failed to read the claim preview'),
);
router.post(
  '/:groupId/claim',
  makeRateLimiter('guest-claim'),
  requirePortalSession,
  resolveCommerceActor,
  handle(performClaim, 'Failed to save these orders to your account'),
);

/**
 * The portal's own public base URL, exported so the boot log can state where
 * links point and a test can assert the deployment is configured.
 */
export const portalLinkBaseUrl = (): string => config.guest.portal.magicLinkBaseUrl;

export default router;
