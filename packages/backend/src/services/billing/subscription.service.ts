/**
 * The merchant subscription lifecycle — what an upgrade, a renewal, a failed
 * payment and a cancellation actually DO.
 *
 * ## A client cannot forge a paid plan, and the mechanism is the missing row
 *
 * {@link startMerchantPlanCheckout} records the terms acceptance and returns a
 * hosted URL. It creates NO subscription row: the row is written only from a
 * provider snapshot, which arrives through a verified webhook or a live
 * retrieve. #47's rule for the buyer rail ("a client cannot forge paid state"),
 * one domain over — with the addition that the acceptance is durable, so the
 * merchant's consent survives the gap between agreeing and the rail confirming.
 *
 * ## A subscription with no acceptance on file is NOT recorded
 *
 * {@link applyProviderSubscriptionState} refuses to create a row for a
 * subscription nobody agreed to — an operator creating one straight in the
 * provider's dashboard, a copied configuration, a test subscription pointed at a
 * production customer. It is reported as a named outcome rather than silently
 * invented, because writing down a paid plan a merchant never accepted is the
 * one result that is worse than not recording it at all.
 *
 * ## The grace deadline is stamped ONCE
 *
 * Entering `past_due` computes the deadline from the plan version in force at
 * that moment and stores it. Staying `past_due` leaves it alone, so a
 * redelivered `invoice.payment_failed` cannot extend a grace; recovering clears
 * it, because a stale deadline on a healthy subscription reads as one.
 *
 * ## Booking an invoice: lock the binding and check the invoice, then post and claim
 *
 * The subscription lock serializes invoice observations, including different
 * event IDs for the same invoice. Check its current binding and an existing
 * invoice claim before inserting any ledger posting. Historical claims have no
 * provider namespace columns, so a matching invoice is conservatively retained
 * as claimed even if the subscription row has since been reused.
 *
 * The immutable audit row follows the posting in the same transaction. A duplicate
 * event ID still throws and rolls both back, including across different invoices.

 */

import type {
  BillingInterval,
  CurrencyCode,
  MerchantBillingSessionView,
  MerchantPlanCheckoutView,
  MerchantSubscriptionStatus,
} from '@mercaria/shared-types';
import { and, eq } from 'drizzle-orm';
import {
  merchantSubscriptions,
  merchantSubscriptionEvents,
} from '../../db/schema/merchantPlans.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { merchantBillingAvailable } from './availability.js';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findMerchantPlanAcceptance,
  findMerchantPlanById,
  findMerchantPlanByProviderPrice,
  findMerchantPlanPrice,
  findMerchantPlanPriceByProviderId,
  insertMerchantPlanAcceptance,
  type MerchantPlanRow,
} from '../../db/merchantPlans/planRepository.js';
import {
  appendSubscriptionEvent,
  ensureBillingCustomer,
  findBillingCustomer,
  findBillingCustomerByProviderId,
  findSubscriptionByProviderId,
  findSubscriptionByStore,
  hasSubscriptionEventSince,
  listReconcilableSubscriptions,
  listSubscriptionsPastGrace,
  updateSubscriptionState,
  upsertMerchantSubscription,
  type MerchantSubscriptionRow,
} from '../../db/merchantPlans/subscriptionRepository.js';
import { insertLedgerTransaction } from '../../db/payments/ledgerRepository.js';
import { invalidateMerchantEntitlements } from '../entitlements/resolve.js';
import {
  getBillingProvider,
  type BillingProvider,
  type BillingSubscriptionSnapshot,
} from './provider.js';
import {
  subscriptionInvoicePaidEntries,
  subscriptionInvoicePaidInFaircoinEntries,
  type SubscriptionSettlement,
} from './ledger-postings.js';

/** Reject a malformed intent key before acceptance/customer effects. */
function requireIntent(key?: string): void {
  if (key !== undefined && !/^[A-Za-z0-9:_-]{8,200}$/.test(key))
    throw validationError('Invalid Idempotency-Key.');
}

/** A day, for the grace arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Thrown to roll back a posting whose audit claim was already taken.
 *
 * Module-private and never propagated: the caller converts it into a `booked:
 * false`, because a redelivered invoice is an ordinary event and not a failure.
 */
