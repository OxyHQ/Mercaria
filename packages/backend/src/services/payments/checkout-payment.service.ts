/**
 * The rail a checkout funds through — chosen, refused or opened.
 *
 * ## Why this is not in `checkout.service`
 *
 * The same boundary `provider-account.service` draws, and for the same reason:
 * `checkout.service` must not import a Stripe module. ADR 0001's last consequence
 * is that everything provider-specific stays behind the payment domain, so that
 * a future rail plugs into the same seam — and a Stripe import in the
 * checkout path would make the card rail structural to placing an order.
 *
 * So the split is by vocabulary. This file knows that a checkout has a rail, that
 * a rail has eligible currencies, and that a buyer's client gets a handoff. It
 * does not know what a PaymentIntent is; the adapter behind the registry owns
 * that entirely.
 *
 * ## Every function here is safe to call twice
 *
 * A checkout replay converges — the Redis claim, the per-order unique index, the
 * payment's `UNIQUE(checkout_group_id)` and the rail's own idempotency key all
 * point the second attempt at what the first one made. That property has to hold
 * through THIS file too, because the payment is opened after the orders exist:
 * a converging replay reaches `openCheckoutPayment` with a group that already has
 * a payment and must come back with the SAME client material, not a second
 * charge for the same goods.
 */

import type {
  CheckoutPaymentHandoff,
  CheckoutPaymentMethod,
  CheckoutPaymentStatus,
  CheckoutPaymentSurfaceMethod,
  CurrencyCode,
  Money,
} from '@mercaria/shared-types';
import {
  assertSafeMoneyAmount,
  FORBIDDEN_PAYMENT_METADATA_SUBSTRINGS,
  PAYMENT_METADATA_KEYS,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  attachPaymentProviderObject,
  findNativePaymentByCheckoutGroupId,
} from '../../db/payments/paymentRepository.js';
import {
  findOrdersByCheckoutGroup,
  type CheckoutGroupOwner,
  type OrderRecord,
} from '../../db/orders/orderRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { findGuestCheckoutIdForGroup } from './guest-correlation.js';
import { ensurePayment } from './payment.service.js';
import { isResumableProvider } from './provider.js';
import { resolvePaymentProvider } from './registry.js';

/**
 * Which rail this checkout will use.
 *
 * `none` is a real answer, not a failure: a deployment with no rail configured
 * places orders exactly as it did before any of this existed, and the dev
 * `mock` seam funds a group from its own endpoint rather than at checkout.
 */
export type CheckoutRail = 'stripe' | 'none';

/**
 * Decide the rail, or refuse.
 *
 * ## The default has to be EXACTLY the old behaviour
 *
 * A request that names no method gets the card rail when it is enabled and
 * nothing when it is not — so a client written before payments existed keeps
 * working, and turning the rail off is a complete rollback rather than a
 * half-state. That is pinned from both sides in the checkout suite.
 *
 * ## Naming an unavailable rail is refused, never downgraded
 *
 * A buyer who asked to pay by card and received a 201 with no way to pay has
 * been told the wrong thing, and would discover it only when their reservation
 * expired. The refusal is a `conflict` because the request is well-formed and
 * the deployment simply cannot serve it.
 */
export function resolveCheckoutRail(requested: CheckoutPaymentMethod | undefined): CheckoutRail {
  if (requested === 'stripe') {
    if (!config.payments.stripe.enabled) {
      throw conflict('Card payments are not available on this deployment.');
    }
    return 'stripe';
  }
  if (requested === 'mock') {
    if (!config.orders.mockPayEnabled) {
      // Hard-gated off in production. Saying "not available" rather than
      // "unknown method" is the honest answer and leaks nothing: the mock rail
      // is documented, and its absence is a deployment fact.
      throw conflict('The mock payment rail is not available on this deployment.');
    }
    // The dev seam does not open a payment at checkout — `POST /orders/:id/
    // mock-pay` funds the whole group through the synthetic rail afterwards. So
    // this checkout behaves exactly like one on a deployment with no rail.
    return 'none';
  }
  return config.payments.stripe.enabled ? 'stripe' : 'none';
}

