/**
 * The Stripe client, and the API version it is pinned to.
 *
 * ## The version is a CODE constant, and ADR 0001 says so twice
 *
 * "API version pinned in code (SDK constant, not env)" — because an event
 * payload's shape is a property of the code that reads it. An environment
 * variable would let a deployment be pointed at a version whose fixtures were
 * never verified, silently, and only for the events that actually changed shape.
 * Upgrading is a deliberate PR that re-verifies the fixtures, never an
 * account-default drift.
 *
 * The pin is asserted against the SDK's own `Stripe.LatestApiVersion` by the
 * compiler: `apiVersion` is typed as that literal, so bumping the `stripe`
 * dependency without bumping this constant does not type-check. That is the
 * whole reason the constant is written out rather than read from the SDK — a
 * `apiVersion: Stripe.LatestApiVersion` would silently follow every SDK bump,
 * which is exactly the drift the ADR forbids.
 *
 * ## Everything here is ASYNC, including the crypto — this is not a style choice
 *
 * `stripe`'s package exports declare a `bun` condition pointing at the WORKER
 * build, whose crypto provider is SubtleCrypto and throws
 * `CryptoProviderOnlySupportsAsyncError: SubtleCryptoProvider cannot be used in
 * a synchronous context` from every synchronous entry point. Measured on
 * stripe@22.4.0: under `node` both `constructEvent` and `constructEventAsync`
 * work; under `bun` the synchronous one throws — and so does
 * `generateTestHeaderString`, which is what a test would reach for.
 *
 * This backend runs BOTH: production is `node packages/backend/dist/index.js`
 * (Dockerfile) while `bun run dev` is `bun --watch src/index.ts`. A synchronous
 * `constructEvent` would therefore verify every delivery in production and throw
 * on every delivery in development, which is the worst possible split — the bug
 * is invisible where it is tested and total where it is written. Use the
 * `*Async` variants everywhere, including in tests.
 */

import Stripe from 'stripe';
import { config } from '../../../config/index.js';

/**
 * The Stripe API release train Mercaria is written against — ADR 0001,
 * "Stripe configuration". Webhook endpoints are registered with this same
 * explicit version.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

/** How long a Stripe API call may take before it is treated as a failure. */
const REQUEST_TIMEOUT_MS = 20_000;

/** How many times the SDK itself retries a failed request before giving up. */
const MAX_NETWORK_RETRIES = 2;

let client: Stripe | undefined;

/**
 * The process-wide Stripe client.
 *
 * Lazy, because constructing it requires a secret key and most deployments (and
 * every test that does not exercise the rail) have none. One instance, because
 * the SDK keeps a connection pool and a fresh client per call would open a new
 * TLS session for every webhook.
 *
 * @throws When the rail is not configured. A caller reaching here without
 *   `config.payments.stripe.enabled` is a bug in the caller: the routes are not
 *   even mounted in that case, so there is no code path that legitimately wants
 *   a client that cannot authenticate.
 */
export function getStripeClient(): Stripe {
  if (!config.payments.stripe.enabled) {
    throw new Error(
      'The Stripe client was requested but STRIPE_ENABLED is off (or the integration is ' +
        'half-configured — see the boot log). No Stripe route is mounted in that state.',
    );
  }
  client ??= new Stripe(config.payments.stripe.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    timeout: REQUEST_TIMEOUT_MS,
    maxNetworkRetries: MAX_NETWORK_RETRIES,
    // Shows up in Stripe's dashboard request log beside every call Mercaria
    // makes, so an operator reading Stripe's side can tell this integration
    // apart from a manual dashboard action.
    appInfo: { name: 'Mercaria', url: 'https://mercaria.co' },
  });
  return client;
}

/** Drop the client. Test support — a suite must not inherit another's key. */
export function resetStripeClient(): void {
  client = undefined;
}

/**
 * Read a PaymentIntent's CURRENT state from Stripe.
 *
 * The answer to "this event cannot be applied safely from its payload alone"
 * (issue #48, ordering and convergence 2). A webhook payload is a snapshot of
 * the moment the event was generated, and Stripe guarantees nothing about
 * delivery order — so an event that would move a payment BACKWARDS is not
 * evidence that the payment moved backwards, it is evidence that this delivery
 * is late. Re-reading replaces a stale snapshot with the truth.
 *
 * @param account The connected account the object belongs to, when the event
 *   was connect-scoped. Passed as `stripeAccount`, which is the `Stripe-Account`
 *   header — reading a connected account's object on the platform account
 *   returns `resource_missing`, so this is not optional decoration.
 */