class SubscriptionInvoiceAlreadyBooked extends Error {}

/**
 * The refusal for any plan action while the store's first payment is pending
 * (`incomplete`): the rail decides that payment, and nothing here may race it.
 */
function firstPaymentPending() {
  return conflict(
    'This store’s first plan payment is still being confirmed. The plan starts once it is; ' +
      'an unfinished payment lapses on its own.',
  );
}

/** The rail this deployment charges subscriptions on, or a refusal. */
function requireBillingProvider(): BillingProvider {
  const provider = getBillingProvider('peable');
  if (!provider) {
    throw conflict('Subscription billing is not configured on this deployment.');
  }
  return provider;
}

/** Where the provider sends a merchant back, or a refusal naming the variable. */
function requireReturnUrl(): string {
  const url = config.merchantBilling.returnUrl;
  if (!url) {
    throw conflict(
      'Subscription billing has no return URL configured (MERCHANT_BILLING_RETURN_URL).',
    );
  }
  return url;
}

/** What starting a paid plan needs. */
export interface StartMerchantPlanCheckoutInput {
  storeId: string;
  storeName: string;
  planId: string;
  interval: BillingInterval;
  currency: CurrencyCode;
  actorOxyUserId: string;
  idempotencyKey?: string;
}

/**
 * Record the terms acceptance and open the subscription checkout the merchant
 * pays in the dashboard's Peable sheet (an embedded session: card or FairCoin).
 *
 * The acceptance is written BEFORE the session and deliberately not undone when
 * the session fails: a merchant who agreed to the terms agreed to them, and the
 * acceptance is idempotent, so a retry converges rather than stacking.
 */
export async function startMerchantPlanCheckout(
  input: StartMerchantPlanCheckoutInput,
): Promise<MerchantPlanCheckoutView> {
  if (!merchantBillingAvailable()) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  requireIntent(input.idempotencyKey);
  const db = getDb();

  const plan = await findMerchantPlanById(db, input.planId);
  if (!plan) throw notFound('Plan not found');
  if (plan.status !== 'active') throw conflict('That plan version is not on sale.');
  if (plan.tier !== 'paid') {
    throw validationError('The free plan is what a store has when it has no subscription.');
  }

  const price = await findMerchantPlanPrice(db, {
    planId: plan.id,
    provider: provider.id,
    livemode: provider.livemode,
    interval: input.interval,
    currency: input.currency,
  });
  if (!price) {
    throw conflict(
      `${plan.name} has no ${input.interval} price in ${input.currency} on this deployment.`,
    );
  }

  // ONE subscription per store (`merchant_subscriptions_store_key`). A second
  // checkout while one is live would start a second subscription at the rail
  // that the store's row could only record by overwriting the first — which
  // would keep billing with nothing in Mercaria pointing at it. A store that
  // already pays changes plan instead (`changeMerchantPlan`); one whose plan
  // has ENDED (`expired`) starts afresh here.
  const live = await findSubscriptionByStore(db, input.storeId);
  // A first payment still confirming (a FairCoin transaction on chain) is a
  // subscription the rail may yet activate; a second checkout beside it could
  // be paid too, and the store would be billed twice for one plan.
  if (live?.status === 'incomplete') throw firstPaymentPending();
  if (live && live.status !== 'expired') {
    throw conflict(
      'This store already has a plan. Change plan instead of starting a second subscription.',
    );
  }

  await insertMerchantPlanAcceptance(db, {
    storeId: input.storeId,
    planKey: plan.planKey,
    planVersion: plan.version,
    termsVersion: plan.termsVersion,
    acceptedByOxyUserId: input.actorOxyUserId,
  });

  const existingCustomer = await findBillingCustomer(db, {
    storeId: input.storeId,
    provider: provider.id,
    livemode: provider.livemode,
  });
  const providerCustomerId =
    existingCustomer?.providerCustomerId ??
    (
      await provider.ensureCustomer({
        storeId: input.storeId,
        storeName: input.storeName,
        // Derived from the STORE, never from a freshly-minted row id — see the
        // interface's own note, and the #46 finding that produced the rule.
        idempotencyKey: `billing-customer:${provider.id}:${input.storeId}`,
      })
    ).providerCustomerId;
  await ensureBillingCustomer(db, {
    storeId: input.storeId,
    provider: provider.id,
    livemode: provider.livemode,
    providerCustomerId,
  });

  const session = await provider.createCheckoutSession({
    providerCustomerId,
    providerPriceId: price.providerPriceId,
    trialDays: plan.trialDays,
    storeId: input.storeId,
    planId: plan.id,
    idempotencyKey:
      input.idempotencyKey ??
      `billing-checkout:${input.storeId}:${plan.id}:${input.interval}:${price.unitPriceCurrency}`,
  });
  // The rail priced the session from the price row; a session for any other
  // figure is not the plan the merchant chose, and is never handed to a payer.
  if (
    session.amountMinor !== price.unitPriceAmount ||
    session.currency !== price.unitPriceCurrency
  ) {
    log.general.error(
      { storeId: input.storeId, planId: plan.id },
      'The billing rail priced a plan checkout differently from its price row',
    );
    throw conflict(`${plan.name} cannot be bought right now: its price is being updated.`);
  }
  return {
    clientSecret: session.clientSecret,
    amount: { amount: session.amountMinor, currency: price.unitPriceCurrency },
    interval: input.interval,
    livemode: session.livemode,
    expiresAt: session.expiresAt?.toISOString() ?? null,
  };
}

