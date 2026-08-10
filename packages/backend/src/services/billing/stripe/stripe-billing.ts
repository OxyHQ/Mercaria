/**
 * The Stripe Billing adapter — merchant subscriptions on Mercaria's OWN platform
 * account.
 *
 * ## The one import this domain makes into the payment domain
 *
 * `getStripeClient()`, and nothing else. One configured SDK instance means one
 * pinned API version, one timeout and one retry policy for every Stripe call
 * this service makes, which is worth more than the separation a second client
 * would buy. Everything ELSE in `services/payments/` is off limits here and
 * `merchant-plan-isolation.test.ts` fails the build over it — in particular
 * `provider-account.service.ts` and `providerAccountRepository.ts`, which are
 * the Connect side acceptance 2 says must never be cross-linked with this one.
 *
 * ## Object ids are shape-checked, and `acct_` is refused BY NAME
 *
 * The second, independent layer over acceptance 2. The schema keeps a billing
 * customer and a connected account in different tables with no relation; this
 * refuses a connected-account id if one ever reaches a billing call anyway —
 * from a mis-wired caller, a hand-run repair or a copied configuration value.
 * A refusal that names `acct_` leads somewhere; a Stripe 404 three calls later
 * does not.
 *
 * The prefixes are Stripe's own vocabulary and belong here, in the adapter,
 * rather than in the provider-neutral interface next door.
 */

import type Stripe from 'stripe';
import type { BillingInterval, MerchantSubscriptionStatus } from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { getStripeClient } from '../../payments/stripe/client.js';
import {
  BillingProviderError,
  registerBillingProvider,
  type BillingHostedSession,
  type BillingProvider,
  type BillingSubscriptionSnapshot,
} from '../provider.js';

/** What a Stripe object id may start with, per role, on a BILLING call. */
const BILLING_ID_PREFIXES = {
  customer: 'cus_',
  price: 'price_',
  subscription: 'sub_',
} as const;

/** The prefix a CONNECTED ACCOUNT carries. It may never appear on a billing call. */
const CONNECTED_ACCOUNT_PREFIX = 'acct_';

/**
 * Refuse an id that is not the shape this call expects.
 *
 * @throws {BillingProviderError} Never retryable: a wrong-shaped id is a defect
 *   in whatever composed the call, and retrying it produces the same id.
 */
function assertBillingObjectId(
  value: string,
  role: keyof typeof BILLING_ID_PREFIXES,
  stage: BillingProviderError['stage'],
): void {
  if (value.startsWith(CONNECTED_ACCOUNT_PREFIX)) {
    throw new BillingProviderError({
      provider: 'stripe',
      stage,
      message:
        `A connected-account id was passed as a billing ${role}. A Connect account and a ` +
        'subscription billing customer are different objects in different key spaces and are ' +
        'never interchangeable (#89 acceptance 2).',
      retryable: false,
    });
  }
  if (!value.startsWith(BILLING_ID_PREFIXES[role])) {
    throw new BillingProviderError({
      provider: 'stripe',
      stage,
      message: `A billing ${role} id must start with '${BILLING_ID_PREFIXES[role]}'.`,
      retryable: false,
    });
  }
}

/** Whether a Stripe failure is worth trying again. */
function classify(error: unknown): { retryable: boolean; code?: string; message: string } {
  const candidate = error as { type?: string; code?: string; message?: string } | undefined;
  const message = candidate?.message ?? 'The billing rail failed.';
  const type = candidate?.type ?? '';
  const retryable =
    type === 'StripeConnectionError' ||
    type === 'StripeAPIError' ||
    type === 'StripeRateLimitError';
  return candidate?.code === undefined
    ? { retryable, message }
    : { retryable, code: candidate.code, message };
}

