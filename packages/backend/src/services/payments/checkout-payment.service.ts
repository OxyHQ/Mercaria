/**
 * The rail a checkout funds through — chosen, refused or opened.
 *
 * ## Why this is not in `checkout.service`
 *
 * The same boundary `provider-account.service` draws, and for the same reason:
 * `checkout.service` must not import an adapter module. ADR 0001's last
 * consequence is that everything provider-specific stays behind the payment
 * domain, so that a future rail plugs into the same seam — and an adapter import
 * in the checkout path would make the card rail structural to placing an order.
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

import {
  permitSupervisedPayment,
  type SupervisedPurchaseContext,
} from '../supervised-shopping/purchase.service.js';

import type {
  CheckoutPaymentHandoff,
  CheckoutPaymentMethod,
  CheckoutPaymentRail,
  CheckoutPaymentStatus,
  CheckoutPaymentSurfaceMethod,
  CurrencyCode,
  FaircoinNetwork,
  FaircoinUnavailableReason,
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
import { listOrderFeeSnapshots } from '../../db/fees/orderFeeSnapshotRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { findGuestCheckoutIdForGroup } from './guest-correlation.js';
import { ensurePayment } from './payment.service.js';
import {
  type CreatePaymentRequest,
  isResumableProvider,
  type PaymentProvider,
  type ProviderPaymentResult,
} from './provider.js';
import {
  FAIRCOIN_CURRENCY,
  nativeRailPresentmentCurrencies,
  railForCurrency,
  resolveNativeRail,
  resolveRailProvider,
} from './native-rail.js';
import { findSellerAccount, parseSellerKey } from './provider-account.service.js';
import { PaymentProviderError } from './provider.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import { resolvePaymentProvider } from './registry.js';

/**
 * Which rail this checkout will use.
 *
 * `none` is a real answer, not a failure: a deployment with no rail configured
 * places orders exactly as it did before any of this existed, and the dev
 * `mock` seam funds a group from its own endpoint rather than at checkout.
 */
export type CheckoutRail = 'card' | 'faircoin' | 'none';

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
  if (requested === 'card') {
    if (!resolveNativeRail()) {
      throw conflict('Card payments are not available on this deployment.');
    }
    return 'card';
  }
  if (requested === 'faircoin') {
    if (!resolveRailProvider('faircoin')) {
      throw conflict('FairCoin payments are not available on this deployment.');
    }
    return 'faircoin';
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
  return resolveNativeRail() ? 'card' : 'none';
}

/**
 * The rail a checkout in `currency` is paid on, once its currency is known —
 * ADR 0019 D1: the rail FOLLOWS the currency (`railForCurrency`), so a buyer
 * pricing in `FAIR` pays in FairCoin and one in USD pays by card.
 *
 * Only a rail the request did NOT name moves: `resolveCheckoutRail` answers
 * `card` for an unnamed one (that is "a native rail is engaged"), and this is
 * where it becomes `faircoin` for a `FAIR` cart. A rail the buyer NAMED is
 * kept, and {@link assertCheckoutCurrencyEligible} refuses it if the currency
 * disagrees — a buyer who asked to pay by card is never handed a FairCoin
 * address, nor the reverse.
 */
export function selectCheckoutRail(
  rail: CheckoutRail,
  requested: CheckoutPaymentMethod | undefined,
  currency: CurrencyCode,
): CheckoutRail {
  if (rail === 'none' || requested !== undefined) return rail;
  const followed = railForCurrency(currency);
  return resolveRailProvider(followed) ? followed : rail;
}

/**
 * Refuse a cart the rail cannot charge — BEFORE anything is reserved.
 *
 * ADR 0001 D8 (amended 2026-11-05) limits card presentment to USD, and this is
 * checked in the same place and for the same reason as the seller-readiness
 * gate: a question that needs no stock to answer must never have taken any.
 *
 * The message NAMES the eligible set, because the buyer's only remedy is to
 * switch their display currency and the client cannot offer that without knowing
 * what to switch to. A minimum-amount refusal is deliberately NOT pre-checked
 * here — the rail enforces its own minimum against the settlement currency after
 * conversion, so a local copy of that rule would be a second, drifting one.
 */