/** What changing a live subscription's plan needs. */
export interface ChangeMerchantPlanInput {
  storeId: string;
  planId: string;
  interval: BillingInterval;
  currency: CurrencyCode;
  actorOxyUserId: string;
  idempotencyKey?: string;
}

/**
 * Move a store's live subscription onto another paid plan version or cadence.
 *
 * The terms of the NEW version are accepted first (the row a change is
 * recorded against must name an acceptance, exactly as a new subscription
 * must), then the rail swaps the price with `always_invoice` proration — an
 * upgrade is paid now, a downgrade leaves a credit — and the snapshot it
 * answers is applied through the one path every provider change takes.
 *
 * Refused while the store's last payment failed (`past_due`) or the plan is
 * paused: settling billing comes first, and a proration invoice on top of an
 * unpaid one would only add to what is owed. The currency must be the one the
 * subscription already bills in — the rail invoices one currency per
 * subscription.
 */
export async function changeMerchantPlan(
  input: ChangeMerchantPlanInput,
): Promise<MerchantSubscriptionRow> {
  if (!merchantBillingAvailable()) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  requireIntent(input.idempotencyKey);
  const db = getDb();

  const subscription = await findSubscriptionByStore(db, input.storeId);
  if (!subscription || subscription.status === 'expired') {
    throw conflict('This store has no plan to change. Choose a plan instead.');
  }
  if (subscription.status === 'incomplete') throw firstPaymentPending();
  if (subscription.status === 'past_due' || subscription.status === 'paused') {
    throw conflict('Settle this store’s billing before changing plan.');
  }

  const plan = await findMerchantPlanById(db, input.planId);
  if (!plan) throw notFound('Plan not found');
  if (plan.status !== 'active') throw conflict('That plan version is not on sale.');
  if (plan.tier !== 'paid') {
    throw validationError('To stop paying, cancel the plan; it ends with the paid period.');
  }

  const [price, current] = await Promise.all([
    findMerchantPlanPrice(db, {
      planId: plan.id,
      provider: provider.id,
      livemode: provider.livemode,
      interval: input.interval,
      currency: input.currency,
    }),
    provider.retrieveSubscription(subscription.providerSubscriptionId),
  ]);
  if (!price) {
    throw conflict(
      `${plan.name} has no ${input.interval} price in ${input.currency} on this deployment.`,
    );
  }
  if (current.providerPriceId === price.providerPriceId) {
    throw conflict('This store is already on that plan and billing period.');
  }
  const currentPrice = await findMerchantPlanPriceByProviderId(db, {
    provider: provider.id,
    livemode: provider.livemode,
    providerPriceId: current.providerPriceId,
  });
  if (currentPrice && currentPrice.unitPriceCurrency !== price.unitPriceCurrency) {
    throw conflict(
      `This plan bills in ${currentPrice.unitPriceCurrency}; a plan change keeps that currency.`,
    );
  }

  await insertMerchantPlanAcceptance(db, {
    storeId: input.storeId,
    planKey: plan.planKey,
    planVersion: plan.version,
    termsVersion: plan.termsVersion,
    acceptedByOxyUserId: input.actorOxyUserId,
  });

  const snapshot = await provider.changeSubscriptionPrice({
    providerSubscriptionId: subscription.providerSubscriptionId,
    providerPriceId: price.providerPriceId,
    idempotencyKey:
      input.idempotencyKey ??
      `billing-change:${input.storeId}:${subscription.providerSubscriptionId}:${price.providerPriceId}`,
  });
  const applied = await applyProviderSubscriptionState({
    snapshot,
    note: `plan changed by the merchant to ${plan.planKey} v${plan.version} (${input.interval})`,
    actorOxyUserId: input.actorOxyUserId,
    eventKind: 'plan_changed',
  });
  if (applied.outcome !== 'applied') {
    throw conflict('The plan was changed at the rail but could not be recorded yet.');
  }
  return applied.subscription;
}

