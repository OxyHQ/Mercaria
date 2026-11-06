/**
 * Merchant subscription billing on Peable's native engine (Peable ADR 0018).
 *
 * Orbit owns the objects — the customer, the subscription, its invoices — and
 * Mercaria owns the plan semantics: which plan version a price sells, who
 * accepted its terms, what it entitles. This adapter is the seam between them,
 * and it is the ONLY one: Mercaria holds no provider credential and calls no
 * provider. It reaches the gateway as its own Oxy workload identity
 * (`createPeableClient`), as the payment rail does.
 *
 * - **Checkout** is a Peable Checkout Session in `mode: 'subscription'` over
 *   the plan's Orbit price. The engine creates the subscription when the payer
 *   confirms and activates it with its first invoice; Mercaria records it only
 *   from a verified event or a live read, never from the merchant coming back.
 * - **Portal** is Peable's customer portal (`billingPortal.sessions`).
 * - **Cancellation** is `cancel_at_period_end` on the native subscription.
 * - **A paid invoice's payment** is read by its id (`retrieveInvoicePayment`):
 *   its `rail` decides how the invoice is booked, because the invoice's
 *   `amount_paid` is the order's fiat figure even when FairCoin paid it
 *   (Peable ADR 0021 D3).
 *
 * A native subscription checkout cannot start a trial (a free period is made
 * through the subscriptions API, which this adapter does not expose to
 * merchants), so a plan version with `trial_days > 0` is refused by name rather
 * than sold without the trial its terms promise.
 *
 * Nothing here takes card data: the session and portal are Peable's hosted
 * pages, and no method has a parameter for a card, a token or a payment method.
 */

import {
  type Peable,
  PeableAPIError,
  PeableConnectionError,
  PeableError,
  PeableRateLimitError,
} from '@peable.to/sdk';
import type { BillingInterval } from '@mercaria/shared-types';
import { z } from 'zod';
import {
  BillingProviderError,
  type BillingEmbeddedCheckout,
  type BillingHostedSession,
  type BillingInvoicePaymentSnapshot,
  type BillingInvoiceSnapshot,
  type BillingProvider,
  type BillingProviderStage,
  type BillingSubscriptionSnapshot,
} from '../provider.js';
import { mapPeableSubscriptionStatus } from './status.js';

/** Peable ids are `<prefix>_<alphanumerics>`; a value of any other shape is refused. */
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const PRICE_ID = /^price_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ITEM_ID = /^si_[A-Za-z0-9]+$/;
const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/;
/** The SDK's own bound on an `Idempotency-Key`. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,200}$/;

/** Instants on the wire are integer Unix seconds (ADR 0014); the domain holds `Date`s. */
const fromUnixSeconds = (seconds: number) => new Date(seconds * 1_000);

/** An id, or the object it names when the gateway expanded it. */
const reference = (pattern: RegExp) =>
  z.union([z.string().regex(pattern), z.object({ id: z.string().regex(pattern) }).passthrough()]);
const idOf = (value: string | { id: string }) => (typeof value === 'string' ? value : value.id);