export async function retrieveStripePaymentIntent(
  paymentIntentId: string,
  account?: string,
): Promise<Stripe.PaymentIntent> {
  return await getStripeClient().paymentIntents.retrieve(
    paymentIntentId,
    undefined,
    account === undefined ? undefined : { stripeAccount: account },
  );
}

/**
 * Create the PaymentIntent that funds one checkout group.
 *
 * The parameters are built by `stripe-provider.ts` and passed through verbatim,
 * the same split `createStripeConnectedAccount` uses: ADR 0001 D3/D4/D8 are
 * DECISIONS and belong beside the code that can be read against the ADR, while
 * this module stays the client and its pinned version. A test asserting the
 * exact payload therefore mocks this ONE module and inspects what it was handed.
 *
 * @param idempotencyKey `pi:<paymentId>` (ADR 0001 D11), derived from Mercaria's
 *   own durable id. It is what makes a double-tapped checkout one charge rather
 *   than two, and it is a required parameter for that reason.
 */
export async function createStripePaymentIntent(
  params: Stripe.PaymentIntentCreateParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  return await getStripeClient().paymentIntents.create(params, { idempotencyKey });
}

/**
 * Cancel a PaymentIntent that will never be paid.
 *
 * The reservation-sweep path: the buyer's stock has gone back, so the intent
 * must not stay confirmable. Cancelling an intent Stripe has already captured
 * FAILS — which is correct and is why the caller treats this as best-effort: a
 * capture that beat the sweep is a real event and the succeeded webhook still
 * has to be allowed to arrive and raise its exception.
 */
export async function cancelStripePaymentIntent(
  paymentIntentId: string,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  return await getStripeClient().paymentIntents.cancel(paymentIntentId, undefined, {
    idempotencyKey,
  });
}

/**
 * Read a charge together with its BALANCE TRANSACTION, in one call.
 *
 * The balance transaction is the only place Stripe states what a charge became
 * in the PLATFORM's settlement currency and what it kept in fees (ADR 0001 D8,
 * fact 5). Both are needed at the moment a payment succeeds: the platform amount
 * is what every ledger leg of that charge is denominated in and what the seller
 * transfers are sized from, and the fee is `processor_expense`.
 *
 * Expanded rather than fetched separately so the two can never come from
 * different moments — a rate read after the fact is not the rate that was
 * applied, and `FxRateSnapshot` exists to make that distinction impossible to
 * lose.
 */
export async function retrieveStripeChargeWithBalance(chargeId: string): Promise<Stripe.Charge> {
  return await getStripeClient().charges.retrieve(chargeId, {
    expand: ['balance_transaction'],
  });
}

/**
 * Create one seller's Transfer out of a settled charge.
 *
 * ADR 0001 D3 step 2. `source_transaction` (in `params`) makes the movement wait
 * for the charge's funds instead of failing against an available balance that
 * has not landed yet, and the transfer's currency must match that charge's
 * balance-transaction currency — both are the adapter's business, built in
 * `stripe-provider.ts` and passed through here.
 *
 * @param idempotencyKey `tr:<paymentId>:<orderId>` (ADR 0001 D11). Two transfers
 *   for one order is money leaving twice, and this key is the outer half of the
 *   guarantee whose inner half is `UNIQUE(payment_id, order_id)` on `transfers`.
 */