/** Wrap any Stripe rejection as a {@link BillingProviderError}. */
function fail(stage: BillingProviderError['stage'], error: unknown): never {
  const { retryable, code, message } = classify(error);
  throw new BillingProviderError({
    provider: 'stripe',
    stage,
    message,
    retryable,
    ...(code === undefined ? {} : { code }),
  });
}

/**
 * Stripe's subscription status in Mercaria's vocabulary — the ONE mapping.
 *
 * Two of the translations are worth reading rather than skimming:
 *
 *  - **A scheduled cancellation is `cancelled` here and `active` at Stripe.**
 *    Stripe keeps a subscription `active` with `cancel_at_period_end` until the
 *    period actually ends. Mercaria records the merchant's DECISION, because the
 *    plan screen has to say "cancels on the 14th" and a status that said `active`
 *    could not. `ENTITLING_SUBSCRIPTION_STATUSES` deliberately excludes
 *    `cancelled`, so a cancelled-but-running subscription keeps its paid
 *    entitlements through the `cancelAt` deadline rather than through its status
 *    — which is why the caller passes the deadline through and the resolver reads
 *    the plan until the period ends.
 *  - **`incomplete` and `incomplete_expired` are `expired`.** A first payment
 *    that never succeeded entitles nothing, and `expired` is the non-entitling
 *    terminal state that already exists. The audit row's note carries Stripe's
 *    own word, so "never started" stays distinguishable from "ran out" without a
 *    status whose only reader would be a dashboard label.
 */
export function mapStripeSubscriptionStatus(
  status: string,
  cancelAtPeriodEnd: boolean,
): MerchantSubscriptionStatus {
  switch (status) {
    case 'trialing':
      return cancelAtPeriodEnd ? 'cancelled' : 'trialing';
    case 'active':
      return cancelAtPeriodEnd ? 'cancelled' : 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
      return 'expired';
    default:
      // An unrecognised status is treated as non-entitling rather than guessed
      // at. Stripe adding one must not silently grant a paid capability.
      return 'expired';
  }
}

/** Stripe's recurring interval in Mercaria's vocabulary. */
function mapStripeInterval(interval: string): BillingInterval {
  return interval === 'year' ? 'annual' : 'monthly';
}

/** A Stripe UNIX second, as a `Date`, or `undefined`. */
function instant(seconds: number | null | undefined): Date | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1_000) : undefined;
}

/**
 * A Stripe subscription as a Mercaria snapshot.
 *
 * The billing PERIOD is read from the subscription's first ITEM, not from the
 * subscription: Stripe moved `current_period_start`/`current_period_end` onto
 * the item, and the pinned API version is well past that change. Reading a
 * property the response does not carry would produce `undefined` silently and
 * leave every subscription with no period at all.
 */