/** Open the provider's hosted billing portal for one store. */
export async function openMerchantBillingPortal(input: {
  storeId: string;
  idempotencyKey?: string;
}): Promise<MerchantBillingSessionView> {
  if (!merchantBillingAvailable()) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  requireIntent(input.idempotencyKey);
  const returnUrl = requireReturnUrl();
  const customer = await findBillingCustomer(getDb(), {
    storeId: input.storeId,
    provider: provider.id,
    livemode: provider.livemode,
  });
  if (!customer) throw conflict('This store has no billing account to manage.');

  const session = await provider.createPortalSession({
    providerCustomerId: customer.providerCustomerId,
    returnUrl,
    idempotencyKey: input.idempotencyKey,
  });
  return { url: session.url, expiresAt: session.expiresAt?.toISOString() ?? null };
}

/**
 * Schedule a cancellation for the end of the paid period.
 *
 * The rail is asked FIRST and Mercaria applies what comes back, rather than
 * writing `cancelled` locally and hoping: an update that succeeded at the rail
 * and failed to persist here converges on the next reconciliation, while the
 * reverse — a local cancellation the rail never received — would keep charging a
 * merchant Mercaria had told was cancelled.
 */
export async function scheduleMerchantSubscriptionCancellation(input: {
  storeId: string;
  idempotencyKey?: string;
  actorOxyUserId: string;
}): Promise<MerchantSubscriptionRow> {
  if (!merchantBillingAvailable()) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  requireIntent(input.idempotencyKey);
  const subscription = await findSubscriptionByStore(getDb(), input.storeId);
  if (!subscription) throw notFound('This store has no subscription to cancel.');
  if (subscription.status === 'expired') {
    throw conflict('That subscription has already ended.');
  }
  // Nothing has been paid for yet, so there is no period to end at; an unpaid
  // first payment lapses at the rail on its own.
  if (subscription.status === 'incomplete') throw firstPaymentPending();

  const snapshot = await provider.cancelAtPeriodEnd(
    subscription.providerSubscriptionId,
    input.idempotencyKey,
  );
  const applied = await applyProviderSubscriptionState({
    snapshot,
    note: 'cancellation scheduled by the merchant',
    actorOxyUserId: input.actorOxyUserId,
    eventKind: 'cancellation_scheduled',
  });
  if (applied.outcome !== 'applied') {
    throw conflict('The cancellation was scheduled at the rail but could not be recorded.');
  }
  return applied.subscription;
}

/** What applying a provider snapshot did. A string discriminant — see #68's finding. */
export type SubscriptionApplyOutcome =
  | { readonly outcome: 'applied'; readonly subscription: MerchantSubscriptionRow }
  /** The provider event had already been applied — nothing changed. */
  | { readonly outcome: 'already_applied' }
  /** No store is bound to the provider customer this subscription belongs to. */
  | { readonly outcome: 'unknown_customer' }
  /** No plan version on this deployment publishes the price the rail names. */
  | { readonly outcome: 'unknown_price' }
  /** Nobody at this store ever accepted the plan — see the file docblock. */
  | { readonly outcome: 'no_acceptance' };

