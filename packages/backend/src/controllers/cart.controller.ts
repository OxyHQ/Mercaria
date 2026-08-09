/**
 * Cart controller (THIN) — the buyer's basket, for either kind of buyer.
 *
 * Logic lives in `cart.service` and `cart-merge.service`. Every response is the
 * freshly hydrated `Cart` DTO (live prices, availability, subtotal, stale and
 * review flags), so the client always sees current state after a mutation.
 *
 * ## The actor, and the two things this layer decides about it (#104)
 *
 * Handlers read `req.commerceActor` — resolved once by `resolveCommerceActor` —
 * and translate it through the ONE `cartOwnerForActor`. Nothing here parses a
 * credential, and no handler ever reads an owner id out of a request body: a
 * client that could name an owner could name someone else's.
 *
 * Two decisions do belong here rather than in the service:
 *
 *  1. **Which writes may lazily ISSUE a guest session.** Adding an item and
 *     setting a quantity create commerce state, so they are the "first eligible
 *     stateful write" ADR 0003 D3 mints on. A READ never does (a page view
 *     creates no row — T10), and neither does a DELETE, which has nothing to
 *     create: removing a line from a cart that does not exist is a no-op, and
 *     minting a session to record that would be farming with extra steps.
 *     Pinning a DISCOUNT code does not either — it requires a non-empty cart,
 *     which requires a session the caller must already hold.
 *  2. **Uniform error shapes across actor kinds** (route requirement 7). Every
 *     refusal below is the same code and status whichever actor hit it; the one
 *     actor-specific answer is `GUEST_CART_DISABLED`, which is a statement
 *     about the deployment rather than about the caller.
 */

import type { Request, Response } from 'express';
import type {
  AddCartItemInput,
  ApplyCartDiscountInput,
  CurrencyCode,
  UpdateCartItemInput,
} from '@mercaria/shared-types';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
// Discovery and guest-commerce analytics (#77). The emitter only — nothing here
// reads a metric, and `cart-merge-isolation.test.ts` already scans this path for
// everything else it must not reach.
import { emitAnalyticsEvent } from '../services/analytics/emit.js';
import {
  clearGuestCredential,
  issueGuestActor,
  type GuestTransport,
} from '../middleware/commerce-actor.js';
import {
  addItem,
  applyDiscountCode,
  emptyCart,
  getCart,
  removeDiscountCode,
  removeItem,
  updateItem,
  type CartView,
} from '../services/cart.service.js';
import { cartOwnerForActor, mayIssueGuestCart } from '../services/cart-owner.js';
import { mergeGuestCart } from '../services/cart-merge.service.js';
import { GuestIssuanceDisabledError } from '../services/guest-session.service.js';
import { log } from '../lib/logger.js';

/** The presentment fallback a cart with no owner is quoted in (ADR 0003 D8). */
const DEFAULT_DISPLAY_CURRENCY: CurrencyCode = 'FAIR';

/**
 * The DISPLAY currency a client asked for, or `undefined`.
 *
 * Validated against the shared-types tuple here rather than trusted: an
 * unrecognised code must never become a currency, and this is the only place a
 * client can propose one. It is display-only in any case — the catalogue stores
 * native prices and checkout reprices — and it is IGNORED for an Oxy owner,
 * whose stored preference is the authority (see
 * `resolvePresentmentCurrencyForOwner`).
 */
function requestedCurrency(req: Request): CurrencyCode | undefined {
  const raw = req.query.currency;
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  return (ALL_CURRENCY_CODES as readonly string[]).includes(upper)
    ? (upper as CurrencyCode)
    : undefined;
}

/** The view (owner + display currency) for this request, or `null` with no owner. */
function cartView(req: Request): CartView | null {
  const actor = req.commerceActor;
  if (!actor) return null;
  const owner = cartOwnerForActor(actor);
  if (!owner) return null;
  const currency = requestedCurrency(req);
  return { owner, ...(currency === undefined ? {} : { requestedCurrency: currency }) };
}

/**
 * The view for a WRITE, issuing a guest session when the actor has none and
 * the deployment allows it.
 *
 * Returns `null` when the response has already been answered (a CSRF refusal
 * inside `issueGuestActor`, or the guest-cart flag being off), so the caller
 * returns without writing anything further.
 */
async function cartViewForWrite(req: Request, res: Response): Promise<CartView | null> {
  const existing = cartView(req);
  if (existing) return existing;

  const actor = req.commerceActor;
  if (!actor || !mayIssueGuestCart(actor)) {
    // A guest actor whose owner resolved to null means guest carts are off on
    // this deployment; a missing actor means the resolver did not run, which is
    // a wiring bug and must not silently write.
    // #77 guest event 14 — "a feature flag or cohort gate blocked the flow".
    // The ONE guest gate this backend can classify honestly today: the refusal
    // is a bounded ErrorCode rather than a sentence, so the reason code is read
    // off the decision rather than matched out of a message. The eligibility
    // gates (#105's P2P and destination refusals) raise generic conflicts and
    // are deferred to #106 for exactly that reason — see
    // `services/analytics/seams.ts`.
    emitAnalyticsEvent(req, {
      eventType: 'guest_feature_gate_blocked',
      reasonCode: 'guest_cart_disabled',
    });
    sendError(
      res,
      ErrorCodes.GUEST_CART_DISABLED,
      'Guest carts are not available on this deployment; sign in to continue',
      403,
    );
    return null;
  }

  const context = await issueGuestActor(req, res);
  if (!context) return null; // refused (CSRF) — already answered
  return cartView(req);
}