/**
 * Refuse a cart the rail cannot charge — BEFORE anything is reserved.
 *
 * ADR 0001 D8 limits the launch to EUR and USD presentment, and this is checked
 * in the same place and for the same reason as the seller-readiness gate: a
 * question that needs no stock to answer must never have taken any.
 *
 * The message NAMES the eligible set, because the buyer's only remedy is to
 * switch their display currency and the client cannot offer that without knowing
 * what to switch to. A minimum-amount refusal is deliberately NOT pre-checked
 * here — Stripe enforces its own minimum against the settlement currency after
 * conversion, so a local copy of that rule would be a second, drifting one.
 */
export function assertCheckoutCurrencyEligible(rail: CheckoutRail, currency: CurrencyCode): void {
  if (rail !== 'stripe') return;
  const eligible = config.payments.stripe.presentmentCurrencies;
  if (eligible.includes(currency)) return;

  throw conflict(
    `Card payments are not available in ${currency}. Switch your currency to ` +
      `${eligible.join(' or ')} and try again.`,
  );
}

/**
 * Open (or re-open) the payment for a checkout group and hand the buyer's client
 * what it needs.
 *
 * ## The order of the two idempotency layers
 *
 * The Mercaria payment record comes first, because its id is what the rail's
 * idempotency key is derived from (ADR 0001 D11 `pi:<paymentId>`) and what the
 * rail's metadata carries back in a webhook. Its `UNIQUE(checkout_group_id)`
 * means a replay converges on one payment, so the derived key is the same key,
 * so the rail converges on one charge. Deriving the key from the request instead
 * would make a retry a second charge — the whole failure the scheme prevents.
 *
 * ## An already-opened payment is READ, not re-created
 *
 * Rails expire idempotency keys (Stripe's last 24 hours), so a buyer returning to
 * an unpaid checkout the next day would otherwise be handed a SECOND charge
 * object for orders the first one can still fund. Once Mercaria has recorded the
 * provider's object id, that id is what gets read — which cannot produce a
 * second one whatever the age of the key.
 */