/** The fields of a native subscription this adapter reads, and nothing else. */
const subscriptionSchema = z.object({
  id: z.string().regex(SUBSCRIPTION_ID),
  livemode: z.boolean(),
  customer: reference(CUSTOMER_ID),
  status: z.string(),
  items: z.object({
    data: z
      .array(
        z
          .object({
            // Read only to change the price (`changeSubscriptionPrice`).
            id: z.string().regex(SUBSCRIPTION_ITEM_ID).optional(),
            price: z
              .object({
                id: z.string().regex(PRICE_ID),
                recurring: z
                  .object({ interval: z.string(), interval_count: z.number().int() })
                  .passthrough()
                  .nullable(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1, 'a merchant plan subscription holds exactly one item'),
  }),
  current_period_start: z.number().int().nonnegative(),
  current_period_end: z.number().int().nonnegative(),
  trial_end: z.number().int().nonnegative().nullable(),
  cancel_at_period_end: z.boolean(),
  cancel_at: z.number().int().nonnegative().nullable(),
  canceled_at: z.number().int().nonnegative().nullable(),
});

/** The fields of a native invoice this adapter reads. Amounts are base-unit strings. */
const invoiceSchema = z.object({
  id: z.string().regex(INVOICE_ID),
  livemode: z.boolean(),
  customer: reference(CUSTOMER_ID),
  subscription: reference(SUBSCRIPTION_ID).nullable(),
  status: z.string().nullable(),
  amount_paid: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  payment_intent: reference(PAYMENT_INTENT_ID).nullable(),
});

/** A base-unit amount string on the wire (ADR 0014), bounded to the safe range. */
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

/**
 * The fields of the payment that paid an invoice this adapter reads. On the
 * FairCoin rail `faircoin.quote` is the fiat order it was quoted for (Peable
 * ADR 0021 D4); its price sources stay at Peable, readable by the payment id.
 */
const invoicePaymentSchema = z.object({
  id: z.string().regex(PAYMENT_INTENT_ID),
  livemode: z.boolean(),
  status: z.string(),
  rail: z.enum(['card', 'faircoin']),
  amount_received: baseUnits,
  currency: z.string().regex(/^[A-Za-z]{3,4}$/),
  faircoin: z
    .object({
      quote: z
        .object({
          currency: z.string().regex(/^[A-Za-z]{3}$/),
          amount: baseUnits,
          quoted_at: z.number().int().nonnegative(),
        })
        .passthrough()
        .nullable(),
    })
    .passthrough()
    .nullable(),
});

/** A hosted page: Checkout Session or portal session. */
const hostedSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'a hosted page is https'),
  expires_at: z.number().int().positive().nullable().optional(),
});

/** An embedded session: the payer capability and the total it was priced at, never a URL. */
const embeddedSchema = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
  client_secret: z.string().min(1),
  amount_total: z.string().regex(/^(0|[1-9]\d*)$/),
  currency: z.string().min(3),
  livemode: z.boolean(),
  expires_at: z.number().int().positive(),
});

/** Monthly or annual, in Mercaria's vocabulary; any other cadence sells no plan. */
function intervalOf(recurring: { interval: string; interval_count: number } | null) {
  if (recurring?.interval_count === 1) {
    if (recurring.interval === 'month') return 'monthly' satisfies BillingInterval;
    if (recurring.interval === 'year') return 'annual' satisfies BillingInterval;
  }
  return undefined;
}

function requireKey(key: string | undefined, stage: BillingProviderStage): string {
  if (key === undefined || !IDEMPOTENCY_KEY.test(key)) {
    throw new BillingProviderError({
      provider: 'peable',
      stage,
      message: 'A stable billing intent key is required.',
      retryable: false,
      code: 'idempotency_key_required',
    });
  }
  return key;
}

function malformed(stage: BillingProviderStage, message: string): never {
  throw new BillingProviderError({
    provider: 'peable',
    stage,
    message,
    retryable: false,
    code: 'billing_response_invalid',
  });
}

/**
 * Classify a gateway failure.
 *
 * The outcome is UNKNOWN — the caller retries its own intent key — when no
 * answer arrived, the gateway failed, it throttled, or the same key is still in
 * flight. Upstream messages are never propagated: a hosted URL or an id must
 * not enter a route log through an error.
 */
function failure(stage: BillingProviderStage, error: unknown): BillingProviderError {
  if (error instanceof BillingProviderError) return error;
  const retryable =
    error instanceof PeableConnectionError ||
    error instanceof PeableAPIError ||
    error instanceof PeableRateLimitError ||
    (error instanceof PeableError && error.code === 'in_progress');
  return new BillingProviderError({
    provider: 'peable',
    stage,
    message: 'The billing gateway could not complete this request.',
    retryable,
    code:
      error instanceof PeableError && error.code !== undefined
        ? error.code
        : retryable
          ? 'billing_outcome_unknown'
          : 'billing_gateway_rejected',
  });
}