/** GET /cart — the hydrated cart, or an empty one for a caller who owns none. */
export async function getMyCart(req: Request, res: Response): Promise<void> {
  try {
    const view = cartView(req);
    if (!view) {
      // No session is minted to answer a read (ADR 0003 T10). This is the
      // "no-actor empty-cart behaviour" #102 selected, and it is what lets the
      // storefront render a cart screen for a visitor who has never written.
      sendSuccess(res, emptyCart(requestedCurrency(req) ?? DEFAULT_DISPLAY_CURRENCY));
      return;
    }
    sendSuccess(res, await getCart(view));
  } catch (err) {
    log.general.error({ err }, 'Failed to load cart');
    respondWithError(res, err, 'Failed to load your cart');
  }
}

/** POST /cart/items — add (or increment) a variant. May issue a guest session. */
export async function addCartItem(req: Request, res: Response): Promise<void> {
  try {
    const view = await cartViewForWrite(req, res);
    if (!view) return;
    const input = req.body as AddCartItemInput;
    const cart = await addItem(view, input);
    // TWO events, and the pair is the point. `native_add_to_cart` is emitted for
    // EVERY actor kind — it is the discovery funnel's step, and the actor
    // dimension is what tells the authenticated and guest funnels apart, which
    // is what "the same definitions" means mechanically. `guest_cart_item_added`
    // is the guest-commerce funnel's own step, emitted only for a guest owner,
    // because #77's guest event list asks for it by name and a metric that had
    // to filter one event by actor kind would be a metric with a hidden
    // denominator.
    emitAnalyticsEvent(req, {
      eventType: 'native_add_to_cart',
      entities: {
        listingId: input.listingId,
        productVariantId: input.variantId,
      },
      measures: { quantity: input.quantity },
      buyerOrigin: view.owner.kind === 'guest_session' ? 'guest' : 'authenticated',
    });
    if (view.owner.kind === 'guest_session') {
      emitAnalyticsEvent(req, {
        eventType: 'guest_cart_item_added',
        entities: { productVariantId: input.variantId },
        measures: { quantity: input.quantity, itemCount: cart.items.length },
      });
    }
    sendSuccess(res, cart, 201);
  } catch (err) {
    if (respondIfIssuanceDisabled(req, res, err)) return;
    log.general.error({ err }, 'Failed to add cart item');
    respondWithError(res, err, 'Failed to add item to cart');
  }
}

/** PATCH /cart/items/:variantId — set the absolute quantity (0 removes). */
export async function updateCartItem(req: Request, res: Response): Promise<void> {
  const variantId = routeParam(req, 'variantId');
  try {
    const { quantity } = req.body as UpdateCartItemInput;
    // A zero quantity is a REMOVAL, and a removal creates nothing — so it must
    // not mint a session either. It falls through to the read view and, with no
    // owner, answers with the same empty cart a delete of nothing would.
    const view = quantity === 0 ? cartView(req) : await cartViewForWrite(req, res);
    if (!view) {
      if (quantity === 0) {
        sendSuccess(res, emptyCart(requestedCurrency(req) ?? DEFAULT_DISPLAY_CURRENCY));
      }
      return;
    }
    sendSuccess(res, await updateItem(view, variantId, quantity));
  } catch (err) {
    if (respondIfIssuanceDisabled(req, res, err)) return;
    log.general.error({ err, variantId }, 'Failed to update cart item');
    respondWithError(res, err, 'Failed to update cart item');
  }
}

/** DELETE /cart/items/:variantId — remove a line. Never issues a session. */
export async function deleteCartItem(req: Request, res: Response): Promise<void> {
  const variantId = routeParam(req, 'variantId');
  try {
    const view = cartView(req);
    if (!view) {
      sendSuccess(res, emptyCart(requestedCurrency(req) ?? DEFAULT_DISPLAY_CURRENCY));
      return;
    }
    sendSuccess(res, await removeItem(view, variantId));
  } catch (err) {
    log.general.error({ err, variantId }, 'Failed to remove cart item');
    respondWithError(res, err, 'Failed to remove cart item');
  }
}