export async function openCheckoutPayment(input: {
  rail: CheckoutRail;
  checkoutGroupId: string;
  /**
   * The Oxy buyer, when there is one.
   *
   * OPTIONAL since #105, and the omission is the whole of the guest change in
   * this file: `payments.buyer_oxy_user_id` was already nullable, correlation
   * runs `payments.checkout_group_id` → `guest_checkouts` (ADR 0003 D4), and
   * the rail's own request has no buyer parameter to widen (ADR 0006 G1). A
   * guest payment is byte-for-byte the payment ADR 0001 defined.
   */
  buyerOxyUserId?: string;
  /**
   * The group's orders — the source of both the amount and the metadata ids.
   *
   * The ORDERS rather than a figure the caller computed, and rather than a query
   * this file makes. They are the immutable record of what the buyer was shown,
   * so charging their sum is the only amount that matches a document the buyer
   * holds; and taking them as an argument is what lets the rail-is-off path cost
   * nothing at all — no sum, no read, no allocation.
   */
  orders: readonly OrderRecord[];
}): Promise<CheckoutPaymentHandoff | undefined> {
  if (input.rail !== 'stripe') return undefined;

  const amount = groupPresentmentTotal(input.orders);
  const orderIds = input.orders.map((order) => order.id);

  const provider = resolvePaymentProvider('stripe');
  if (!provider) {
    // `resolveCheckoutRail` already refused this case. Reaching here means the
    // configuration changed mid-request, which is worth a loud failure rather
    // than a silent order with no payment.
    throw conflict('Card payments are not available on this deployment.');
  }

  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId: input.checkoutGroupId,
    presentment: amount,
    ...(input.buyerOxyUserId !== undefined ? { buyerOxyUserId: input.buyerOxyUserId } : {}),
  });

  // ADR 0006 G7's third metadata key, read from the group rather than passed in
  // by the caller. Reading it here is what makes it survive a CONVERGING
  // replay: `summarizePriorGroup` re-opens a payment for a group it did not
  // create and has no contact record in hand, so a parameter would be absent
  // exactly when the metadata has to come out byte-identical.
  //
  // `undefined` for an Oxy buyer's group — the ordinary case, not a failure.
  const guestCheckoutId = await findGuestCheckoutIdForGroup(input.checkoutGroupId);

  const result =
    payment.providerObjectId && isResumableProvider(provider)
      ? await provider.resumePayment(payment.providerObjectId)
      : await provider.createPayment({
        paymentId: payment.id,
        checkoutGroupId: input.checkoutGroupId,
        amount,
        orderIds,
        idempotencyKey: `pi:${payment.id}`,
        metadata: buildPaymentMetadata({
          paymentId: payment.id,
          checkoutGroupId: input.checkoutGroupId,
          orderIds,
          ...(guestCheckoutId !== undefined ? { guestCheckoutId } : {}),
        }),
      });

  if (!payment.providerObjectId) {
    // Attached rather than transitioned. The payment stays `created` — which is
    // true, it has been opened and nobody has acted on it — and the rail's own
    // events are what move it. Inventing a status here would put a client-time
    // guess in front of the verified one.
    await attachPaymentProviderObject(getDb(), payment.id, result.providerObjectId);
  }

  if (result.clientAction?.kind !== 'client_secret') {
    throw conflict('The payment rail did not return client material for this checkout.');
  }

  const stripe = config.payments.stripe;
  const returnUrl = checkoutReturnUrl(input.checkoutGroupId);
  return {
    paymentId: payment.id,
    provider: 'stripe',
    clientSecret: result.clientAction.value,
    ...(stripe.publishableKey ? { publishableKey: stripe.publishableKey } : {}),
    amount,
    methods: checkoutPaymentSurfaces(),
    ...(returnUrl !== undefined ? { returnUrl } : {}),
  };
}

/**
 * Which payment surfaces this deployment permits a client to render — #107's
 * server-authoritative method eligibility, and the whole of what "authoritative"
 * means here.
 *
 * The server names an UPPER BOUND and the device narrows it. That split is not a
 * compromise, it is the only correct division of the question: only the browser
 * knows whether an Apple Pay sheet exists on this machine and only Stripe knows
 * whether the domain is registered, while only the server knows whether an
 * operator has switched a wallet off mid-incident. A client cannot ADD a surface
 * the server withheld — the Express Checkout Element and PaymentSheet are both
 * configured from this list — and the server cannot force one the device cannot
 * show.
 *
 * Buyer origin is deliberately NOT an input. ADR 0006 G2 puts both actor kinds
 * on one client component, B11 forbids origin-dependent treatment, and a guest
 * offered a smaller set of ways to pay than an account holder would be exactly
 * the second-class checkout ADR 0003 refuses. It takes no arguments at all,
 * which is the version of that promise a reviewer can check.
 */
export function checkoutPaymentSurfaces(): readonly CheckoutPaymentSurfaceMethod[] {
  return config.payments.stripe.paymentSurfaceMethods;
}

/**
 * Where a buyer sent away for authentication comes back to — ADR 0006 G10.
 *
 * The group id is appended by the SERVER onto a configured origin, so a client
 * cannot choose where a bank redirect lands (the `onboardingBaseUrl` reasoning:
 * a URL built from a request header behind an ALB is an open redirect with a
 * bank's own first hop in front of it). What it carries is one opaque
 * server-issued uuid and nothing else — no token, no order number, no contact,
 * because the return proves nothing and the status endpoint authenticates its
 * caller separately.
 *
 * A malformed configured value produces NO return url rather than a broken one:
 * `confirmPayment` then runs with `redirect: 'if_required'`, in-frame
 * authentication still completes, and only a full-redirect challenge fails —
 * visibly, in front of the buyer. Returning a URL that cannot be parsed would
 * instead be handed to Stripe and fail inside their sheet.
 */
