/**
 * The rail a checkout funds through — chosen, refused or opened.
 *
 * ## Why this is not in `checkout.service`
 *
 * The same boundary `provider-account.service` draws, and for the same reason:
 * `checkout.service` must not import a Stripe module. ADR 0001's last consequence
 * is that everything provider-specific stays behind the payment domain, so that
 * #51's Faircoin rail plugs into the same seam — and a Stripe import in the
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
  CurrencyCode,
  Money,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  attachPaymentProviderObject,
  findNativePaymentByCheckoutGroupId,
} from '../../db/payments/paymentRepository.js';
import { findOrdersByCheckoutGroup, type OrderRecord } from '../../db/orders/orderRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
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
  buyerOxyUserId: string;
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
    buyerOxyUserId: input.buyerOxyUserId,
  });

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
  return {
    paymentId: payment.id,
    provider: 'stripe',
    clientSecret: result.clientAction.value,
    ...(stripe.publishableKey ? { publishableKey: stripe.publishableKey } : {}),
    amount,
  };
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
 * The rail's metadata for a payment — ADR 0001 D11's contract.
 *
 * `paymentId` is the correlation the webhook resolver reads, and it is the ONLY
 * one anything depends on. `orderIds` is reconciliation convenience for a person
 * reading the rail's own dashboard, so it is included when it fits inside
 * Stripe's 500-character metadata value and dropped entirely when it does not —
 * a truncated list would look complete and name the wrong set of orders.
 * `orderCount` is always present, so a reader can tell a dropped list from a
 * single-seller checkout.
 *
 * The ids are SORTED. A repeated call must produce a byte-identical request or
 * the rail rejects the reused idempotency key, and "the order the rows came back
 * in" is not a guarantee worth resting that on.
 */
function buildPaymentMetadata(input: {
  paymentId: string;
  checkoutGroupId: string;
  orderIds: readonly string[];
}): Record<string, string> {
  const joined = [...input.orderIds].sort().join(',');
  return {
    paymentId: input.paymentId,
    checkoutGroupId: input.checkoutGroupId,
    orderCount: String(input.orderIds.length),
    ...(joined.length <= METADATA_VALUE_MAX_LENGTH ? { orderIds: joined } : {}),
  };
}

/** Stripe's per-value metadata limit. */
const METADATA_VALUE_MAX_LENGTH = 500;

/**
 * What the buyer may learn about their checkout group's payment.
 *
 * Scoped to the CALLER's own orders — `findOrdersByCheckoutGroup` filters by
 * buyer, so a group id belonging to somebody else answers 404 rather than
 * leaking that it exists. That is the whole authorization: a checkout group is a
 * server-issued uuid, and the orders under it are the only thing that proves who
 * it belongs to.
 */
export async function readCheckoutPaymentStatus(
  oxyUserId: string,
  checkoutGroupId: string,
): Promise<CheckoutPaymentStatus> {
  const orders = await findOrdersByCheckoutGroup(checkoutGroupId, oxyUserId);
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
