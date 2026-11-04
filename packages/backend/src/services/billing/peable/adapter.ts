/** Peable executes the same Stripe billing rail; Mercaria owns its plan semantics. */
import { type Peable, PeableError } from '@peable.to/sdk';
import { z } from 'zod';
import { getDb } from '../../../db/postgres.js';
import {
  findBillingCustomerByProviderId,
  findSubscriptionByProviderId,
} from '../../../db/merchantPlans/subscriptionRepository.js';
import {
  findMerchantPlanByProviderPrice,
  findMerchantPlanPriceByProviderId,
} from '../../../db/merchantPlans/planRepository.js';
import {
  BillingProviderError,
  type BillingProvider,
  type BillingProviderStage,
  type BillingSubscriptionSnapshot,
} from '../provider.js';
import { mapStripeSubscriptionStatus } from '../stripe/stripe-billing.js';

const id = z.string().min(1).max(200);
import { billingCohortSchema, type BillingCohort } from '../cohort-config.js';
export { billingCohortSchema, type BillingCohort } from '../cohort-config.js';
/** Peable instants are integer Unix seconds (ADR 0014); Mercaria's domain holds `Date`s. */
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fromUnixSeconds = (seconds: number) => new Date(seconds * 1000);
const subscriptionSchema = z
  .object({
    provider_subscription_id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
    latest_invoice_id: z
      .string()
      .regex(/^in_[A-Za-z0-9]+$/)
      .nullable()
      .optional(),
    provider_customer_id: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    provider_price_id: z.string().regex(/^price_[A-Za-z0-9]+$/),
    store_id: id,
    plan_id: id,
    livemode: z.boolean(),
    status: z.enum([
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ]),
    interval: z.enum(['month', 'year']),
    cancel_at_period_end: z.boolean(),
    current_period_start: timestamp,
    current_period_end: timestamp,
    trial_ends_at: timestamp.nullable(),
    cancel_at: timestamp.nullable(),
    cancelled_at: timestamp.nullable(),
  })
  .strict()
  .refine((v) => v.current_period_end > v.current_period_start);
const hostedSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === 'https:'),
    expires_at: timestamp,
    // A billing checkout session also names its `cs_…`; a portal session does not.
    id: z.string().min(1).optional(),
  })
  .strict();

function refused(stage: BillingProviderStage): never {
  throw new BillingProviderError({
    provider: 'stripe',
    stage,
    message: 'Billing ownership or cohort verification failed.',
    retryable: false,
    code: 'billing_cohort_mismatch',
  });
}
function requireKey(key: string | undefined, stage: BillingProviderStage): string {
  if (!key || !/^[A-Za-z0-9:_-]{8,200}$/.test(key)) {
    throw new BillingProviderError({
      provider: 'stripe',
      stage,
      message: 'A stable billing intent key is required.',
      retryable: false,
      code: 'idempotency_key_required',
    });
  }
  return key;
}

/** Configured cohort is durable routing, independent of the new-action feature flag.
 * The Stripe reader must use the verified platform account, never metadata authority.
 * No catch in this class falls back to the legacy mutator after a Peable failure.
 */