export function checkoutReturnUrl(checkoutGroupId: string): string | undefined {
  const configured = config.payments.stripe.checkoutReturnUrl;
  if (configured === undefined) return undefined;
  try {
    const url = new URL(configured);
    url.searchParams.set('checkoutGroupId', checkoutGroupId);
    return url.toString();
  } catch {
    log.general.error(
      { configured },
      '[Payments] STRIPE_CHECKOUT_RETURN_URL is not a valid URL; payment authentication will ' +
        'complete in place and a redirect-only challenge will fail visibly',
    );
    return undefined;
  }
}

/**
 * What the buyer is charged for a whole checkout group: the sum of its orders'
 * presentment grand totals.
 *
 * Summed from the orders rather than recomputed from the cart, because the
 * orders are the immutable record of what the buyer was shown — and the charge
 * has to be that figure exactly, or the buyer is billed something no document of
 * theirs states. It is also what lets a converging replay price a group it did
 * not create.
 */
function groupPresentmentTotal(orders: readonly OrderRecord[]): Money {
  const [first] = orders;
  if (!first) {
    throw conflict('This checkout has no orders to pay for.');
  }
  const amount = orders.reduce(
    (total, order) => total + order.totalsGrandTotalPresentmentAmount,
    0,
  );
  assertSafeMoneyAmount(amount, 'checkout.payment.amount');
  return { amount, currency: first.totalsGrandTotalPresentmentCurrency as CurrencyCode };
}

/**
 * The rail's metadata for a payment — ADR 0001 D11's contract, extended by
 * ADR 0006 G7 with one guest key.
 *
 * `paymentId` is the correlation the webhook resolver reads, and it is the ONLY
 * one anything depends on. `orderIds` is reconciliation convenience for a person
 * reading the rail's own dashboard, so it is included when it fits inside
 * Stripe's 500-character metadata value and dropped entirely when it does not —
 * a truncated list would look complete and name the wrong set of orders.
 * `orderCount` is always present, so a reader can tell a dropped list from a
 * single-seller checkout.
 *
 * `guestCheckoutId` appears on a guest-origin payment and nowhere else. It is
 * the DURABLE Mercaria correlation (ADR 0006 B2) — it outlives the guest
 * session, it authorizes nothing, and it is deterministic on replay because
 * `guest_checkouts` is UNIQUE per checkout group. That last property is load
 * bearing rather than pleasant: a converging retry must compose a byte-identical
 * request or Stripe rejects the reused idempotency key, and this is the one key
 * whose value comes from a second table.
 *
 * The ids are SORTED, for the same reason: "the order the rows came back in" is
 * not a guarantee worth resting a reused idempotency key on.
 *
 * ## The two gates below are not belt and braces
 *
 * They fail differently, which is why both are here. The allow-list catches a
 * key nobody thought about — a spread, a widened input type, a field added to
 * this function's parameter object. The forbidden-substring scan catches a key
 * somebody added ON PURPOSE under a plausible name (`buyerEmail`,
 * `guestSessionId`, `portalToken`), which the allow-list would also catch but
 * which a future author might be tempted to "fix" by extending the allow-list.
 * Extending BOTH, in one diff, to put an email in provider metadata is not
 * something that happens by accident.
 *
 * They throw rather than filtering. A metadata key that should not exist is a
 * defect in the composition above, and silently dropping it would let the defect
 * ship — while a payment that refuses to open is a checkout failure somebody
 * fixes that afternoon.
 */