/** POST /cart/discount — pin a discount code. Requires an existing cart. */
export async function applyCartDiscount(req: Request, res: Response): Promise<void> {
  try {
    const view = cartView(req);
    if (!view) {
      // Pinning a code needs a non-empty cart, so a caller without one is
      // answered with the same CONFLICT an owner with an empty cart gets — the
      // uniform shape across actor kinds, rather than a 401 that would leak
      // whether the deployment has guest carts at all.
      sendError(res, ErrorCodes.CONFLICT, 'Cart is empty', 409);
      return;
    }
    const { code } = req.body as ApplyCartDiscountInput;
    sendSuccess(res, await applyDiscountCode(view, code));
  } catch (err) {
    log.general.error({ err }, 'Failed to apply cart discount');
    respondWithError(res, err, 'Failed to apply discount code');
  }
}

/** DELETE /cart/discount/:code — remove a pinned discount code. */
export async function deleteCartDiscount(req: Request, res: Response): Promise<void> {
  const code = routeParam(req, 'code');
  try {
    const view = cartView(req);
    if (!view) {
      sendSuccess(res, emptyCart(requestedCurrency(req) ?? DEFAULT_DISPLAY_CURRENCY));
      return;
    }
    sendSuccess(res, await removeDiscountCode(view, code));
  } catch (err) {
    log.general.error({ err, code }, 'Failed to remove cart discount');
    respondWithError(res, err, 'Failed to remove discount code');
  }
}

/**
 * POST /cart/merge — fold the presented guest cart into the Oxy cart (#104).
 *
 * EXPLICIT and server-authorized, never implicit: the person must be Oxy
 * authenticated AND still present a valid guest credential, which the resolver
 * has already verified before it surfaces `presentedGuestSessionId`. A client
 * cannot name a session id — the field is not read from the body, the query or
 * a header, so there is nothing to forge.
 *
 * A caller with no presented guest credential is NOT an error: it is the state
 * a retry lands in once the first merge revoked the credential (ADR 0003
 * diagram 3), so it answers 200 with the current cart and `merged: false`. The
 * flag is not deployment-gated the way guest cart WRITES are — a cart created
 * while guest carts were on must stay mergeable after they are switched off,
 * which is "gate the loop, never the durable record".
 */
export async function mergeGuestCartHandler(req: Request, res: Response): Promise<void> {
  try {
    const actor = req.commerceActor;
    if (actor?.kind !== 'oxy') {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Sign in to merge your guest cart', 401);
      return;
    }

    const currency = requestedCurrency(req);
    const view: CartView = {
      owner: { kind: 'oxy_user', oxyUserId: actor.oxyUserId },
      ...(currency === undefined ? {} : { requestedCurrency: currency }),
    };

    if (actor.presentedGuestSessionId === undefined) {
      sendSuccess(res, {
        merged: false,
        linesAdded: 0,
        linesCombined: 0,
        linesClamped: 0,
        linesFlagged: 0,
        discountCodesAdded: 0,
        discountCodesDropped: 0,
        reasons: [],
        // Nothing was presented, so nothing was revoked — and a client told to
        // discard a credential it does not hold would clear one it may have
        // legitimately re-acquired.
        guestCredentialRevoked: false,
        cart: await getCart(view),
      });
      return;
    }

    const result = await mergeGuestCart({
      guestSessionId: actor.presentedGuestSessionId,
      oxyUserId: actor.oxyUserId,
      ...(currency === undefined ? {} : { requestedCurrency: currency }),
    });

    // Answer the revocation in the carriage the credential arrived in (D9).
    // Header transport has nothing server-side to clear; `guestCredentialRevoked`
    // in the body is that client's discard instruction.
    const transport: GuestTransport = req.presentedGuestTransport ?? 'cookie';
    clearGuestCredential(res, transport);
    // The merge OUTCOME, as a bounded reason code — never the session id, never
    // a line, never a discount code. `cart_merges` already records the counts
    // durably; this event exists so the funnel can show where a sign-in landed,
    // and it deliberately carries no more than the audit row does.
    emitAnalyticsEvent(req, {
      eventType: 'guest_cart_merged',
      reasonCode: result.merged ? 'merge_completed' : 'merge_already_done',
      measures: {
        itemCount: result.linesAdded + result.linesCombined,
      },
    });
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Failed to merge guest cart');
    respondWithError(res, err, 'Failed to merge your guest cart');
  }
}

/**
 * Answer the issuance kill switch (`GUEST_SESSION_ISSUANCE_ENABLED=false`) as
 * a retryable 503, matching the `/guest/session` surface exactly.
 *
 * A buyer whose add-to-cart lands during an abuse incident is told to try
 * again, not handed a 500 that reads as "the shop is broken".
 */
function respondIfIssuanceDisabled(req: Request, res: Response, err: unknown): boolean {
  if (!(err instanceof GuestIssuanceDisabledError)) return false;
  // The second real gate, and the same bounded-code reasoning as the cart one
  // above: the incident kill switch is a decision this code MADE, not a
  // sentence it has to parse back.
  emitAnalyticsEvent(req, {
    eventType: 'guest_feature_gate_blocked',
    reasonCode: 'guest_issuance_disabled',
  });
  sendError(
    res,
    ErrorCodes.GUEST_ISSUANCE_DISABLED,
    'Guest session issuance is temporarily disabled',
    503,
  );
  return true;
}