/** The audit kinds a provider-driven change may append. */
export type ProviderSubscriptionEventKind =
  | 'created'
  | 'activated'
  | 'past_due'
  | 'paused'
  | 'resumed'
  | 'cancellation_scheduled'
  | 'plan_changed'
  | 'cancelled'
  | 'expired'
  | 'reconciled';

/**
 * Apply what the rail says about one subscription.
 *
 * The ONE path every provider-driven change takes — a webhook, a reconciliation
 * re-read and an operator refetch all land here, so the state machine exists
 * once. When `providerEventId` is supplied the audit row is the idempotency
 * claim: an event already applied returns `already_applied` and changes nothing.
 */
export async function applyProviderSubscriptionState(input: {
  snapshot: BillingSubscriptionSnapshot;
  note: string;
  providerEventId?: string;
  actorOxyUserId?: string;
  eventKind?: ProviderSubscriptionEventKind;
  at?: Date;
}): Promise<SubscriptionApplyOutcome> {
  const at = input.at ?? new Date();
  const db = getDb();
  const snapshot = input.snapshot;

  const customer = await findBillingCustomerByProviderId(db, {
    provider: 'peable',
    livemode: snapshot.livemode,
    providerCustomerId: snapshot.providerCustomerId,
  });
  if (!customer) return { outcome: 'unknown_customer' };

  const plan = await findMerchantPlanByProviderPrice(db, {
    provider: 'peable',
    livemode: snapshot.livemode,
    providerPriceId: snapshot.providerPriceId,
  });
  if (!plan) return { outcome: 'unknown_price' };

  const existing = await findSubscriptionByProviderId(db, {
    provider: 'peable',
    livemode: snapshot.livemode,
    providerSubscriptionId: snapshot.providerSubscriptionId,
  });

  if (!existing) {
    const acceptance = await findMerchantPlanAcceptance(db, {
      storeId: customer.storeId,
      planKey: plan.planKey,
      planVersion: plan.version,
    });
    if (!acceptance) return { outcome: 'no_acceptance' };

    const created = await upsertMerchantSubscription(db, {
      storeId: customer.storeId,
      planId: plan.id,
      billingCustomerId: customer.id,
      provider: 'peable',
      livemode: snapshot.livemode,
      providerSubscriptionId: snapshot.providerSubscriptionId,
      status: snapshot.status,
      interval: snapshot.interval,
      ...(snapshot.currentPeriodStart ? { currentPeriodStart: snapshot.currentPeriodStart } : {}),
      ...(snapshot.currentPeriodEnd ? { currentPeriodEnd: snapshot.currentPeriodEnd } : {}),
      ...(snapshot.trialEndsAt ? { trialEndsAt: snapshot.trialEndsAt } : {}),
      acceptedTermsVersion: acceptance.termsVersion,
      acceptedByOxyUserId: acceptance.acceptedByOxyUserId,
      acceptedAt: acceptance.createdAt,
    });
    // A brand-new subscription can already be past due — a first payment that
    // failed — and the CHECK refuses that row without its deadline, so the grace
    // is stamped here rather than only on a transition.
    const withGrace =
      snapshot.status === 'past_due'
        ? ((await updateSubscriptionState(db, created.id, {
            graceExpiresAt: new Date(at.getTime() + plan.gracePeriodDays * DAY_MS),
          })) ?? created)
        : created;

    await appendSubscriptionEvent(db, {
      subscriptionId: withGrace.id,
      kind: 'created',
      note: input.note,
      toStatus: withGrace.status,
      planId: plan.id,
      ...(input.actorOxyUserId ? { actorOxyUserId: input.actorOxyUserId } : {}),
      ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
    });
    invalidateMerchantEntitlements(customer.storeId);
    return { outcome: 'applied', subscription: withGrace };
  }

  // A sweep that found nothing new writes nothing. An EVENT is different: it is
  // a fact the rail reported and worth recording even when it moved no column,
  // and its claim is what stops a redelivery being applied twice.
  if (!input.providerEventId && !snapshotDiffers(existing, snapshot, plan.id)) {
    return { outcome: 'applied', subscription: existing };
  }

  const claim = await appendSubscriptionEvent(db, {
    subscriptionId: existing.id,
    kind: input.eventKind ?? 'reconciled',
    note: input.note,
    fromStatus: existing.status,
    toStatus: snapshot.status,
    planId: plan.id,
    ...(input.actorOxyUserId ? { actorOxyUserId: input.actorOxyUserId } : {}),
    ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
  });
  if (!claim.created) return { outcome: 'already_applied' };

  const updated = await updateSubscriptionState(db, existing.id, {
    status: snapshot.status,
    planId: plan.id,
    interval: snapshot.interval,
    currentPeriodStart: snapshot.currentPeriodStart ?? null,
    currentPeriodEnd: snapshot.currentPeriodEnd ?? null,
    trialEndsAt: snapshot.trialEndsAt ?? null,
    graceExpiresAt: nextGraceDeadline({ existing, status: snapshot.status, plan, at }),
    cancellationBehavior: snapshot.cancelAt ? 'at_period_end' : null,
    cancelAt: snapshot.cancelAt ?? null,
    cancelledAt: snapshot.cancelledAt ?? null,
    endedAt: snapshot.status === 'expired' ? (snapshot.cancelledAt ?? at) : null,
  });
  if (!updated) return { outcome: 'unknown_customer' };
  invalidateMerchantEntitlements(existing.storeId);
  return { outcome: 'applied', subscription: updated };
}

