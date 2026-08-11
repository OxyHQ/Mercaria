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
 * ## Booking an invoice: the posting comes FIRST and the claim rolls it back
 *
 * `merchant_subscription_events` is append-only by trigger, so the audit row
 * cannot be written and then stamped with the ledger transaction it booked. The
 * order is therefore posting, then claim, and a claim that finds the event
 * already applied THROWS — which rolls the posting back inside the same
 * transaction. That is the only ordering under which a redelivered `invoice.paid`
 * cannot double-book, and it uses the transaction as the mechanism rather than a
 * flag somebody has to remember to check.
 */

import type {
  BillingInterval,
  CurrencyCode,
  MerchantBillingSessionView,
  MerchantSubscriptionStatus,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findMerchantPlanAcceptance,
  findMerchantPlanById,
  findMerchantPlanByProviderPrice,
  findMerchantPlanPrice,
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
  type SubscriptionSettlement,
} from './ledger-postings.js';

/** A day, for the grace arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Thrown to roll back a posting whose audit claim was already taken.
 *
 * Module-private and never propagated: the caller converts it into a `booked:
 * false`, because a redelivered invoice is an ordinary event and not a failure.
 */
class SubscriptionInvoiceAlreadyBooked extends Error {}

/** The rail this deployment charges subscriptions on, or a refusal. */
function requireBillingProvider(): BillingProvider {
  const provider = getBillingProvider('stripe');
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
}

/**
 * Record the terms acceptance and open a hosted subscription checkout.
 *
 * The acceptance is written BEFORE the session and deliberately not undone when
 * the session fails: a merchant who agreed to the terms agreed to them, and the
 * acceptance is idempotent, so a retry converges rather than stacking.
 */
export async function startMerchantPlanCheckout(
  input: StartMerchantPlanCheckoutInput,
): Promise<MerchantBillingSessionView> {
  if (!config.merchantBilling.enabled) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  const returnUrl = requireReturnUrl();
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
    returnUrl,
    storeId: input.storeId,
    planId: plan.id,
    idempotencyKey: `billing-checkout:${input.storeId}:${plan.id}:${input.interval}:${price.unitPriceCurrency}`,
  });
  return { url: session.url, expiresAt: session.expiresAt?.toISOString() ?? null };
}

/** Open the provider's hosted billing portal for one store. */
export async function openMerchantBillingPortal(input: {
  storeId: string;
}): Promise<MerchantBillingSessionView> {
  if (!config.merchantBilling.enabled) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
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
  actorOxyUserId: string;
}): Promise<MerchantSubscriptionRow> {
  if (!config.merchantBilling.enabled) {
    throw conflict('Paid plans are not available on this deployment.');
  }
  const provider = requireBillingProvider();
  const subscription = await findSubscriptionByStore(getDb(), input.storeId);
  if (!subscription) throw notFound('This store has no subscription to cancel.');
  if (subscription.status === 'expired') {
    throw conflict('That subscription has already ended.');
  }

  const snapshot = await provider.cancelAtPeriodEnd(subscription.providerSubscriptionId);
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
    provider: 'stripe',
    livemode: snapshot.livemode,
    providerCustomerId: snapshot.providerCustomerId,
  });
  if (!customer) return { outcome: 'unknown_customer' };

  const plan = await findMerchantPlanByProviderPrice(db, {
    provider: 'stripe',
    livemode: snapshot.livemode,
    providerPriceId: snapshot.providerPriceId,
  });
  if (!plan) return { outcome: 'unknown_price' };

  const existing = await findSubscriptionByProviderId(db, {
    provider: 'stripe',
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
      provider: 'stripe',
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
  /**
   * What actually landed on the platform balance. ABSENT when the invoice
   * settled no money at all — a fully-discounted period, or one paid from a
   * credit balance. Absent rather than a zero amount in some currency, because
   * "nothing moved" has no currency to name.
   */
  settlement?: SubscriptionSettlement;
  note: string;
}): Promise<{ booked: boolean }> {
  const settlement = input.settlement;
  const gross = settlement ? settlement.netMinor + settlement.feeMinor : 0;
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      // An invoice that settled nothing books NOTHING and still leaves a claim,
      // so a redelivery of it converges the same way a settled one does.
      const ledgerTransactionId =
        settlement && gross > 0
          ? (
              await insertLedgerTransaction(
                tx,
                {
                  kind: 'subscription_invoice_paid',
                  description: `Merchant subscription invoice ${input.providerInvoiceId}`,
                },
                subscriptionInvoicePaidEntries(settlement),
              )
            ).id
          : undefined;

      const claim = await appendSubscriptionEvent(tx, {
        subscriptionId: input.subscriptionId,
        kind: 'invoice_paid',
        note: input.note,
        providerEventId: input.providerEventId,
        providerInvoiceId: input.providerInvoiceId,
        ...(settlement ? { amount: { amount: gross, currency: settlement.currency } } : {}),
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
}): Promise<{ announced: number }> {
  const at = input?.at ?? new Date();
  const db = getDb();
  const due = await listSubscriptionsPastGrace(db, {
    at,
    limit: input?.limit ?? config.merchantBilling.reconciliationBatchSize,
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
  return { announced };
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
}): Promise<{ examined: number; applied: number; failed: number }> {
  const provider = getBillingProvider('stripe');
  if (!provider) return { examined: 0, applied: 0, failed: 0 };

  const page = await listReconcilableSubscriptions(getDb(), {
    limit: input?.limit ?? config.merchantBilling.reconciliationBatchSize,
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
  return { examined: page.length, applied, failed };
}
