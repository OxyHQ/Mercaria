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