/** Two instants that are the same to the millisecond, either both absent. */
function sameInstant(left: Date | null, right: Date | undefined): boolean {
  if (!left) return right === undefined;
  return right !== undefined && left.getTime() === right.getTime();
}

/**
 * Whether the rail says anything this row does not already record.
 *
 * Every column {@link applyProviderSubscriptionState} would write is compared,
 * so a sweep cannot decide "nothing changed" about a field it forgot to look at.
 */
function snapshotDiffers(
  existing: MerchantSubscriptionRow,
  snapshot: BillingSubscriptionSnapshot,
  planId: string,
): boolean {
  return (
    existing.status !== snapshot.status ||
    existing.planId !== planId ||
    existing.interval !== snapshot.interval ||
    !sameInstant(existing.currentPeriodStart, snapshot.currentPeriodStart) ||
    !sameInstant(existing.currentPeriodEnd, snapshot.currentPeriodEnd) ||
    !sameInstant(existing.trialEndsAt, snapshot.trialEndsAt) ||
    !sameInstant(existing.cancelAt, snapshot.cancelAt) ||
    !sameInstant(existing.cancelledAt, snapshot.cancelledAt)
  );
}

/**
 * The grace deadline after a state change, stamped ONCE.
 *
 * Entering `past_due` computes it from the plan version in force NOW; staying
 * `past_due` keeps whatever is already there, so a redelivery cannot extend it;
 * leaving `past_due` clears it, because a subscription that recovered is not
 * inside a grace any more.
 */
function nextGraceDeadline(input: {
  existing: MerchantSubscriptionRow;
  status: MerchantSubscriptionStatus;
  plan: MerchantPlanRow;
  at: Date;
}): Date | null {
  if (input.status !== 'past_due') return null;
  if (input.existing.graceExpiresAt) return input.existing.graceExpiresAt;
  return new Date(input.at.getTime() + input.plan.gracePeriodDays * DAY_MS);
}

/**
 * What one paid plan invoice actually brought in, by the rail that paid it.
 *
 * - `card` — fiat captured to the platform's Peable balance: booked to
 *   `provider_clearing` against `subscription_revenue`, in the invoice currency.
 * - `faircoin` — FAIR in the Peable wallet of the Oxy organization that owns
 *   Mercaria's application: booked to `faircoin_received` against
 *   `subscription_revenue`, in FAIR, with the fiat quote kept on the audit row.
 *   `quote` is `null` only for an invoice priced in FAIR itself.
 */