export function snapshotFromStripeSubscription(
  subscription: Stripe.Subscription,
): BillingSubscriptionSnapshot {
  const item = subscription.items.data[0];
  if (!item) {
    throw new BillingProviderError({
      provider: 'stripe',
      stage: 'retrieveSubscription',
      message: `Stripe subscription ${subscription.id} carries no items, so it prices nothing.`,
      retryable: false,
    });
  }
  const customer =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const periodStart = instant(item.current_period_start);
  const periodEnd = instant(item.current_period_end);
  const trialEndsAt = instant(subscription.trial_end);
  const cancelAt = instant(subscription.cancel_at);
  const cancelledAt = instant(subscription.canceled_at);

  return {
    providerSubscriptionId: subscription.id,
    providerCustomerId: customer,
    livemode: subscription.livemode,
    status: mapStripeSubscriptionStatus(subscription.status, subscription.cancel_at_period_end),
    interval: mapStripeInterval(item.price.recurring?.interval ?? 'month'),
    providerPriceId: item.price.id,
    ...(periodStart ? { currentPeriodStart: periodStart } : {}),
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    ...(trialEndsAt ? { trialEndsAt } : {}),
    ...(cancelAt ? { cancelAt } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
  };
}

/** The Stripe Billing rail. */
class StripeBillingProvider implements BillingProvider {
  readonly id = 'stripe' as const;

  get livemode(): boolean {
    return config.payments.stripe.livemode;
  }

  async ensureCustomer(input: {
    storeId: string;
    storeName: string;
    idempotencyKey: string;
  }): Promise<{ providerCustomerId: string }> {
    try {
      const customer = await getStripeClient().customers.create(
        {
          name: input.storeName,
          // The correlation, and nothing else. No email, no address, no phone:
          // a billing customer needs none of them to be charged against a saved
          // payment method the merchant enters on Stripe's own hosted page.
          metadata: { storeId: input.storeId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { providerCustomerId: customer.id };
    } catch (error) {
      fail('ensureCustomer', error);
    }
  }

  async createCheckoutSession(input: {
    providerCustomerId: string;
    providerPriceId: string;
    trialDays: number;
    returnUrl: string;
    storeId: string;
    planId: string;
    idempotencyKey: string;
  }): Promise<BillingHostedSession> {
    assertBillingObjectId(input.providerCustomerId, 'customer', 'createCheckoutSession');
    assertBillingObjectId(input.providerPriceId, 'price', 'createCheckoutSession');
    try {
      const session = await getStripeClient().checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.providerCustomerId,
          line_items: [{ price: input.providerPriceId, quantity: 1 }],
          subscription_data: {
            ...(input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}),
            metadata: { storeId: input.storeId, planId: input.planId },
          },
          success_url: `${input.returnUrl}?billing=complete`,
          cancel_url: `${input.returnUrl}?billing=cancelled`,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) {
        throw new BillingProviderError({
          provider: 'stripe',
          stage: 'createCheckoutSession',
          message: 'Stripe returned a checkout session with no URL to send the merchant to.',
          retryable: false,
        });
      }
      const expiresAt = instant(session.expires_at);
      return { url: session.url, ...(expiresAt ? { expiresAt } : {}) };
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      fail('createCheckoutSession', error);
    }
  }

  async createPortalSession(input: {
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<BillingHostedSession> {
    assertBillingObjectId(input.providerCustomerId, 'customer', 'createPortalSession');
    try {
      const session = await getStripeClient().billingPortal.sessions.create({
        customer: input.providerCustomerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    } catch (error) {
      fail('createPortalSession', error);
    }
  }

  async retrieveSubscription(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionSnapshot> {
    assertBillingObjectId(providerSubscriptionId, 'subscription', 'retrieveSubscription');
    try {
      const subscription = await getStripeClient().subscriptions.retrieve(providerSubscriptionId);
      return snapshotFromStripeSubscription(subscription);
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      fail('retrieveSubscription', error);
    }
  }

  async cancelAtPeriodEnd(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionSnapshot> {
    assertBillingObjectId(providerSubscriptionId, 'subscription', 'cancelSubscription');
    try {
      const subscription = await getStripeClient().subscriptions.update(providerSubscriptionId, {
        cancel_at_period_end: true,
      });
      return snapshotFromStripeSubscription(subscription);
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      fail('cancelSubscription', error);
    }
  }
}

/**
 * Register the Stripe billing rail, when this deployment has one.
 *
 * Gated on `STRIPE_ENABLED` and not on `MERCHANT_BILLING_ENABLED`: the billing
 * flag gates a merchant's ACTIONS, while the adapter is what applies provider
 * events and reconciles subscriptions that already exist. Registering it only
 * when merchants may upgrade would strand every existing subscription the moment
 * somebody pulled the incident lever, which is the failure the "no lever gates a
 * durable record" rule exists to prevent.
 */
export function registerStripeBillingProvider(): void {
  if (!config.payments.stripe.enabled) return;
  registerBillingProvider(new StripeBillingProvider());
  log.general.info({}, '[MerchantBilling] the Stripe billing rail is registered');
}