export async function createStripeTransfer(
  params: Stripe.TransferCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Transfer> {
  return await getStripeClient().transfers.create(params, { idempotencyKey });
}

/**
 * Read a charge together with the REFUNDS made against it.
 *
 * `charge.refunded` delivers a CHARGE, not a refund, so the refund ids it is
 * about are inside `charge.refunds` — and that list is not expanded by default.
 * The handler needs them to correlate each movement to a Mercaria refund record,
 * and on a retry (where the delivered payload is gone) this read is the only
 * place they exist at all.
 *
 * `amount_refunded` comes back on the charge itself and is what decides whether
 * the PAYMENT is now `refunded` or `partially_refunded` — a group-level fact
 * that no single refund object can answer.
 */
export async function retrieveStripeChargeWithRefunds(chargeId: string): Promise<Stripe.Charge> {
  return await getStripeClient().charges.retrieve(chargeId, { expand: ['refunds'] });
}

/**
 * Refund part or all of a charge, and read what it cost the platform balance.
 *
 * ADR 0001 D7: a per-order refund draws from the GROUP's charge, because one
 * checkout group is one charge (D4). Which order it is for is Mercaria's own
 * arithmetic and is carried in `metadata`, never inferred by Stripe.
 *
 * `balance_transaction` is expanded for the same reason the charge's is
 * (`retrieveStripeChargeWithBalance`): it is the only place Stripe states what
 * the refund took off the PLATFORM's balance and at what rate, and a refund
 * converts at the refund-time rate rather than the charge's. Expanding it here
 * means the amount and its rate come from one moment; `charge` is expanded
 * alongside so `amount_refunded` decides the payment's own status in the same
 * call rather than a second round trip that could see a different total.
 *
 * @param idempotencyKey `re:<refundId>` (ADR 0001 D11), derived from Mercaria's
 *   durable refund id. It is what makes a retried refund one movement rather
 *   than two, and refunding a buyer twice is money that does not come back.
 */
export async function createStripeRefund(
  params: Stripe.RefundCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Refund> {
  return await getStripeClient().refunds.create(
    { ...params, expand: ['balance_transaction', 'charge'] },
    { idempotencyKey },
  );
}

/**
 * Read a Refund's CURRENT state from Stripe.
 *
 * The same rule as every other re-read here: a `charge.refund.updated` retried
 * hours later carries a snapshot of a state that has since moved, and a refund
 * genuinely does move — `pending` to `succeeded`, or to `failed` when the
 * issuer bounces it days later.
 */
export async function retrieveStripeRefund(refundId: string): Promise<Stripe.Refund> {
  return await getStripeClient().refunds.retrieve(refundId, {
    expand: ['balance_transaction', 'charge'],
  });
}

/**
 * Reverse part or all of one seller's Transfer.
 *
 * The seller-side half of a refund and the recovery half of a lost dispute (ADR
 * 0001 D7). Reversals are created ON the transfer rather than as a top-level
 * object, and the amount is in the transfer's own currency — the platform
 * settlement currency, never the buyer's.
 *
 * `refund_application_fee` is deliberately not sent: under separate charges and
 * transfers there IS no application fee (D3), Mercaria's commission is the
 * residual in its own ledger, and sending the parameter would be describing a
 * mechanism this integration does not use.
 *
 * @param idempotencyKey `trr:<refundId>:<orderId>`, or
 *   `trr:dispute:<disputeId>:<orderId>` (ADR 0001 D11). Two reversals of one
 *   refund would take a seller's money twice for goods returned once.
 */
export async function createStripeTransferReversal(
  transferId: string,
  params: Stripe.TransferCreateReversalParams,
  idempotencyKey: string,
): Promise<Stripe.TransferReversal> {
  return await getStripeClient().transfers.createReversal(transferId, params, { idempotencyKey });
}

/**
 * Read a Dispute's CURRENT state from Stripe.
 *
 * Disputes live on the PLATFORM account under ADR 0001 D1 — Mercaria is the
 * merchant of record, so the network's dispute is with Mercaria and the platform
 * balance is what was debited. There is no `stripeAccount` parameter, and adding
 * one would look for a dispute against the seller that does not exist.
 *
 * `balance_transactions` is what distinguishes a real chargeback from an
 * INQUIRY: an inquiry carries a deadline and moves no money, so the list is
 * empty and nothing may be booked. That is read here rather than inferred from
 * the status string, because the statuses that mean "inquiry" differ by network
 * and grow on Stripe's schedule while the empty list does not.
 */
export async function retrieveStripeDispute(disputeId: string): Promise<Stripe.Dispute> {
  return await getStripeClient().disputes.retrieve(disputeId);
}

/**
 * Read a Payout's CURRENT state from a CONNECTED account.
 *
 * The one read here that genuinely needs `stripeAccount`, and it is the mirror
 * of `retrieveStripeTransfer`'s not needing it: a transfer is Mercaria's own
 * movement on the platform account, while a payout is the SELLER's account
 * paying its own balance out. Reading one on the platform account answers
 * `resource_missing`.
 */
export async function retrieveStripePayout(
  payoutId: string,
  account: string,
): Promise<Stripe.Payout> {
  return await getStripeClient().payouts.retrieve(payoutId, undefined, {
    stripeAccount: account,
  });
}

/**
 * Read a Transfer's CURRENT state from Stripe.
 *
 * Needed for the same reason as the PaymentIntent read: a transfer's reversal
 * total is cumulative and its events are not ordered, so a delivery being
 * retried hours later carries a figure that has since moved. Transfers live on
 * the PLATFORM account under ADR 0001 D3 (Mercaria makes them; the connected
 * account only receives), so there is no `stripeAccount` parameter here — and
 * adding one would be the mistake, because it would look up a transfer the
 * seller made.
 */
export async function retrieveStripeTransfer(transferId: string): Promise<Stripe.Transfer> {
  return await getStripeClient().transfers.retrieve(transferId);
}

/**
 * Read one bounded page of the platform's BALANCE TRANSACTIONS.
 *
 * The reconciliation sweep's single window onto Stripe (#50, jobs 2 and 3), and
 * one list rather than five deliberately. Stripe exposes `charges.list`,
 * `refunds.list`, `transfers.list` and `payouts.list` separately, and sweeping
 * them all would be four cursors, four windows and four ways to be half done.
 * Every one of those objects also produces a balance transaction, and the
 * balance transaction is the only place Stripe states the movement in the
 * PLATFORM's own settlement currency — which is the currency Mercaria's ledger
 * and transfers are denominated in, so it is the only figure a comparison
 * against those rows can honestly use.
 *
 * `expand: ['data.source']` is what makes one call enough: without it a `charge`
 * row carries `ch_…` and nothing else, and correlating it to a Mercaria payment
 * would need a second retrieve per charge to reach its `payment_intent`. One
 * expansion per PAGE against one per OBJECT is the difference between a sweep
 * that fits in a rate limit and one that does not.
 *
 * @param startingAfter The id of the last balance transaction of the previous
 *   page — Stripe's own cursor, persisted in `reconciliation_cursors` so an
 *   interrupted pass resumes instead of restarting.
 */
export async function listStripeBalanceTransactions(input: {
  createdGte: Date;
  limit: number;
  startingAfter?: string;
}): Promise<Stripe.ApiList<Stripe.BalanceTransaction>> {
  return await getStripeClient().balanceTransactions.list({
    created: { gte: Math.floor(input.createdGte.getTime() / 1_000) },
    limit: input.limit,
    expand: ['data.source'],
    ...(input.startingAfter === undefined ? {} : { starting_after: input.startingAfter }),
  });
}

/**
 * Create a connected account.
 *
 * The parameters are built by `account.service.ts` and passed through verbatim,
 * deliberately: ADR 0001 D2's controller properties are the DECISION and belong
 * with the code that can be read against the ADR, while this module stays what
 * it says it is — the client and its pinned version. A test asserting the exact
 * shape sent to Stripe therefore mocks this ONE module and inspects what it was
 * handed, which is the only way to check the properties without a network call.
 *
 * @param idempotencyKey Derived from a Mercaria durable id (ADR 0001 D11), never
 *   from request-scoped randomness — so a retried onboarding click converges on
 *   the account the first one made instead of opening a second one at Stripe.
 *   That is the outer half of the guarantee whose inner half is the
 *   `UNIQUE(provider, owner_type, owner_id)` index.
 */
export async function createStripeConnectedAccount(
  params: Stripe.AccountCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Account> {
  return await getStripeClient().accounts.create(params, { idempotencyKey });
}

/**
 * Read a connected account's CURRENT state from Stripe.
 *
 * Accounts are retrieved on the PLATFORM account by id, not through a
 * `Stripe-Account` header: Mercaria is the platform reading an account it
 * controls, and passing the header would ask that account to look up itself,
 * which is a different (and, for a `requirement_collection=stripe` account,
 * differently-permissioned) call.
 *
 * Every readiness decision goes through here rather than through a webhook
 * payload. An `account.updated` body is a snapshot of a moment that has passed,
 * and Stripe orders nothing — so a delivery retried hours later would otherwise
 * restore requirements the seller has since satisfied.
 */
export async function retrieveStripeAccount(accountId: string): Promise<Stripe.Account> {
  return await getStripeClient().accounts.retrieve(accountId);
}

/**
 * Mint a hosted-onboarding Account Link.
 *
 * Single-use and expiring in minutes (ADR 0001 D2), which is why nothing stores
 * the result: a link in a database has expired by the time anyone reads it, and
 * a link in an email is a link that left the app. No idempotency key — the
 * whole point of the call is to produce a NEW link, so replaying one would hand
 * back an already-consumed URL.
 */
export async function createStripeAccountLink(
  params: Stripe.AccountLinkCreateParams,
): Promise<Stripe.AccountLink> {
  return await getStripeClient().accountLinks.create(params);
}