export type SubscriptionInvoiceReceipt =
  | { readonly rail: 'card'; readonly settlement: SubscriptionSettlement }
  | {
      readonly rail: 'faircoin';
      readonly fairMinor: number;
      readonly quote: {
        readonly amountMinor: number;
        readonly currency: CurrencyCode;
        readonly quotedAt: Date;
      } | null;
    };

/** The entries, the audit amount and the quote one receipt books. */
function bookingOf(receipt: SubscriptionInvoiceReceipt) {
  if (receipt.rail === 'card') {
    const { settlement } = receipt;
    return {
      gross: settlement.netMinor + settlement.feeMinor,
      currency: settlement.currency,
      entries: () => subscriptionInvoicePaidEntries(settlement),
      quoted: undefined,
    };
  }
  return {
    gross: receipt.fairMinor,
    currency: 'FAIR' as const,
    entries: () => subscriptionInvoicePaidInFaircoinEntries({ fairMinor: receipt.fairMinor }),
    quoted: receipt.quote
      ? {
          amount: receipt.quote.amountMinor,
          currency: receipt.quote.currency,
          at: receipt.quote.quotedAt,
        }
      : undefined,
  };
}

/**
 * Book one settled subscription invoice, exactly once.
 *
 * @returns `booked: false` when this provider event had already been applied, or
 *   when the invoice settled for nothing — both ordinary outcomes rather than
 *   failures.
 */
export async function recordSubscriptionInvoicePaid(input: {
  subscriptionId: string;
  providerEventId: string;
  providerInvoiceId: string;
  /** The payment that paid it (`pi_…`), when the invoice names one. */
  providerPaymentId?: string;
  expectedSubscription: Pick<
    MerchantSubscriptionRow,
    'provider' | 'livemode' | 'providerSubscriptionId' | 'billingCustomerId'
  >;
  /**
   * What actually arrived, by rail. ABSENT when the invoice settled no money at
   * all — a fully-discounted period, or one paid from a credit balance. Absent
   * rather than a zero amount in some currency, because "nothing moved" has no
   * currency to name.
   */
  receipt?: SubscriptionInvoiceReceipt;
  note: string;
}): Promise<{ booked: boolean }> {
  const booking = input.receipt ? bookingOf(input.receipt) : undefined;
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(merchantSubscriptions)
        .where(eq(merchantSubscriptions.id, input.subscriptionId))
        .for('update');
      if (
        !current ||
        current.provider !== input.expectedSubscription.provider ||
        current.livemode !== input.expectedSubscription.livemode ||
        current.providerSubscriptionId !== input.expectedSubscription.providerSubscriptionId ||
        current.billingCustomerId !== input.expectedSubscription.billingCustomerId
      ) {
        throw conflict('Subscription billing binding changed before settlement.');
      }
      const [priorClaim] = await tx
        .select({ id: merchantSubscriptionEvents.id })
        .from(merchantSubscriptionEvents)
        .where(
          and(
            eq(merchantSubscriptionEvents.subscriptionId, input.subscriptionId),
            eq(merchantSubscriptionEvents.kind, 'invoice_paid'),
            eq(merchantSubscriptionEvents.providerInvoiceId, input.providerInvoiceId),
          ),
        )
        .limit(1);
      if (priorClaim) return { booked: false };
      // An invoice that settled nothing books NOTHING and still leaves a claim,
      // so a redelivery of it converges the same way a settled one does.
      const ledgerTransactionId =
        booking && booking.gross > 0
          ? (
              await insertLedgerTransaction(
                tx,
                {
                  kind: 'subscription_invoice_paid',
                  description: `Merchant subscription invoice ${input.providerInvoiceId}`,
                },
                booking.entries(),
              )
            ).id
          : undefined;

      const claim = await appendSubscriptionEvent(tx, {
        subscriptionId: input.subscriptionId,
        kind: 'invoice_paid',
        note: input.note,
        providerEventId: input.providerEventId,
        providerInvoiceId: input.providerInvoiceId,
        ...(input.providerPaymentId ? { providerPaymentId: input.providerPaymentId } : {}),
        ...(booking ? { amount: { amount: booking.gross, currency: booking.currency } } : {}),
        ...(booking?.quoted ? { quoted: booking.quoted } : {}),
        ...(ledgerTransactionId ? { ledgerTransactionId } : {}),
      });
      // The claim was already taken by an earlier delivery, so the posting above
      // is a duplicate — throwing rolls it back with the rest of this
      // transaction, which is the whole reason the posting comes first.
      if (!claim.created) throw new SubscriptionInvoiceAlreadyBooked();
      return { booked: ledgerTransactionId !== undefined };
    });
  } catch (error) {
    if (error instanceof SubscriptionInvoiceAlreadyBooked) return { booked: false };
    throw error;
  }
}