function buildPaymentMetadata(input: {
  paymentId: string;
  checkoutGroupId: string;
  orderIds: readonly string[];
  /** The `guest_checkouts` row id, on a guest-origin group only (G7). */
  guestCheckoutId?: string;
}): Record<string, string> {
  const joined = [...input.orderIds].sort().join(',');
  const metadata: Record<string, string> = {
    paymentId: input.paymentId,
    checkoutGroupId: input.checkoutGroupId,
    ...(input.guestCheckoutId !== undefined ? { guestCheckoutId: input.guestCheckoutId } : {}),
    orderCount: String(input.orderIds.length),
    ...(joined.length <= METADATA_VALUE_MAX_LENGTH ? { orderIds: joined } : {}),
  };
  assertPaymentMetadataKeys(metadata);
  return metadata;
}

/**
 * Refuse metadata carrying a key ADR 0006 G7 does not name — see
 * {@link buildPaymentMetadata} for why there are two independent checks.
 *
 * Exported so the isolation suite can drive it against composed records rather
 * than re-deriving the rule, which would be a second copy of it.
 */
export function assertPaymentMetadataKeys(metadata: Record<string, string>): void {
  for (const key of Object.keys(metadata)) {
    if (!(PAYMENT_METADATA_KEYS as readonly string[]).includes(key)) {
      throw conflict(`Payment metadata may not carry '${key}'.`);
    }
    const lowered = key.toLowerCase();
    const forbidden = FORBIDDEN_PAYMENT_METADATA_SUBSTRINGS.find((substring) =>
      lowered.includes(substring),
    );
    if (forbidden !== undefined) {
      throw conflict(`Payment metadata may not carry '${key}'.`);
    }
  }
}

/** Stripe's per-value metadata limit. */
const METADATA_VALUE_MAX_LENGTH = 500;

/**
 * What the buyer may learn about their checkout group's payment.
 *
 * Scoped to the CALLER's own orders — `findOrdersByCheckoutGroup` filters by
 * owner, so a group id belonging to somebody else answers 404 rather than
 * leaking that it exists. That is the whole authorization: a checkout group is a
 * server-issued uuid, and the orders under it are the only thing that proves who
 * it belongs to.
 *
 * The owner is a `CheckoutGroupOwner` since #105, not an Oxy id: a guest who
 * placed the group polls this endpoint exactly as an Oxy buyer does, and the
 * guest branch scopes through `guest_checkouts.guest_session_id` rather than a
 * buyer column (ADR 0006 G10). Widening the SCOPE is all that changes — the
 * projection is identical and still answers from the payment aggregate, so a
 * client of either kind still cannot forge paid state.
 */
export async function readCheckoutPaymentStatus(
  owner: CheckoutGroupOwner,
  checkoutGroupId: string,
): Promise<CheckoutPaymentStatus> {
  const orders = await findOrdersByCheckoutGroup(checkoutGroupId, owner);
  if (orders.length === 0) {
    throw notFound('Checkout not found');
  }

  const payment = await findNativePaymentByCheckoutGroupId(getDb(), checkoutGroupId);
  return {
    checkoutGroupId,
    ...(payment
      ? {
          status: payment.status,
          provider: payment.provider,
          amount: {
            amount: payment.presentmentAmount,
            currency: payment.presentmentCurrency as CurrencyCode,
          },
        }
      : {}),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
    })),
  };
}

/**
 * Give up on a swept checkout group's payment, best effort.
 *
 * The reservation sweep's seam. It is here rather than called directly from the
 * queue handler so the sweep — which is about inventory — never has to know a
 * payment domain exists beyond this one call, and so a failure in it can never
 * stop stock going back: the orders are already cancelled by the time this runs,
 * and the worst case of a failure is a payment row that stays `created` and an
 * intent Stripe eventually expires on its own.
 */
export async function releaseCheckoutPayments(checkoutGroupIds: readonly string[]): Promise<void> {
  if (checkoutGroupIds.length === 0) return;
  const { cancelPaymentForCheckoutGroup } = await import('./payment.service.js');

  for (const checkoutGroupId of checkoutGroupIds) {
    try {
      await cancelPaymentForCheckoutGroup(checkoutGroupId);
    } catch (error: unknown) {
      log.general.warn(
        { err: error, checkoutGroupId },
        '[Payments] could not release the payment for an expired checkout group',
      );
    }
  }
}