export class CohortBillingProvider implements BillingProvider {
  readonly id = 'stripe' as const;
  readonly livemode: boolean;
  private readonly stores: ReadonlySet<string>;
  constructor(
    private readonly legacy: BillingProvider,
    private readonly client: Peable,
    private readonly cohort: BillingCohort,
    private readonly readStripeCustomer: (
      subscriptionId: string,
    ) => Promise<{ id: string; customerId: string; livemode: boolean }>,
  ) {
    this.cohort = billingCohortSchema.parse(cohort);
    this.livemode = cohort.livemode;
    if (legacy.livemode !== this.livemode) refused('retrieveSubscription');
    this.stores = new Set(cohort.storeIds);
  }
  requiresExplicitIntent(storeId: string): boolean {
    return this.stores.has(storeId);
  }
  private async call<T>(stage: BillingProviderStage, action: () => Promise<T>): Promise<T> {
    try {
      // The SDK authenticates; this compares its resolved namespace with the deployment cohort.
      const merchant = await this.client.merchants.retrieve();
      if (
        merchant.id !== this.cohort.merchantId ||
        merchant.oxy_app_id !== this.cohort.applicationId ||
        merchant.environment !== this.cohort.environment
      )
        refused(stage);
      return await action();
    } catch (error) {
      if (error instanceof BillingProviderError) throw error;
      // The gateway's machine reason is `error.code` (ADR 0014); never parse `message`.
      if (error instanceof PeableError && error.code === 'result_expired') {
        throw new BillingProviderError({
          provider: 'stripe',
          stage,
          message: 'The hosted billing link expired. Start a new intent.',
          retryable: false,
          code: 'billing_result_expired',
        });
      }
      const retryable =
        error instanceof PeableError &&
        (error.type === 'api_error' || error.statusCode === 429 || error.code === 'in_progress');
      // Never propagate an upstream message/cause: hosted URLs and secrets must not enter route logs.
      throw new BillingProviderError({
        provider: 'stripe',
        stage,
        message: 'The billing gateway could not complete this request.',
        retryable,
        code: retryable ? 'billing_outcome_unknown' : 'billing_gateway_rejected',
      });
    }
  }
  private async customerStore(customerId: string, stage: BillingProviderStage): Promise<string> {
    const customer = await findBillingCustomerByProviderId(getDb(), {
      provider: 'stripe',
      livemode: this.livemode,
      providerCustomerId: customerId,
    });
    if (!customer) refused(stage);
    return customer.storeId;
  }
  private async subscriptionStore(ref: string, stage: BillingProviderStage): Promise<string> {
    if (!/^sub_[A-Za-z0-9]+$/.test(ref)) refused(stage);
    const known = await findSubscriptionByProviderId(getDb(), {
      provider: 'stripe',
      livemode: this.livemode,
      providerSubscriptionId: ref,
    });
    if (known) return known.storeId;
    // First webhook may precede Mercaria's subscription row. Read exact Stripe ID, then SQL customer mapping.
    let observed: Awaited<ReturnType<typeof this.readStripeCustomer>>;
    try {
      observed = await this.readStripeCustomer(ref);
    } catch {
      throw new BillingProviderError({
        provider: 'stripe',
        stage,
        message: 'Subscription ownership could not be verified.',
        retryable: true,
        code: 'billing_ownership_unavailable',
      });
    }
    if (observed.id !== ref || observed.livemode !== this.livemode) refused(stage);
    return this.customerStore(observed.customerId, stage);
  }
  private hosted(value: unknown) {
    const result = hostedSchema.parse(value);
    const expiresAt = fromUnixSeconds(result.expires_at);
    if (expiresAt.getTime() <= Date.now()) refused('createCheckoutSession');
    return { url: result.url, expiresAt };
  }
  private async snapshot(
    value: unknown,
    ref: string,
    storeId: string,
    stage: BillingProviderStage,
  ): Promise<BillingSubscriptionSnapshot> {
    const s = subscriptionSchema.parse(value);
    if (
      s.provider_subscription_id !== ref ||
      s.store_id !== storeId ||
      s.livemode !== this.livemode ||
      !this.stores.has(storeId)
    )
      refused(stage);
    if ((await this.customerStore(s.provider_customer_id, stage)) !== storeId) refused(stage);
    const price = await findMerchantPlanPriceByProviderId(getDb(), {
      provider: 'stripe',
      livemode: this.livemode,
      providerPriceId: s.provider_price_id,
    });
    if (
      !price ||
      price.planId !== s.plan_id ||
      price.interval !== (s.interval === 'year' ? 'annual' : 'monthly')
    )
      refused(stage);
    return {
      providerSubscriptionId: s.provider_subscription_id,
      providerCustomerId: s.provider_customer_id,
      providerPriceId: s.provider_price_id,
      livemode: s.livemode,
      status: mapStripeSubscriptionStatus(s.status, s.cancel_at_period_end),
      interval: s.interval === 'year' ? 'annual' : 'monthly',
      currentPeriodStart: fromUnixSeconds(s.current_period_start),
      currentPeriodEnd: fromUnixSeconds(s.current_period_end),
      ...(s.trial_ends_at !== null ? { trialEndsAt: fromUnixSeconds(s.trial_ends_at) } : {}),
      ...(s.cancel_at !== null ? { cancelAt: fromUnixSeconds(s.cancel_at) } : {}),
      ...(s.cancelled_at !== null ? { cancelledAt: fromUnixSeconds(s.cancelled_at) } : {}),
    };
  }
  async ensureCustomer(input: Parameters<BillingProvider['ensureCustomer']>[0]) {
    if (!this.stores.has(input.storeId)) return this.legacy.ensureCustomer(input);
    const key = requireKey(input.idempotencyKey, 'ensureCustomer');
    return this.call('ensureCustomer', async () => {
      const customer = z
        .object({ provider_customer_id: z.string().regex(/^cus_[A-Za-z0-9]+$/) })
        .strict()
        .parse(
          await this.client.billing.ensureCustomer(
            { store_id: input.storeId, store_name: input.storeName },
            { idempotencyKey: key },
          ),
        );
      return { providerCustomerId: customer.provider_customer_id };
    });
  }
  async createCheckoutSession(input: Parameters<BillingProvider['createCheckoutSession']>[0]) {
    if (!this.stores.has(input.storeId)) return this.legacy.createCheckoutSession(input);
    const key = requireKey(input.idempotencyKey, 'createCheckoutSession');
    if (
      (await this.customerStore(input.providerCustomerId, 'createCheckoutSession')) !==
      input.storeId
    )
      refused('createCheckoutSession');
    const plan = await findMerchantPlanByProviderPrice(getDb(), {
      provider: 'stripe',
      livemode: this.livemode,
      providerPriceId: input.providerPriceId,
    });
    if (!plan || plan.id !== input.planId) refused('createCheckoutSession');
    return this.call('createCheckoutSession', async () =>
      this.hosted(
        await this.client.billing.createCheckoutSession(
          {
            store_id: input.storeId,
            plan_id: input.planId,
            provider_customer_id: input.providerCustomerId,
            provider_price_id: input.providerPriceId,
            trial_days: input.trialDays,
            return_url: input.returnUrl,
          },
          { idempotencyKey: key },
        ),
      ),
    );
  }
  async createPortalSession(input: Parameters<BillingProvider['createPortalSession']>[0]) {
    const store = await this.customerStore(input.providerCustomerId, 'createPortalSession');
    if (!this.stores.has(store)) return this.legacy.createPortalSession(input);
    const key = requireKey(input.idempotencyKey, 'createPortalSession');
    return this.call('createPortalSession', async () =>
      this.hosted(
        await this.client.billing.createPortalSession(
          { provider_customer_id: input.providerCustomerId, return_url: input.returnUrl },
          { idempotencyKey: key },
        ),
      ),
    );
  }
  async retrieveSubscription(ref: string) {
    const store = await this.subscriptionStore(ref, 'retrieveSubscription');
    if (!this.stores.has(store)) return this.legacy.retrieveSubscription(ref);
    return this.call('retrieveSubscription', async () =>
      this.snapshot(
        await this.client.billing.retrieveSubscription(ref),
        ref,
        store,
        'retrieveSubscription',
      ),
    );
  }
  async cancelAtPeriodEnd(ref: string, idempotencyKey?: string) {
    const store = await this.subscriptionStore(ref, 'cancelSubscription');
    if (!this.stores.has(store)) return this.legacy.cancelAtPeriodEnd(ref, idempotencyKey);
    const key = requireKey(idempotencyKey, 'cancelSubscription');
    return this.call('cancelSubscription', async () => {
      // An idempotent replay returns the original receipt, which may predate a
      // later reconciliation. Verify it, then project the current observation.
      // A failed read leaves the caller's intent pending; never project history
      // or invent another mutation key to recover the response.
      await this.snapshot(
        await this.client.billing.cancelAtPeriodEnd(ref, {}, { idempotencyKey: key }),
        ref,
        store,
        'cancelSubscription',
      );
      return this.snapshot(
        await this.client.billing.retrieveSubscription(ref),
        ref,
        store,
        'cancelSubscription',
      );
    });
  }
}