/**
 * Announce that a grace period has run out.
 *
 * It changes NOTHING on the subscription, deliberately: the rail still says
 * `past_due`, and inventing a Mercaria state the provider does not report would
 * be a second answer to a question the provider owns. What actually removes the
 * paid entitlements is the deadline itself, which the resolver compares against
 * the clock — so this sweep is the audit trail catching up, not the mechanism,
 * and a deployment that never runs it still downgrades on time.
 */
export async function announceExpiredGracePeriods(input?: {
  at?: Date;
  limit?: number;
  afterId?: string;
}): Promise<{ announced: number; nextAfterId: string | null }> {
  const at = input?.at ?? new Date();
  const db = getDb();
  const limit = input?.limit ?? config.merchantBilling.reconciliationBatchSize;
  const due = await listSubscriptionsPastGrace(db, {
    at,
    limit,
    afterId: input?.afterId,
  });

  let announced = 0;
  for (const subscription of due) {
    if (!subscription.graceExpiresAt) continue;
    const already = await hasSubscriptionEventSince(db, {
      subscriptionId: subscription.id,
      kind: 'grace_expired',
      since: subscription.graceExpiresAt,
    });
    if (already) continue;
    await appendSubscriptionEvent(db, {
      subscriptionId: subscription.id,
      kind: 'grace_expired',
      note: 'the grace period ran out; paid entitlements no longer apply',
      fromStatus: subscription.status,
      toStatus: subscription.status,
    });
    invalidateMerchantEntitlements(subscription.storeId);
    announced += 1;
  }
  const nextAfterId = due.length === limit ? (due.at(-1)?.id ?? null) : null;
  return { announced, nextAfterId };
}

/**
 * Re-read subscriptions from the rail — issue #89 billing rule 7.
 *
 * Webhooks are the normal path and are NOT a substitute for this: an event that
 * was never delivered is invisible to everything that waits to be told (#50's
 * opening sentence, applied to subscriptions). A failure on one subscription is
 * logged and the sweep continues, because a page that aborted on its worst row
 * would leave the cursor stuck there forever (#60's per-record isolation).
 */
export async function reconcileMerchantSubscriptions(input?: {
  limit?: number;
  afterId?: string;
}): Promise<{ examined: number; applied: number; failed: number; nextAfterId: string | null }> {
  const provider = getBillingProvider('peable');
  const empty = { examined: 0, applied: 0, failed: 0, nextAfterId: null };
  if (!provider) return empty;

  const limit = input?.limit ?? config.merchantBilling.reconciliationBatchSize;
  const page = await listReconcilableSubscriptions(getDb(), {
    limit,
    afterId: input?.afterId,
    provider: provider.id,
    livemode: provider.livemode,
  });

  let applied = 0;
  let failed = 0;
  for (const subscription of page) {
    try {
      const snapshot = await provider.retrieveSubscription(subscription.providerSubscriptionId);
      const outcome = await applyProviderSubscriptionState({
        snapshot,
        note: 'reconciled against the billing rail',
        eventKind: 'reconciled',
      });
      if (outcome.outcome === 'applied') applied += 1;
    } catch (error) {
      failed += 1;
      log.general.warn(
        { subscriptionId: subscription.id, error },
        '[MerchantBilling] a subscription could not be reconciled',
      );
    }
  }
  // Advance past failed reads too; a partial/empty page wraps on the next pass.
  const nextAfterId = page.length === limit ? (page.at(-1)?.id ?? null) : null;
  return { examined: page.length, applied, failed, nextAfterId };
}