export function assertCheckoutCurrencyEligible(rail: CheckoutRail, currency: CurrencyCode): void {
  if (rail === 'none') return;
  const eligible = nativeRailPresentmentCurrencies();
  if (rail === 'faircoin') {
    // FAIR is paid as it is priced (ADR 0019 D1). An order priced in a card
    // currency is paid in FairCoin at Peable's quote, through a FairCoin-only
    // Checkout Session (ADR 0020) — the currencies Mercaria presents an order
    // in for payment at all, so FairCoin is offered on every order a card can
    // pay and nothing narrower.
    if (currency === FAIRCOIN_CURRENCY || eligible.includes(currency)) return;
    throw conflict(
      `FairCoin payments are made for orders in ${[FAIRCOIN_CURRENCY, ...eligible].join(' or ')}. ` +
        `Switch your currency to one of them to pay with FairCoin.`,
    );
  }
  // An empty set means the deployment configured its rail's currencies away
  // entirely, and refusing every card checkout is the correct reading of that —
  // NOT the vacuous pass an `if (eligible.length === 0) return;` would give. The
  // message below names the empty set, which is the operator's own doing and
  // the only remedy anyone can act on.
  if (eligible.includes(currency)) return;

  // FairCoin is always offered (ADR 0019 D1), so the remedy names it beside the
  // card currencies whenever this deployment has it.
  const faircoin = !resolveRailProvider('faircoin')
    ? ' and try again'
    : currency === FAIRCOIN_CURRENCY
      ? ' to pay by card, or pay with FairCoin'
      : ` to pay by card, or to ${FAIRCOIN_CURRENCY} to pay with FairCoin`;
  throw conflict(
    `Card payments are not available in ${currency}. Switch your currency to ` +
      `${eligible.join(' or ')}${faircoin}.`,
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
 * Rails expire idempotency keys (Peable's last 24 hours), so a buyer returning to
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
  supervisedPurchase?: SupervisedPurchaseContext;
}): Promise<CheckoutPaymentHandoff | undefined> {
  if (input.rail === 'none') return undefined;

  const amount = groupPresentmentTotal(input.orders);
  const orderIds = input.orders.map((order) => order.id);

  // WHICH native rail pays the group, read off the ORDERS and not the request:
  // a converging replay may reach here with a request that names another
  // method, and the orders are the record of what the buyer is paying for and
  // how. A FAIR group is paid in FairCoin (ADR 0019 D1); a fiat group by the
  // method its fee snapshot was decided for (ADR 0020) — so the rail a payment
  // opens on can never disagree with the fee its orders carry.
  const paymentRail = await groupPaymentRail(input.orders, amount.currency);
  const quoted = paymentRail === 'faircoin' && amount.currency !== FAIRCOIN_CURRENCY;

  // Resolved ONCE and reused for the adapter, the payment row and the handoff.
  // Three separate resolutions could disagree if configuration changed between
  // them, and the row would then name a rail the charge was not opened on —
  // which is the correlation every webhook afterwards depends on.
  const rail = resolveRailProvider(paymentRail);
  const provider = rail ? resolvePaymentProvider(rail) : undefined;
  if (!rail || !provider) {
    // `resolveCheckoutRail` already refused this case. Reaching here means the
    // configuration changed mid-request, which is worth a loud failure rather
    // than a silent order with no payment.
    throw conflict(
      paymentRail === 'faircoin'
        ? 'FairCoin payments are not available on this deployment.'
        : 'Card payments are not available on this deployment.',
    );
  }
  // The seller a FairCoin payment pays — before the payment row exists, so a
  // group that cannot be paid this way leaves nothing behind.
  const onBehalfOf = paymentRail === 'faircoin' ? await faircoinPayee(input.orders) : undefined;

  const payment = await ensurePayment({
    provider: rail,
    checkoutGroupId: input.checkoutGroupId,
    presentment: amount,
    ...(input.buyerOxyUserId !== undefined ? { buyerOxyUserId: input.buyerOxyUserId } : {}),
  });

  if (!(await permitSupervisedPayment(payment, input.orders, input.supervisedPurchase)))
    return undefined;

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
      : await createRailPayment(provider, {
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
          ...(quoted
            ? {
                description: `Mercaria order ${input.orders
                  .map((order) => order.orderNumber)
                  .sort()
                  .join(', ')}`,
              }
            : {}),
          ...(onBehalfOf
            ? {
                onBehalfOf,
                // An unpaid FairCoin payment stops being payable when the
                // reservation does, so a buyer cannot pay for goods the sweep has
                // released. A broadcast one never expires (Peable ADR 0012 D9),
                // and the sweep keeps its orders (`handleExpireReservations`).
                expiresInSeconds: Math.max(60, Math.floor(config.orders.reservationTtlMs / 1_000)),
              }
            : {}),
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

  // No key of any kind travels with the handoff: Mercaria reaches Peable with its
  // own Oxy workload identity (ADR 0009 D20), and the rail's payment object and
  // the payer's secret over it are the only material a buyer's client needs.
  if (quoted) {
    // A fiat order paid in FairCoin: the buyer's client opens Peable's sheet
    // over the SESSION, which quotes the total in FAIR when they confirm. There
    // is no address before that, and none is invented here.
    return {
      paymentId: payment.id,
      provider: rail,
      rail: 'faircoin',
      payerObject: 'checkout_session',
      providerPaymentId: result.providerObjectId,
      clientSecret: result.clientAction.value,
      amount,
      methods: [],
    };
  }
  if (paymentRail === 'faircoin') {
    if (!result.faircoin) {
      throw conflict('The payment rail did not say where to send the FairCoin for this checkout.');
    }
    return {
      paymentId: payment.id,
      provider: rail,
      rail: 'faircoin',
      payerObject: 'payment_intent',
      faircoin: result.faircoin,
      providerPaymentId: result.providerObjectId,
      clientSecret: result.clientAction.value,
      amount,
      methods: [],
    };
  }
  return {
    paymentId: payment.id,
    provider: rail,
    rail: 'card',
    payerObject: 'payment_intent',
    providerPaymentId: result.providerObjectId,
    clientSecret: result.clientAction.value,
    amount,
    methods: checkoutPaymentSurfaces(),
  };
}

/**
 * The rail a placed group is paid on — Mercaria ADR 0020's "the payment follows
 * the method the fee was decided for".
 *
 * A FAIR group is FairCoin (no card settles FAIR). A fiat group is FairCoin
 * exactly when checkout priced its orders for a FairCoin payment
 * (`faircoin_exempt`), and card otherwise; a group whose orders disagree was not
 * produced by checkout and is refused rather than opened on either rail.
 */
async function groupPaymentRail(
  orders: readonly OrderRecord[],
  currency: CurrencyCode,
): Promise<CheckoutPaymentRail> {
  if (currency === FAIRCOIN_CURRENCY) return railForCurrency(currency);
  const snapshots = await listOrderFeeSnapshots(orders.map((order) => order.id));
  const exempt = orders.filter((order) => snapshots.get(order.id)?.result === 'faircoin_exempt');
  if (exempt.length === 0) return 'card';
  if (exempt.length === orders.length) return 'faircoin';
  throw conflict('This checkout mixes payment methods and cannot be paid. Check out again.');
}

/**
 * Create the payment at its rail, turning Peable's FairCoin refusals into a
 * classified checkout refusal the buyer is shown in words (ADR 0019 D4).
 *
 * The readiness gate already refused every case Mercaria can see ahead of a
 * payment; what is left is the gateway's own answer at creation — the seller's
 * wallet gone, or the network gate closing between the probe and this call.
 * The orders stay `pending_payment` and the sweep releases them, exactly as
 * for any refusal at this step.
 */
async function createRailPayment(
  provider: PaymentProvider,
  request: CreatePaymentRequest,
): Promise<ProviderPaymentResult> {
  try {
    return await provider.createPayment(request);
  } catch (error) {
    const reason = faircoinRefusalReason(error);
    if (reason === undefined) throw error;
    throw checkoutRefusal(
      'faircoin_unavailable',
      reason === 'price_unavailable'
        ? 'FairCoin cannot be priced for this order right now. Try again in a moment, or pay by ' +
            'card; nothing has been charged.'
        : 'This seller cannot be paid in FairCoin right now. Pay by card in USD instead; nothing ' +
            'has been charged.',
      { reason: 'faircoin_unavailable', unavailableReason: reason, sellers: [] },
    );
  }
}

/** The FairCoin reason behind a gateway refusal, or `undefined` for any other failure. */
function faircoinRefusalReason(error: unknown): FaircoinUnavailableReason | undefined {
  if (!(error instanceof PaymentProviderError) || error.provider !== 'peable_faircoin') {
    return undefined;
  }
  switch (error.code) {
    case 'faircoin_wallet_missing':
      return 'faircoin_wallet_missing';
    case 'faircoin_network_closed':
      return 'faircoin_network_closed';
    case 'account_not_ready':
      return 'seller_not_confirmed';
    case 'faircoin_price_unavailable':
      return 'price_unavailable';
    default:
      return undefined;
  }
}

/**
 * The seller a FairCoin payment pays, and the chain it is paid on: the group's
 * ONE seller's connected account, whose FairCoin half must be active.
 *
 * The readiness gate refused every other shape before reservation; this is the
 * opener's own check for a converging replay, which never passed through it.
 */
async function faircoinPayee(
  orders: readonly OrderRecord[],
): Promise<{ providerAccountId: string; network: FaircoinNetwork }> {
  const owners = new Set(
    orders.map((order) =>
      order.sellerType === 'store' ? `store:${order.storeId}` : `user:${order.sellerOxyUserId}`,
    ),
  );
  const [sellerKey] = owners;
  const owner = owners.size === 1 && sellerKey ? parseSellerKey(sellerKey) : undefined;
  if (!owner) {
    throw conflict('A FairCoin payment goes to one seller. Check out each seller separately.');
  }
  const account = await findSellerAccount(owner);
  if (account?.faircoinState !== 'active' || !account.faircoinNetwork) {
    throw conflict('This seller cannot be paid in FairCoin yet. Pay by card in USD instead.');
  }
  return { providerAccountId: account.providerAccountId, network: account.faircoinNetwork };
}

/**
 * Which payment surfaces this deployment permits a client to render — #107's
 * server-authoritative method eligibility, and the whole of what "authoritative"
 * means here.
 *
 * The server names an UPPER BOUND and the device narrows it. That split is not a
 * compromise, it is the only correct division of the question: only the browser
 * knows whether an Apple Pay sheet exists on this machine and only the rail
 * knows whether the domain is registered, while only the server knows whether an
 * operator has switched a wallet off mid-incident. A client cannot ADD a surface
 * the server withheld and the server cannot force one the device cannot show.
 *
 * Buyer origin is deliberately NOT an input. ADR 0006 G2 puts both actor kinds
 * on one client component, B11 forbids origin-dependent treatment, and a guest
 * offered a smaller set of ways to pay than an account holder would be exactly
 * the second-class checkout ADR 0003 refuses. It takes no arguments at all,
 * which is the version of that promise a reviewer can check.
 *
 * Which wallets a client may render is a CHECKOUT fact, not an acquirer fact
 * (`CHECKOUT_PAYMENT_SURFACE_METHODS`): an operator switching Apple Pay off
 * mid-incident means it off, full stop.
 */
export function checkoutPaymentSurfaces(): readonly CheckoutPaymentSurfaceMethod[] {
  return config.payments.paymentSurfaceMethods;
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
 * the rail's 500-character metadata value and dropped entirely when it does not —
 * a truncated list would look complete and name the wrong set of orders.
 * `orderCount` is always present, so a reader can tell a dropped list from a
 * single-seller checkout.
 *
 * `guestCheckoutId` appears on a guest-origin payment and nowhere else. It is
 * the DURABLE Mercaria correlation (ADR 0006 B2) — it outlives the guest
 * session, it authorizes nothing, and it is deterministic on replay because
 * `guest_checkouts` is UNIQUE per checkout group. That last property is load
 * bearing rather than pleasant: a converging retry must compose a byte-identical
 * request or the rail rejects the reused idempotency key, and this is the one key
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

/** The rail's per-value metadata limit. */
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
 * intent the rail eventually expires on its own.
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