export class PeableBillingProvider implements BillingProvider {
  readonly id = 'peable' as const;

  constructor(
    private readonly client: Peable,
    /** The mode of this deployment's Peable merchant: production ⟺ live (Peable ADR 0017). */
    readonly livemode: boolean,
  ) {}

  private async call<T>(stage: BillingProviderStage, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw failure(stage, error);
    }
  }

  private hosted(stage: BillingProviderStage, value: unknown): BillingHostedSession {
    const parsed = hostedSchema.safeParse(value);
    if (!parsed.success)
      malformed(stage, 'The gateway answered a hosted page Mercaria cannot use.');
    const expiresAt =
      typeof parsed.data.expires_at === 'number'
        ? fromUnixSeconds(parsed.data.expires_at)
        : undefined;
    return { url: parsed.data.url, ...(expiresAt ? { expiresAt } : {}) };
  }

  private embedded(value: unknown): BillingEmbeddedCheckout {
    const parsed = embeddedSchema.safeParse(value);
    if (!parsed.success) {
      malformed('createCheckoutSession', 'The gateway answered a checkout Mercaria cannot pay.');
    }
    const session = parsed.data;
    if (session.livemode !== this.livemode) {
      malformed('createCheckoutSession', 'The checkout belongs to the other mode.');
    }
    const amountMinor = Number(session.amount_total);
    if (!Number.isSafeInteger(amountMinor)) {
      malformed('createCheckoutSession', 'The checkout total is outside the safe range.');
    }
    return {
      sessionId: session.id,
      clientSecret: session.client_secret,
      amountMinor,
      currency: session.currency.toUpperCase(),
      livemode: session.livemode,
      expiresAt: fromUnixSeconds(session.expires_at),
    };
  }

  private snapshot(stage: BillingProviderStage, value: unknown): BillingSubscriptionSnapshot {
    const parsed = subscriptionSchema.safeParse(value);
    if (!parsed.success) {
      malformed(stage, 'The gateway answered a subscription Mercaria cannot read.');
    }
    const s = parsed.data;
    if (s.livemode !== this.livemode) {
      malformed(stage, 'The subscription belongs to the other mode.');
    }
    const [item] = s.items.data;
    const interval = item ? intervalOf(item.price.recurring) : undefined;
    if (!item || !interval) {
      malformed(stage, 'The subscription is not on a monthly or annual plan price.');
    }
    return {
      providerSubscriptionId: s.id,
      providerCustomerId: idOf(s.customer),
      livemode: s.livemode,
      status: mapPeableSubscriptionStatus(s.status, s.cancel_at_period_end),
      interval,
      providerPriceId: item.price.id,
      currentPeriodStart: fromUnixSeconds(s.current_period_start),
      currentPeriodEnd: fromUnixSeconds(s.current_period_end),
      ...(s.trial_end !== null ? { trialEndsAt: fromUnixSeconds(s.trial_end) } : {}),
      ...(s.cancel_at !== null ? { cancelAt: fromUnixSeconds(s.cancel_at) } : {}),
      ...(s.canceled_at !== null ? { cancelledAt: fromUnixSeconds(s.canceled_at) } : {}),
    };
  }

  async ensureCustomer(input: Parameters<BillingProvider['ensureCustomer']>[0]) {
    const key = requireKey(input.idempotencyKey, 'ensureCustomer');
    return this.call('ensureCustomer', async () => {
      // Called only when Mercaria has no `billing_customers` row for the store,
      // under a key derived from the STORE, so a retried creation whose answer
      // was lost converges on the same customer.
      const customer = await this.client.customers.create(
        { name: input.storeName, metadata: { store_id: input.storeId } },
        { idempotencyKey: key },
      );
      if (!CUSTOMER_ID.test(customer.id)) {
        malformed('ensureCustomer', 'The gateway answered a customer Mercaria cannot read.');
      }
      return { providerCustomerId: customer.id };
    });
  }

  async createCheckoutSession(input: Parameters<BillingProvider['createCheckoutSession']>[0]) {
    const key = requireKey(input.idempotencyKey, 'createCheckoutSession');
    if (input.trialDays > 0) {
      throw new BillingProviderError({
        provider: 'peable',
        stage: 'createCheckoutSession',
        message:
          'A subscription checkout cannot start a trial; this plan version promises one, ' +
          'so it is not sold until it can be honoured.',
        retryable: false,
        code: 'trial_not_supported',
      });
    }
    if (!CUSTOMER_ID.test(input.providerCustomerId) || !PRICE_ID.test(input.providerPriceId)) {
      malformed('createCheckoutSession', 'The customer or price is not a Peable id.');
    }
    return this.call('createCheckoutSession', async () =>
      this.embedded(
        await this.client.checkout.sessions.create(
          {
            mode: 'subscription',
            // Paid in the dashboard's Peable sheet, never on a redirect.
            ui_mode: 'embedded',
            customer: input.providerCustomerId,
            line_items: [{ price: input.providerPriceId, quantity: 1 }],
            client_reference_id: input.storeId,
            metadata: { store_id: input.storeId, plan_id: input.planId },
          },
          { idempotencyKey: key },
        ),
      ),
    );
  }

  async createPortalSession(input: Parameters<BillingProvider['createPortalSession']>[0]) {
    if (!CUSTOMER_ID.test(input.providerCustomerId)) {
      malformed('createPortalSession', 'The customer is not a Peable id.');
    }
    return this.call('createPortalSession', async () =>
      this.hosted(
        'createPortalSession',
        await this.client.billingPortal.sessions.create(
          { customer: input.providerCustomerId, return_url: input.returnUrl },
          input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {},
        ),
      ),
    );
  }

  async retrieveSubscription(ref: string) {
    if (!SUBSCRIPTION_ID.test(ref)) malformed('retrieveSubscription', 'Not a subscription id.');
    return this.call('retrieveSubscription', async () =>
      this.snapshot('retrieveSubscription', await this.client.subscriptions.retrieve(ref)),
    );
  }

  async retrieveInvoice(ref: string): Promise<BillingInvoiceSnapshot> {
    if (!INVOICE_ID.test(ref)) malformed('retrieveInvoice', 'Not an invoice id.');
    return this.call('retrieveInvoice', async () => {
      const parsed = invoiceSchema.safeParse(await this.client.invoices.retrieve(ref));
      if (!parsed.success) {
        malformed('retrieveInvoice', 'The gateway answered an invoice Mercaria cannot read.');
      }
      const invoice = parsed.data;
      if (invoice.livemode !== this.livemode) {
        malformed('retrieveInvoice', 'The invoice belongs to the other mode.');
      }
      const amountPaidMinor = Number(invoice.amount_paid);
      if (!Number.isSafeInteger(amountPaidMinor)) {
        malformed('retrieveInvoice', 'The invoice amount is outside the safe range.');
      }
      return {
        providerInvoiceId: invoice.id,
        providerCustomerId: idOf(invoice.customer),
        ...(invoice.subscription !== null
          ? { providerSubscriptionId: idOf(invoice.subscription) }
          : {}),
        livemode: invoice.livemode,
        status: invoice.status ?? 'draft',
        amountPaidMinor,
        currency: invoice.currency.toUpperCase(),
        ...(invoice.payment_intent !== null
          ? { providerPaymentId: idOf(invoice.payment_intent) }
          : {}),
      };
    });
  }

  async retrieveInvoicePayment(ref: string): Promise<BillingInvoicePaymentSnapshot> {
    if (!PAYMENT_INTENT_ID.test(ref)) malformed('retrieveInvoicePayment', 'Not a payment id.');
    return this.call('retrieveInvoicePayment', async () => {
      const parsed = invoicePaymentSchema.safeParse(await this.client.paymentIntents.retrieve(ref));
      if (!parsed.success) {
        malformed('retrieveInvoicePayment', 'The gateway answered a payment Mercaria cannot read.');
      }
      const payment = parsed.data;
      if (payment.id !== ref)
        malformed('retrieveInvoicePayment', 'The gateway read another payment.');
      if (payment.livemode !== this.livemode) {
        malformed('retrieveInvoicePayment', 'The payment belongs to the other mode.');
      }
      const quote = payment.faircoin?.quote ?? null;
      if (payment.rail === 'card' && quote !== null) {
        malformed('retrieveInvoicePayment', 'A card payment carries no FairCoin quote.');
      }
      const amountReceivedMinor = Number(payment.amount_received);
      const quotedMinor = quote === null ? 0 : Number(quote.amount);
      if (!Number.isSafeInteger(amountReceivedMinor) || !Number.isSafeInteger(quotedMinor)) {
        malformed('retrieveInvoicePayment', 'The payment amount is outside the safe range.');
      }
      return {
        providerPaymentId: payment.id,
        livemode: payment.livemode,
        status: payment.status,
        rail: payment.rail,
        amountReceivedMinor,
        currency: payment.currency.toUpperCase(),
        faircoinQuote:
          quote === null
            ? null
            : {
                currency: quote.currency.toUpperCase(),
                amountMinor: quotedMinor,
                quotedAt: fromUnixSeconds(quote.quoted_at),
              },
      };
    });
  }

  async changeSubscriptionPrice(
    input: Parameters<BillingProvider['changeSubscriptionPrice']>[0],
  ): Promise<BillingSubscriptionSnapshot> {
    const key = requireKey(input.idempotencyKey, 'changeSubscriptionPrice');
    if (
      !SUBSCRIPTION_ID.test(input.providerSubscriptionId) ||
      !PRICE_ID.test(input.providerPriceId)
    ) {
      malformed('changeSubscriptionPrice', 'The subscription or price is not a Peable id.');
    }
    return this.call('changeSubscriptionPrice', async () => {
      // The item to swap is read live rather than remembered: a merchant plan
      // subscription holds exactly one item (the schema refuses any other
      // shape), and its id is the rail's.
      const current = subscriptionSchema.safeParse(
        await this.client.subscriptions.retrieve(input.providerSubscriptionId),
      );
      if (!current.success) {
        malformed(
          'changeSubscriptionPrice',
          'The gateway answered a subscription Mercaria cannot read.',
        );
      }
      if (current.data.livemode !== this.livemode) {
        malformed('changeSubscriptionPrice', 'The subscription belongs to the other mode.');
      }
      const [item] = current.data.items.data;
      if (!item?.id)
        malformed('changeSubscriptionPrice', 'The subscription has no item to change.');
      return this.snapshot(
        'changeSubscriptionPrice',
        await this.client.subscriptions.update(
          input.providerSubscriptionId,
          {
            items: [{ id: item.id, price: input.providerPriceId }],
            proration_behavior: 'always_invoice',
            cancel_at_period_end: false,
          },
          { idempotencyKey: key },
        ),
      );
    });
  }

  async cancelAtPeriodEnd(ref: string, idempotencyKey?: string) {
    if (!SUBSCRIPTION_ID.test(ref)) malformed('cancelSubscription', 'Not a subscription id.');
    return this.call('cancelSubscription', async () =>
      this.snapshot(
        'cancelSubscription',
        await this.client.subscriptions.update(
          ref,
          { cancel_at_period_end: true },
          idempotencyKey ? { idempotencyKey } : {},
        ),
      ),
    );
  }
}
